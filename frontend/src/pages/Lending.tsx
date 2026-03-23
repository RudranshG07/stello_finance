import { useState } from 'react';
import { Shield, AlertTriangle, TrendingUp, Zap, ChevronDown } from 'lucide-react';
import { useWallet } from '../hooks/useWallet';
import { useLending } from '../hooks/useLending';
import { formatXLM } from '../utils/stellar';

export default function Lending() {
  const { isConnected, connect } = useWallet();
  const {
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
  } = useLending();

  const [activeTab, setActiveTab] = useState<'deposit' | 'withdraw' | 'borrow' | 'repay' | 'liquidate'>('deposit');
  const [amount, setAmount] = useState('');
  const [borrowerAddress, setBorrowerAddress] = useState('');
  const [liquidateAsset, setLiquidateAsset] = useState('');

  const selectedAssetMeta = supportedAssets.find((a) => a.contractId === selectedAsset);
  const selectedAssetCfBps = selectedAssetMeta?.collateralFactorBps ?? stats.collateralFactorBps;

  const handleSubmit = async () => {
    clearError();

    if (activeTab === 'liquidate') {
      if (!borrowerAddress) return;
      const success = await liquidate(borrowerAddress, liquidateAsset || undefined);
      if (success) { setBorrowerAddress(''); setLiquidateAsset(''); }
      return;
    }

    const val = parseFloat(amount);
    if (!val || val <= 0) return;

    let success = false;
    switch (activeTab) {
      case 'deposit':
        success = await depositCollateral(val, selectedAsset);
        break;
      case 'withdraw':
        success = await withdrawCollateral(val, selectedAsset);
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

  const hasCollateral = position.totalCollateralXlm > 0;

  return (
    <div className="max-w-4xl mx-auto px-4 space-y-6">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-white mb-2">Lending</h1>
        <p className="text-gray-400">Deposit multi-asset collateral to borrow XLM</p>
      </div>

      {/* Protocol Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Available Liquidity', value: formatXLM(stats.poolBalance) + ' XLM', highlight: true },
          { label: 'Total Collateral (XLM)', value: formatXLM(stats.totalCollateral) + ' XLM' },
          { label: 'Utilization', value: (stats.utilizationRate * 100).toFixed(1) + '%' },
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
                <span className="text-gray-400">Total Collateral Value</span>
                <span className="text-white">{formatXLM(position.totalCollateralXlm)} XLM</span>
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

              {/* Per-asset breakdown */}
              {position.assetPositions.filter((a) => a.amountDeposited > 0).length > 0 && (
                <div className="pt-2 border-t border-white/10 space-y-2">
                  <p className="text-xs text-gray-500 uppercase tracking-wide">Deposited Assets</p>
                  {position.assetPositions
                    .filter((a) => a.amountDeposited > 0)
                    .map((ap) => (
                      <div key={ap.contractId} className="flex justify-between text-xs">
                        <span className="text-gray-400">
                          {ap.symbol}
                          <span className="ml-1 text-gray-600">CF {(ap.collateralFactorBps / 100).toFixed(0)}%</span>
                        </span>
                        <span className="text-white">
                          {formatXLM(ap.amountDeposited)} {ap.symbol}
                          <span className="ml-1 text-gray-500">(≈{formatXLM(ap.xlmValue)} XLM)</span>
                        </span>
                      </div>
                    ))}
                </div>
              )}
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
          {/* Tab bar */}
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

          {/* Asset selector — shown for deposit and withdraw */}
          {(activeTab === 'deposit' || activeTab === 'withdraw') && supportedAssets.length > 1 && (
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Collateral Asset</label>
              <div className="relative">
                <select
                  value={selectedAsset}
                  onChange={(e) => setSelectedAsset(e.target.value)}
                  className="w-full appearance-none bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-yellow-400/50 pr-10"
                >
                  {supportedAssets.map((a) => (
                    <option key={a.contractId} value={a.contractId} style={{ background: '#1a1a2e' }}>
                      {a.symbol} — CF {(a.collateralFactorBps / 100).toFixed(0)}% / LT {(a.liquidationThresholdBps / 100).toFixed(0)}%
                    </option>
                  ))}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              </div>
            </div>
          )}

          {/* Step reminder */}
          {(activeTab === 'borrow' || activeTab === 'withdraw' || activeTab === 'repay') && !hasCollateral && (
            <div className="rounded-lg p-3 text-xs" style={{ background: 'rgba(245,207,0,0.06)', border: '1px solid rgba(245,207,0,0.2)' }}>
              <p style={{ color: '#F5CF00' }} className="font-medium mb-1">Step 1 required: Deposit collateral first</p>
              <p className="text-gray-400">Switch to the <strong className="text-white">Deposit</strong> tab, choose an asset, and deposit it as collateral.</p>
            </div>
          )}

          {activeTab === 'liquidate' ? (
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-400 mb-1 block">Borrower Address</label>
                <input
                  type="text"
                  value={borrowerAddress}
                  onChange={(e) => setBorrowerAddress(e.target.value)}
                  placeholder="G..."
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500/50"
                />
              </div>
              {supportedAssets.length > 1 && (
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Collateral Asset to Seize</label>
                  <div className="relative">
                    <select
                      value={liquidateAsset}
                      onChange={(e) => setLiquidateAsset(e.target.value)}
                      className="w-full appearance-none bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-yellow-400/50 pr-10"
                    >
                      <option value="" style={{ background: '#1a1a2e' }}>Default (sXLM)</option>
                      {supportedAssets.map((a) => (
                        <option key={a.contractId} value={a.contractId} style={{ background: '#1a1a2e' }}>
                          {a.symbol}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                  </div>
                </div>
              )}
              <p className="text-xs text-gray-500">
                Liquidate positions with health factor below 1.0. You repay their XLM debt and receive their collateral + 5% bonus.
              </p>
            </div>
          ) : (
            <div>
              <label className="text-xs text-gray-400 mb-1 block">
                {activeTab === 'deposit' || activeTab === 'withdraw'
                  ? `${selectedAssetMeta?.symbol ?? 'Asset'} Amount`
                  : 'XLM Amount'}
              </label>
              {activeTab === 'borrow' && position.maxBorrow > 0 && (
                <p className="text-xs text-gray-500 mb-1">Max: {position.maxBorrow.toFixed(4)} XLM</p>
              )}
              {(activeTab === 'deposit' || activeTab === 'withdraw') && selectedAssetMeta && (
                <p className="text-xs text-gray-500 mb-1">
                  CF {(selectedAssetCfBps / 100).toFixed(0)}% · Price ≈ {selectedAssetMeta.priceInXlm.toFixed(4)} XLM
                </p>
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
                {isPending ? 'Transaction submitted — confirming on Stellar…' : 'Transaction successful!'}
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
                (activeTab === 'liquidate'
                  ? !borrowerAddress
                  : !amount || parseFloat(amount) <= 0) ||
                (['borrow', 'withdraw', 'repay'].includes(activeTab) && !hasCollateral)
              }
              className="w-full py-3 rounded-xl font-semibold hover:opacity-90 transition-opacity disabled:opacity-40 text-black"
              style={{ background: '#F5CF00' }}
            >
              {isSubmitting ? 'Processing…' : buttonLabels[activeTab]}
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

      {/* Supported assets info */}
      {supportedAssets.length > 0 && (
        <div className="glass rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-yellow-400" />
            <h3 className="text-sm font-semibold text-white">Supported Collateral Assets</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b border-white/10">
                  <th className="text-left pb-2">Asset</th>
                  <th className="text-right pb-2">Price (XLM)</th>
                  <th className="text-right pb-2">Collateral Factor</th>
                  <th className="text-right pb-2">Liq. Threshold</th>
                  <th className="text-right pb-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {supportedAssets.map((a) => (
                  <tr key={a.contractId}>
                    <td className="py-2 text-white font-medium">{a.symbol}</td>
                    <td className="py-2 text-right text-gray-300">{a.priceInXlm.toFixed(4)}</td>
                    <td className="py-2 text-right text-gray-300">{(a.collateralFactorBps / 100).toFixed(0)}%</td>
                    <td className="py-2 text-right text-gray-300">{(a.liquidationThresholdBps / 100).toFixed(0)}%</td>
                    <td className="py-2 text-right">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${a.enabled ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-500'}`}>
                        {a.enabled ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* How it works */}
      <div className="glass rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-semibold text-white">How Multi-Asset Lending Works</h3>
        <div className="space-y-2 text-sm text-gray-400">
          <p>1. Deposit any supported asset (sXLM, USDC, EURC, yXLM) as collateral.</p>
          <p>2. Each asset has its own Collateral Factor — higher-quality assets earn higher LTV.</p>
          <p>3. Your total borrow capacity is the weighted sum across all deposited assets.</p>
          <p>4. Health Factor must stay above 1.0 across your full portfolio to avoid liquidation.</p>
          <p>5. Liquidators can choose which collateral asset to seize when repaying your debt.</p>
          <p className="text-xs text-gray-500">
            Borrow rate: {stats.borrowRateBps / 100}% APR · Liquidation bonus: 5%.
          </p>
        </div>
      </div>
    </div>
  );
}
