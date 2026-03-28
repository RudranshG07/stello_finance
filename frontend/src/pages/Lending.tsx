import { useState, useEffect } from 'react';
import { Shield, AlertTriangle, TrendingUp, Zap, ChevronDown } from 'lucide-react';
import { useWallet } from '../hooks/useWallet';
import { useLending } from '../hooks/useLending';
import { formatXLM } from '../utils/stellar';
import { CONTRACTS } from '../config/contracts';

// Known Stellar asset labels — extend as new collaterals are added.
const KNOWN_ASSET_LABELS: Record<string, string> = {
  [CONTRACTS.sxlmToken]: 'sXLM',
  ...(import.meta.env.VITE_USDC_SAC_CONTRACT_ID
    ? { [import.meta.env.VITE_USDC_SAC_CONTRACT_ID as string]: 'USDC' }
    : {}),
  ...(import.meta.env.VITE_EURC_SAC_CONTRACT_ID
    ? { [import.meta.env.VITE_EURC_SAC_CONTRACT_ID as string]: 'EURC' }
    : {}),
  ...(import.meta.env.VITE_YXLM_SAC_CONTRACT_ID
    ? { [import.meta.env.VITE_YXLM_SAC_CONTRACT_ID as string]: 'yXLM' }
    : {}),
};

