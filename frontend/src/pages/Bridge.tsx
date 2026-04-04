import BridgeCard from '../components/BridgeCard';

export default function Bridge() {
  return (
    <div className="max-w-lg mx-auto px-4 py-10 space-y-5">
      <div>
        <p className="text-[11px] uppercase tracking-widest mb-2" style={{ color: '#F5CF00' }}>
          Cross-Chain
        </p>
        <h1 className="text-2xl font-bold text-white mb-1">Bridge sXLM</h1>
        <p className="text-sm" style={{ color: '#525252' }}>
          Move sXLM to EVM chains · use wsXLM as collateral in Aave &amp; Compound
        </p>
      </div>

      <BridgeCard />

      <div className="card p-5 space-y-3">
        {[
          { label: 'Supported Chains',  val: 'Ethereum, Arbitrum' },
          { label: 'Testnet',           val: 'Sepolia' },
          { label: 'Bridge Time',       val: '~1–3 minutes' },
          { label: 'Minimum Amount',    val: '1 sXLM' },
          { label: 'Bridge Fee',        val: 'Gas only' },
          { label: 'EVM Token',         val: 'wsXLM (ERC-20, 18 decimals)' },
        ].map(({ label, val }) => (
          <div key={label} className="flex justify-between text-sm">
            <span style={{ color: '#525252' }}>{label}</span>
            <span className="text-white font-mono">{val}</span>
          </div>
        ))}
      </div>

      <div className="card p-5 space-y-3 text-xs" style={{ color: '#525252' }}>
        <p>
          <span className="text-neutral-300 font-medium">Stellar → EVM</span>
          {' '}— sXLM is burned on Stellar and wsXLM is minted on the target EVM chain by the relayer.
        </p>
        <p>
          <span className="text-neutral-300 font-medium">EVM → Stellar</span>
          {' '}— wsXLM is burned on EVM and sXLM is released to your Stellar address by the relayer. Takes ~1–3 minutes.
        </p>
        <p>
          <span className="text-neutral-300 font-medium">wsXLM</span>
          {' '}— A yield-bearing ERC-20 usable as collateral in Aave, Compound, and other EVM DeFi protocols.
        </p>
      </div>
    </div>
  );
}