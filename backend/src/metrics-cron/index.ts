import { PrismaClient } from "@prisma/client";
import cron from "node-cron";
import { getTotalStaked, getTotalSupply } from "../staking-engine/contractClient.js";

let cronJob: cron.ScheduledTask | null = null;

const XLM_PRICE_API = "https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd";

export class MetricsCron {
  private prisma: PrismaClient;
  private lastXlmPrice = 0;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async initialize(): Promise<void> {
    console.log("[MetricsCron] Initializing...");

    // Fetch initial price
    await this.fetchXlmPrice().catch((err) =>
      console.error("[MetricsCron] Initial price fetch failed:", err)
    );

    // Take initial snapshot
    await this.takeMetricsSnapshot().catch((err) =>
      console.error("[MetricsCron] Initial snapshot failed:", err)
    );

    // Schedule: every 5 minutes
    cronJob = cron.schedule("*/5 * * * *", async () => {
      try {
        await this.fetchXlmPrice();
        await this.takeMetricsSnapshot();
      } catch (err) {
        console.error("[MetricsCron] Cron error:", err);
      }
    });

    console.log("[MetricsCron] Initialized, running every 5 min");
  }

  async shutdown(): Promise<void> {
    if (cronJob) {
      cronJob.stop();
      cronJob = null;
    }
    console.log("[MetricsCron] Shut down");
  }

  private async fetchXlmPrice(): Promise<void> {
    try {
      const response = await fetch(XLM_PRICE_API);
      if (!response.ok) {
        console.warn(`[MetricsCron] Price API returned ${response.status}`);
        return;
      }

      const data = (await response.json()) as {
        stellar?: { usd?: number };
      };

      if (data.stellar?.usd) {
        this.lastXlmPrice = data.stellar.usd;
        console.log(`[MetricsCron] XLM price: $${this.lastXlmPrice}`);
      }
    } catch (err) {
      console.error("[MetricsCron] Price fetch error:", err);
    }
  }

  private async takeMetricsSnapshot(): Promise<void> {
    let totalStaked: bigint;
    let totalSupply: bigint;

    try {
      [totalStaked, totalSupply] = await Promise.all([
        getTotalStaked(),
        getTotalSupply(),
      ]);
    } catch {
      // If contract calls fail, use last known values
      const latest = await this.prisma.protocolMetrics.findFirst({
        orderBy: { updatedAt: "desc" },
      });
      totalStaked = latest?.totalStaked ?? BigInt(0);
      totalSupply = latest?.totalSupply ?? BigInt(0);
    }

    // Calculate TVL in USD: totalStaked (in stroops) / 1e7 * xlmPrice
    const totalStakedXlm = Number(totalStaked) / 1e7;
    const tvlUsd = totalStakedXlm * (this.lastXlmPrice || 0);

    // Get average validator score
    const validators = await this.prisma.validator.findMany({
      select: { performanceScore: true },
    });
    const avgValidatorScore =
      validators.length > 0
        ? validators.reduce((sum, v) => sum + v.performanceScore, 0) /
          validators.length
        : 0;

    await this.prisma.protocolMetrics.create({
      data: {
        totalStaked,
        totalSupply,
        tvlUsd,
        avgValidatorScore,
      },
    });

    console.log(
      `[MetricsCron] Snapshot: staked=${totalStakedXlm.toFixed(2)} XLM, TVL=$${tvlUsd.toFixed(2)}, avgScore=${avgValidatorScore.toFixed(3)}`
    );
  }

  getXlmPrice(): number {
    return this.lastXlmPrice;
  }
}
