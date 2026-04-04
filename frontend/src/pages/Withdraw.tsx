import WithdrawCard from '../components/WithdrawCard';

export default function Withdraw() {
  return (
    <div className="max-w-lg mx-auto px-4 py-10 space-y-5">
      <div>
        <p className="text-[11px] uppercase tracking-widest mb-2" style={{ color: '#F5CF00' }}>
          Unstake
        </p>
        <h1 className="text-2xl font-bold text-white mb-1">Withdraw</h1>
        <p className="text-sm" style={{ color: '#525252' }}>
          Burn sXLM to receive XLM at the current exchange rate
        </p>
      </div>

      <WithdrawCard />

      <div className="card p-5 space-y-3 text-xs" style={{ color: '#525252' }}>
        <p>
          <span className="text-neutral-300 font-medium">Instant</span>
          {' '}— If the liquidity buffer has enough XLM, your withdrawal processes immediately.
        </p>
        <p>
          <span className="text-neutral-300 font-medium">Delayed</span>
          {' '}— If the buffer is insufficient, you enter a queue. Claim after ~24h cooldown.
        </p>
      </div>
    </div>
  );
}
