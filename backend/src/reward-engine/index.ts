import { PrismaClient } from "@prisma/client";
import { getTotalStaked, getTotalSupply, callUpdateLendingExchangeRate } from "../staking-engine/contractClient.js";
import { computeExchangeRate } from "../staking-engine/exchangeRateManager.js";
import { getEventBus, EventType } from "../event-bus/index.js";
import { config } from "../config/index.js";

let snapshotInterval: ReturnType<typeof setInterval> | null = null;
let rewardDistributionInterval: ReturnType<typeof setInterval> | null = null;

export class RewardEngine {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async initialize(): Promise<void> {
    console.log("[RewardEngine] Initializing...");

    // Initial snapshot
    await this.takeSnapshot().catch((err) =>
      console.error("[RewardEngine] Initial snapshot failed:", err)
    );

    // Periodic snapshots
    snapshotInterval = setInterval(async () => {
      try {
        await this.takeSnapshot();
      } catch (err) {
        console.error("[RewardEngine] Snapshot error:", err);
      }
    }, config.protocol.rewardSnapshotIntervalMs);

    // NOTE: Simulated APR distribution is DISABLED.
    // Real yield is harvested by the KeeperBot from lending interest every 6h.
    // RewardEngine only handles snapshots and APY tracking.
    console.log(
      `[RewardEngine] Initialized, snapshotting every ${config.protocol.rewardSnapshotIntervalMs / 1000}s (reward distribution handled by KeeperBot)`
    );
  }

  async shutdown(): Promise<void> {
    if (snapshotInterval) {
      clearInterval(snapshotInterval);
      snapshotInterval = null;
    }
    if (rewardDistributionInterval) {
      clearInterval(rewardDistributionInterval);
      rewardDistributionInterval = null;
    }
    console.log("[RewardEngine] Shut down");
  }

  async takeSnapshot(): Promise<void> {
    const [totalStaked, totalSupply] = await Promise.all([
      getTotalStaked(),
      getTotalSupply(),
    ]);

    const exchangeRate = computeExchangeRate(totalStaked, totalSupply);
    const apy = await this.calculateAPY(exchangeRate);

    await this.prisma.rewardSnapshot.create({
      data: {
        totalStaked,
        totalSupply,
        exchangeRate,
        apy,
      },
    });

    // Sync exchange rate to lending contract (best effort — don't fail snapshot on error)
    callUpdateLendingExchangeRate(exchangeRate).catch((err) =>
      console.warn("[RewardEngine] Lending rate sync failed (non-fatal):", err)
    );

    // Publish reward update event
    const eventBus = getEventBus();
    await eventBus.publish(EventType.REWARD_UPDATED, {
      exchangeRate,
      apy,
      totalStaked,
      totalSupply,
      timestamp: Date.now(),
    });

    console.log(
      `[RewardEngine] Snapshot: rate=${exchangeRate.toFixed(7)}, apy=${(apy * 100).toFixed(2)}%`
    );
  }

  private async calculateAPY(currentRate: number): Promise<number> {
    // Fetch the snapshot from ~365 days ago (or oldest available)
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

    const oldestSnapshot = await this.prisma.rewardSnapshot.findFirst({
      where: {
        timestamp: { gte: oneYearAgo },
      },
      orderBy: { timestamp: "asc" },
    });

    if (!oldestSnapshot) {
      // No historical data; try to estimate from recent data
      const recentSnapshot = await this.prisma.rewardSnapshot.findFirst({
        orderBy: { timestamp: "desc" },
        skip: 1,
      });

      if (!recentSnapshot) {
        return 0;
      }

      const timeDiffMs =
        Date.now() - recentSnapshot.timestamp.getTime();
      if (timeDiffMs < 60_000) return 0;

      const rateGrowth = currentRate / recentSnapshot.exchangeRate - 1;
      const periodsPerYear =
        (365 * 24 * 60 * 60 * 1000) / timeDiffMs;

      const annualizedReturn = Math.pow(1 + rateGrowth, periodsPerYear) - 1;

      return Math.max(0, Math.min(annualizedReturn, 0.5));
    }

    const timeDiffMs =
      Date.now() - oldestSnapshot.timestamp.getTime();
    const yearFraction = timeDiffMs / (365 * 24 * 60 * 60 * 1000);

    if (yearFraction < 0.001) return 0;

    const totalReturn = currentRate / oldestSnapshot.exchangeRate - 1;
    const annualizedReturn = Math.pow(1 + totalReturn, 1 / yearFraction) - 1;

    return Math.max(0, Math.min(annualizedReturn, 0.5));
  }

