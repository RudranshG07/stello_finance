import { PrismaClient } from "@prisma/client";
import { getEventBus, EventType } from "../event-bus/index.js";
import { config } from "../config/index.js";
import { callApplySlashing, callPause, callUnpause } from "../staking-engine/contractClient.js";
import { getLogger, ServiceContext } from "../utils/logger.js";

const logger = getLogger(ServiceContext.RISK_ENGINE);

let monitorInterval: ReturnType<typeof setInterval> | null = null;

interface ReallocationPlan {
  fromValidator: string;
  toValidator: string;
  amount: bigint;
}

export class RiskEngine {
  private prisma: PrismaClient;
  private emergencyMode = false;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async initialize(): Promise<void> {
    logger.info("Initializing Risk Engine", "initialize");

    const eventBus = getEventBus();
    await eventBus.subscribe(EventType.VALIDATOR_DOWN, async (data) => {
      logger.warn("Validator down alert detected", "validator-down", { pubkey: data.pubkey, uptime: data.uptime });
      await this.handleValidatorDown(data.pubkey, data.uptime);
    });

    await eventBus.subscribe(EventType.REBALANCE_REQUIRED, async (data) => {
      logger.warn("Rebalance required", "rebalance-required", { reason: data.reason });
      await this.executeAutoReallocation(data.reason);
    });

    monitorInterval = setInterval(async () => {
      try {
        await this.runHealthCheck();
      } catch (err) {
        logger.error("Health check error", "health-check", {}, err as Error);
      }
    }, 60_000);

    logger.info("Risk Engine initialized successfully", "initialize");
  }

  async shutdown(): Promise<void> {
    if (monitorInterval) {
      clearInterval(monitorInterval);
      monitorInterval = null;
    }
    logger.info("Risk Engine shut down", "shutdown");
  }

  private async runHealthCheck(): Promise<void> {
    const validators = await this.prisma.validator.findMany();
    if (validators.length === 0) return;

    const downValidators = validators.filter(
      (v) => v.uptime < config.protocol.validatorMinUptime
    );

    if (downValidators.length > validators.length * 0.3) {
      if (!this.emergencyMode) {
        this.emergencyMode = true;
        logger.error("EMERGENCY MODE ACTIVATED", "emergency-activation", { 
          downValidators: downValidators.length, 
          totalValidators: validators.length,
          threshold: 0.3 
        });

        // Pause protocol on-chain
        try {
          await callPause();
          logger.info("Protocol paused on-chain", "emergency-pause");
        } catch (err) {
          logger.error("Failed to pause protocol on-chain", "emergency-pause-failed", {}, err as Error);
        }

        const eventBus = getEventBus();
        await eventBus.publish(EventType.REBALANCE_REQUIRED, {
          reason: "emergency",
          validators: downValidators.map((v) => ({
            pubkey: v.pubkey,
            currentAllocation: v.allocatedStake,
            targetAllocation: BigInt(0),
          })),
          timestamp: Date.now(),
        });

        await this.sendGovernanceNotification(
          "EMERGENCY",
          `${downValidators.length}/${validators.length} validators down. Protocol paused. Emergency rebalance triggered.`
        );
      }
    } else if (this.emergencyMode && downValidators.length === 0) {
      this.emergencyMode = false;
      logger.info("Emergency mode deactivated - all validators healthy", "emergency-deactivation");

      // Unpause protocol on-chain
      try {
        await callUnpause();
        logger.info("Protocol unpaused on-chain", "emergency-unpause");
      } catch (err) {
        logger.error("Failed to unpause protocol on-chain", "emergency-unpause-failed", {}, err as Error);
      }

      await this.sendGovernanceNotification(
        "RECOVERY",
        "All validators healthy. Protocol unpaused. Emergency mode deactivated."
      );
    }

    // Check for individual slashing risk
    for (const validator of downValidators) {
      const hoursSinceCheck =
        (Date.now() - validator.lastChecked.getTime()) / (1000 * 60 * 60);

      if (hoursSinceCheck > 2 && validator.uptime < 0.9) {
        logger.warn(
          "Slashing risk detected for validator",
          "slashing-risk",
          {
            pubkey: validator.pubkey,
            uptime: validator.uptime,
            uptimePercent: (validator.uptime * 100).toFixed(1),
            hoursSinceCheck: hoursSinceCheck.toFixed(1),
            lastChecked: validator.lastChecked
          }
        );

        const eventBus = getEventBus();
        await eventBus.publish(EventType.REBALANCE_REQUIRED, {
          reason: "slashing_risk",
          validators: [{
            pubkey: validator.pubkey,
            currentAllocation: validator.allocatedStake,
            targetAllocation: BigInt(0),
          }],
          timestamp: Date.now(),
        });
      }
    }

    // Check for allocation deviation
    await this.checkAllocationDeviation(validators);
  }

