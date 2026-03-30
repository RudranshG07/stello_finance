import { useState, useCallback, useEffect } from 'react';
import axios from '../lib/apiClient';
import { API_BASE_URL } from '../config/contracts';
import { useWallet } from './useWallet';

interface Proposal {
  id: number;
  proposer: string;
  paramKey: string;
  newValue: string;
  votesFor: string;
  votesAgainst: string;
  status: string;
  executed: boolean;
  queued: boolean;
  timelockEta?: number | null;
  startLedger?: number;
  endLedger?: number;
  expiresAt?: string;
}

interface GovParam {
  key: string;
  currentValue: string;
  description: string;
}

interface UseGovernanceReturn {
  proposals: Proposal[];
  params: GovParam[];
  isLoading: boolean;
  isSubmitting: boolean;
  error: string | null;
  lastTxHash: string | null;
  createProposal: (paramKey: string, newValue: string) => Promise<boolean>;
  vote: (proposalId: number, support: boolean) => Promise<boolean>;
  queueProposal: (proposalId: number) => Promise<boolean>;
  cancelProposal: (proposalId: number) => Promise<boolean>;
  executeQueued: (proposalId: number) => Promise<boolean>;
  executeProposal: (proposalId: number) => Promise<boolean>;
  clearError: () => void;
  refresh: () => Promise<void>;
}

export function useGovernance(): UseGovernanceReturn {
  const { publicKey, isConnected, signTransaction, getAuthHeaders } = useWallet();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [params, setParams] = useState<GovParam[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTxHash, setLastTxHash] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  const fetchData = useCallback(async () => {
    try {
      const [proposalsRes, paramsRes] = await Promise.allSettled([
        axios.get(`${API_BASE_URL}/api/governance/proposals`),
        axios.get(`${API_BASE_URL}/api/governance/params`),
      ]);

      if (proposalsRes.status === 'fulfilled' && proposalsRes.value) {
        setProposals(proposalsRes.value.data.proposals || []);
      }
      if (paramsRes.status === 'fulfilled' && paramsRes.value) {
        setParams(paramsRes.value.data.params || []);
      }
    } catch {
      // Keep defaults
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const submitGovTx = useCallback(
    async (endpoint: string, payload: Record<string, unknown>): Promise<boolean> => {
      if (!isConnected || !publicKey) {
        setError('Please connect your wallet first');
        return false;
      }

      setIsSubmitting(true);
      setError(null);
      setLastTxHash(null);

      try {
        const { data: txData } = await axios.post(
          `${API_BASE_URL}/api/governance/${endpoint}`,
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

  const createProposal = useCallback(
    (paramKey: string, newValue: string) =>
      submitGovTx('create-proposal', { paramKey, newValue }),
    [submitGovTx]
  );

  const vote = useCallback(
    (proposalId: number, support: boolean) =>
      submitGovTx('vote', { proposalId, support }),
    [submitGovTx]
  );

  const queueProposal = useCallback(
    (proposalId: number) => submitGovTx('queue', { proposalId }),
    [submitGovTx]
  );

  const cancelProposal = useCallback(
    (proposalId: number) => submitGovTx('cancel', { proposalId }),
    [submitGovTx]
  );

  const executeQueued = useCallback(
    (proposalId: number) => submitGovTx('execute-queued', { proposalId }),
    [submitGovTx]
  );

  const executeProposal = useCallback(
    (proposalId: number) => submitGovTx('execute', { proposalId }),
    [submitGovTx]
  );

  return {
    proposals,
    params,
    isLoading,
    isSubmitting,
    error,
    lastTxHash,
    createProposal,
    vote,
    queueProposal,
    cancelProposal,
    executeQueued,
    executeProposal,
    clearError,
    refresh: fetchData,
  };
}