  async getCurrentAPY(): Promise<number> {
    const latest = await this.prisma.rewardSnapshot.findFirst({
      orderBy: { timestamp: "desc" },
    });
    return latest?.apy ?? 0;
  }

  /**
   * Derive APR purely from exchange rate history.
   * APR = (currentRate / oldRate - 1) × (365 / daysDiff)
   * Returns 0 if insufficient data (<24h of snapshots).
   */
  async getDerivedAPR(): Promise<number> {
    const now = Date.now();
    // Try 30-day window first, fall back to 7-day
    for (const days of [30, 7]) {
      const since = new Date(now - days * 24 * 60 * 60 * 1000);

      const [oldest, latest] = await Promise.all([
        this.prisma.rewardSnapshot.findFirst({
          where: { timestamp: { gte: since } },
          orderBy: { timestamp: "asc" },
        }),
        this.prisma.rewardSnapshot.findFirst({
          orderBy: { timestamp: "desc" },
        }),
      ]);

      if (!oldest || !latest || oldest.id === latest.id) continue;

      const timeDiffMs = latest.timestamp.getTime() - oldest.timestamp.getTime();
      const daysDiff = timeDiffMs / (24 * 60 * 60 * 1000);

      // Require at least 24h of data
      if (daysDiff < 1) continue;

      const rateGrowth = latest.exchangeRate / oldest.exchangeRate - 1;
      if (rateGrowth <= 0) return 0;

      const apr = rateGrowth * (365 / daysDiff);
      // Cap at 50% to filter nonsense
      return Math.min(apr, 0.5);
    }

    return 0;
  }

  async getExchangeRateHistory(
    days: number
  ): Promise<Array<{ timestamp: Date; exchangeRate: number }>> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return this.prisma.rewardSnapshot.findMany({
      where: { timestamp: { gte: since } },
      select: { timestamp: true, exchangeRate: true },
      orderBy: { timestamp: "asc" },
    });
  }

  async get7DayYield(): Promise<number> {
    return this.calculatePeriodYield(7);
  }

  async get30DayYield(): Promise<number> {
    return this.calculatePeriodYield(30);
  }

  private async calculatePeriodYield(days: number): Promise<number> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [oldest, latest] = await Promise.all([
      this.prisma.rewardSnapshot.findFirst({
        where: { timestamp: { gte: since } },
        orderBy: { timestamp: "asc" },
      }),
      this.prisma.rewardSnapshot.findFirst({
        orderBy: { timestamp: "desc" },
      }),
    ]);

    if (!oldest || !latest || oldest.id === latest.id) {
      return 0;
    }

    const rateGrowth = latest.exchangeRate / oldest.exchangeRate - 1;
    return Math.max(0, rateGrowth);
  }

  async getTotalRewardsDistributed(): Promise<bigint> {
    const latest = await this.prisma.rewardSnapshot.findFirst({
      orderBy: { timestamp: "desc" },
    });

    if (!latest) return BigInt(0);

    const initialXlmEquivalent = latest.totalSupply;

    if (latest.totalStaked > initialXlmEquivalent) {
      return latest.totalStaked - initialXlmEquivalent;
    }

    return BigInt(0);
  }

  async getLatestSnapshot(): Promise<{
    exchangeRate: number;
    apy: number;
    totalStaked: bigint;
    totalSupply: bigint;
    timestamp: Date;
    yield7d: number;
    yield30d: number;
  } | null> {
    const latest = await this.prisma.rewardSnapshot.findFirst({
      orderBy: { timestamp: "desc" },
    });

    if (!latest) return null;

    const [yield7d, yield30d] = await Promise.all([
      this.get7DayYield(),
      this.get30DayYield(),
    ]);

    return {
      exchangeRate: latest.exchangeRate,
      apy: latest.apy,
      totalStaked: latest.totalStaked,
      totalSupply: latest.totalSupply,
      timestamp: latest.timestamp,
      yield7d,
      yield30d,
    };
  }
}
