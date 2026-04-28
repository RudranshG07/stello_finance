import { useState, useCallback, useEffect } from 'react';
import { SorobanRpc, Contract, Address, TransactionBuilder, BASE_FEE, scValToNative } from '@stellar/stellar-sdk';
import axios from '../lib/apiClient';
import { API_BASE_URL, NETWORK } from '../config/contracts';
import { useWallet } from './useWallet';

// Admin public key used as source for read-only Soroban simulations.
// It's a known active account on mainnet — the user's own account may not
// be loadable by getAccount() before their first Soroban interaction.
const SIMULATION_SOURCE = 'GDWXTIIROGCVBSNQMBJFH6HOWQ4YSRVMKSUS53CH6MP56WSWD6J4VZ5N';

// Hardcoded mainnet sXLM token contract ID — do NOT use CONTRACTS.sxlmToken here
// because VITE_SXLM_TOKEN_CONTRACT_ID may be misconfigured in the deployment env.
const SXLM_TOKEN_CONTRACT = 'CCGFHMW3NZD5Z7ATHYHZSEG6ABCJADUHP5HIAWFPR37CP4VGNEDQO7FJ';

interface StakingState {
  isStaking: boolean;
  isUnstaking: boolean;
  isClaiming: boolean;
  error: string | null;
  lastTxHash: string | null;
  isPending: boolean;
}

interface BalanceInfo {
  sxlmBalance: number;
  xlmValue: number;
  exchangeRate: number;
  xlmNativeBalance: number;
  archived?: boolean;
}

interface PendingWithdrawal {
  id: string;
  wallet: string;
  amount: string;
  status: string;
  unlockTime: string;
  createdAt: string;
}

interface UseStakingReturn extends StakingState {
  isPending: boolean;
  stake: (xlmAmount: number) => Promise<boolean>;
  unstake: (sxlmAmount: number, instant?: boolean) => Promise<boolean>;
  claimWithdrawal: (withdrawalId: string) => Promise<boolean>;
  pendingWithdrawals: PendingWithdrawal[];
  fetchPendingWithdrawals: () => Promise<void>;
  clearError: () => void;
  balance: BalanceInfo;
  refreshBalance: () => Promise<void>;
}

