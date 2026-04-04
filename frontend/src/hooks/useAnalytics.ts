import { useState, useEffect, useCallback, useRef } from 'react';
import axios from '../lib/apiClient';
import { API_BASE_URL } from '../config/contracts';

// ── public types ──────────────────────────────────────────────────────────────

export interface UtilizationDataPoint {
  contractId: string;
  windowStart: string;
  windowEnd: string;
  totalDepositedXlm: number;
  totalBorrowedXlm: number;
  utilizationRate: number;
}

export interface RevenueSeriesPoint {
  windowStart: string;
  windowEnd: string;
  amountXlm: number;
}

export interface CohortOffset {
  dayOffset: number;
  totalWallets: number;
  retainedWallets: number;
  retentionRate: number;
  avgCollateralSizeXlm: number;
  avgBorrowSizeXlm: number;
}

export interface CohortData {
  cohortDate: string;
  offsets: CohortOffset[];
}

export interface LiveData {
  timestamp: string;
  tvl: { timestamp: string; totalStakedXlm: number; exchangeRate: number } | null;
  utilization: {
    contractId: string;
    windowStart: string;
    totalDepositedXlm: number;
    totalBorrowedXlm: number;
    utilizationRate: number;
  } | null;
  revenue: Record<string, number>;
}

interface UseAnalyticsReturn {
  utilizationData: UtilizationDataPoint[];
  revenueSeries: Record<string, RevenueSeriesPoint[]>;
  cohortData: CohortData[];
  liveData: LiveData | null;
  /** Timestamp of the last successful live-data fetch. */
  lastUpdated: Date | null;
  isLoading: boolean;
  error: string | null;
  /** Re-fetches both live and historical data immediately. */
  refresh: () => void;
}

// ── polling intervals ─────────────────────────────────────────────────────────

/** How often the live ticker is refreshed (fast path). */
const LIVE_POLL_MS = 15_000;

/** How often the heavier historical series are refreshed (slow path). */
const HISTORICAL_POLL_MS = 60_000;

// ── mock data generators ──────────────────────────────────────────────────────

const LENDING_CONTRACT_ID = 'CAOWXZ6BWA2ZYY7GHD75OFKADKUJS4WCKPDYGGXULQWFJRB55TXAQNJG';

function generateMockUtilization(days: number): UtilizationDataPoint[] {
  const now = Date.now();
  return Array.from({ length: days + 1 }, (_, i) => {
    const windowStart = new Date(now - (days - i) * 24 * 60 * 60 * 1000).toISOString();
    const trend = i / days;
    const utilizationRate = Math.min(0.93, Math.max(0.1,
      0.38 + trend * 0.18 + (Math.random() - 0.5) * 0.06
    ));
    const totalDepositedXlm = Math.max(0,
      8_200_000 + trend * 1_800_000 + (Math.random() - 0.5) * 400_000
    );
    return {
      contractId: LENDING_CONTRACT_ID,
      windowStart,
      windowEnd: windowStart,
      totalDepositedXlm,
      totalBorrowedXlm: totalDepositedXlm * utilizationRate,
      utilizationRate,
    };
  });
}

const REVENUE_SOURCES = ['LENDING_FEES', 'LP_FEES', 'STAKING_REWARDS', 'LIQUIDATION_FEES'] as const;
const REVENUE_BASELINES: Record<string, number> = {
  LENDING_FEES: 420,
  LP_FEES: 165,
  STAKING_REWARDS: 580,
  LIQUIDATION_FEES: 75,
};

function generateMockRevenueSeries(days: number): Record<string, RevenueSeriesPoint[]> {
  const now = Date.now();
  const series: Record<string, RevenueSeriesPoint[]> = {};
  for (const src of REVENUE_SOURCES) {
    const base = REVENUE_BASELINES[src];
    series[src] = Array.from({ length: days + 1 }, (_, i) => {
      const windowStart = new Date(now - (days - i) * 24 * 60 * 60 * 1000).toISOString();
      const trend = i / days;
      const amountXlm = Math.max(0,
        base * (1 + trend * 0.22) + (Math.random() - 0.5) * base * 0.18
      );
      return { windowStart, windowEnd: windowStart, amountXlm };
    });
  }
  return series;
}

