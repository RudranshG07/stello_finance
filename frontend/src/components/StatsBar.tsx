import { useProtocol } from '../hooks/useProtocol';
import { formatXLM, formatUSD, formatAPY } from '../utils/stellar';

export default function StatsBar() {
  const { stats, apy, isLoading } = useProtocol();

  const items = [
    { label: 'Total Staked', value: `${formatXLM(stats.totalStaked)} XLM` },
    { label: 'TVL', value: formatUSD(stats.tvlUsd) },
    { label: 'APR / APY', value: `${formatAPY(apy.currentApr)} / ${formatAPY(apy.currentApy)}` },
    { label: 'Exchange Rate', value: `1 sXLM = ${stats.exchangeRate.toFixed(4)} XLM` },
  ];

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-border rounded-lg overflow-hidden">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-surface p-5 animate-pulse">
            <div className="h-3 w-16 bg-white/5 rounded mb-2" />
            <div className="h-5 w-24 bg-white/5 rounded" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-border rounded-lg overflow-hidden">
      {items.map((item) => (
        <div key={item.label} className="bg-surface p-5">
          <p className="stat-label">{item.label}</p>
          <p className="stat-value mt-1">{item.value}</p>
        </div>
      ))}
    </div>
  );
}