  /**
   * Check if validator allocations deviate too far from their target (weighted by performance).
   */
  private async checkAllocationDeviation(
    validators: Array<{
      pubkey: string;
      performanceScore: number;
      allocatedStake: bigint;
      uptime: number;
    }>
  ): Promise<void> {
    const activeValidators = validators.filter(
      (v) => v.uptime >= config.protocol.validatorMinUptime
    );
    if (activeValidators.length === 0) return;

    const totalScore = activeValidators.reduce(
      (sum, v) => sum + v.performanceScore,
      0
    );
    const totalStake = activeValidators.reduce(
      (sum, v) => sum + v.allocatedStake,
      BigInt(0)
    );

    if (totalStake === BigInt(0) || totalScore === 0) return;

    for (const v of activeValidators) {
      const targetFraction = v.performanceScore / totalScore;
      const actualFraction = Number(v.allocatedStake) / Number(totalStake);
      const deviation = Math.abs(actualFraction - targetFraction);

      if (deviation > config.protocol.rebalanceThreshold) {
        logger.info(
          "Allocation deviation detected",
          "allocation-deviation",
          {
            pubkey: v.pubkey,
            actualPercent: (actualFraction * 100).toFixed(1),
            targetPercent: (targetFraction * 100).toFixed(1),
            deviation: deviation,
            actualStake: v.allocatedStake.toString(),
            targetStake: BigInt(Math.floor(Number(totalStake) * targetFraction)).toString()
          }
        );

        const eventBus = getEventBus();
        await eventBus.publish(EventType.REBALANCE_REQUIRED, {
          reason: "allocation_deviation",
          validators: [{
            pubkey: v.pubkey,
            currentAllocation: v.allocatedStake,
            targetAllocation: BigInt(Math.floor(Number(totalStake) * targetFraction)),
          }],
          timestamp: Date.now(),
        });
      }
    }
  }

  /**
   * Execute auto-reallocation: move stake from underperforming validators to healthy ones.
   */
  private async executeAutoReallocation(reason: string): Promise<void> {
    logger.info("Executing auto-reallocation", "auto-reallocation", { reason });

    const validators = await this.prisma.validator.findMany({
      orderBy: { performanceScore: "desc" },
    });

    if (validators.length < 2) {
      logger.warn("Not enough validators for reallocation", "auto-reallocation", { 
        validatorCount: validators.length, 
        required: 2 
      });
      return;
    }

    const healthy = validators.filter(
      (v) => v.uptime >= config.protocol.validatorMinUptime
    );
    const unhealthy = validators.filter(
      (v) => v.uptime < config.protocol.validatorMinUptime && v.allocatedStake > BigInt(0)
    );

    if (healthy.length === 0 || unhealthy.length === 0) {
      logger.info("No reallocation needed", "auto-reallocation", { 
        healthyCount: healthy.length, 
        unhealthyCount: unhealthy.length 
      });
      return;
    }

    // Calculate total stake to redistribute from unhealthy validators
    const stakeToRedistribute = unhealthy.reduce(
      (sum, v) => sum + v.allocatedStake,
      BigInt(0)
    );

    if (stakeToRedistribute === BigInt(0)) return;

    // Distribute proportionally to healthy validators by performance score
    const totalHealthyScore = healthy.reduce(
      (sum, v) => sum + v.performanceScore,
      0
    );

    const plans: ReallocationPlan[] = [];

    for (const target of healthy) {
      const fraction = target.performanceScore / totalHealthyScore;
      const allocation = BigInt(
        Math.floor(Number(stakeToRedistribute) * fraction)
      );

      if (allocation > BigInt(0)) {
        // Pick the first unhealthy validator with remaining stake
        for (const source of unhealthy) {
          if (source.allocatedStake > BigInt(0)) {
            const moveAmount =
              allocation < source.allocatedStake
                ? allocation
                : source.allocatedStake;

            plans.push({
              fromValidator: source.pubkey,
              toValidator: target.pubkey,
              amount: moveAmount,
            });
            break;
          }
        }
      }
    }

    // Apply reallocation in DB (in production, this would also call contracts)
    for (const plan of plans) {
      logger.financial(
        "Reallocating stake between validators",
        plan.amount,
        "XLM",
        "stake-reallocation",
        {
          fromValidator: plan.fromValidator,
          toValidator: plan.toValidator,
          amountStroops: plan.amount.toString()
        }
      );

      await this.prisma.validator.update({
        where: { pubkey: plan.fromValidator },
        data: {
          allocatedStake: {
            decrement: plan.amount,
          },
        },
      });

      await this.prisma.validator.update({
        where: { pubkey: plan.toValidator },
        data: {
          allocatedStake: {
            increment: plan.amount,
          },
        },
      });
    }

    logger.info(
      "Auto-reallocation completed",
      "auto-reallocation-complete",
      {
        plansExecuted: plans.length,
        totalStakeRedistributed: stakeToRedistribute.toString(),
        reason: reason
      }
    );

    await this.sendGovernanceNotification(
      "REBALANCE",
      `Auto-reallocation executed: ${plans.length} stake moves (reason: ${reason})`
    );
  }