export function useStaking(): UseStakingReturn {
  const { publicKey, isConnected, signTransaction, getAuthHeaders } = useWallet();
  const [state, setState] = useState<StakingState>({
    isStaking: false,
    isUnstaking: false,
    isClaiming: false,
    error: null,
    lastTxHash: null,
    isPending: false,
  });
  const [pendingWithdrawals, setPendingWithdrawals] = useState<PendingWithdrawal[]>([]);
  const [balance, setBalance] = useState<BalanceInfo>({ sxlmBalance: 0, xlmValue: 0, exchangeRate: 1, xlmNativeBalance: 0 });

  const clearError = useCallback(() => {
    setState((prev) => ({ ...prev, error: null }));
  }, []);

  const refreshBalance = useCallback(async () => {
    if (!publicKey) return;
    try {
      // Fetch Horizon account (native XLM) and backend (exchange rate) in parallel
      const [accountRes, apiRes] = await Promise.all([
        fetch(`${NETWORK.horizonUrl}/accounts/${publicKey}`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        axios.get(`${API_BASE_URL}/api/balance/${publicKey}`).catch(() => null),
      ]);

      // Native XLM balance from Horizon
      let xlmNativeBalance = 0;
      if (accountRes?.balances) {
        const nativeBal = accountRes.balances.find(
          (b: { asset_type: string; balance: string }) => b.asset_type === 'native'
        );
        if (nativeBal) xlmNativeBalance = parseFloat(nativeBal.balance);
      }

      // Exchange rate from backend
      const exchangeRate: number = apiRes?.data?.exchangeRate ?? 1;

      // Read sXLM balance DIRECTLY from the on-chain token contract via Soroban RPC.
      // Uses SXLM_TOKEN_CONTRACT constant (not CONTRACTS.sxlmToken) to avoid env-var misconfiguration.
      let sxlmBalance = 0;
      try {
        const soroban = new SorobanRpc.Server(NETWORK.sorobanRpcUrl);
        const account = await soroban.getAccount(SIMULATION_SOURCE);
        const tx = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: NETWORK.networkPassphrase,
        })
          .addOperation(
            new Contract(SXLM_TOKEN_CONTRACT).call('balance', new Address(publicKey).toScVal())
          )
          .setTimeout(30)
          .build();
        const sim = await soroban.simulateTransaction(tx);
        if (SorobanRpc.Api.isSimulationSuccess(sim) && sim.result) {
          sxlmBalance = Number(scValToNative(sim.result.retval)) / 1e7;
        }
      } catch {
        // Fall back to backend value if Soroban read fails
        sxlmBalance = apiRes?.data?.sxlmBalance ?? 0;
      }

      setBalance({
        sxlmBalance,
        xlmValue: sxlmBalance * exchangeRate,
        exchangeRate,
        xlmNativeBalance,
        archived: apiRes?.data?.archived ?? false,
      });
    } catch {
      // silently fail
    }
  }, [publicKey]);

  // Auto-fetch balance when wallet connects
  useEffect(() => {
    if (isConnected && publicKey) {
      refreshBalance();
    }
  }, [isConnected, publicKey, refreshBalance]);

  const stake = useCallback(
    async (xlmAmount: number): Promise<boolean> => {
      if (!isConnected || !publicKey) {
        setState((prev) => ({ ...prev, error: 'Please connect your wallet first' }));
        return false;
      }

      setState((prev) => ({ ...prev, isStaking: true, error: null }));

      try {
        // Step 1: Get unsigned transaction XDR from backend
        const { data: txData } = await axios.post(
          `${API_BASE_URL}/api/staking/stake`,
          { userAddress: publicKey, amount: xlmAmount },
          { headers: getAuthHeaders() }
        );

        if (txData.xdr) {
          // Step 2: Sign with Freighter
          const signedXdr = await signTransaction(txData.xdr, txData.networkPassphrase);

          // Step 3: Submit signed tx back to backend
          const { data: submitData } = await axios.post(
            `${API_BASE_URL}/api/staking/submit`,
            { signedXdr },
            { headers: getAuthHeaders() }
          );

          setState((prev) => ({
            ...prev,
            isStaking: false,
            lastTxHash: submitData.txHash,
            isPending: submitData.pending ?? false,
          }));
        } else {
          setState((prev) => ({
            ...prev,
            isStaking: false,
            lastTxHash: txData.txHash || null,
            isPending: false,
          }));
        }

        // Refresh balance after staking
        await refreshBalance();
        return true;
      } catch (err: unknown) {
        const message =
          axios.isAxiosError(err) && err.response?.data?.error
            ? err.response.data.error
            : err instanceof Error
              ? err.message
              : 'Staking failed';
        setState((prev) => ({ ...prev, isStaking: false, error: message }));
        return false;
      }
    },
    [isConnected, publicKey, signTransaction, getAuthHeaders, refreshBalance]
  );

  const unstake = useCallback(
    async (sxlmAmount: number, instant: boolean = false): Promise<boolean> => {
      if (!isConnected || !publicKey) {
        setState((prev) => ({ ...prev, error: 'Please connect your wallet first' }));
        return false;
      }

      setState((prev) => ({ ...prev, isUnstaking: true, error: null }));

      try {
        const { data: txData } = await axios.post(
          `${API_BASE_URL}/api/staking/unstake`,
          { userAddress: publicKey, amount: sxlmAmount, instant },
          { headers: getAuthHeaders() }
        );

        if (txData.xdr) {
          const signedXdr = await signTransaction(txData.xdr, txData.networkPassphrase);
          const { data: submitData } = await axios.post(
            `${API_BASE_URL}/api/staking/submit`,
            { signedXdr },
            { headers: getAuthHeaders() }
          );

          setState((prev) => ({
            ...prev,
            isUnstaking: false,
            lastTxHash: submitData.txHash,
            isPending: submitData.pending ?? false,
          }));
        } else {
          setState((prev) => ({
            ...prev,
            isUnstaking: false,
            lastTxHash: txData.txHash || null,
            isPending: false,
          }));
        }

        // Refresh balance after unstaking
        await refreshBalance();
        return true;
      } catch (err: unknown) {
        const message =
          axios.isAxiosError(err) && err.response?.data?.error
            ? err.response.data.error
            : err instanceof Error
              ? err.message
              : 'Unstaking failed';
        setState((prev) => ({ ...prev, isUnstaking: false, error: message }));
        return false;
      }
    },
    [isConnected, publicKey, signTransaction, getAuthHeaders, refreshBalance]
  );

  const claimWithdrawal = useCallback(
    async (withdrawalId: string): Promise<boolean> => {
      if (!isConnected || !publicKey) {
        setState((prev) => ({ ...prev, error: 'Please connect your wallet first' }));
        return false;
      }

      setState((prev) => ({ ...prev, isClaiming: true, error: null }));

      try {
        // Step 1: Get unsigned claim tx
        const { data: txData } = await axios.post(
          `${API_BASE_URL}/api/staking/claim`,
          { userAddress: publicKey, withdrawalId },
          { headers: getAuthHeaders() }
        );

        if (txData.xdr) {
          // Step 2: Sign and submit
          const signedXdr = await signTransaction(txData.xdr, txData.networkPassphrase);
          await axios.post(
            `${API_BASE_URL}/api/staking/submit`,
            { signedXdr },
            { headers: getAuthHeaders() }
          );
        }

        setState((prev) => ({ ...prev, isClaiming: false }));

        // Mark withdrawal as claimed in the backend DB
        try {
          await axios.post(
            `${API_BASE_URL}/api/staking/withdrawals/mark-claimed`,
            { wallet: publicKey, withdrawalId },
            { headers: getAuthHeaders() }
          );
        } catch {
          // Non-critical — UI will still remove it below
        }

        // Remove claimed withdrawal from local state immediately
        setPendingWithdrawals((prev) => prev.filter((w) => w.id !== withdrawalId));
        await refreshBalance();
        return true;
      } catch (err: unknown) {
        const message =
          axios.isAxiosError(err) && err.response?.data?.error
            ? err.response.data.error
            : err instanceof Error
              ? err.message
              : 'Claim failed';
        setState((prev) => ({ ...prev, isClaiming: false, error: message }));
        return false;
      }
    },
    [isConnected, publicKey, signTransaction, getAuthHeaders, refreshBalance]
  );

  const fetchPendingWithdrawals = useCallback(async () => {
    if (!publicKey) return;
    try {
      const { data } = await axios.get(
        `${API_BASE_URL}/api/staking/withdrawals/${publicKey}`,
        { headers: getAuthHeaders() }
      );
      setPendingWithdrawals(data.withdrawals || []);
    } catch {
      // Silently fail — withdrawals will show as empty
    }
  }, [publicKey, getAuthHeaders]);

  return {
    ...state,
    stake,
    unstake,
    claimWithdrawal,
    pendingWithdrawals,
    fetchPendingWithdrawals,
    clearError,
    balance,
    refreshBalance,
  };
}
