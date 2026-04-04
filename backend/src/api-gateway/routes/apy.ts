import { FastifyPluginAsync } from "fastify";
import { RewardEngine } from "../../reward-engine/index.js";
import { StakingEngine } from "../../staking-engine/index.js";

export const apyRoutes: FastifyPluginAsync<{ rewardEngine: RewardEngine; stakingEngine?: StakingEngine }> = async (
  fastify,
  opts
) => {
  const { rewardEngine, stakingEngine } = opts;

  /**
   * GET /apy
   * Returns APY/APR data derived purely from exchange rate history.
   *
   * APR = (currentRate / oldRate - 1) × (365 / daysDiff)
   * APY = (1 + APR/n)^n - 1  (compounded at 6h intervals)
   *
   * Returns 0 if insufficient data — honest, no fake numbers.
   */
  fastify.get("/apy", async () => {
    try {
      // Derived APR from real exchange rate history
      const derivedAPR = await rewardEngine.getDerivedAPR();

      // Compound APR into APY at 6h distribution cadence (1460 periods/year)
      const PERIODS_PER_YEAR = 1460;
      const derivedAPY = derivedAPR > 0
        ? Math.pow(1 + derivedAPR / PERIODS_PER_YEAR, PERIODS_PER_YEAR) - 1
        : 0;

      const snapshot = await rewardEngine.getLatestSnapshot();

      if (!snapshot) {
        let exchangeRate = 1.0;
        if (stakingEngine) {
          try { exchangeRate = await stakingEngine.getExchangeRate(); } catch { /* fallback 1.0 */ }
        }
        return {
          currentApr: derivedAPR * 100,
          currentApy: derivedAPY * 100,
          apy7d: 0,
          apy30d: 0,
          apy90d: 0,
          exchangeRate,
          totalStaked: "0",
          totalSupply: "0",
          timestamp: new Date().toISOString(),
        };
      }

      return {
        currentApr: derivedAPR * 100,
        currentApy: derivedAPY * 100,
        apy7d: snapshot.yield7d * 100,
        apy30d: snapshot.yield30d * 100,
        apy90d: derivedAPY * 100,
        exchangeRate: snapshot.exchangeRate,
        totalStaked: snapshot.totalStaked.toString(),
        totalSupply: snapshot.totalSupply.toString(),
        timestamp: snapshot.timestamp.toISOString(),
      };
    } catch {
      return {
        currentApr: 0, currentApy: 0, apy7d: 0, apy30d: 0, apy90d: 0,
        exchangeRate: 1, totalStaked: "0", totalSupply: "0",
        timestamp: new Date().toISOString(),
      };
    }
  });
};
