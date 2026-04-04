import { useState, useCallback, useEffect } from 'react';
import axios from '../lib/apiClient';
import { API_BASE_URL, SUPPORTED_COLLATERAL_ASSETS } from '../config/contracts';
import { useWallet } from './useWallet';

export interface CollateralAssetPosition {
  assetAddress: string;
  symbol: string;
  amount: number;
  amountRaw: string;
  collateralFactorBps: number;
  liquidationThresholdBps: number;
  priceInXlm: number;
}

export interface LendingPosition {
  collateralAssets: CollateralAssetPosition[];
  xlmBorrowed: number;
  xlmBorrowedRaw: string;
  totalCollateralValueXlm: number;
  healthFactor: number;
  maxBorrow: number;
}

export interface CollateralAssetStats {
  assetAddress: string;
  symbol: string;
  totalCollateral: number;
  totalCollateralRaw: string;
  collateralFactorBps: number;
  liquidationThresholdBps: number;
  priceInXlm: number;
}

interface LendingStats {
  assets: CollateralAssetStats[];
  totalBorrowed: number;
  totalBorrowedRaw: string;
  totalCollateralValueXlm: number;
  poolBalance: number;
  borrowRateBps: number;
  utilizationRate: number;
}

interface LendingAlert {
  healthFactor: number;
  riskLevel: 'safe' | 'warning' | 'critical';
  recommendation: string;
}

interface UseLendingReturn {
  position: LendingPosition;
  stats: LendingStats;
  alert: LendingAlert;
  isLoading: boolean;
  isSubmitting: boolean;
  isPending: boolean;
  error: string | null;
  lastTxHash: string | null;
  depositCollateral: (amount: number, assetAddress: string) => Promise<boolean>;
  withdrawCollateral: (amount: number, assetAddress: string) => Promise<boolean>;
  borrow: (amount: number) => Promise<boolean>;
  repay: (amount: number) => Promise<boolean>;
  liquidate: (borrowerAddress: string, collateralAssetAddress: string) => Promise<boolean>;
  clearError: () => void;
  refresh: () => Promise<void>;
}

const DEFAULT_POSITION: LendingPosition = {
  collateralAssets: [],
  xlmBorrowed: 0,
  xlmBorrowedRaw: '0',
  totalCollateralValueXlm: 0,
  healthFactor: 0,
  maxBorrow: 0,
};

const DEFAULT_STATS: LendingStats = {
  assets: [],
  totalBorrowed: 0,
  totalBorrowedRaw: '0',
  totalCollateralValueXlm: 0,
  poolBalance: 0,
  borrowRateBps: 500,
  utilizationRate: 0,
};

const DEFAULT_ALERT: LendingAlert = {
  healthFactor: 0,
  riskLevel: 'safe',
  recommendation: 'No active debt position detected.',
};

