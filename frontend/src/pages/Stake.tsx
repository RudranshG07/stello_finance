import StakeCard from '../components/StakeCard';
import { useProtocol } from '../hooks/useProtocol';
import { formatAPY } from '../utils/stellar';

export default function Stake() {
  const { stats, apy } = useProtocol();

  return (
    <div className="max-w-lg mx-auto px-4 py-10 space-y-5">
      <div>
        <p className="text-[11px] uppercase tracking-widest mb-2" style={{ color: '#F5CF00' }}>
          Liquid Staking
        </p>
        <h1 className="text-2xl font-bold text-white mb-1">Stake XLM</h1>
        <p className="text-sm" style={{ color: '#525252' }}>
          Earn {formatAPY(apy.currentApy)} APY · receive yield-bearing sXLM
        </p>
      </div>

      <StakeCard />

      <div className="card p-5 space-y-3">
        {[
          { label: 'Exchange Rate',  val: `1 sXLM = ${stats.exchangeRate.toFixed(6)} XLM` },
          { label: 'Current APY',    val: formatAPY(apy.currentApy) },
          { label: '7-Day Yield',    val: formatAPY(apy.apy7d) },
          { label: '30-Day Yield',   val: formatAPY(apy.apy30d) },
        ].map(({ label, val }) => (
          <div key={label} className="flex justify-between text-sm">
            <span style={{ color: '#525252' }}>{label}</span>
            <span className="text-white font-mono">{val}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
