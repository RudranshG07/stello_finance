import { useState } from 'react';
import { Vote, Plus, Clock, CheckCircle, XCircle, Timer, Ban } from 'lucide-react';
import { useWallet } from '../hooks/useWallet';
import { useGovernance } from '../hooks/useGovernance';
import { formatAddress } from '../utils/stellar';

export default function Governance() {
  const { isConnected, connect } = useWallet();
  const {
    proposals,
    params,
    isLoading,
    isSubmitting,
    error,
    lastTxHash,
    createProposal,
    vote,
    queueProposal,
    cancelProposal,
    executeQueued,
    executeProposal,
    clearError,
  } = useGovernance();

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [paramKey, setParamKey] = useState('protocol_fee_bps');
  const [newValue, setNewValue] = useState('');

  const handleCreateProposal = async () => {
    if (!newValue) return;
    clearError();
    const success = await createProposal(paramKey, newValue);
    if (success) {
      setNewValue('');
      setShowCreateForm(false);
    }
  };

  const handleVote = async (proposalId: number, support: boolean) => {
    clearError();
    await vote(proposalId, support);
  };

  const handleQueue = async (proposalId: number) => {
    clearError();
    await queueProposal(proposalId);
  };

  const handleCancel = async (proposalId: number) => {
    clearError();
    await cancelProposal(proposalId);
  };

  const handleExecuteQueued = async (proposalId: number) => {
    clearError();
    await executeQueued(proposalId);
  };

  const handleExecute = async (proposalId: number) => {
    clearError();
    await executeProposal(proposalId);
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'active':
        return <span className="px-2 py-1 rounded-full text-xs bg-yellow-400/10 text-yellow-400 border border-yellow-400/20">Active</span>;
      case 'passed':
        return <span className="px-2 py-1 rounded-full text-xs bg-green-500/20 text-green-400 border border-green-500/30">Passed</span>;
      case 'rejected':
        return <span className="px-2 py-1 rounded-full text-xs bg-red-500/20 text-red-400 border border-red-500/30">Rejected</span>;
      case 'queued':
        return <span className="px-2 py-1 rounded-full text-xs bg-blue-500/20 text-blue-400 border border-blue-500/30">Queued (Timelock)</span>;
      case 'cancelled':
        return <span className="px-2 py-1 rounded-full text-xs bg-gray-500/20 text-gray-400 border border-gray-500/30">Cancelled</span>;
      case 'executed':
        return <span className="px-2 py-1 rounded-full text-xs bg-purple-500/20 text-purple-400 border border-purple-500/30">Executed</span>;
      default:
        return null;
    }
  };

  const activeCount = proposals.filter(p => p.status === 'active').length;

  return (
    <div className="max-w-4xl mx-auto px-4 space-y-6">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-white mb-2">Governance</h1>
        <p className="text-gray-400">Vote on protocol parameter changes with sXLM</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <div className="glass rounded-xl p-4 text-center">
          <p className="text-xs text-gray-400">Total Proposals</p>
          <p className="text-lg font-bold text-white mt-1">{isLoading ? '...' : proposals.length}</p>
        </div>
        <div className="glass rounded-xl p-4 text-center">
          <p className="text-xs text-gray-400">Active Proposals</p>
          <p className="text-lg font-bold text-white mt-1">{isLoading ? '...' : activeCount}</p>
        </div>
        <div className="glass rounded-xl p-4 text-center">
          <p className="text-xs text-gray-400">Quorum Required</p>
          <p className="text-lg font-bold text-white mt-1">10%</p>
        </div>
      </div>

      {/* Governable Params */}
      {params.length > 0 && (
        <div className="glass rounded-2xl p-6 space-y-3">
          <h3 className="text-sm font-semibold text-white">Governable Parameters</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {params.map((p) => (
              <div key={p.key} className="bg-white/5 rounded-xl p-3">
                <p className="text-xs text-gray-400">{p.description}</p>
                <p className="text-sm text-white font-medium mt-1">{p.key}: <span className="text-yellow-400">{p.currentValue}</span></p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Error / Success Messages */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}
      {lastTxHash && (
        <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3">
          <p className="text-xs text-green-400">Transaction successful!</p>
        </div>
      )}

      {/* Create Proposal */}
      <div className="flex justify-end">
        {isConnected ? (
          <button
            onClick={() => setShowCreateForm(!showCreateForm)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-yellow-400/10 text-yellow-400 border border-yellow-400/20 hover:bg-yellow-400/15 transition-colors text-sm font-medium"
          >
            <Plus className="w-4 h-4" />
            Create Proposal
          </button>
        ) : (
          <button
            onClick={connect}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-yellow-400/10 text-yellow-400 border border-yellow-400/20 text-sm font-medium"
          >
            Connect Wallet to Propose
          </button>
        )}
      </div>

      {showCreateForm && (
        <div className="glass rounded-2xl p-6 space-y-4 border border-yellow-400/15">
          <h3 className="text-sm font-semibold text-white">New Proposal</h3>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Parameter</label>
            <select
              value={paramKey}
              onChange={(e) => setParamKey(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-primary-500/50"
            >
              {params.map((p) => (
                <option key={p.key} value={p.key}>{p.description} ({p.key})</option>
              ))}
              {params.length === 0 && (
                <>
                  <option value="protocol_fee_bps">Protocol Fee (bps)</option>
                  <option value="cooldown_period">Cooldown Period (ledgers)</option>
                  <option value="collateral_factor">Collateral Factor (bps)</option>
                  <option value="buffer_safety_factor">Buffer Safety Factor</option>
                </>
              )}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">New Value</label>
            <input
              type="text"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder="Enter new value"
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500/50"
            />
          </div>
          <p className="text-xs text-gray-500">Minimum 100 sXLM balance required to create a proposal.</p>
          <button
            onClick={handleCreateProposal}
            disabled={isSubmitting || !newValue}
            className="w-full py-3 rounded-xl bg-gradient-to-r from-primary-500 to-accent-500 text-white font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            {isSubmitting ? 'Submitting...' : 'Submit Proposal'}
          </button>
        </div>
      )}

      {/* Proposals List */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
          <Vote className="w-4 h-4 text-yellow-400" />
          Proposals
        </h3>

        {isLoading ? (
          <p className="text-sm text-gray-400">Loading proposals...</p>
        ) : proposals.length === 0 ? (
          <div className="glass rounded-2xl p-8 text-center">
            <p className="text-gray-400">No proposals yet. Be the first to create one!</p>
          </div>
        ) : (
          proposals.map((proposal) => {
            const votesFor = Number(proposal.votesFor) / 1e7;
            const votesAgainst = Number(proposal.votesAgainst) / 1e7;
            const totalVotes = votesFor + votesAgainst;
            const forPercent = totalVotes > 0 ? (votesFor / totalVotes) * 100 : 50;

            return (
              <div key={proposal.id} className="glass rounded-2xl p-6 space-y-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-white font-medium text-sm">
                        #{proposal.id}: Change {proposal.paramKey}
                      </span>
                      {getStatusBadge(proposal.status)}
                    </div>
                    <p className="text-xs text-gray-400">
                      Proposed by {formatAddress(proposal.proposer)} &bull; New value: <span className="text-white">{proposal.newValue}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-gray-500">
                    <Clock className="w-3 h-3" />
                    {proposal.status === 'active' ? 'Voting' : proposal.status}
                  </div>
                </div>

                {/* Vote Bar */}
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-green-400 flex items-center gap-1">
                      <CheckCircle className="w-3 h-3" />
                      For: {formatXLMVotes(votesFor)} ({forPercent.toFixed(0)}%)
                    </span>
                    <span className="text-red-400 flex items-center gap-1">
                      Against: {formatXLMVotes(votesAgainst)} ({(100 - forPercent).toFixed(0)}%)
                      <XCircle className="w-3 h-3" />
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-white/5 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-green-500 to-green-400"
                      style={{ width: `${forPercent}%` }}
                    />
                  </div>
                </div>

                {/* Vote Actions */}
                {proposal.status === 'active' && isConnected && (
                  <div className="flex gap-3">
                    <button
                      onClick={() => handleVote(proposal.id, true)}
                      disabled={isSubmitting}
                      className="flex-1 py-2 rounded-xl bg-green-500/10 text-green-400 border border-green-500/20 hover:bg-green-500/20 transition-colors text-sm font-medium disabled:opacity-40"
                    >
                      {isSubmitting ? '...' : 'Vote For'}
                    </button>
                    <button
                      onClick={() => handleVote(proposal.id, false)}
                      disabled={isSubmitting}
                      className="flex-1 py-2 rounded-xl bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors text-sm font-medium disabled:opacity-40"
                    >
                      {isSubmitting ? '...' : 'Vote Against'}
                    </button>
                  </div>
                )}

                {/* Queue into timelock: passed proposals not yet queued */}
                {proposal.status === 'passed' && !proposal.queued && !proposal.executed && isConnected && (
                  <button
                    onClick={() => handleQueue(proposal.id)}
                    disabled={isSubmitting}
                    className="w-full py-2 rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20 hover:bg-blue-500/20 transition-colors text-sm font-medium disabled:opacity-40 flex items-center justify-center gap-2"
                  >
                    <Timer className="w-4 h-4" />
                    {isSubmitting ? 'Queuing...' : 'Queue (Enter 48h Timelock)'}
                  </button>
                )}

                {/* Timelock status + execute/cancel */}
                {proposal.status === 'queued' && isConnected && (
                  <div className="space-y-2">
                    {proposal.timelockEta != null && (
                      <p className="text-xs text-blue-400 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        Executable after ledger {proposal.timelockEta}
                      </p>
                    )}
                    <div className="flex gap-3">
                      <button
                        onClick={() => handleExecuteQueued(proposal.id)}
                        disabled={isSubmitting}
                        className="flex-1 py-2 rounded-xl bg-purple-500/10 text-purple-400 border border-purple-500/20 hover:bg-purple-500/20 transition-colors text-sm font-medium disabled:opacity-40"
                      >
                        {isSubmitting ? '...' : 'Execute'}
                      </button>
                      <button
                        onClick={() => handleCancel(proposal.id)}
                        disabled={isSubmitting}
                        className="flex-1 py-2 rounded-xl bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors text-sm font-medium disabled:opacity-40 flex items-center justify-center gap-1"
                      >
                        <Ban className="w-3 h-3" />
                        {isSubmitting ? '...' : 'Cancel (Guardian)'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function formatXLMVotes(amount: number): string {
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}K`;
  return amount.toFixed(0);
}