export function useLending(): UseLendingReturn {
  const { publicKey, isConnected, signTransaction, getAuthHeaders } = useWallet();
  const [position, setPosition] = useState<LendingPosition>(DEFAULT_POSITION);
  const [stats, setStats] = useState<LendingStats>(DEFAULT_STATS);
  const [alert, setAlert] = useState<LendingAlert>(DEFAULT_ALERT);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTxHash, setLastTxHash] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  const fetchData = useCallback(async () => {
    try {
      const [statsRes, posRes, alertRes] = await Promise.allSettled([
        axios.get(`${API_BASE_URL}/api/lending/stats`),
        publicKey
          ? axios.get(`${API_BASE_URL}/api/lending/position/${publicKey}`)
          : Promise.resolve(null),
        publicKey
          ? axios.get(`${API_BASE_URL}/api/lending/alerts/${publicKey}`)
          : Promise.resolve(null),
      ]);

      if (statsRes.status === 'fulfilled' && statsRes.value) {
        setStats(statsRes.value.data);
      }
      if (posRes.status === 'fulfilled' && posRes.value?.data) {
        setPosition(posRes.value.data);
      }
      if (alertRes.status === 'fulfilled' && alertRes.value?.data) {
        setAlert(alertRes.value.data);
      } else if (!publicKey) {
        setAlert(DEFAULT_ALERT);
      }
    } catch {
      // Keep defaults on error
    }
    setIsLoading(false);
  }, [publicKey]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const submitContractTx = useCallback(
    async (endpoint: string, payload: Record<string, unknown>): Promise<boolean> => {
      if (!isConnected || !publicKey) {
        setError('Please connect your wallet first');
        return false;
      }

      setIsSubmitting(true);
      setError(null);
      setLastTxHash(null);
      setIsPending(false);

      try {
        const { data: txData } = await axios.post(
          `${API_BASE_URL}/api/lending/${endpoint}`,
          { userAddress: publicKey, ...payload },
          { headers: getAuthHeaders() }
        );

        if (txData.xdr) {
          const signedXdr = await signTransaction(txData.xdr, txData.networkPassphrase);
          const { data: submitData } = await axios.post(
            `${API_BASE_URL}/api/staking/submit`,
            { signedXdr },
            { headers: getAuthHeaders() }
          );
          setLastTxHash(submitData.txHash);
          setIsPending(submitData.pending ?? false);
        }

        await fetchData();
        setIsSubmitting(false);
        return true;
      } catch (err: unknown) {
        const message =
          axios.isAxiosError(err) && err.response?.data?.error
            ? err.response.data.error
            : err instanceof Error
              ? err.message
              : 'Transaction failed';
        setError(message);
        setIsSubmitting(false);
        return false;
      }
    },
    [isConnected, publicKey, signTransaction, getAuthHeaders, fetchData]
  );

  const depositCollateral = useCallback(
    (amount: number, assetAddress: string) =>
      submitContractTx('deposit-collateral', { amount, assetAddress }),
    [submitContractTx]
  );

  const withdrawCollateral = useCallback(
    (amount: number, assetAddress: string) =>
      submitContractTx('withdraw-collateral', { amount, assetAddress }),
    [submitContractTx]
  );

  const borrow = useCallback(
    (amount: number) => submitContractTx('borrow', { amount }),
    [submitContractTx]
  );

  const repay = useCallback(
    (amount: number) => submitContractTx('repay', { amount }),
    [submitContractTx]
  );

  const liquidate = useCallback(
    async (borrowerAddress: string, collateralAssetAddress: string): Promise<boolean> => {
      if (!isConnected || !publicKey) {
        setError('Please connect your wallet first');
        return false;
      }

      setIsSubmitting(true);
      setError(null);
      setLastTxHash(null);
      setIsPending(false);

      try {
        const { data: txData } = await axios.post(
          `${API_BASE_URL}/api/lending/liquidate`,
          { liquidatorAddress: publicKey, borrowerAddress, collateralAssetAddress },
          { headers: getAuthHeaders() }
        );

        if (txData.xdr) {
          const signedXdr = await signTransaction(txData.xdr, txData.networkPassphrase);
          const { data: submitData } = await axios.post(
            `${API_BASE_URL}/api/staking/submit`,
            { signedXdr },
            { headers: getAuthHeaders() }
          );
          setLastTxHash(submitData.txHash);
          setIsPending(submitData.pending ?? false);
        }

        await fetchData();
        setIsSubmitting(false);
        return true;
      } catch (err: unknown) {
        const message =
          axios.isAxiosError(err) && err.response?.data?.error
            ? err.response.data.error
            : err instanceof Error
              ? err.message
              : 'Liquidation failed';
        setError(message);
        setIsSubmitting(false);
        return false;
      }
    },
    [isConnected, publicKey, signTransaction, getAuthHeaders, fetchData]
  );

  return {
    position,
    stats,
    alert,
    isLoading,
    isSubmitting,
    isPending,
    error,
    lastTxHash,
    depositCollateral,
    withdrawCollateral,
    borrow,
    repay,
    liquidate,
    clearError,
    refresh: fetchData,
  };
}

/** Returns the CollateralAssetMeta entry for a given contract address, or undefined. */
export function assetMetaByAddress(address: string) {
  return SUPPORTED_COLLATERAL_ASSETS.find((a) => a.contractId === address);
}