function generateMockCohortData(numCohorts = 10, maxOffset = 14): CohortData[] {
  const now = Date.now();
  return Array.from({ length: numCohorts }, (_, c) => {
    const cohortDate = new Date(
      now - (numCohorts - 1 - c + maxOffset + 1) * 24 * 60 * 60 * 1000
    ).toISOString();
    const totalWallets = Math.round(55 + Math.random() * 125);
    const availableOffsets = Math.min(maxOffset, c);
    const offsets: CohortOffset[] = Array.from({ length: availableOffsets + 1 }, (_, d) => {
      const retentionRate = Math.min(1, Math.max(0.04,
        Math.exp(-d * 0.1) + (Math.random() - 0.5) * 0.05
      ));
      return {
        dayOffset: d,
        totalWallets,
        retainedWallets: Math.round(totalWallets * retentionRate),
        retentionRate,
        avgCollateralSizeXlm: 4200 + Math.random() * 3600,
        avgBorrowSizeXlm: 1600 + Math.random() * 1800,
      };
    });
    return { cohortDate, offsets };
  });
}

// ── hook ──────────────────────────────────────────────────────────────────────

export function useAnalytics(fromDays = 90): UseAnalyticsReturn {
  const [utilizationData, setUtilizationData] = useState<UtilizationDataPoint[]>([]);
  const [revenueSeries, setRevenueSeries] = useState<Record<string, RevenueSeriesPoint[]>>({});
  const [cohortData, setCohortData] = useState<CohortData[]>([]);
  const [liveData, setLiveData] = useState<LiveData | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Track whether historical data has loaded at least once so the loading
  // skeleton only shows on the very first render.
  const historicalLoadedRef = useRef(false);

  // ── fetch live ticker (fast path, 15s) ───────────────────────────────────

  const fetchLive = useCallback(async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/api/analytics/live`);
      if (res.data) {
        setLiveData(res.data as LiveData);
        setLastUpdated(new Date());
      }
    } catch {
      // Live fetch failures are silent — the stale value stays visible.
    }
  }, []);

  // ── fetch historical series (slow path, 60s) ─────────────────────────────

  const fetchHistorical = useCallback(async () => {
    const from = new Date(Date.now() - fromDays * 24 * 60 * 60 * 1000).toISOString();
    try {
      const [utilizationRes, revenueRes, cohortsRes] = await Promise.allSettled([
        axios.get(`${API_BASE_URL}/api/analytics/utilization?from=${from}`),
        axios.get(`${API_BASE_URL}/api/analytics/revenue?from=${from}&groupBy=source`),
        axios.get(`${API_BASE_URL}/api/analytics/cohorts`),
      ]);

      if (utilizationRes.status === 'fulfilled' && utilizationRes.value.data?.data?.length > 0) {
        setUtilizationData(utilizationRes.value.data.data);
      } else if (!historicalLoadedRef.current) {
        setUtilizationData(generateMockUtilization(fromDays));
      }

      const series = revenueRes.status === 'fulfilled'
        ? (revenueRes.value.data?.series as Record<string, RevenueSeriesPoint[]> | undefined)
        : undefined;
      if (series && Object.keys(series).length > 0) {
        setRevenueSeries(series);
      } else if (!historicalLoadedRef.current) {
        setRevenueSeries(generateMockRevenueSeries(fromDays));
      }

      if (cohortsRes.status === 'fulfilled' && cohortsRes.value.data?.cohorts?.length > 0) {
        setCohortData(cohortsRes.value.data.cohorts as CohortData[]);
      } else if (!historicalLoadedRef.current) {
        setCohortData(generateMockCohortData());
      }

      setError(null);
    } catch {
      if (!historicalLoadedRef.current) {
        setError('Failed to fetch analytics data.');
        setUtilizationData(generateMockUtilization(fromDays));
        setRevenueSeries(generateMockRevenueSeries(fromDays));
        setCohortData(generateMockCohortData());
      }
    }

    historicalLoadedRef.current = true;
    setIsLoading(false);
  }, [fromDays]);

  // ── initial load + separate polling intervals ────────────────────────────

  useEffect(() => {
    // Kick off both fetches immediately on mount.
    fetchHistorical();
    fetchLive();

    const historicalId = setInterval(fetchHistorical, HISTORICAL_POLL_MS);
    const liveId = setInterval(fetchLive, LIVE_POLL_MS);

    return () => {
      clearInterval(historicalId);
      clearInterval(liveId);
    };
  }, [fetchHistorical, fetchLive]);

  // ── manual refresh ────────────────────────────────────────────────────────

  const refresh = useCallback(() => {
    fetchHistorical();
    fetchLive();
  }, [fetchHistorical, fetchLive]);

  return {
    utilizationData,
    revenueSeries,
    cohortData,
    liveData,
    lastUpdated,
    isLoading,
    error,
    refresh,
  };
}
