import { PrismaClient } from "@prisma/client";
import { getEventBus, EventType } from "../event-bus/index.js";
import { config } from "../config/index.js";
import { callApplySlashing, callPause, callUnpause } from "../staking-engine/contractClient.js";

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
    console.log("[RiskEngine] Initializing...");

    const eventBus = getEventBus();
    await eventBus.subscribe(EventType.VALIDATOR_DOWN, async (data) => {
      console.warn(`[RiskEngine] Validator down alert: ${data.pubkey}`);
      await this.handleValidatorDown(data.pubkey, data.uptime);
    });

    await eventBus.subscribe(EventType.REBALANCE_REQUIRED, async (data) => {
      console.warn(`[RiskEngine] Rebalance required: ${data.reason}`);
      await this.executeAutoReallocation(data.reason);
    });

    monitorInterval = setInterval(async () => {
      try {
        await this.runHealthCheck();
      } catch (err) {
        console.error("[RiskEngine] Health check error:", err);
      }
    }, 60_000);

    console.log("[RiskEngine] Initialized");
  }

  async shutdown(): Promise<void> {
    if (monitorInterval) {
      clearInterval(monitorInterval);
      monitorInterval = null;
    }
    console.log("[RiskEngine] Shut down");
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
        console.error("[RiskEngine] EMERGENCY MODE ACTIVATED — >30% validators down");

        // Pause protocol on-chain
        try {
          await callPause();
          console.log("[RiskEngine] Protocol paused on-chain");
        } catch (err) {
          console.error("[RiskEngine] Failed to pause on-chain:", err);
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
      console.log("[RiskEngine] Emergency mode deactivated — all validators healthy");

      // Unpause protocol on-chain
      try {
        await callUnpause();
        console.log("[RiskEngine] Protocol unpaused on-chain");
      } catch (err) {
        console.error("[RiskEngine] Failed to unpause on-chain:", err);
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
        console.warn(
          `[RiskEngine] Slashing risk for ${validator.pubkey} — uptime ${(validator.uptime * 100).toFixed(1)}%, stale for ${hoursSinceCheck.toFixed(1)}h`
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
        console.log(
          `[RiskEngine] Allocation deviation for ${v.pubkey}: actual=${(actualFraction * 100).toFixed(1)}% target=${(targetFraction * 100).toFixed(1)}%`
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
    console.log(`[RiskEngine] Executing auto-reallocation (reason: ${reason})...`);

    const validators = await this.prisma.validator.findMany({
      orderBy: { performanceScore: "desc" },
    });

    if (validators.length < 2) {
      console.log("[RiskEngine] Not enough validators for reallocation");
      return;
    }

    const healthy = validators.filter(
      (v) => v.uptime >= config.protocol.validatorMinUptime
    );
    const unhealthy = validators.filter(
      (v) => v.uptime < config.protocol.validatorMinUptime && v.allocatedStake > BigInt(0)
    );

    if (healthy.length === 0 || unhealthy.length === 0) {
      console.log("[RiskEngine] No reallocation needed");
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
      console.log(
        `[RiskEngine] Reallocating ${plan.amount} stroops: ${plan.fromValidator} → ${plan.toValidator}`
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

    console.log(
      `[RiskEngine] Auto-reallocation complete: ${plans.length} moves executed`
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
      console.error(
        `[RiskEngine] Critical: validator ${pubkey} uptime ${(uptime * 100).toFixed(1)}% — triggering reallocation`
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
            console.warn(
              `[RiskEngine] Applied slashing: ${Number(slashAmount) / 1e7} XLM for validator ${pubkey}`
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
            console.error("[RiskEngine] On-chain slashing failed:", err);
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
        console.error("[RiskEngine] Slack notification failed:", err);
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
        console.error("[RiskEngine] Governance webhook failed:", err);
      }
    }

    console.log(`[RiskEngine] Notification sent: [${level}] ${message}`);
  }

  isEmergencyMode(): boolean {
    return this.emergencyMode;
  }
}
