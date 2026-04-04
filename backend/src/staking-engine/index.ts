import { PrismaClient } from "@prisma/client";
import {
  startPeriodicRefresh as startExchangeRateRefresh,
  stopPeriodicRefresh as stopExchangeRateRefresh,
  getCurrentRate,
} from "./exchangeRateManager.js";
import {
  startWithdrawalQueueProcessor,
  stopWithdrawalQueueProcessor,
  getQueueStats,
} from "./withdrawalQueueProcessor.js";
import {
  getTotalStaked,
  getTotalSupply,
  getLiquidityBuffer,
  getTreasuryBalance,
  getIsPaused,
  getProtocolFeeBps,
  callApplySlashing,
  callPause,
  callUnpause,
  callRecalibrateRate,
} from "./contractClient.js";
import { getEventBus, EventType } from "../event-bus/index.js";

export class StakingEngine {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async initialize(): Promise<void> {
    console.log("[StakingEngine] Initializing...");
    startExchangeRateRefresh();
    startWithdrawalQueueProcessor(this.prisma);

    // Subscribe to slashing events → recalculate withdrawal queue
    const eventBus = getEventBus();
    await eventBus.subscribe(EventType.SLASHING_APPLIED, async (data) => {
      const slashAmount = BigInt(data.amount);
      await this.recalculateWithdrawalQueueAfterSlash(slashAmount);
    });

    console.log("[StakingEngine] Initialized successfully");
  }

  async shutdown(): Promise<void> {
    console.log("[StakingEngine] Shutting down...");
    stopExchangeRateRefresh();
    stopWithdrawalQueueProcessor();
    console.log("[StakingEngine] Shut down");
  }

  async getExchangeRate(): Promise<number> {
    return getCurrentRate();
  }

  async getProtocolStats(): Promise<{
    totalStaked: bigint;
    totalSupply: bigint;
    exchangeRate: number;
    liquidityBuffer: bigint;
    treasuryBalance: bigint;
    isPaused: boolean;
    protocolFeeBps: number;
  }> {
    // Use allSettled so one RPC failure doesn't break the entire response
    const [totalStakedR, totalSupplyR, exchangeRateR, liquidityBufferR, treasuryBalanceR, isPausedR, protocolFeeBpsR] =
      await Promise.allSettled([
        getTotalStaked(),
        getTotalSupply(),
        getCurrentRate(),
        getLiquidityBuffer(),
        getTreasuryBalance(),
        getIsPaused(),
        getProtocolFeeBps(),
      ]);

    return {
      totalStaked: totalStakedR.status === "fulfilled" ? totalStakedR.value : BigInt(0),
      totalSupply: totalSupplyR.status === "fulfilled" ? totalSupplyR.value : BigInt(0),
      exchangeRate: exchangeRateR.status === "fulfilled" ? exchangeRateR.value : 1,
      liquidityBuffer: liquidityBufferR.status === "fulfilled" ? liquidityBufferR.value : BigInt(0),
      treasuryBalance: treasuryBalanceR.status === "fulfilled" ? treasuryBalanceR.value : BigInt(0),
      isPaused: isPausedR.status === "fulfilled" ? isPausedR.value : false,
      protocolFeeBps: protocolFeeBpsR.status === "fulfilled" ? protocolFeeBpsR.value : 1000,
    };
  }

  async getWithdrawalQueueStats() {
    return getQueueStats(this.prisma);
  }

  /**
   * Fix #4: Recalculate pending withdrawal amounts after slashing.
   * When slashing reduces total_xlm, the exchange rate drops.
   * Pending withdrawals should reflect the new (lower) exchange rate.
   */
  async recalculateWithdrawalQueueAfterSlash(slashAmount: bigint): Promise<void> {
    const [totalStaked, totalSupply] = await Promise.all([
      getTotalStaked(),
      getTotalSupply(),
    ]);

    if (totalSupply === BigInt(0)) return;

    // New exchange rate after slashing: ER = totalStaked / totalSupply
    // (slashing already reduced totalStaked on-chain)
    const newER = Number(totalStaked) / Number(totalSupply);
    const oldER = Number(totalStaked + slashAmount) / Number(totalSupply);

    if (oldER <= 0) return;

    const reductionFactor = newER / oldER;

    // Get all pending withdrawals
    const pendingWithdrawals = await this.prisma.withdrawal.findMany({
      where: { status: "pending" },
    });

    if (pendingWithdrawals.length === 0) return;

    let recalculated = 0;
    for (const w of pendingWithdrawals) {
      const newAmount = BigInt(Math.floor(Number(w.amount) * reductionFactor));
      if (newAmount !== w.amount) {
        await this.prisma.withdrawal.update({
          where: { id: w.id },
          data: { amount: newAmount },
        });
        recalculated++;
      }
    }

    console.log(
      `[StakingEngine] Slashing recalculation: ${recalculated} pending withdrawals adjusted by factor ${reductionFactor.toFixed(6)} (slash: ${Number(slashAmount) / 1e7} XLM)`
    );
  }

  // --- Admin operations ---

  async applySlashing(slashAmountStroops: bigint): Promise<string> {
    // apply_slashing already emits recalib event on-chain
    const result = await callApplySlashing(slashAmountStroops);

    // Explicit ER recalibration call to ensure event is emitted
    try {
      await callRecalibrateRate();
      console.log("[StakingEngine] Exchange rate recalibrated on-chain after slashing");
    } catch (err) {
      console.error("[StakingEngine] Recalibration call failed (ER still auto-adjusts):", err);
    }

    // Emit slashing event so withdrawal queue gets recalculated
    const eventBus = getEventBus();
    await eventBus.publish(EventType.SLASHING_APPLIED, {
      amount: slashAmountStroops,
      reason: "admin",
      timestamp: Date.now(),
    });

    return result;
  }

  async pause(): Promise<string> {
    return callPause();
  }

  async unpause(): Promise<string> {
    return callUnpause();
  }
}