function assetLabel(address: string): string {
  return KNOWN_ASSET_LABELS[address] ?? `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export default function Lending() {
  const { isConnected, connect } = useWallet();
  const {
    position,
    stats,
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
  // The currently selected collateral asset address for deposit/withdraw.
  const [selectedAsset, setSelectedAsset] = useState<string>('');

  // When supported assets load (or change), auto-select the first one.
  useEffect(() => {
    if (!selectedAsset && stats.supportedAssets.length > 0) {
      setSelectedAsset(stats.supportedAssets[0]);
    }
  }, [stats.supportedAssets, selectedAsset]);

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
        if (!selectedAsset) return;
        success = await depositCollateral(val, selectedAsset);
        break;
      case 'withdraw':
        if (!selectedAsset) return;
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

  // Total collateral deposited (across all assets) — used for "step 1" guard.
  const totalCollateralValue = position.collateralValueXlm;
  const hasCollateral = totalCollateralValue > 0;

  // Health factor is mathematically ∞ when there is no debt.
  // Backends often return Number.MAX_SAFE_INTEGER (9007199254740991) as a sentinel — always
  // override with ∞ when borrowed is 0 so the UI never looks broken.
  const hasDebt = position.xlmBorrowed > 0;
  const displayHealthFactor = !hasDebt
    ? '∞'
    : Number.isFinite(position.healthFactor) && position.healthFactor > 0
      ? position.healthFactor.toFixed(2)
      : '—';
  const healthFactorColor = !hasDebt
    ? 'text-green-400'
    : position.healthFactor > 1.5
      ? 'text-green-400'
      : position.healthFactor > 1.0
        ? 'text-yellow-400'
        : 'text-red-400';

  // Amount deposited for the currently selected asset.
  const selectedAssetEntry = position.collaterals.find((c) => c.asset === selectedAsset);
  const selectedAssetDeposited = selectedAssetEntry?.amount ?? 0;

  // Aggregate stats for the header card (sum of all per-asset totals).
  const totalDeposited = stats.assetStats.reduce((s, a) => s + a.totalDeposited, 0);

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
          { label: 'Total Collateral (XLM eq.)', value: formatXLM(totalDeposited) },
          { label: 'Total Borrowed', value: formatXLM(stats.totalBorrowed) + ' XLM' },
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
              {/* Per-asset collateral breakdown */}
              {position.collaterals.length > 0 ? (
                <div className="space-y-1">
                  <p className="text-xs text-gray-400 mb-1">Collateral Deposited</p>
                  {position.collaterals.map((entry) => (
                    <div key={entry.asset} className="flex justify-between text-sm">
                      <span className="text-gray-400 pl-2">{assetLabel(entry.asset)}</span>
                      <span className="text-white">{entry.amount.toFixed(4)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Collateral Deposited</span>
                  <span className="text-white">—</span>
                </div>
              )}

              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Collateral Value (XLM)</span>
                <span className="text-white">{formatXLM(position.collateralValueXlm)} XLM</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">XLM Borrowed</span>
                <span className="text-white">{formatXLM(position.xlmBorrowed)} XLM</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Health Factor</span>
                <span className={`font-bold ${healthFactorColor}`}>
                  {displayHealthFactor}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Max Borrow</span>
                <span className="text-white">{formatXLM(position.maxBorrow)} XLM</span>
              </div>
            </div>
          )}

          {hasDebt && position.healthFactor > 0 && position.healthFactor < 1.2 && (
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
          {(activeTab === 'borrow' || activeTab === 'withdraw' || activeTab === 'repay') && !hasCollateral && (
            <div className="rounded-lg p-3 text-xs" style={{ background: 'rgba(245,207,0,0.06)', border: '1px solid rgba(245,207,0,0.2)' }}>
              <p style={{ color: '#F5CF00' }} className="font-medium mb-1">Step 1 required: Deposit collateral first</p>
              <p className="text-gray-400">You have no collateral deposited. Switch to the <strong className="text-white">Deposit</strong> tab, deposit a supported asset, then come back to borrow.</p>
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
            <div className="space-y-3">
              {/* Collateral asset selector — only for deposit / withdraw */}
              {(activeTab === 'deposit' || activeTab === 'withdraw') && (
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Collateral Asset</label>
                  {stats.supportedAssets.length === 0 ? (
                    <p className="text-xs text-gray-500">Loading supported assets…</p>
                  ) : (
                    <div className="relative">
                      <select
                        value={selectedAsset}
                        onChange={(e) => setSelectedAsset(e.target.value)}
                        className="w-full appearance-none bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-yellow-400/50 pr-10"
                      >
                        {stats.supportedAssets.map((addr) => (
                          <option key={addr} value={addr} className="bg-gray-900">
                            {assetLabel(addr)}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    </div>
                  )}
                  {activeTab === 'withdraw' && selectedAssetDeposited > 0 && (
                    <p className="text-xs text-gray-500 mt-1">
                      Deposited: {selectedAssetDeposited.toFixed(4)} {assetLabel(selectedAsset)}
                    </p>
                  )}
                  {/* Per-asset risk params hint */}
                  {selectedAsset && (() => {
                    const stat = stats.assetStats.find((s) => s.asset === selectedAsset);
                    if (!stat) return null;
                    return (
                      <p className="text-xs text-gray-500 mt-1">
                        Collateral factor: {stat.collateralFactorBps / 100}% &bull; Liq. threshold: {stat.liquidationThresholdBps / 100}%
                      </p>
                    );
                  })()}
                </div>
              )}

              <div>
                <label className="text-xs text-gray-400 mb-1 block">
                  {activeTab === 'deposit' || activeTab === 'withdraw'
                    ? `${assetLabel(selectedAsset)} Amount`
                    : 'XLM Amount'}
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
                (activeTab === 'liquidate'
                  ? !borrowerAddress
                  : (!amount || parseFloat(amount) <= 0) ||
                    ((activeTab === 'deposit' || activeTab === 'withdraw') && !selectedAsset)) ||
                (['borrow', 'withdraw', 'repay'].includes(activeTab) && !hasCollateral)
              }
              className="w-full py-3 rounded-xl font-semibold hover:opacity-90 transition-opacity disabled:opacity-40 text-black"
              style={{ background: '#F5CF00' }}
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

      {/* Per-asset risk parameters table */}
      {stats.assetStats.length > 0 && (
        <div className="glass rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-yellow-400" />
            <h3 className="text-sm font-semibold text-white">Supported Collateral Assets</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 text-xs border-b border-white/10">
                  <th className="text-left pb-2">Asset</th>
                  <th className="text-right pb-2">Total Deposited</th>
                  <th className="text-right pb-2">Collateral Factor</th>
                  <th className="text-right pb-2">Liq. Threshold</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {stats.assetStats.map((a) => (
                  <tr key={a.asset}>
                    <td className="py-2 text-white font-medium">{assetLabel(a.asset)}</td>
                    <td className="py-2 text-right text-gray-300">{a.totalDeposited.toFixed(4)}</td>
                    <td className="py-2 text-right text-gray-300">{(a.collateralFactorBps / 100).toFixed(1)}%</td>
                    <td className="py-2 text-right text-gray-300">{(a.liquidationThresholdBps / 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Info */}
      <div className="glass rounded-2xl p-6 space-y-4">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-5 h-5 text-yellow-400" />
          <h3 className="text-sm font-semibold text-white">How Lending Works</h3>
        </div>
        <div className="space-y-3 text-sm text-gray-400">
          <p>1. Deposit a supported collateral asset (sXLM, USDC, EURC, yXLM) into the lending contract.</p>
          <p>2. Borrow XLM up to your collateral-factor-weighted collateral value.</p>
          <p>3. Your Health Factor must stay above 1.0 to avoid liquidation.</p>
          <p>4. Repay your borrowed XLM to unlock your collateral.</p>
          <p>5. Liquidators can repay unhealthy positions and receive collateral + 5% bonus.</p>
          <p className="text-xs text-gray-500">
            Borrow rate: {stats.borrowRateBps / 100}% APR. Each collateral asset has its own collateral factor and liquidation threshold.
          </p>
        </div>
      </div>
    </div>
  );
}
