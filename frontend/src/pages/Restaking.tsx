import { useState } from 'react';
import { RefreshCw, TrendingUp } from 'lucide-react';
import axios from '../lib/apiClient';
import { API_BASE_URL } from '../config/contracts';
import { useWallet } from '../hooks/useWallet';

interface RestakingStep {
  step: number;
  action: string;
  amount: number;
  totalStaked: number;
  totalBorrowed: number;
  healthFactor: number;
}

interface SimResult {
  initialDeposit: number;
  loops: number;
  totalStaked: number;
  totalBorrowed: number;
  effectiveLeverage: number;
  estimatedNetAPR: number;
  healthFactor: number;
  steps: RestakingStep[];
}

interface RestakingPosition {
  wallet: string;
  totalStaked: number;
  totalBorrowed: number;
  effectiveLeverage: number;
  healthFactor: number;
  netAPR: number;
  loops: number;
}

export default function Restaking() {
  const { publicKey, isConnected } = useWallet();
  const [principal, setPrincipal] = useState('1000');
  const [loops, setLoops] = useState('3');
  const [simResult, setSimResult] = useState<SimResult | null>(null);
  const [position, setPosition] = useState<RestakingPosition | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSimulate = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { data } = await axios.post(`${API_BASE_URL}/api/restaking/simulate`, {
        principal: parseFloat(principal),
        loops: parseInt(loops),
      });
      setSimResult(data);
    } catch {
      setError('Simulation failed');
    }
    setIsLoading(false);
  };

  const handleFetchPosition = async () => {
    if (!publicKey) return;
    setIsLoading(true);
    setError(null);
    try {
      const { data } = await axios.get(`${API_BASE_URL}/api/restaking/position/${publicKey}`);
      setPosition(data);
    } catch {
      setError('Could not fetch position');
    }
    setIsLoading(false);
  };

  return (
    <div className="max-w-4xl mx-auto px-4 space-y-6">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-white mb-2">Restaking</h1>
        <p className="text-gray-400">Automated stake → collateral → borrow → restake loop</p>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Simulate Card */}
        <div className="glass rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-2">
            <RefreshCw className="w-5 h-5 text-yellow-400" />
            <h3 className="text-sm font-semibold text-white">Simulate Restaking</h3>
          </div>

          <div>
            <label className="text-xs text-gray-400 mb-1 block">Principal (XLM)</label>
            <input
              type="number"
              value={principal}
              onChange={(e) => setPrincipal(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500/50"
            />
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Number of Loops</label>
            <input
              type="number"
              value={loops}
              onChange={(e) => setLoops(e.target.value)}
              min="1"
              max="10"
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500/50"
            />
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
              <p className="text-xs text-red-400">{error}</p>
            </div>
          )}

          <button
            onClick={handleSimulate}
            disabled={isLoading}
            className="w-full py-3 rounded-xl bg-gradient-to-r from-primary-500 to-accent-500 text-white font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            {isLoading ? 'Simulating...' : 'Simulate'}
          </button>

          {isConnected && (
            <button
              onClick={handleFetchPosition}
              disabled={isLoading}
              className="w-full py-2 rounded-xl bg-white/5 text-gray-400 border border-white/10 hover:bg-white/10 transition-colors text-sm"
            >
              Fetch My Position
            </button>
          )}
        </div>

        {/* Results Card */}
        <div className="glass rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-yellow-400" />
            <h3 className="text-sm font-semibold text-white">Results</h3>
          </div>

          {simResult ? (
            <div className="space-y-4">
              {/* Final position */}
              <div className="space-y-2">
                {[
                  { label: 'Total Staked', value: simResult.totalStaked.toFixed(2) + ' XLM' },
                  { label: 'Total Borrowed', value: simResult.totalBorrowed.toFixed(2) + ' XLM' },
                  { label: 'Net Position', value: (simResult.totalStaked - simResult.totalBorrowed).toFixed(2) + ' XLM' },
                  { label: 'Effective Leverage', value: simResult.effectiveLeverage.toFixed(2) + 'x' },
                  { label: 'Estimated Net APR', value: simResult.estimatedNetAPR.toFixed(2) + '%' },
                  { label: 'Health Factor', value: simResult.healthFactor === Infinity ? '∞' : simResult.healthFactor.toFixed(2) },
                ].map(({ label, value }) => (
                  <div key={label} className="flex justify-between text-sm">
                    <span className="text-gray-400">{label}</span>
                    <span className="text-white font-medium">{value}</span>
                  </div>
                ))}
              </div>

              {/* Step breakdown */}
              <div className="mt-3">
                <p className="text-xs text-gray-400 mb-2">Step Breakdown</p>
                <div className="space-y-1">
                  {simResult.steps.map((step) => (
                    <div key={step.step} className="flex justify-between text-xs bg-white/5 rounded-lg px-3 py-2">
                      <span className="text-gray-400">#{step.step} {step.action}</span>
                      <span className="text-white">{step.amount.toFixed(1)} XLM</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : position ? (
            <div className="space-y-3">
              <p className="text-xs text-yellow-400 font-semibold">Your Restaking Position</p>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Total Staked</span>
                <span className="text-white">{position.totalStaked.toFixed(2)} XLM</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Total Borrowed</span>
                <span className="text-white">{position.totalBorrowed.toFixed(2)} XLM</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Health Factor</span>
                <span className={`font-bold ${
                  position.healthFactor > 1.5 ? 'text-green-400' :
                  position.healthFactor > 1.0 ? 'text-yellow-400' : 'text-red-400'
                }`}>
                  {position.healthFactor.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Net APR</span>
                <span className="text-white">{position.netAPR.toFixed(2)}%</span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-400">Run a simulation to see results.</p>
          )}
        </div>
      </div>

      {/* Info */}
      <div className="glass rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-semibold text-white">How Restaking Works</h3>
        <div className="space-y-2 text-sm text-gray-400">
          <p>1. Stake XLM to receive sXLM (earning staking yield)</p>
          <p>2. Deposit sXLM as collateral in the lending contract</p>
          <p>3. Borrow XLM against your sXLM collateral (up to 70%)</p>
          <p>4. Stake the borrowed XLM again to get more sXLM</p>
          <p>5. Repeat for N loops, each time staking more and borrowing more</p>
          <p className="text-xs text-gray-500">
            This amplifies your staking yield but also increases liquidation risk.
          </p>
        </div>
      </div>
    </div>
  );
}
