import { getExchangeRate as fetchExchangeRateFromContract } from "./contractClient.js";
import { config } from "../config/index.js";

interface CachedRate {
  rate: number;
  fetchedAt: number;
}

let cachedRate: CachedRate | null = null;
let refreshInterval: ReturnType<typeof setInterval> | null = null;
let isRefreshing = false;

const STALE_THRESHOLD_MS = config.protocol.exchangeRateRefreshIntervalMs * 3;

export async function getCurrentRate(): Promise<number> {
  if (cachedRate && !isStale(cachedRate)) {
    return cachedRate.rate;
  }

  return refreshRate();
}

export async function refreshRate(): Promise<number> {
  if (isRefreshing) {
    // If already refreshing, wait briefly and return cached if available
    await new Promise((r) => setTimeout(r, 500));
    if (cachedRate) return cachedRate.rate;
  }

  isRefreshing = true;

  try {
    const rate = await fetchExchangeRateFromContract();

    if (rate <= 0 || !isFinite(rate)) {
      throw new Error(`Invalid exchange rate received: ${rate}`);
    }

    cachedRate = {
      rate,
      fetchedAt: Date.now(),
    };

    console.log(
      `[ExchangeRateManager] Rate updated: ${rate.toFixed(7)} (1 sXLM = ${rate.toFixed(7)} XLM)`
    );

    return rate;
  } catch (err) {
    console.error("[ExchangeRateManager] Failed to refresh rate:", err);

    // Return cached rate if we have one, even if stale
    if (cachedRate) {
      console.warn(
        `[ExchangeRateManager] Using stale rate from ${new Date(cachedRate.fetchedAt).toISOString()}`
      );
      return cachedRate.rate;
    }

    // Fallback to 1:1 for initial state (no stake yet means parity)
    console.warn("[ExchangeRateManager] No cached rate, defaulting to 1.0");
    return 1.0;
  } finally {
    isRefreshing = false;
  }
}

function isStale(cached: CachedRate): boolean {
  return Date.now() - cached.fetchedAt > STALE_THRESHOLD_MS;
}

export function getCachedRateInfo(): {
  rate: number;
  fetchedAt: number;
  isStale: boolean;
} | null {
  if (!cachedRate) return null;
  return {
    rate: cachedRate.rate,
    fetchedAt: cachedRate.fetchedAt,
    isStale: isStale(cachedRate),
  };
}

export function startPeriodicRefresh(): void {
  if (refreshInterval) {
    console.warn("[ExchangeRateManager] Periodic refresh already running");
    return;
  }

  // Initial fetch
  refreshRate().catch((err) =>
    console.error("[ExchangeRateManager] Initial refresh failed:", err)
  );

  refreshInterval = setInterval(async () => {
    try {
      await refreshRate();
    } catch (err) {
      console.error("[ExchangeRateManager] Periodic refresh failed:", err);
    }
  }, config.protocol.exchangeRateRefreshIntervalMs);

  console.log(
    `[ExchangeRateManager] Periodic refresh started (every ${config.protocol.exchangeRateRefreshIntervalMs / 1000}s)`
  );
}

export function stopPeriodicRefresh(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
    console.log("[ExchangeRateManager] Periodic refresh stopped");
  }
}

export function computeExchangeRate(
  totalXlmStaked: bigint,
  totalSxlmSupply: bigint
): number {
  if (totalSxlmSupply === BigInt(0)) {
    return 1.0; // Initial rate is 1:1
  }

  // Both values are in stroops (7 decimal places)
  return Number(totalXlmStaked) / Number(totalSxlmSupply);
}

export function xlmToSxlm(xlmStroops: bigint, exchangeRate: number): bigint {
  if (exchangeRate <= 0) throw new Error("Invalid exchange rate");
  return BigInt(Math.floor(Number(xlmStroops) / exchangeRate));
}

export function sxlmToXlm(sxlmStroops: bigint, exchangeRate: number): bigint {
  if (exchangeRate <= 0) throw new Error("Invalid exchange rate");
  return BigInt(Math.floor(Number(sxlmStroops) * exchangeRate));
}
