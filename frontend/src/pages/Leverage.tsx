import { useState } from 'react';
import { TrendingUp, Calculator, Zap } from 'lucide-react';
import axios from '../lib/apiClient';
import { API_BASE_URL } from '../config/contracts';

interface SimResult {
  maxLeverage: number;
  effectiveLeverage: number;
  totalStaked: number;
  totalBorrowed: number;
  netYieldPercent: number;
  grossYield: number;
  borrowCost: number;
  netYield: number;
  loops: { loop: number; deposited: number; borrowed: number; totalStaked: number; totalBorrowed: number }[];
}

interface OptimalResult {
  collateralFactor: number;
  maxLeverage: number;
  optimalLoops: number;
  stakingAPR: number;
  borrowAPR: number;
  netYieldPercent: number;
}

export default function Leverage() {
  const [principal, setPrincipal] = useState('1000');
  const [loops, setLoops] = useState('3');
  const [collateralFactor, setCollateralFactor] = useState('0.7');
  const [stakingAPR, setStakingAPR] = useState('0');
  const [borrowAPR, setBorrowAPR] = useState('0.04');
  const [result, setResult] = useState<SimResult | null>(null);
  const [optimalResult, setOptimalResult] = useState<OptimalResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSimulate = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { data } = await axios.post(`${API_BASE_URL}/api/leverage/simulate`, {
        principal: parseFloat(principal),
        loops: parseInt(loops),
        collateralFactor: parseFloat(collateralFactor),
        stakingAPR: parseFloat(stakingAPR),
        borrowAPR: parseFloat(borrowAPR),
      });
      setResult(data);
    } catch (err: unknown) {
      setError(axios.isAxiosError(err) ? err.response?.data?.error ?? 'Simulation failed' : 'Simulation failed');
    }
    setIsLoading(false);
  };

  const handleOptimal = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { data } = await axios.get(`${API_BASE_URL}/api/leverage/optimal`);
      setOptimalResult(data);
    } catch {
      setError('Could not fetch optimal leverage');
    }
    setIsLoading(false);
  };

  return (
    <div className="max-w-4xl mx-auto px-4 space-y-6">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-white mb-2">Leverage Simulator</h1>
        <p className="text-gray-400">Calculate optimal leverage for sXLM staking yield</p>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Input Card */}
        <div className="glass rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Calculator className="w-5 h-5 text-yellow-400" />
            <h3 className="text-sm font-semibold text-white">Parameters</h3>
          </div>

          {[
            { label: 'Principal (XLM)', value: principal, setter: setPrincipal },
            { label: 'Loops', value: loops, setter: setLoops },
            { label: 'Collateral Factor', value: collateralFactor, setter: setCollateralFactor },
            { label: 'Staking APR', value: stakingAPR, setter: setStakingAPR },
            { label: 'Borrow APR', value: borrowAPR, setter: setBorrowAPR },
          ].map(({ label, value, setter }) => (
            <div key={label}>
              <label className="text-xs text-gray-400 mb-1 block">{label}</label>
              <input
                type="number"
                value={value}
                onChange={(e) => setter(e.target.value)}
                step="any"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500/50"
              />
            </div>
          ))}

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
              <p className="text-xs text-red-400">{error}</p>
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={handleSimulate}
              disabled={isLoading}
              className="flex-1 py-3 rounded-xl bg-gradient-to-r from-primary-500 to-accent-500 text-white font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              {isLoading ? 'Simulating...' : 'Simulate'}
            </button>
            <button
              onClick={handleOptimal}
              disabled={isLoading}
              className="flex items-center gap-1 px-4 py-3 rounded-xl bg-yellow-400/10 text-yellow-400 border border-yellow-400/20 hover:bg-yellow-400/15 transition-colors text-sm font-medium disabled:opacity-40"
            >
              <Zap className="w-4 h-4" /> Optimal
            </button>
          </div>
        </div>

        {/* Results Card */}
        <div className="glass rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-yellow-400" />
            <h3 className="text-sm font-semibold text-white">Results</h3>
          </div>

          {result ? (
            <div className="space-y-3">
              {[
                { label: 'Effective Leverage', value: result.effectiveLeverage.toFixed(2) + 'x' },
                { label: 'Net Yield', value: result.netYieldPercent.toFixed(2) + '%' },
                { label: 'Total Staked', value: result.totalStaked.toFixed(2) + ' XLM' },
                { label: 'Total Borrowed', value: result.totalBorrowed.toFixed(2) + ' XLM' },
                { label: 'Net Position', value: (result.totalStaked - result.totalBorrowed).toFixed(2) + ' XLM' },
                { label: 'Annual Return', value: result.netYield.toFixed(2) + ' XLM' },
              ].map(({ label, value }) => (
                <div key={label} className="flex justify-between text-sm">
                  <span className="text-gray-400">{label}</span>
                  <span className="text-white font-medium">{value}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-400">Run a simulation to see results.</p>
          )}

          {optimalResult && (
            <div className="mt-4 p-4 rounded-xl bg-yellow-400/8 border border-yellow-400/15 space-y-2">
              <p className="text-xs font-semibold text-yellow-400">Optimal Strategy</p>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Optimal Loops</span>
                <span className="text-white">{optimalResult.optimalLoops}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Net Yield</span>
                <span className="text-white">{optimalResult.netYieldPercent.toFixed(2)}%</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Leverage</span>
                <span className="text-white">{optimalResult.maxLeverage.toFixed(2)}x</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Formula Info */}
      <div className="glass rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-semibold text-white">How Leverage Works</h3>
        <div className="space-y-2 text-sm text-gray-400">
          <p>Leverage = 1 / (1 - c), where c = collateral factor</p>
          <p>Net Yield = (Leverage x Staking APR) - ((Leverage - 1) x Borrow APR)</p>
          <p>Example: c=0.7, r=APR%, b=4% → Leverage=3.33x, Net Yield=(L×r)−((L−1)×b)</p>
        </div>
      </div>
    </div>
  );
}
