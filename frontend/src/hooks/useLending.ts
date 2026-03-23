import { useState, useCallback, useEffect } from 'react';
import axios from '../lib/apiClient';
import { API_BASE_URL } from '../config/contracts';
import { useWallet } from './useWallet';

export interface AssetPosition {
  contractId: string;
  symbol: string;
  amountDeposited: number;
  amountDepositedRaw: string;
  xlmValue: number;
  collateralFactorBps: number;
  liquidationThresholdBps: number;
  priceInXlm: number;
}

export interface SupportedAsset {
  contractId: string;
  symbol: string;
  collateralFactorBps: number;
  liquidationThresholdBps: number;
  priceInXlm: number;
  enabled: boolean;
}

interface LendingPosition {
  totalCollateralXlm: number;
  xlmBorrowed: number;
  healthFactor: number;
  maxBorrow: number;
  assetPositions: AssetPosition[];
}

interface LendingStats {
  totalCollateral: number;
  totalBorrowed: number;
  poolBalance: number;
  collateralFactorBps: number;
  liquidationThresholdBps: number;
  borrowRateBps: number;
  utilizationRate: number;
}

interface UseLendingReturn {
  position: LendingPosition;
  stats: LendingStats;
  supportedAssets: SupportedAsset[];
  selectedAsset: string;
  setSelectedAsset: (assetId: string) => void;
  isLoading: boolean;
  isSubmitting: boolean;
  isPending: boolean;
  error: string | null;
  lastTxHash: string | null;
  depositCollateral: (amount: number, asset?: string) => Promise<boolean>;
  withdrawCollateral: (amount: number, asset?: string) => Promise<boolean>;
  borrow: (amount: number) => Promise<boolean>;
  repay: (amount: number) => Promise<boolean>;
  liquidate: (borrowerAddress: string, collateralAsset?: string) => Promise<boolean>;
  clearError: () => void;
  refresh: () => Promise<void>;
}

const DEFAULT_POSITION: LendingPosition = {
  totalCollateralXlm: 0,
  xlmBorrowed: 0,
  healthFactor: 0,
  maxBorrow: 0,
  assetPositions: [],
};

const DEFAULT_STATS: LendingStats = {
  totalCollateral: 0,
  totalBorrowed: 0,
  poolBalance: 0,
  collateralFactorBps: 7500,
  liquidationThresholdBps: 8000,
  borrowRateBps: 500,
  utilizationRate: 0,
};

export function useLending(): UseLendingReturn {
  const { publicKey, isConnected, signTransaction, getAuthHeaders } = useWallet();
  const [position, setPosition] = useState<LendingPosition>(DEFAULT_POSITION);
  const [stats, setStats] = useState<LendingStats>(DEFAULT_STATS);
  const [supportedAssets, setSupportedAssets] = useState<SupportedAsset[]>([]);
  const [selectedAsset, setSelectedAsset] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTxHash, setLastTxHash] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  const fetchData = useCallback(async () => {
    try {
      const [statsRes, assetsRes, posRes] = await Promise.allSettled([
        axios.get(`${API_BASE_URL}/api/lending/stats`),
        axios.get(`${API_BASE_URL}/api/lending/assets`),
        publicKey
          ? axios.get(`${API_BASE_URL}/api/lending/position/${publicKey}`)
          : Promise.resolve(null),
      ]);

      if (statsRes.status === 'fulfilled' && statsRes.value) {
        setStats(statsRes.value.data);
      }

      if (assetsRes.status === 'fulfilled' && assetsRes.value?.data) {
        const assets: SupportedAsset[] = assetsRes.value.data.filter(Boolean);
        setSupportedAssets(assets);
        // Set default selected asset to first enabled asset (sXLM).
        if (!selectedAsset && assets.length > 0) {
          setSelectedAsset(assets[0].contractId);
        }
      }

      if (posRes.status === 'fulfilled' && posRes.value?.data) {
        setPosition(posRes.value.data);
      }
    } catch {
      // Keep defaults on error.
    }
    setIsLoading(false);
  }, [publicKey, selectedAsset]);

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
    (amount: number, asset?: string) =>
      submitContractTx('deposit-collateral', { amount, asset: asset ?? selectedAsset }),
    [submitContractTx, selectedAsset]
  );

  const withdrawCollateral = useCallback(
    (amount: number, asset?: string) =>
      submitContractTx('withdraw-collateral', { amount, asset: asset ?? selectedAsset }),
    [submitContractTx, selectedAsset]
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
    async (borrowerAddress: string, collateralAsset?: string): Promise<boolean> => {
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
          { liquidatorAddress: publicKey, borrowerAddress, collateralAsset },
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
    supportedAssets,
    selectedAsset,
    setSelectedAsset,
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
