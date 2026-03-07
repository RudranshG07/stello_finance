import { useState, useEffect } from 'react';
import axios from '../lib/apiClient';
import { useWallet } from '../hooks/useWallet';
import { useStaking } from '../hooks/useStaking';
import { useProtocol } from '../hooks/useProtocol';
import { API_BASE_URL } from '../config/contracts';

export default function WithdrawCard() {
  const { isConnected, connect, publicKey, signTransaction } = useWallet();
  const { unstake, claimWithdrawal, isUnstaking, isClaiming, pendingWithdrawals, fetchPendingWithdrawals, error, clearError, balance, refreshBalance } = useStaking();
  const { stats } = useProtocol();
  const [sxlmAmount, setSxlmAmount] = useState('');
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreSuccess, setRestoreSuccess] = useState(false);
  const [txSuccess, setTxSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (isConnected && publicKey) {
      fetchPendingWithdrawals();
    }
  }, [isConnected, publicKey, fetchPendingWithdrawals]);

  const isArchived = (balance as { archived?: boolean }).archived === true
    || (error?.includes('ENTRY_ARCHIVED') ?? false)
    || (error?.includes('expired') ?? false);

  const xlmReceive = sxlmAmount
    ? (parseFloat(sxlmAmount) * stats.exchangeRate).toFixed(4)
    : '0.0000';

  const handleUnstake = async () => {
    if (!sxlmAmount || parseFloat(sxlmAmount) <= 0) return;
    clearError();
    setRestoreError(null);
    setTxSuccess(null);
    const success = await unstake(parseFloat(sxlmAmount));
    if (success) {
      setSxlmAmount('');
      setTxSuccess(`Withdrawal of ${sxlmAmount} sXLM requested. It will appear in your pending withdrawals below.`);
      await fetchPendingWithdrawals();
    }
  };

  const handleRestore = async () => {
    if (!publicKey) return;
    setIsRestoring(true);
    setRestoreError(null);
    setRestoreSuccess(false);
    try {
      const { data } = await axios.post(`${API_BASE_URL}/api/staking/restore-balance`, {
        userAddress: publicKey,
      });
      const signedXdr = await signTransaction(data.xdr, data.networkPassphrase);
      await axios.post(`${API_BASE_URL}/api/staking/submit`, { signedXdr });
      setRestoreSuccess(true);
      await refreshBalance();
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err) && err.response?.data?.error
        ? err.response.data.error
        : err instanceof Error ? err.message : 'Restore failed';
      setRestoreError(msg);
    } finally {
      setIsRestoring(false);
    }
  };

  return (
    <div className="card p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Withdraw</h3>
        {isConnected && balance.sxlmBalance > 0 && (
          <span className="text-[10px]" style={{ color: '#525252' }}>
            Balance: <span className="text-neutral-400">{balance.sxlmBalance.toFixed(4)} sXLM</span>
          </span>
        )}
      </div>

      <div>
        <div className="flex justify-between items-center mb-1">
          <label className="label mb-0">You burn (sXLM)</label>
          {isConnected && balance.sxlmBalance > 0 && (
            <button
              onClick={() => setSxlmAmount(balance.sxlmBalance.toFixed(7))}
              className="text-[10px] transition-colors"
              style={{ color: '#525252' }}
              onMouseEnter={(e) => (e.currentTarget.style.color = '#F5CF00')}
              onMouseLeave={(e) => (e.currentTarget.style.color = '#525252')}
            >
              MAX
            </button>
          )}
        </div>
        <input
          type="number"
          value={sxlmAmount}
          onChange={(e) => setSxlmAmount(e.target.value)}
          placeholder="0.00"
          max={balance.sxlmBalance}
          className="input font-mono text-lg"
        />
      </div>

      <div className="flex items-center justify-center gap-3 text-neutral-700 text-xs">
        <div className="flex-1 h-px bg-border" />
        <span>becomes</span>
        <div className="flex-1 h-px bg-border" />
      </div>

      <div
        className="rounded-lg p-4"
        style={{ background: '#080808', border: '1px solid #1e1e1e' }}
      >
        <p className="label">You receive (XLM)</p>
        <p className="font-mono text-xl font-semibold" style={{ color: '#F5CF00' }}>
          {xlmReceive}
        </p>
      </div>

      <div className="flex gap-3 text-xs" style={{ color: '#525252' }}>
        <div className="flex-1 rounded-lg p-3" style={{ border: '1px solid #1e1e1e' }}>
          <p className="text-neutral-400 font-medium">Instant</p>
          <p className="text-[10px] mt-0.5">If buffer available</p>
        </div>
        <div className="flex-1 rounded-lg p-3" style={{ border: '1px solid #1e1e1e' }}>
          <p className="text-neutral-400 font-medium">Delayed</p>
          <p className="text-[10px] mt-0.5">~24h cooldown</p>
        </div>
      </div>

      {/* Archived / TTL expired banner */}
      {isConnected && isArchived && !restoreSuccess && (
        <div className="banner-warning space-y-3">
          <p className="text-xs" style={{ color: '#ccc' }}>
            Your sXLM balance entry expired on testnet (TTL). Sign a free restore transaction to recover it.
          </p>
          {restoreError && <p className="text-xs text-red-400">{restoreError}</p>}
          <button
            onClick={handleRestore}
            disabled={isRestoring}
            className="w-full btn text-sm"
          >
            {isRestoring ? 'Restoring...' : 'Restore Balance'}
          </button>
        </div>
      )}

      {restoreSuccess && (
        <div className="banner-success">
          <p className="text-xs text-green-400">Balance restored. You can now withdraw.</p>
        </div>
      )}

      {txSuccess && (
        <div className="banner-success">
          <p className="text-xs text-green-400">{txSuccess}</p>
        </div>
      )}

      {error && !isArchived && (
        <div className="banner-error">
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}

      {isConnected ? (
        <button
          onClick={handleUnstake}
          disabled={isUnstaking || !sxlmAmount || parseFloat(sxlmAmount) <= 0 || isArchived}
          className="w-full btn"
        >
          {isUnstaking ? 'Processing...' : 'Unstake sXLM'}
        </button>
      ) : (
        <button onClick={connect} className="w-full btn">Connect Wallet</button>
      )}

      {pendingWithdrawals.length > 0 && (
        <div className="pt-4" style={{ borderTop: '1px solid #1e1e1e' }}>
          <h4 className="text-xs font-medium mb-3" style={{ color: '#525252' }}>Pending Withdrawals</h4>
          <div className="space-y-2">
            {pendingWithdrawals.map((w: { id: string; amount: string; unlockTime: string; status: string }) => {
              const ready = new Date(w.unlockTime) <= new Date();
              return (
                <div
                  key={w.id}
                  className="flex items-center justify-between rounded-lg p-3"
                  style={{ background: '#080808', border: '1px solid #1e1e1e' }}
                >
                  <div>
                    <p className="text-sm text-white">{(Number(w.amount) / 1e7).toFixed(2)} sXLM</p>
                    <p className="text-[10px] mt-0.5 text-neutral-500">
                      ≈ {(Number(w.amount) / 1e7 * stats.exchangeRate).toFixed(2)} XLM
                    </p>
                    <p className="text-[10px] mt-0.5" style={{ color: ready ? '#F5CF00' : '#525252' }}>
                      {ready ? 'Ready to claim' : `Unlocks ${new Date(w.unlockTime).toLocaleDateString()}`}
                    </p>
                  </div>
                  <button
                    onClick={() => claimWithdrawal(w.id)}
                    disabled={isClaiming || !ready}
                    className="btn-outline text-xs px-3 py-1.5"
                    style={{ fontSize: '11px' }}
                  >
                    {isClaiming ? '...' : 'Claim'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