  private async handleValidatorDown(
    pubkey: string,
    uptime: number
  ): Promise<void> {
    if (uptime < 0.85) {
      logger.error(
        "Critical validator uptime detected - triggering reallocation",
        "critical-validator-uptime",
        {
          pubkey: pubkey,
          uptime: uptime,
          uptimePercent: (uptime * 100).toFixed(1),
          threshold: 0.85
        }
      );

      // Apply slashing on-chain: estimate 5% loss for severely down validators
      const validator = await this.prisma.validator.findUnique({
        where: { pubkey },
      });
      if (validator && validator.allocatedStake > BigInt(0)) {
        const slashPercent = uptime < 0.5 ? 0.1 : 0.05; // 10% for <50% uptime, 5% otherwise
        const slashAmount = BigInt(
          Math.floor(Number(validator.allocatedStake) * slashPercent)
        );

        if (slashAmount > BigInt(0)) {
          try {
            await callApplySlashing(slashAmount);
            logger.warn(
              "Applied slashing for validator",
              "slashing-applied",
              {
                pubkey: pubkey,
                slashAmount: slashAmount.toString(),
                slashAmountFormatted: (Number(slashAmount) / 1e7).toFixed(2),
                slashPercent: (slashPercent * 100).toFixed(0),
                uptime: (uptime * 100).toFixed(1)
              }
            );

            // Emit slashing event for withdrawal queue recalculation
            const slashBus = getEventBus();
            await slashBus.publish(EventType.SLASHING_APPLIED, {
              amount: slashAmount,
              reason: `validator_down:${pubkey}`,
              timestamp: Date.now(),
            });

            await this.sendGovernanceNotification(
              "SLASHING",
              `Applied ${(slashPercent * 100).toFixed(0)}% slash (${(Number(slashAmount) / 1e7).toFixed(2)} XLM) for validator ${pubkey} (uptime: ${(uptime * 100).toFixed(1)}%)`
            );
          } catch (err) {
            logger.error("On-chain slashing failed", "slashing-failed", { pubkey }, err as Error);
          }
        }
      }

      const eventBus = getEventBus();
      await eventBus.publish(EventType.REBALANCE_REQUIRED, {
        reason: "validator_critical",
        validators: [{
          pubkey,
          currentAllocation: BigInt(0),
          targetAllocation: BigInt(0),
        }],
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Send notification to governance/monitoring webhooks.
   */
  private async sendGovernanceNotification(
    level: string,
    message: string
  ): Promise<void> {
    const payload = {
      level,
      message,
      protocol: "sXLM",
      timestamp: new Date().toISOString(),
      emergencyMode: this.emergencyMode,
    };

    // Slack webhook
    if (config.webhooks.slackUrl) {
      try {
        await fetch(config.webhooks.slackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `[sXLM ${level}] ${message}`,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `*[sXLM Protocol — ${level}]*\n${message}\n_${payload.timestamp}_`,
                },
              },
            ],
          }),
        });
      } catch (err) {
        logger.error("Slack notification failed", "slack-notification-failed", { level, message }, err as Error);
      }
    }

    // Generic governance webhook
    if (config.webhooks.governanceUrl) {
      try {
        await fetch(config.webhooks.governanceUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        logger.error("Governance webhook failed", "governance-webhook-failed", { level, message }, err as Error);
      }
    }

    logger.info("Notification sent", "notification-sent", { level, message });
  }

  isEmergencyMode(): boolean {
    return this.emergencyMode;
  }
}
