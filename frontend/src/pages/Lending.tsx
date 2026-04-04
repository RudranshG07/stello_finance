import { useState } from 'react';
import { Shield, AlertTriangle, TrendingUp, Zap, ChevronDown } from 'lucide-react';
import { useWallet } from '../hooks/useWallet';
import { useLending } from '../hooks/useLending';
import { SUPPORTED_COLLATERAL_ASSETS } from '../config/contracts';
import { formatXLM } from '../utils/stellar';

type Tab = 'deposit' | 'withdraw' | 'borrow' | 'repay' | 'liquidate';

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

  const [activeTab, setActiveTab] = useState<Tab>('deposit');
  const [amount, setAmount] = useState('');
  const [borrowerAddress, setBorrowerAddress] = useState('');

  // Asset selected for deposit / withdraw / liquidate
  const [selectedAsset, setSelectedAsset] = useState(SUPPORTED_COLLATERAL_ASSETS[0].contractId);
  // Asset the liquidator wants to seize
  const [seizeAsset, setSeizeAsset] = useState(SUPPORTED_COLLATERAL_ASSETS[0].contractId);

  const selectedAssetMeta = SUPPORTED_COLLATERAL_ASSETS.find(
    (a) => a.contractId === selectedAsset
  ) ?? SUPPORTED_COLLATERAL_ASSETS[0];

  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab);
    setAmount('');
    setBorrowerAddress('');
    clearError();
  };

  const handleSubmit = async () => {
    clearError();

    if (activeTab === 'liquidate') {
      if (!borrowerAddress) return;
      const success = await liquidate(borrowerAddress, seizeAsset);
      if (success) setBorrowerAddress('');
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

  const buttonLabels: Record<Tab, string> = {
    deposit: `Deposit ${selectedAssetMeta.symbol}`,
    withdraw: `Withdraw ${selectedAssetMeta.symbol}`,
    borrow: 'Borrow XLM',
    repay: 'Repay Debt',
    liquidate: 'Liquidate Position',
  };

  const hasAnyCollateral = position.collateralAssets.length > 0;

  // Find the per-asset position for the selected asset (for withdraw UI)
  const selectedAssetPosition = position.collateralAssets.find(
    (a) => a.assetAddress === selectedAsset
  );

  return (
    <div className="max-w-4xl mx-auto px-4 space-y-6">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-white mb-2">Lending</h1>
        <p className="text-gray-400">Deposit multi-asset collateral to borrow XLM</p>
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
              className={`w-4 h-4 ${
                alert.riskLevel === 'critical' ? 'text-red-400' : 'text-yellow-400'
              }`}
            />
            <p
              className={`text-sm font-semibold ${
                alert.riskLevel === 'critical' ? 'text-red-300' : 'text-yellow-300'
              }`}
            >
              {alert.riskLevel === 'critical' ? 'Critical lending risk' : 'Lending risk warning'}
            </p>
          </div>
          <p
            className={`mt-2 text-xs ${
              alert.riskLevel === 'critical' ? 'text-red-200' : 'text-yellow-200'
            }`}
          >
            {alert.recommendation} Current health factor:{' '}
            {alert.healthFactor.toFixed(2)}
          </p>
        </div>
      )}

      {/* Protocol Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          {
            label: 'Available Liquidity',
            value: formatXLM(stats.poolBalance) + ' XLM',
            highlight: true,
          },
          {
            label: 'Total Collateral (XLM)',
            value: formatXLM(stats.totalCollateralValueXlm) + ' XLM',
          },
          {
            label: 'Assets Supported',
            value: stats.assets.length > 0 ? stats.assets.length.toString() : '—',
          },
          {
            label: 'Borrow Rate',
            value: (stats.borrowRateBps / 100).toFixed(2) + '% APR',
          },
        ].map((stat) => (
          <div key={stat.label} className="glass rounded-xl p-4 text-center">
            <p className="text-xs text-gray-400">{stat.label}</p>
            <p
              className={`text-lg font-bold mt-1 ${
                stat.highlight ? 'text-yellow-400' : 'text-white'
              }`}
            >
              {stat.value}
            </p>
          </div>
        ))}
      </div>

      {/* Per-asset collateral stats */}
      {stats.assets.length > 0 && (
        <div className="glass rounded-2xl p-4">
          <p className="text-xs text-gray-400 mb-3 font-medium">Collateral Markets</p>
          <div className="space-y-2">
            {stats.assets.map((asset) => (
              <div
                key={asset.assetAddress}
                className="flex items-center justify-between text-sm"
              >
                <span className="text-white font-medium w-16">{asset.symbol}</span>
                <span className="text-gray-400 flex-1 px-2">
                  {formatXLM(asset.totalCollateral)} deposited
                </span>
                <span className="text-gray-400 w-20 text-right">
                  CF {(asset.collateralFactorBps / 100).toFixed(0)}%
                </span>
                <span className="text-gray-400 w-24 text-right">
                  LT {(asset.liquidationThresholdBps / 100).toFixed(0)}%
                </span>
                <span className="text-gray-500 w-28 text-right text-xs">
                  {asset.priceInXlm.toFixed(4)} XLM
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

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
              {/* Multi-asset collateral breakdown */}
              {position.collateralAssets.length > 0 ? (
                <div>
                  <p className="text-xs text-gray-400 mb-2">Collateral Deposited</p>
                  <div className="space-y-2">
                    {position.collateralAssets.map((asset) => {
                      const meta = SUPPORTED_COLLATERAL_ASSETS.find(
                        (a) => a.contractId === asset.assetAddress
                      );
                      return (
                        <div
                          key={asset.assetAddress}
                          className="flex justify-between items-center text-sm"
                        >
                          <span className="flex items-center gap-2">
                            <span
                              className="w-2 h-2 rounded-full inline-block"
                              style={{ background: meta?.color ?? '#888' }}
                            />
                            <span className="text-gray-300">{asset.symbol}</span>
                          </span>
                          <span className="text-white">
                            {formatXLM(asset.amount)} {asset.symbol}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-2 pt-2 border-t border-white/10 flex justify-between text-xs text-gray-400">
                    <span>Total value</span>
                    <span className="text-white font-medium">
                      {formatXLM(position.totalCollateralValueXlm)} XLM
                    </span>
                  </div>
                </div>
              ) : (
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Collateral Deposited</span>
                  <span className="text-gray-500">—</span>
                </div>
              )}

              <div className="flex justify-between text-sm">
                <span className="text-gray-400">XLM Borrowed</span>
                <span className="text-white">{formatXLM(position.xlmBorrowed)} XLM</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Health Factor</span>
                <span
                  className={`font-bold ${
                    position.healthFactor > 1.5
                      ? 'text-green-400'
                      : position.healthFactor > 1.0
                        ? 'text-yellow-400'
                        : 'text-red-400'
                  }`}
                >
                  {position.healthFactor > 0 ? position.healthFactor.toFixed(2) : '—'}
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
          {/* Tabs */}
          <div className="flex gap-1 bg-white/5 rounded-lg p-1">
            {(['deposit', 'withdraw', 'borrow', 'repay', 'liquidate'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => handleTabChange(tab)}
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

          {/* Step 1 reminder */}
          {(activeTab === 'borrow' || activeTab === 'withdraw' || activeTab === 'repay') &&
            !hasAnyCollateral && (
              <div
                className="rounded-lg p-3 text-xs"
                style={{
                  background: 'rgba(245,207,0,0.06)',
                  border: '1px solid rgba(245,207,0,0.2)',
                }}
              >
                <p style={{ color: '#F5CF00' }} className="font-medium mb-1">
                  Step 1 required: Deposit collateral first
                </p>
                <p className="text-gray-400">
                  You have no collateral deposited. Switch to the{' '}
                  <strong className="text-white">Deposit</strong> tab, choose an asset, and
                  deposit before borrowing.
                </p>
              </div>
            )}

          {/* Asset selector — shown for deposit, withdraw, and liquidate (seize asset) */}
          {(activeTab === 'deposit' ||
            activeTab === 'withdraw' ||
            activeTab === 'liquidate') && (
            <div>
              <label className="text-xs text-gray-400 mb-1 block">
                {activeTab === 'liquidate' ? 'Collateral Asset to Seize' : 'Collateral Asset'}
              </label>
              <div className="relative">
                <select
                  value={activeTab === 'liquidate' ? seizeAsset : selectedAsset}
                  onChange={(e) =>
                    activeTab === 'liquidate'
                      ? setSeizeAsset(e.target.value)
                      : setSelectedAsset(e.target.value)
                  }
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white appearance-none focus:outline-none focus:border-primary-500/50 cursor-pointer"
                >
                  {SUPPORTED_COLLATERAL_ASSETS.map((asset) => (
                    <option key={asset.contractId} value={asset.contractId}>
                      {asset.symbol} — {asset.name}
                    </option>
                  ))}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              </div>

              {/* Show per-asset CF and on-chain balance for deposit/withdraw */}
              {activeTab !== 'liquidate' && (
                <div className="flex justify-between mt-1 text-xs text-gray-500">
                  <span>
                    CF:{' '}
                    {selectedAssetPosition
                      ? (selectedAssetPosition.collateralFactorBps / 100).toFixed(0)
                      : (selectedAssetMeta.defaultCollateralFactorBps / 100).toFixed(0)}
                    %
                  </span>
                  {activeTab === 'withdraw' && selectedAssetPosition && (
                    <span>
                      Deposited: {formatXLM(selectedAssetPosition.amount)}{' '}
                      {selectedAssetMeta.symbol}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {activeTab === 'liquidate' ? (
            <div>
              <label className="text-xs text-gray-400 mb-1 block">
                Borrower Address to Liquidate
              </label>
              <input
                type="text"
                value={borrowerAddress}
                onChange={(e) => setBorrowerAddress(e.target.value)}
                placeholder="G..."
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500/50"
              />
              <p className="text-xs text-gray-500 mt-2">
                Liquidate positions with health factor below 1.0. You repay their XLM debt
                and receive their {SUPPORTED_COLLATERAL_ASSETS.find(a => a.contractId === seizeAsset)?.symbol ?? 'collateral'} + 5% bonus.
              </p>
            </div>
          ) : (
            <div>
              <label className="text-xs text-gray-400 mb-1 block">
                {activeTab === 'deposit' || activeTab === 'withdraw'
                  ? `${selectedAssetMeta.symbol} Amount`
                  : 'XLM Amount'}
              </label>
              {activeTab === 'borrow' && position.maxBorrow > 0 && (
                <p className="text-xs text-gray-500 mb-1">
                  Max: {position.maxBorrow.toFixed(4)} XLM
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
            <div
              className={`rounded-lg p-3 space-y-1 ${
                isPending
                  ? 'bg-yellow-500/10 border border-yellow-500/20'
                  : 'bg-green-500/10 border border-green-500/20'
              }`}
            >
              <p className={`text-xs ${isPending ? 'text-yellow-400' : 'text-green-400'}`}>
                {isPending
                  ? 'Transaction submitted — confirming on Stellar (may take a moment)'
                  : 'Transaction successful!'}
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
                (['borrow', 'withdraw', 'repay'].includes(activeTab) && !hasAnyCollateral)
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

      {/* How it works */}
      <div className="glass rounded-2xl p-6 space-y-4">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-5 h-5 text-yellow-400" />
          <h3 className="text-sm font-semibold text-white">How Multi-Collateral Lending Works</h3>
        </div>
        <div className="space-y-3 text-sm text-gray-400">
          <p>1. Choose any supported asset (sXLM, USDC, EURC, yXLM) and deposit it as collateral.</p>
          <p>2. Each asset has its own Collateral Factor — USDC is accepted at 90%, sXLM at 75%, etc.</p>
          <p>3. Your borrowing power is the sum of all collateral values weighted by their Collateral Factors.</p>
          <p>4. Your Health Factor combines all collateral. Keep it above 1.0 to avoid liquidation.</p>
          <p>5. Repay borrowed XLM to free up any collateral asset.</p>
          <p>6. Liquidators can repay unhealthy positions and receive the specified collateral asset + 5% bonus.</p>
          <p className="text-xs text-gray-500">
            Borrow rate: {(stats.borrowRateBps / 100).toFixed(2)}% APR. Prices are updated
            by the admin oracle.
          </p>
        </div>
      </div>
    </div>
  );
}
