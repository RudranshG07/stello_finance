import { useState, useEffect } from 'react';
import { Lock, Unlock, CheckCircle, AlertCircle, Clock, TrendingUp, Plus } from 'lucide-react';
import axios from '../lib/apiClient';
import { useWallet } from '../hooks/useWallet';
import { useVesting, stroopsToXlm, estimateVestedPercent, type VestingSchedule } from '../hooks/useVesting';
import { API_BASE_URL, CONTRACTS } from '../config/contracts';

/** Native XLM SAC on testnet — available to everyone, no staking needed. */
const NATIVE_XLM_SAC = CONTRACTS.nativeXlmSac;

/* ── Stellar brand palette (matches rest of app) ──────────────────────────── */
const Y = '#F5CF00';
const S = '#0d0d0d';
const BR = '#1e1e1e';
const W = '#ffffff';
const T2 = '#a3a3a3';

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function fmt(n: number, dec = 2): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(dec)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(dec)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(dec)}K`;
  return n.toFixed(dec);
}

/** Approximate ledgers remaining → human-readable time (5 s / ledger). */
function ledgersToTime(ledgers: number): string {
  if (ledgers <= 0) return 'Unlocked';
  const seconds = ledgers * 5;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `~${days}d ${hours}h`;
  const mins = Math.floor(seconds / 60);
  return mins > 0 ? `~${mins}m` : '<1m';
}

/** Convert a date string (YYYY-MM-DD) to an approximate ledger number. */
function dateToLedger(dateStr: string, currentLedger: number): number {
  if (!dateStr || currentLedger === 0) return currentLedger;
  const diffLedgers = Math.round((new Date(dateStr).getTime() - Date.now()) / 5000);
  return currentLedger + diffLedgers;
}

/** Return a YYYY-MM-DD string for today + N days. */
function todayPlusDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().split('T')[0];
}

/* ── Sub-components ──────────────────────────────────────────────────────── */

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div
      style={{
        background: S,
        border: `1px solid ${BR}`,
        borderRadius: 12,
        padding: '20px 24px',
        textAlign: 'center',
      }}
    >
      <p style={{ fontSize: 11, color: T2, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
        {label}
      </p>
      <p style={{ fontSize: 22, fontWeight: 700, color: W }}>{value}</p>
      {sub && <p style={{ fontSize: 11, color: T2, marginTop: 2 }}>{sub}</p>}
    </div>
  );
}

function ProgressBar({ percent, revoked }: { percent: number; revoked: boolean }) {
  const color = revoked ? '#ef4444' : Y;
  return (
    <div style={{ background: BR, borderRadius: 99, height: 6, overflow: 'hidden' }}>
      <div
        style={{
          width: `${Math.min(100, percent)}%`,
          height: '100%',
          background: color,
          borderRadius: 99,
          transition: 'width 0.6s ease',
        }}
      />
    </div>
  );
}

function ScheduleCard({
  schedule,
  onClaim,
  isSubmitting,
  currentLedger,
}: {
  schedule: VestingSchedule;
  onClaim: (id: number) => void;
  isSubmitting: boolean;
  currentLedger: number;
}) {
  const totalXlm = stroopsToXlm(schedule.totalAmount);
  const claimedXlm = stroopsToXlm(schedule.claimed);
  const claimableXlm = stroopsToXlm(schedule.claimable);
  const remainingXlm = totalXlm - claimedXlm;

  const vestedPct = schedule.revoked
    ? (stroopsToXlm(schedule.vestedAtRevoke) / totalXlm) * 100
    : estimateVestedPercent(schedule.startLedger, schedule.endLedger, currentLedger);

  const ledgersToCliff = Math.max(0, schedule.cliffLedger - currentLedger);
  const ledgersToEnd = Math.max(0, schedule.endLedger - currentLedger);
  const cliffPassed = currentLedger >= schedule.cliffLedger;
  const fullyVested = currentLedger >= schedule.endLedger;

  const canClaim = claimableXlm > 0 && !schedule.revoked;

  return (
    <div
      style={{
        background: S,
        border: `1px solid ${schedule.revoked ? '#7f1d1d' : BR}`,
        borderRadius: 16,
        padding: '24px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {schedule.revoked ? (
            <AlertCircle size={18} color="#ef4444" />
          ) : fullyVested ? (
            <CheckCircle size={18} color="#22c55e" />
          ) : cliffPassed ? (
            <Unlock size={18} color={Y} />
          ) : (
            <Lock size={18} color={T2} />
          )}
          <span style={{ fontSize: 14, fontWeight: 600, color: W }}>
            Schedule #{schedule.scheduleId}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {schedule.revoked && (
            <span style={{
              fontSize: 10, color: '#ef4444',
              border: '1px solid #7f1d1d', borderRadius: 4,
              padding: '1px 7px', letterSpacing: '0.05em',
            }}>REVOKED</span>
          )}
          {schedule.revocable && !schedule.revoked && (
            <span style={{
              fontSize: 10, color: T2,
              border: `1px solid ${BR}`, borderRadius: 4,
              padding: '1px 7px', letterSpacing: '0.05em',
            }}>REVOCABLE</span>
          )}
          <span style={{
            fontSize: 10, color: Y,
            border: `1px solid ${Y}35`, borderRadius: 4,
            padding: '1px 7px', letterSpacing: '0.05em',
          }}>{schedule.tokenSymbol}</span>
        </div>
      </div>

      {/* Progress */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
          <span style={{ color: T2 }}>Vested</span>
          <span style={{ color: W, fontWeight: 600 }}>{vestedPct.toFixed(1)}%</span>
        </div>
        <ProgressBar percent={vestedPct} revoked={schedule.revoked} />
      </div>

      {/* Amounts grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        {[
          { label: 'Total', value: fmt(totalXlm), sub: schedule.tokenSymbol },
          { label: 'Claimed', value: fmt(claimedXlm), sub: schedule.tokenSymbol },
          { label: 'Remaining', value: fmt(remainingXlm), sub: schedule.tokenSymbol },
        ].map((item) => (
          <div key={item.label} style={{ background: BR, borderRadius: 8, padding: '10px 12px', textAlign: 'center' }}>
            <p style={{ fontSize: 10, color: T2, marginBottom: 2 }}>{item.label}</p>
            <p style={{ fontSize: 14, fontWeight: 700, color: W }}>{item.value}</p>
            <p style={{ fontSize: 10, color: T2 }}>{item.sub}</p>
          </div>
        ))}
      </div>

      {/* Timeline */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: T2 }}>
          <Clock size={12} />
          {cliffPassed
            ? <span style={{ color: '#22c55e' }}>Cliff passed</span>
            : <span>Cliff in {ledgersToTime(ledgersToCliff)}</span>
          }
        </div>
        <span style={{ color: BR }}>·</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: T2 }}>
          <TrendingUp size={12} />
          {fullyVested
            ? <span style={{ color: '#22c55e' }}>Fully vested</span>
            : <span>Full vest in {ledgersToTime(ledgersToEnd)}</span>
          }
        </div>
      </div>

      {/* Claim button */}
      {!schedule.revoked && (
        <button
          onClick={() => onClaim(schedule.scheduleId)}
          disabled={!canClaim || isSubmitting}
          style={{
            background: canClaim ? Y : BR,
            color: canClaim ? '#000' : T2,
            border: 'none',
            borderRadius: 10,
            padding: '12px 0',
            fontWeight: 700,
            fontSize: 14,
            cursor: canClaim && !isSubmitting ? 'pointer' : 'not-allowed',
            transition: 'background 0.2s',
            width: '100%',
          }}
        >
          {isSubmitting
            ? 'Claiming...'
            : canClaim
              ? `Claim ${fmt(claimableXlm)} ${schedule.tokenSymbol}`
              : cliffPassed
                ? 'Nothing to claim yet'
                : 'Locked (cliff not reached)'
          }
        </button>
      )}

      {schedule.revoked && (
        <div style={{
          background: '#1c0707',
          border: '1px solid #7f1d1d',
          borderRadius: 10,
          padding: '10px 14px',
          fontSize: 12,
          color: '#fca5a5',
          textAlign: 'center',
        }}>
          Schedule revoked — unvested tokens returned to admin.
          {stroopsToXlm(schedule.vestedAtRevoke) - claimedXlm > 0 && (
            <> You can still claim <strong>{fmt(stroopsToXlm(schedule.vestedAtRevoke) - claimedXlm)} {schedule.tokenSymbol}</strong> already vested.</>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Admin: Create Schedule panel ────────────────────────────────────────── */

interface CreateForm {
  beneficiary: string;
  totalAmount: string;
  startDate: string;
  cliffDate: string;
  endDate: string;
}

function CreateSchedulePanel({
  userKey,
  onCreated,
}: {
  userKey: string;
  onCreated: () => void;
}) {
  const { signTransaction, getAuthHeaders } = useWallet();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [currentLedger, setCurrentLedger] = useState(0);

  useEffect(() => {
    fetch('https://soroban-testnet.stellar.org', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestLedger', params: {} }),
    })
      .then((r) => r.json())
      .then((r) => setCurrentLedger(r.result?.sequence ?? 0))
      .catch(() => {});
  }, []);

  const [form, setForm] = useState<CreateForm>({
    beneficiary: '',
    totalAmount: '100',
    startDate: todayPlusDays(0),
    cliffDate: todayPlusDays(7),
    endDate:   todayPlusDays(60),
  });

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setOk(null);
    setBusy(true);
    try {
      const totalStroops = Math.round(parseFloat(form.totalAmount) * 1e7);
      const beneficiaryAddr = form.beneficiary || userKey;
      const { data: txData } = await axios.post(
        `${API_BASE_URL}/api/vesting/create`,
        {
          userAddress: userKey,
          beneficiary: beneficiaryAddr,
          tokenAddress: NATIVE_XLM_SAC,   // use native XLM — always available on testnet
          totalAmount: totalStroops,
          startLedger: dateToLedger(form.startDate, currentLedger),
          cliffLedger: dateToLedger(form.cliffDate, currentLedger),
          endLedger:   dateToLedger(form.endDate,   currentLedger),
          revocable: false,
        },
        { headers: getAuthHeaders() }
      );
      const signedXdr = await signTransaction(txData.xdr, txData.networkPassphrase);
      const { data: submitData } = await axios.post(
        `${API_BASE_URL}/api/staking/submit`,
        { signedXdr },
        { headers: getAuthHeaders() }
      );
      // Sync on-chain schedule data into DB so the list refreshes correctly
      await axios.post(
        `${API_BASE_URL}/api/vesting/sync/${beneficiaryAddr}`,
        {},
        { headers: getAuthHeaders() }
      ).catch(() => { /* best-effort */ });
      setOk(submitData.txHash ?? 'submitted');
      setOpen(false);
      onCreated();
    } catch (e: unknown) {
      setErr(
        axios.isAxiosError(e) && e.response?.data?.error
          ? e.response.data.error
          : e instanceof Error ? e.message : 'Failed'
      );
    } finally {
      setBusy(false);
    }
  }

  const inp = (label: string, key: keyof CreateForm, type = 'text', placeholder = '') => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 11, color: T2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</label>
      <input
        type={type}
        placeholder={placeholder}
        value={String(form[key])}
        onChange={(e) => setForm((f) => ({ ...f, [key]: type === 'number' ? e.target.value : e.target.value }))}
        style={{
          background: '#111', border: `1px solid ${BR}`, borderRadius: 8,
          padding: '8px 12px', color: W, fontSize: 13, outline: 'none',
        }}
      />
    </div>
  );

  return (
    <div style={{ background: S, border: `1px solid ${Y}40`, borderRadius: 16, padding: '20px 24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: open ? 20 : 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Plus size={16} color={Y} />
          <span style={{ fontSize: 14, fontWeight: 600, color: Y }}>Create Schedule</span>
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          style={{
            background: open ? BR : Y, color: open ? T2 : '#000',
            border: 'none', borderRadius: 8,
            padding: '6px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer',
          }}
        >
          {open ? 'Cancel' : 'New Schedule'}
        </button>
      </div>

      {ok && (
        <div style={{ background: '#052e16', border: '1px solid #166534', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#86efac', marginTop: 8 }}>
          ✅ Schedule created — tx: {ok}
        </div>
      )}

      {open && (
        <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {inp('Beneficiary wallet', 'beneficiary', 'text', `Default: your wallet (${userKey.slice(0, 8)}…)`)}
          {inp('Total XLM to vest', 'totalAmount', 'number', '100')}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            {inp('Start date', 'startDate', 'date')}
            {inp('Cliff date', 'cliffDate', 'date')}
            {inp('End date',   'endDate',   'date')}
          </div>
          <p style={{ fontSize: 11, color: T2 }}>
            Start → vesting başlangıcı · Cliff → ilk token açılma tarihi · End → tam açılma tarihi
          </p>

          {err && (
            <div style={{ background: '#1c0707', border: '1px solid #7f1d1d', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#fca5a5' }}>
              {err}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            style={{
              background: busy ? BR : Y, color: busy ? T2 : '#000',
              border: 'none', borderRadius: 10, padding: '12px 0',
              fontWeight: 700, fontSize: 14, cursor: busy ? 'not-allowed' : 'pointer',
            }}
          >
            {busy ? 'Building tx...' : 'Create Vesting Schedule'}
          </button>
        </form>
      )}
    </div>
  );
}

/* ── Main page ───────────────────────────────────────────────────────────── */

export default function Vesting() {
  const { isConnected, connect, publicKey } = useWallet();
  const {
    schedules,
    isLoading,
    isSubmitting,
    error,
    lastTxHash,
    claim,
    refresh,
    clearError,
  } = useVesting();

  const [filter, setFilter] = useState<'all' | 'active' | 'revoked'>('all');


  // Approximate current ledger from the latest schedule data
  // (rough estimate: we don't have a real ledger feed in the frontend)
  const currentLedger = 0; // set to 0 — claimable comes fresh from chain anyway

  const filtered = schedules.filter((s) => {
    if (filter === 'active') return !s.revoked;
    if (filter === 'revoked') return s.revoked;
    return true;
  });

  const totalClaimable = schedules.reduce(
    (sum, s) => sum + stroopsToXlm(s.claimable),
    0
  );

  // Derive wallet-scoped stats from the already-fetched schedules
  const walletStats = isConnected ? {
    totalSchedules: schedules.length,
    totalLocked: schedules.reduce((sum, s) => sum + stroopsToXlm(s.totalAmount), 0),
    totalClaimed: schedules.reduce((sum, s) => sum + stroopsToXlm(s.claimed), 0),
    revoked: schedules.filter((s) => s.revoked).length,
  } : null;

  return (
    <div className="max-w-4xl mx-auto px-4 space-y-6 pb-12">
      {/* Title */}
      <div className="text-center pt-4">
        <h1 className="text-3xl font-bold text-white mb-2">Vesting</h1>
        <p style={{ color: T2 }}>Linear XLM vesting schedules with cliff support</p>
      </div>

      {/* Wallet-scoped stats — only shown when connected */}
      {walletStats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
          <StatCard label="My Schedules" value={String(walletStats.totalSchedules)} />
          <StatCard
            label="Total Locked"
            value={`${fmt(walletStats.totalLocked)} XLM`}
          />
          <StatCard
            label="Total Claimed"
            value={`${fmt(walletStats.totalClaimed)} XLM`}
          />
          <StatCard label="Revoked" value={String(walletStats.revoked)} />
        </div>
      )}

      {/* Wallet state */}
      {!isConnected ? (
        <div
          style={{
            background: S,
            border: `1px solid ${BR}`,
            borderRadius: 16,
            padding: '48px 32px',
            textAlign: 'center',
          }}
        >
          <Lock size={40} style={{ color: T2, margin: '0 auto 16px' }} />
          <p style={{ color: W, fontWeight: 600, marginBottom: 8 }}>Connect your wallet</p>
          <p style={{ color: T2, fontSize: 14, marginBottom: 24 }}>
            Connect to view your vesting schedules and claim unlocked tokens.
          </p>
          <button
            onClick={connect}
            style={{
              background: Y, color: '#000', border: 'none',
              borderRadius: 10, padding: '12px 32px',
              fontWeight: 700, fontSize: 14, cursor: 'pointer',
            }}
          >
            Connect Wallet
          </button>
        </div>
      ) : (
        <>
          {/* Create schedule panel — visible to all connected wallets */}
          <CreateSchedulePanel userKey={publicKey!} onCreated={refresh} />

          {/* Claimable summary */}
          {totalClaimable > 0 && (
            <div
              style={{
                background: `${Y}10`,
                border: `1px solid ${Y}35`,
                borderRadius: 12,
                padding: '16px 20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Unlock size={18} color={Y} />
                <span style={{ color: W, fontWeight: 600 }}>
                  {fmt(totalClaimable)} sXLM available to claim
                </span>
              </div>
              <span style={{ fontSize: 12, color: T2 }}>
                Claim each schedule individually below
              </span>
            </div>
          )}

          {/* Success / error banners */}
          {lastTxHash && (
            <div style={{
              background: '#052e16', border: '1px solid #166534',
              borderRadius: 10, padding: '12px 16px',
              display: 'flex', alignItems: 'center', gap: 8, fontSize: 13,
            }}>
              <CheckCircle size={16} color="#22c55e" />
              <span style={{ color: '#86efac' }}>
                Claimed successfully —{' '}
                <a
                  href={`https://stellar.expert/explorer/public/tx/${lastTxHash}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: Y, textDecoration: 'underline' }}
                >
                  View tx
                </a>
              </span>
            </div>
          )}

          {error && (
            <div style={{
              background: '#1c0707', border: '1px solid #7f1d1d',
              borderRadius: 10, padding: '12px 16px',
              display: 'flex', alignItems: 'center', gap: 8, fontSize: 13,
            }}>
              <AlertCircle size={16} color="#ef4444" />
              <span style={{ color: '#fca5a5', flex: 1 }}>{error}</span>
              <button
                onClick={clearError}
                style={{ background: 'none', border: 'none', color: T2, cursor: 'pointer', fontSize: 16 }}
              >
                ×
              </button>
            </div>
          )}

          {/* Filter tabs */}
          {schedules.length > 0 && (
            <div style={{ display: 'flex', gap: 6 }}>
              {(['all', 'active', 'revoked'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  style={{
                    background: filter === f ? Y : BR,
                    color: filter === f ? '#000' : T2,
                    border: 'none', borderRadius: 8,
                    padding: '6px 16px', fontSize: 13,
                    fontWeight: filter === f ? 700 : 400,
                    cursor: 'pointer', textTransform: 'capitalize',
                    transition: 'background 0.15s',
                  }}
                >
                  {f}
                </button>
              ))}
            </div>
          )}

          {/* Schedule list */}
          {isLoading ? (
            <div style={{ textAlign: 'center', padding: '60px 0', color: T2 }}>
              Loading schedules...
            </div>
          ) : filtered.length === 0 ? (
            <div
              style={{
                background: S, border: `1px solid ${BR}`,
                borderRadius: 16, padding: '48px 32px', textAlign: 'center',
              }}
            >
              <Clock size={36} style={{ color: T2, margin: '0 auto 12px' }} />
              <p style={{ color: W, fontWeight: 600, marginBottom: 6 }}>No vesting schedules</p>
              <p style={{ color: T2, fontSize: 14 }}>
                {filter === 'all'
                  ? 'Your wallet has no vesting schedules assigned.'
                  : `No ${filter} schedules found.`}
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {filtered.map((s) => (
                <ScheduleCard
                  key={s.scheduleId}
                  schedule={s}
                  onClaim={claim}
                  isSubmitting={isSubmitting}
                  currentLedger={currentLedger}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Info section */}
      <div
        style={{
          background: S, border: `1px solid ${BR}`,
          borderRadius: 16, padding: '24px',
        }}
      >
        <h3 style={{ fontSize: 14, fontWeight: 600, color: W, marginBottom: 12 }}>
          How Vesting Works
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[
            { icon: '🔒', title: 'Cliff Period', desc: 'No tokens can be claimed before the cliff ledger.' },
            { icon: '📈', title: 'Linear Unlock', desc: 'After the cliff, tokens unlock linearly from start to end ledger.' },
            { icon: '✅', title: 'Claim Anytime', desc: 'Claim vested tokens at any time — unclaimed tokens accumulate.' },
            { icon: '↩️', title: 'Revocable', desc: 'If marked revocable, admin can cancel unvested tokens. Already-vested tokens remain claimable.' },
          ].map((item) => (
            <div key={item.title} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 16, flexShrink: 0 }}>{item.icon}</span>
              <div>
                <p style={{ fontSize: 13, fontWeight: 600, color: W }}>{item.title}</p>
                <p style={{ fontSize: 12, color: T2, marginTop: 2 }}>{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
