import { useState, useCallback, useEffect } from 'react';
import axios from '../lib/apiClient';
import { API_BASE_URL } from '../config/contracts';
import { useWallet } from './useWallet';

export interface VestingSchedule {
  id: number;
  scheduleId: number;
  beneficiary: string;
  tokenAddress: string;
  tokenSymbol: string;
  /** Total locked, in stroops (divide by 1e7 for display). */
  totalAmount: string;
  claimed: string;
  /** Currently claimable, fresh from chain (stroops). */
  claimable: string;
  startLedger: number;
  cliffLedger: number;
  endLedger: number;
  revocable: boolean;
  revoked: boolean;
  vestedAtRevoke: string;
  createdAt: string;
}

export interface VestingStats {
  totalSchedules: number;
  revokedSchedules: number;
  totalLockedStroops: string;
  totalClaimedStroops: string;
}

interface UseVestingReturn {
  schedules: VestingSchedule[];
  stats: VestingStats | null;
  isLoading: boolean;
  isSubmitting: boolean;
  error: string | null;
  lastTxHash: string | null;
  claim: (scheduleId: number) => Promise<boolean>;
  refresh: () => Promise<void>;
  clearError: () => void;
}

/** Convert stroops (i128 string) to a human-readable XLM amount. */
export function stroopsToXlm(stroops: string): number {
  return Number(stroops) / 1e7;
}

/** Estimate percentage vested at the current moment based on ledger numbers.
 *  Uses an approximation of 1 ledger ≈ 5 seconds. */
export function estimateVestedPercent(
  startLedger: number,
  endLedger: number,
  currentLedger: number
): number {
  if (currentLedger <= startLedger) return 0;
  if (currentLedger >= endLedger) return 100;
  const elapsed = currentLedger - startLedger;
  const total = endLedger - startLedger;
  return Math.min(100, (elapsed / total) * 100);
}

export function useVesting(): UseVestingReturn {
  const { publicKey, isConnected, signTransaction, getAuthHeaders } = useWallet();
  const [schedules, setSchedules] = useState<VestingSchedule[]>([]);
  const [stats, setStats] = useState<VestingStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTxHash, setLastTxHash] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  const fetchData = useCallback(async () => {
    if (!publicKey) return;
    setIsLoading(true);
    try {
      const [schedulesRes, statsRes] = await Promise.allSettled([
        axios.get(`${API_BASE_URL}/api/vesting/${publicKey}`),
        axios.get(`${API_BASE_URL}/api/vesting/stats`),
      ]);

      if (schedulesRes.status === 'fulfilled' && schedulesRes.value) {
        setSchedules(schedulesRes.value.data.schedules ?? []);
      }
      if (statsRes.status === 'fulfilled' && statsRes.value) {
        setStats(statsRes.value.data ?? null);
      }
    } finally {
      setIsLoading(false);
    }
  }, [publicKey]);

  useEffect(() => {
    if (!isConnected || !publicKey) {
      setSchedules([]);
      return;
    }
    fetchData();
    const interval = setInterval(fetchData, 60_000);
    return () => clearInterval(interval);
  }, [isConnected, publicKey, fetchData]);

  const claim = useCallback(
    async (scheduleId: number): Promise<boolean> => {
      if (!isConnected || !publicKey) {
        setError('Please connect your wallet first');
        return false;
      }

      setIsSubmitting(true);
      setError(null);
      setLastTxHash(null);

      try {
        // 1. Build unsigned transaction
        const { data: txData } = await axios.post(
          `${API_BASE_URL}/api/vesting/claim`,
          { userAddress: publicKey, scheduleId },
          { headers: getAuthHeaders() }
        );

        // 2. Sign with Freighter
        const signedXdr = await signTransaction(txData.xdr, txData.networkPassphrase);

        // 3. Submit
        const { data: submitData } = await axios.post(
          `${API_BASE_URL}/api/staking/submit`,
          { signedXdr },
          { headers: getAuthHeaders() }
        );

        setLastTxHash(submitData.txHash);
        await fetchData();
        setIsSubmitting(false);
        return true;
      } catch (err: unknown) {
        const message =
          axios.isAxiosError(err) && err.response?.data?.error
            ? err.response.data.error
            : err instanceof Error
              ? err.message
              : 'Claim failed';
        setError(message);
        setIsSubmitting(false);
        return false;
      }
    },
    [isConnected, publicKey, signTransaction, getAuthHeaders, fetchData]
  );

  return {
    schedules,
    stats,
    isLoading,
    isSubmitting,
    error,
    lastTxHash,
    claim,
    refresh: fetchData,
    clearError,
  };
}
