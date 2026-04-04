import { FastifyPluginAsync } from "fastify";
import { PrismaClient } from "@prisma/client";
import { StakingEngine } from "../../staking-engine/index.js";
import { chartDaysSchema } from "../middleware/validation.js";

export const statsRoutes: FastifyPluginAsync<{
  prisma: PrismaClient;
  stakingEngine: StakingEngine;
}> = async (fastify, opts) => {
  const { prisma, stakingEngine } = opts;

  /**
   * GET /chart-data
   * Returns historical time-series data for frontend charts.
   * Query param `days` is clamped to 1–365.
   */
  fastify.get<{ Querystring: { days?: string } }>("/chart-data", async (request) => {
    try {
      const { days } = chartDaysSchema.parse(request.query);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const snapshots = await prisma.rewardSnapshot.findMany({
        where: { timestamp: { gte: since } },
        orderBy: { timestamp: "asc" },
        select: { timestamp: true, exchangeRate: true, apy: true, totalStaked: true },
      });

      return {
        apyHistory: snapshots.map((s) => ({ timestamp: s.timestamp.toISOString(), value: s.apy * 100 })),
        exchangeRateHistory: snapshots.map((s) => ({ timestamp: s.timestamp.toISOString(), value: s.exchangeRate })),
        totalStakedHistory: snapshots.map((s) => ({ timestamp: s.timestamp.toISOString(), value: Number(s.totalStaked) / 1e7 })),
        tvlHistory: snapshots.map((s) => ({ timestamp: s.timestamp.toISOString(), value: (Number(s.totalStaked) / 1e7) * 0.12 })),
      };
    } catch {
      return { apyHistory: [], exchangeRateHistory: [], totalStakedHistory: [], tvlHistory: [] };
    }
  });

  /**
   * GET /protocol-stats
   * Returns protocol metrics matching the frontend ProtocolStats interface.
   */
  fastify.get("/protocol-stats", async () => {
    // Use Promise.allSettled so individual RPC failures don't break the whole response
    const [metricsResult, statsResult] = await Promise.allSettled([
      prisma.protocolMetrics.findFirst({ orderBy: { updatedAt: "desc" } }),
      stakingEngine.getProtocolStats(),
    ]);

    const metrics = metricsResult.status === "fulfilled" ? metricsResult.value : null;

    // If full stats call failed, still try to get just the exchange rate
    let protocolStats: Awaited<ReturnType<typeof stakingEngine.getProtocolStats>> | null = null;
    if (statsResult.status === "fulfilled") {
      protocolStats = statsResult.value;
    }

    // Always try to get a real exchange rate even if getProtocolStats failed
    let exchangeRate = protocolStats?.exchangeRate ?? 1;
    if (!protocolStats) {
      try {
        exchangeRate = await stakingEngine.getExchangeRate();
      } catch {
        // last resort fallback
      }
    }

    const totalStakedXlm = protocolStats ? Number(protocolStats.totalStaked) / 1e7 : 0;
    const totalSxlmSupply = protocolStats ? Number(protocolStats.totalSupply) / 1e7 : 0;

    return {
      totalStaked: totalStakedXlm,
      totalSxlmSupply,
      exchangeRate,
      tvlUsd: metrics?.tvlUsd ?? 0,
      totalStakers: 0,
      totalValidators: 0,
      xlmPrice: metrics?.tvlUsd && totalStakedXlm > 0
        ? metrics.tvlUsd / totalStakedXlm
        : 0.12,
      liquidityBuffer: protocolStats ? Number(protocolStats.liquidityBuffer) / 1e7 : 0,
      avgValidatorScore: metrics?.avgValidatorScore ?? 0,
      treasuryBalance: protocolStats ? Number(protocolStats.treasuryBalance) / 1e7 : 0,
      isPaused: protocolStats?.isPaused ?? false,
      protocolFeePct: protocolStats ? protocolStats.protocolFeeBps / 100 : 10,
    };
  });
};
