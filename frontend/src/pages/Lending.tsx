import { useState } from 'react';
import { Shield, AlertTriangle, TrendingUp, Zap } from 'lucide-react';
import { useWallet } from '../hooks/useWallet';
import { useLending } from '../hooks/useLending';
import { formatXLM } from '../utils/stellar';

export default function Lending() {
  const { isConnected, connect } = useWallet();
  const {
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
  } = useLending();

  const [activeTab, setActiveTab] = useState<'deposit' | 'withdraw' | 'borrow' | 'repay' | 'liquidate'>('deposit');
  const [amount, setAmount] = useState('');
  const [borrowerAddress, setBorrowerAddress] = useState('');

  const handleSubmit = async () => {
    clearError();

    if (activeTab === 'liquidate') {
      if (!borrowerAddress) return;
      const success = await liquidate(borrowerAddress);
      if (success) setBorrowerAddress('');
      return;
    }

    const val = parseFloat(amount);
    if (!val || val <= 0) return;

    let success = false;
    switch (activeTab) {
      case 'deposit':
        success = await depositCollateral(val);
        break;
      case 'withdraw':
        success = await withdrawCollateral(val);
        break;
      case 'borrow':
        success = await borrow(val);
        break;
      case 'repay':
        success = await repay(val);
        break;
    }
    if (success) setAmount('');
  };

  const buttonLabels = {
    deposit: 'Deposit Collateral',
    withdraw: 'Withdraw Collateral',
    borrow: 'Borrow XLM',
    repay: 'Repay Debt',
    liquidate: 'Liquidate Position',
  };

  return (
    <div className="max-w-4xl mx-auto px-4 space-y-6">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-white mb-2">Lending</h1>
        <p className="text-gray-400">Use sXLM as collateral to borrow XLM</p>
      </div>

      {isConnected && alert.riskLevel !== 'safe' && (
        <div
          className={`rounded-xl border p-4 ${
            alert.riskLevel === 'critical'
              ? 'bg-red-500/10 border-red-500/30'
              : 'bg-yellow-500/10 border-yellow-500/30'
          }`}
        >
          <div className="flex items-center gap-2">
            <AlertTriangle
              className={`w-4 h-4 ${alert.riskLevel === 'critical' ? 'text-red-400' : 'text-yellow-400'}`}
            />
            <p className={`text-sm font-semibold ${alert.riskLevel === 'critical' ? 'text-red-300' : 'text-yellow-300'}`}>
              {alert.riskLevel === 'critical' ? 'Critical lending risk' : 'Lending risk warning'}
            </p>
          </div>
          <p className={`mt-2 text-xs ${alert.riskLevel === 'critical' ? 'text-red-200' : 'text-yellow-200'}`}>
            {alert.recommendation} Current health factor: {alert.healthFactor.toFixed(2)}
          </p>
        </div>
      )}

      {/* Protocol Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Available Liquidity', value: formatXLM(stats.poolBalance) + ' XLM', highlight: true },
          { label: 'Total Collateral', value: formatXLM(stats.totalCollateral) + ' sXLM' },
          { label: 'Collateral Factor', value: (stats.collateralFactorBps / 100) + '%' },
          { label: 'Borrow Rate', value: (stats.borrowRateBps / 100) + '% APR' },
        ].map((stat) => (
          <div key={stat.label} className="glass rounded-xl p-4 text-center">
            <p className="text-xs text-gray-400">{stat.label}</p>
            <p className={`text-lg font-bold mt-1 ${stat.highlight ? 'text-yellow-400' : 'text-white'}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Position Card */}
        <div className="glass rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-yellow-400" />
            <h3 className="text-sm font-semibold text-white">Your Position</h3>
          </div>
          {isLoading ? (
            <p className="text-sm text-gray-400">Loading...</p>
          ) : (
            <div className="space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Collateral Deposited</span>
                <span className="text-white">{formatXLM(position.sxlmDeposited)} sXLM</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">XLM Borrowed</span>
                <span className="text-white">{formatXLM(position.xlmBorrowed)} XLM</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Health Factor</span>
                <span className={`font-bold ${
                  position.healthFactor > 1.5 ? 'text-green-400' :
                  position.healthFactor > 1.0 ? 'text-yellow-400' : 'text-red-400'
                }`}>
                  {position.healthFactor > 0 ? position.healthFactor.toFixed(2) : '\u2014'}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Max Borrow</span>
                <span className="text-white">{formatXLM(position.maxBorrow)} XLM</span>
              </div>
            </div>
          )}

          {position.healthFactor > 0 && position.healthFactor < 1.2 && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
              <AlertTriangle className="w-4 h-4 text-red-400" />
              <span className="text-xs text-red-400">
                Health factor is low. Consider repaying debt or adding collateral.
              </span>
            </div>
          )}
        </div>

        {/* Action Card */}
        <div className="glass rounded-2xl p-6 space-y-4">
          <div className="flex gap-1 bg-white/5 rounded-lg p-1">
            {(['deposit', 'withdraw', 'borrow', 'repay', 'liquidate'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => { setActiveTab(tab); setAmount(''); setBorrowerAddress(''); clearError(); }}
                className={`flex-1 py-2 rounded-md text-xs font-medium transition-all ${
                  activeTab === tab
                    ? 'bg-yellow-400/10 text-white border border-yellow-400/20'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                {tab === 'liquidate' ? (
                  <span className="flex items-center justify-center gap-1">
                    <Zap className="w-3 h-3" /> Liq.
                  </span>
                ) : (
                  tab.charAt(0).toUpperCase() + tab.slice(1)
                )}
              </button>
            ))}
          </div>

          {/* Step 1 reminder: must deposit before borrow/withdraw/repay */}
          {(activeTab === 'borrow' || activeTab === 'withdraw' || activeTab === 'repay') && position.sxlmDeposited === 0 && (
            <div className="rounded-lg p-3 text-xs" style={{ background: 'rgba(245,207,0,0.06)', border: '1px solid rgba(245,207,0,0.2)' }}>
              <p style={{ color: '#F5CF00' }} className="font-medium mb-1">Step 1 required: Deposit sXLM first</p>
              <p className="text-gray-400">You have no collateral deposited. Switch to the <strong className="text-white">Deposit</strong> tab, deposit your sXLM, then come back to borrow.</p>
            </div>
          )}

          {activeTab === 'liquidate' ? (
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Borrower Address to Liquidate</label>
              <input
                type="text"
                value={borrowerAddress}
                onChange={(e) => setBorrowerAddress(e.target.value)}
                placeholder="G..."
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500/50"
              />
              <p className="text-xs text-gray-500 mt-2">
                Liquidate positions with health factor below 1.0. You repay their debt and receive their collateral + 5% bonus.
              </p>
            </div>
          ) : (
            <div>
              <label className="text-xs text-gray-400 mb-1 block">
                {activeTab === 'deposit' || activeTab === 'withdraw' ? 'sXLM Amount' : 'XLM Amount'}
              </label>
              {activeTab === 'borrow' && position.maxBorrow > 0 && (
                <p className="text-xs text-gray-500 mb-1">Max: {position.maxBorrow.toFixed(4)} XLM</p>
              )}
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500/50"
              />
            </div>
          )}

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
              <p className="text-xs text-red-400">{error}</p>
            </div>
          )}

          {lastTxHash && (
            <div className={`rounded-lg p-3 space-y-1 ${isPending ? 'bg-yellow-500/10 border border-yellow-500/20' : 'bg-green-500/10 border border-green-500/20'}`}>
              <p className={`text-xs ${isPending ? 'text-yellow-400' : 'text-green-400'}`}>
                {isPending ? 'Transaction submitted — confirming on Stellar (may take a moment)' : 'Transaction successful!'}
              </p>
              <a
                href={`https://stellar.expert/explorer/public/tx/${lastTxHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-[10px] font-mono truncate"
                style={{ color: isPending ? '#F5CF00' : '#4ade80', opacity: 0.7 }}
              >
                {lastTxHash}
              </a>
            </div>
          )}

          {isConnected ? (
            <button
              onClick={handleSubmit}
              disabled={
                isSubmitting ||
                (activeTab === 'liquidate' ? !borrowerAddress : (!amount || parseFloat(amount) <= 0)) ||
                (['borrow', 'withdraw', 'repay'].includes(activeTab) && position.sxlmDeposited === 0)
              }
              className="w-full py-3 rounded-xl font-semibold hover:opacity-90 transition-opacity disabled:opacity-40 text-black" style={{ background: '#F5CF00' }}
            >
              {isSubmitting ? 'Processing...' : buttonLabels[activeTab]}
            </button>
          ) : (
            <button
              onClick={connect}
              className="w-full py-3 rounded-xl bg-gradient-to-r from-primary-500 to-accent-500 text-white font-semibold"
            >
              Connect Wallet
            </button>
          )}
        </div>
      </div>

      {/* Info */}
      <div className="glass rounded-2xl p-6 space-y-4">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-5 h-5 text-yellow-400" />
          <h3 className="text-sm font-semibold text-white">How Lending Works</h3>
        </div>
        <div className="space-y-3 text-sm text-gray-400">
          <p>1. Deposit sXLM as collateral into the lending contract.</p>
          <p>2. Borrow up to {stats.collateralFactorBps / 100}% of your collateral value in XLM.</p>
          <p>3. Your Health Factor must stay above 1.0 to avoid liquidation.</p>
          <p>4. Repay your borrowed XLM to unlock your sXLM collateral.</p>
          <p>5. Liquidators can repay unhealthy positions and receive collateral + 5% bonus.</p>
          <p className="text-xs text-gray-500">
            Liquidation threshold: {stats.liquidationThresholdBps / 100}%. Borrow rate: {stats.borrowRateBps / 100}% APR.
          </p>
        </div>
      </div>
    </div>
  );
}
