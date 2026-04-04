import { useState } from 'react';
import { useWallet } from '../hooks/useWallet';
import { useStaking } from '../hooks/useStaking';
import { useProtocol } from '../hooks/useProtocol';
import { formatAPY } from '../utils/stellar';
import { NETWORK } from '../config/contracts';

export default function StakeCard() {
  const { isConnected, connect, publicKey } = useWallet();
  const { stake, isStaking, isPending, error, lastTxHash, clearError, balance } = useStaking();
  const { stats, apy } = useProtocol();
  const [xlmAmount, setXlmAmount] = useState('');

  // Bakiye kontrolü
  const userBalance = balance?.xlmNativeBalance || 0;
  const isInsufficient = parseFloat(xlmAmount) > userBalance;

  const sxlmReceive = xlmAmount
    ? (parseFloat(xlmAmount) / stats.exchangeRate).toFixed(4)
    : '0.0000';

  const handleStake = async () => {
    if (!xlmAmount || parseFloat(xlmAmount) <= 0 || isInsufficient) return;
    clearError();
    const success = await stake(parseFloat(xlmAmount));
    if (success) setXlmAmount('');
  };

  const handleMaxClick = () => {
    // Stellar ağında işlem ücreti için bir miktar (örn: 1 XLM) bırakmak güvenlidir
    const maxSafeAmount = Math.max(0, userBalance - 1); 
    setXlmAmount(maxSafeAmount.toString());
  };

  return (
    <div className="card p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Stake XLM</h3>
        <span className="tag-yellow">
          {formatAPY(apy.currentApr)} APR
        </span>
      </div>

      <div className="space-y-2">
        <div className="flex justify-between items-end">
          <label className="label">You stake (XLM)</label>
          {isConnected && (
            <button 
              onClick={handleMaxClick}
              className="text-[10px] text-yellow-500 hover:text-yellow-400 font-bold uppercase tracking-wider"
            >
              Max: {userBalance.toFixed(2)}
            </button>
          )}
        </div>
        <input
          type="number"
          value={xlmAmount}
          onChange={(e) => setXlmAmount(e.target.value)}
          placeholder="0.00"
          className={`input font-mono text-lg ${isInsufficient ? 'border-red-500 focus:border-red-500' : ''}`}
        />
        {isInsufficient && (
          <p className="text-[10px] text-red-400 mt-1">Insufficient XLM balance</p>
        )}
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
        <p className="label">You receive (sXLM)</p>
        <p className="font-mono text-xl font-semibold" style={{ color: '#F5CF00' }}>
          {sxlmReceive}
        </p>
      </div>

      <div className="space-y-1.5 text-xs px-1" style={{ color: '#525252' }}>
        <div className="flex justify-between">
          <span>Exchange Rate</span>
          <span className="text-neutral-400">1 sXLM = {stats.exchangeRate.toFixed(4)} XLM</span>
        </div>
        <div className="flex justify-between">
          <span>30d APY</span>
          <span className="text-neutral-400">{formatAPY(apy.apy30d)}</span>
        </div>
      </div>

      {error && (
        <div className="banner-error space-y-2">
          <p className="text-xs text-red-400">{error}</p>
          {error.toLowerCase().includes('friendbot') && publicKey && (
            <a
              href={`${NETWORK.friendbotUrl}?addr=${publicKey}`}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-center text-xs underline"
              style={{ color: '#F5CF00' }}
            >
              Fund your testnet account via Friendbot →
            </a>
          )}
        </div>
      )}

      {lastTxHash && (
        <div className={isPending ? "banner-warning space-y-1" : "banner-success space-y-1"}>
          <p className={`text-xs ${isPending ? 'text-yellow-400' : 'text-green-400'}`}>
            {isPending
              ? 'Transaction submitted — confirming on Stellar'
              : 'Staked successfully — sXLM minted'}
          </p>
        </div>
      )}

      {isConnected ? (
        <button
          onClick={handleStake}
          disabled={isStaking || !xlmAmount || parseFloat(xlmAmount) <= 0 || isInsufficient}
          className={`w-full btn ${isStaking ? 'opacity-70 cursor-not-allowed' : ''}`}
        >
          {isStaking ? 'Processing...' : isInsufficient ? 'Insufficient Balance' : 'Stake XLM'}
        </button>
      ) : (
        <button onClick={connect} className="w-full btn">
          Connect Wallet to Stake
        </button>
      )}
    </div>
  );
}
