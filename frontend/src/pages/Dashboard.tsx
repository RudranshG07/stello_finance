/**
 * Dashboard — sXLM Protocol landing page
 *
 * Design language:
 *  – Fonts  : Inter (app default, no overrides)
 *  – Colors : Stellar brand — #000 black · #fff white · #F5CF00 yellow
 *  – Cards  : bg-surface (#111) · border (#222) — matches Stake/Withdraw pages
 *  – Buttons: bg-white text-black (primary) · ghost (secondary) — matches .btn
 *  – Layout : Lido.fi structure — stats strip · numbered list · product cards
 */

import { useState, useRef, useEffect, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useProtocol } from '../hooks/useProtocol';
import { useWallet } from '../hooks/useWallet';
import { useTransactionExport } from '../hooks/useTransactionExport';

/* ── Stellar brand palette ────────────────────────────────────────────────── */
const Y  = '#F5CF00';   // Stellar yellow
const YD = '#D4A800';   // yellow dark (hover)
const B  = '#000000';   // black bg
const S  = '#0d0d0d';   // surface
const BR = '#1e1e1e';   // border
const W  = '#ffffff';   // white
const T2 = '#a3a3a3';   // neutral-400 secondary text
const T3 = '#525252';   // neutral-600 muted text

/* ── Animated counter ─────────────────────────────────────────────────────── */
function useCountUp(target: number, duration = 1600) {
  const [val, setVal] = useState(0);
  const done = useRef(false);
  useEffect(() => {
    if (target === 0 || done.current) return;
    done.current = true;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min((now - t0) / duration, 1);
      setVal(target * (1 - Math.pow(1 - p, 4)));
      if (p < 1) requestAnimationFrame(tick);
      else setVal(target);
    };
    requestAnimationFrame(tick);
  }, [target, duration]);
  return val;
}

function fmt(n: number, dec = 2) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(dec)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(dec)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(dec)}K`;
  return n.toFixed(dec);
}

/* ── Stellar logo mark ────────────────────────────────────────────────────── */
function StellarMark({ size = 28, color = W }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <path
        d="M24.7 10.56l-1.57.78-13.42 6.68a6.4 6.4 0 01-.07-1 6.5 6.5 0 019.65-5.68l1.75-.87.34-.17A8 8 0 008 16a8.1 8.1 0 00.1 1.25L5.3 18.7v1.74l3.43-1.71a8 8 0 0015.12-2.48L26.7 15v-1.74l-2.56 1.27A8.07 8.07 0 0024.2 13l2.5-1.25v-1.73zM16 22.5a6.5 6.5 0 01-6-3.99l13.5-6.72A6.5 6.5 0 0116 22.5z"
        fill={color}
      />
    </svg>
  );
}

/* ── Hero visual: Stello mascot ──────────────────────────────────────────── */
function StellarHeroVisual({ aprVal }: { aprVal: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20 }}>
      {/* Mascot with float animation + yellow glow halo */}
      <div style={{ position: 'relative', display: 'flex', justifyContent: 'center' }}>
        {/* Radial glow behind mascot */}
        <div style={{
          position: 'absolute',
          bottom: 0,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 220,
          height: 80,
          background: `radial-gradient(ellipse, ${Y}22 0%, transparent 70%)`,
          filter: 'blur(12px)',
          pointerEvents: 'none',
        }} />
        <img
          src="/mascot.jpeg"
          alt="Stello mascot"
          style={{
            height: 400,
            width: 'auto',
            objectFit: 'contain',
            animation: 'stellar-float 4s ease-in-out infinite',
            display: 'block',
            position: 'relative',
            zIndex: 1,
            // mascot has black bg — blend it into the dark page
            mixBlendMode: 'screen',
          }}
        />
      </div>

      {/* Stats strip below mascot */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1,
        width: '100%', background: BR,
        border: `1px solid ${BR}`, borderRadius: 12, overflow: 'hidden',
      }}>
        {[
          { label: 'APR', value: aprVal },
          { label: 'Network', value: 'Stellar' },
        ].map((s) => (
          <div key={s.label} style={{ background: 'rgba(13,13,13,0.9)', padding: '16px 20px', textAlign: 'center' }}>
            <p style={{ fontSize: 18, fontWeight: 700, color: s.label === 'APR' ? Y : W, marginBottom: 2 }}>
              {s.value}
            </p>
            <p style={{ fontSize: 11, color: T3, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
              {s.label}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Numbered block (Lido pattern) ───────────────────────────────────────── */
function NumberedBlock({
  num, title, desc, tag, _accentTag = Y, delay = 0, isLast = false,
}: {
  num: string; title: string; desc: string; tag?: string;
  accentTag?: string; delay?: number; isLast?: boolean;
}) {
  return (
    <div
      className="lido-reveal"
      style={{
        animationDelay: `${delay}ms`,
        display: 'grid',
        gridTemplateColumns: '80px 1fr',
        gap: '0 32px',
        padding: '32px 0',
        borderBottom: isLast ? 'none' : `1px solid ${BR}`,
        alignItems: 'start',
      }}
    >
      <div style={{
        fontSize: 40, fontWeight: 700, lineHeight: 1,
        color: 'rgba(255,255,255,0.06)',
        letterSpacing: '-1px', paddingTop: 2,
      }}>
        {num}
      </div>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, color: W }}>
            {title}
          </h3>
          {tag && (
            <span style={{
              fontSize: 10, color: Y,
              border: `1px solid ${Y}35`,
              borderRadius: 4, padding: '1px 7px',
              letterSpacing: '0.05em', fontWeight: 500,
            }}>
              {tag}
            </span>
          )}
        </div>
        <p style={{ fontSize: 13, color: T2, lineHeight: 1.75 }}>
          {desc}
        </p>
      </div>
    </div>
  );
}

/* ── Product card ─────────────────────────────────────────────────────────── */
function ProductCard({
  icon, title, stat, statLabel, desc, href, delay = 0,
}: {
  icon: string; title: string; stat?: string; statLabel?: string;
  desc: string; href: string; delay?: number;
}) {
  const [hov, setHov] = useState(false);
  return (
    <Link
      to={href}
      className="lido-reveal"
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        animationDelay: `${delay}ms`,
        display: 'block', textDecoration: 'none',
        background: hov ? '#161616' : S,
        borderTop: `1px solid ${BR}`,
        borderBottom: `1px solid ${BR}`,
        borderRight: `1px solid ${BR}`,
        padding: '28px 24px',
        transition: 'background 0.2s',
      }}
    >
      <div style={{
        width: 40, height: 40, borderRadius: 8, marginBottom: 18,
        background: `${Y}15`, border: `1px solid ${Y}25`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 18,
      }}>
        {icon}
      </div>
      <h4 style={{ fontSize: 15, fontWeight: 600, color: W, marginBottom: 6 }}>
        {title}
      </h4>
      {stat && (
        <div style={{ marginBottom: 10 }}>
          <span style={{ fontSize: 20, fontWeight: 700, color: Y }}>{stat}</span>
          {statLabel && <span style={{ fontSize: 12, color: T3, marginLeft: 5 }}>{statLabel}</span>}
        </div>
      )}
      <p style={{ fontSize: 12, color: T2, lineHeight: 1.7, marginBottom: 18 }}>
        {desc}
      </p>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4,
        fontSize: 12, fontWeight: 500,
        color: hov ? Y : T3,
        transition: 'color 0.2s',
      }}>
        Open <span>→</span>
      </div>
    </Link>
  );
}

/* ── Main ─────────────────────────────────────────────────────────────────── */
export default function Dashboard() {
  const { stats, apy, isLoading } = useProtocol();
  const { isConnected } = useWallet();
  const { exportTransactionsCSV, isExporting } = useTransactionExport();

  const tvlXlm  = stats.totalStaked / 1e7;
  const apr     = apy.currentApy > 0 ? apy.currentApy : (apy.apy30d > 0 ? apy.apy30d : 0);
  const er      = stats.exchangeRate;

  const aniApr  = useCountUp(apr);
  const aniTvl  = useCountUp(tvlXlm);
  const aniEr   = useCountUp(er);

  const aprDisplay  = isLoading ? '—' : apr > 0 ? `${aniApr.toFixed(2)}%` : '—';
  const tvlDisplay  = isLoading ? '—' : `${fmt(aniTvl, 0)} XLM`;
  const erDisplay   = isLoading ? '—' : aniEr.toFixed(4);

  /* Shared layout helpers */
  const wrap = (maxW = 1100): CSSProperties => ({ maxWidth: maxW, margin: '0 auto', padding: '0 24px' });
  const divider: CSSProperties = { borderTop: `1px solid ${BR}` };
  const sectionPad = (py = 80): CSSProperties => ({ padding: `${py}px 0` });

  /* Yellow label */
  const yl: CSSProperties = {
    fontSize: 11, textTransform: 'uppercase' as const,
    letterSpacing: '0.12em', color: Y, marginBottom: 12,
  };

  /* Section heading */
  const sh: CSSProperties = {
    fontSize: 'clamp(1.7rem, 3.2vw, 2.4rem)', fontWeight: 700,
    color: W, lineHeight: 1.15, letterSpacing: '-0.3px',
  };

  return (
    <div style={{ background: 'transparent', color: W, minHeight: '100vh' }}>

      {/* ══ HERO ═══════════════════════════════════════════════════════ */}
      <section style={{ ...sectionPad(72), borderBottom: `1px solid ${BR}`, background: 'transparent' }}>
        <div style={wrap()}>
          <div className="lido-hero-grid">

            {/* Left */}
            <div>
              {/* Badge */}
              <div className="lido-fade" style={{
                display: 'inline-flex', alignItems: 'center', gap: 7,
                padding: '4px 12px', borderRadius: 4,
                border: `1px solid ${BR}`,
                background: S,
                fontSize: 11, color: T2, marginBottom: 28,
                letterSpacing: '0.02em',
              }}>
                <StellarMark size={13} color={Y} />
                Stellar · Soroban Smart Contracts
                <span style={{
                  background: '#1a1a1a', border: `1px solid ${BR}`,
                  borderRadius: 3, padding: '0 6px', fontSize: 10, color: T3,
                }}>Testnet</span>
              </div>

              <h1 className="lido-reveal" style={{
                fontSize: 'clamp(2.6rem, 5.5vw, 4.5rem)',
                fontWeight: 700, lineHeight: 1.06,
                color: W, marginBottom: 20,
                animationDelay: '50ms', letterSpacing: '-1px',
              }}>
                Liquid Staking<br />
                <span style={{ color: Y }}>for Stellar</span>
              </h1>

              <p className="lido-reveal" style={{
                fontSize: 16, color: T2, lineHeight: 1.75,
                marginBottom: 36, maxWidth: 460,
                animationDelay: '130ms',
              }}>
                Stake XLM, receive{' '}
                <strong style={{ color: W, fontWeight: 600 }}>sXLM</strong>{' '}
                — a yield-bearing token that appreciates automatically.
                Stay liquid while earning Stellar staking rewards.
              </p>

              <div className="lido-reveal" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', animationDelay: '200ms' }}>
                <Link
                  to="/stake"
                  style={{
                    background: Y, color: B,
                    padding: '12px 28px', borderRadius: 6,
                    fontSize: 14, fontWeight: 600, textDecoration: 'none',
                    display: 'inline-block',
                    transition: 'background 0.15s, transform 0.15s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = YD; e.currentTarget.style.transform = 'translateY(-1px)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = Y; e.currentTarget.style.transform = 'none'; }}
                >
                  Stake XLM
                </Link>
                <Link
                  to="/withdraw"
                  style={{
                    background: 'transparent', color: W,
                    padding: '12px 28px', borderRadius: 6,
                    border: `1px solid ${BR}`,
                    fontSize: 14, fontWeight: 500, textDecoration: 'none',
                    display: 'inline-block',
                    transition: 'border-color 0.15s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = '#555')}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = BR)}
                >
                  Withdraw
                </Link>
              </div>
            </div>

            {/* Right — 3D Stellar visual */}
            <div className="lido-fade" style={{ animationDelay: '250ms' }}>
              <StellarHeroVisual aprVal={aprDisplay} />
            </div>
          </div>
        </div>
      </section>

      {/* ══ STATS STRIP (Lido — plain numbers, border dividers) ════════ */}
      <section style={{ background: 'rgba(13,13,13,0.85)', borderBottom: `1px solid ${BR}` }}>
        <div style={{ ...wrap(), padding: '0 24px' }}>
          <div className="lido-stat-strip">
            {[
              { label: 'Total XLM Staked', val: tvlDisplay,  sub: stats.tvlUsd > 0 ? `≈ $${fmt(stats.tvlUsd)}` : undefined },
              { label: 'Current APR',       val: aprDisplay,   sub: apy.apy30d > 0 ? `30d: ${apy.apy30d.toFixed(2)}%` : undefined },
              { label: 'Exchange Rate',     val: erDisplay,    sub: '1 sXLM → XLM' },
            ].map((s, i) => (
              <div key={i} className="lido-reveal" style={{
                animationDelay: `${i * 60}ms`,
                flex: 1, padding: '28px 28px',
                borderRight: `1px solid ${BR}`,
              }}>
                <p style={{ fontSize: 26, fontWeight: 700, color: W, lineHeight: 1, marginBottom: 4 }}>
                  {s.val}
                </p>
                {s.sub && <p style={{ fontSize: 11, color: T3, fontFamily: 'monospace', marginBottom: 4 }}>{s.sub}</p>}
                <p style={{ fontSize: 11, color: T3, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                  {s.label}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══ EXPORT TRANSACTIONS ═════════════════════════════════════════ */}
      {isConnected && (
        <section style={{ borderBottom: `1px solid ${BR}`, background: 'rgba(13,13,13,0.4)' }}>
          <div style={wrap()}>
            <div style={{ ...sectionPad(32), display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <p style={yl}>Audit & Tax Reporting</p>
                <h3 style={{ ...sh, marginBottom: 0, fontSize: 18 }}>Export Transaction History</h3>
              </div>
              <button
                onClick={exportTransactionsCSV}
                disabled={isExporting}
                style={{
                  background: Y,
                  color: B,
                  padding: '10px 24px',
                  borderRadius: 6,
                  border: 'none',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: isExporting ? 'not-allowed' : 'pointer',
                  transition: 'background 0.15s',
                  opacity: isExporting ? 0.6 : 1,
                }}
                onMouseEnter={(e) => !isExporting && (e.currentTarget.style.background = YD)}
                onMouseLeave={(e) => (e.currentTarget.style.background = Y)}
              >
                {isExporting ? 'Exporting...' : 'Download CSV'}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* ══ WHAT IS sXLM ════════════════════════════════════════════════ */}
      <section style={{ ...sectionPad(), ...divider }}>
        <div style={wrap()}>
          <div className="lido-two-col">

            {/* Left */}
            <div className="lido-reveal">
              <p style={yl}>The Protocol</p>
              <h2 style={{ ...sh, marginBottom: 20 }}>
                Native XLM<br />
                <span style={{ color: Y }}>Liquid Restaking</span>
              </h2>
              <div style={{ width: 32, height: 2, background: Y, marginBottom: 20 }} />
              <p style={{ fontSize: 14, color: T2, lineHeight: 1.8, marginBottom: 14 }}>
                Deposit XLM into the Staking Pool Contract on Soroban. Receive{' '}
                <strong style={{ color: W }}>sXLM</strong> — a yield-bearing token that
                automatically appreciates as validator rewards accrue.
              </p>
              <p style={{ fontSize: 14, color: T2, lineHeight: 1.8 }}>
                No lockups. No manual reward claims. The exchange rate rises every epoch —
                your sXLM is worth more XLM over time.
              </p>
            </div>

            {/* Right — formula */}
            <div className="lido-reveal" style={{
              animationDelay: '100ms',
              background: 'rgba(13,13,13,0.85)', border: `1px solid ${BR}`, borderRadius: 8, padding: 28,
            }}>
              <p style={{ fontSize: 10, color: T3, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 20 }}>
                Exchange Rate Model
              </p>
              <div style={{ fontFamily: 'monospace', fontSize: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 20px', marginBottom: 20, color: T2 }}>
                  <span style={{ color: T3 }}>T_xlm</span>  <span>Total XLM staked</span>
                  <span style={{ color: T3 }}>T_sxlm</span> <span>Total sXLM supply</span>
                </div>
                <div style={{ borderTop: `1px solid ${BR}`, paddingTop: 18, marginBottom: 18 }}>
                  <p style={{ fontSize: 18, fontWeight: 700, color: W, marginBottom: 6 }}>
                    ER = T_xlm / T_sxlm
                  </p>
                  <p style={{ color: T3, fontSize: 11 }}>Rewards ↑ T_xlm · Supply fixed → ER rises</p>
                </div>
                <div style={{ borderTop: `1px solid ${BR}`, paddingTop: 18, marginBottom: er > 1 ? 18 : 0 }}>
                  <p style={{ color: T2, marginBottom: 4 }}>APY = (ER₁/ER₀)^(1/Δt) − 1</p>
                  <p style={{ color: T3, fontSize: 11 }}>Compound growth, epoch-based</p>
                </div>
                {er > 1 && (
                  <div style={{ borderTop: `1px solid ${BR}`, paddingTop: 18 }}>
                    <p style={{ color: T3, fontSize: 11, marginBottom: 6 }}>Live exchange rate</p>
                    <p style={{ fontSize: 22, fontWeight: 700, color: Y }}>{er.toFixed(7)}</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ══ PROTOCOL FEATURES — numbered list ═══════════════════════════ */}
      <section style={{ ...sectionPad(), background: 'rgba(13,13,13,0.85)', ...divider, borderBottom: `1px solid ${BR}` }}>
        <div style={wrap()}>
          <p style={yl}>5 Milestones · Fully built</p>
          <h2 style={{ ...sh, marginBottom: 40 }}>Protocol Features</h2>

          <div style={{ borderTop: `1px solid ${BR}` }}>
            {([
              { n:'01', title:'Liquid Staking MVP',    desc:'Deposit XLM → mint sXLM. The exchange rate automatically rises as validator rewards accrue. No manual claiming. sXLM = XLM / ER on mint, XLM = sXLM × ER on burn.',           tag:'M1' },
              { n:'02', title:'Exchange Rate Engine',   desc:'APR/APY derived purely from on-chain exchange rate history. No hardcoded yields — what you see is what the protocol actually earns from lending interest.',                    tag:'M2' },
              { n:'03', title:'Withdrawal Queue',      desc:'Instant redemption via the liquidity buffer (D × α safety factor). Delayed queue with ~24h cooldown. Slashing-aware accounting throughout the entire withdrawal flow.',         tag:'M3' },
              { n:'04', title:'Risk Engine',           desc:'Slashing impact model: T_xlm,new = T_xlm,old × (1 − s). Emergency pause logic for protocol safety. Withdrawal queue recalculation after slashing events.',                    tag:'M4' },
              { n:'05', title:'Capital Efficiency',    desc:'Use sXLM as collateral in the lending protocol. AMM liquidity pool (sXLM/XLM). Leverage loop up to 3.33× with Net Yield = (L×r) − ((L−1)×b). Governance DAO.',               tag:'M5' },
            ] as const).map((f, i, arr) => (
              <NumberedBlock
                key={i} num={f.n} title={f.title} desc={f.desc} tag={f.tag}
                delay={i * 50} isLast={i === arr.length - 1}
              />
            ))}
          </div>
        </div>
      </section>

      {/* ══ DeFi ECOSYSTEM ══════════════════════════════════════════════ */}
      <section style={{ ...sectionPad(), ...divider }}>
        <div style={wrap()}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 32, flexWrap: 'wrap', gap: 16 }}>
            <div>
              <p style={yl}>Full DeFi Composability</p>
              <h2 style={sh}>
                sXLM is a<br />
                <span style={{ color: Y }}>base yield asset</span>
              </h2>
            </div>
            <p style={{ fontSize: 13, color: T2, maxWidth: 320, lineHeight: 1.7 }}>
              Use sXLM across the protocol ecosystem.<br />
              Every product amplifies your staking yield.
            </p>
          </div>

          {/* Product cards — Lido style: flush border grid */}
          <div style={{ border: `1px solid ${BR}`, borderRadius: 8, overflow: 'hidden' }}>
            <div className="lido-four-cards" style={{ background: BR }}>
              <ProductCard icon="🏦" title="Lending"    href="/lending"    stat="70%" statLabel="max LTV"      desc="Deposit sXLM as collateral. Borrow XLM at 70% LTV. Health factor monitored on-chain." delay={0} />
              <ProductCard icon="💧" title="Liquidity"  href="/liquidity"  stat="0.3%" statLabel="swap fee"   desc="Provide sXLM/XLM liquidity to the AMM pool. Earn swap fees on top of staking yield." delay={60} />
              <ProductCard icon="⚡" title="Leverage"   href="/leverage"   stat="3.33×" statLabel="max"       desc="Stake → collateral → borrow → restake. Up to 3.33× with live net yield calculator." delay={120} />
              <ProductCard icon="🗳" title="Governance" href="/governance"             desc="Vote on protocol parameters using sXLM balance. Create and execute on-chain proposals." delay={180} />
            </div>
          </div>

          {/* Minting example row */}
          <div style={{
            marginTop: 1, background: S,
            border: `1px solid ${BR}`, borderTop: 'none',
            borderRadius: '0 0 8px 8px',
          }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', borderTop: `1px solid ${BR}` }}>
              {[
                { label: 'You deposit',    val: '120 XLM'   },
                { label: 'Exchange rate',  val: '1.2000'    },
                { label: 'sXLM received',  val: '100 sXLM'  },
                { label: 'After 1 year',  val: '100 sXLM + yield' },
              ].map((item, i) => (
                <div key={i} style={{
                  padding: '16px 24px', textAlign: 'center',
                  borderRight: i < 3 ? `1px solid ${BR}` : 'none',
                }}>
                  <p style={{ fontSize: 11, color: T3, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>
                    {item.label}
                  </p>
                  <p style={{ fontSize: 16, fontWeight: 600, color: W }}>{item.val}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ══ LIVE STATS — border grid ════════════════════════════════════ */}
      <section style={{ ...sectionPad(), ...divider }}>
        <div style={wrap()}>
          <p style={yl}>On-chain · Real-time</p>
          <h2 style={{ ...sh, marginBottom: 32 }}>Protocol Statistics</h2>

          <div style={{ border: `1px solid ${BR}`, borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)' }}>
              {([
                { label: 'Total XLM Staked', val: isLoading ? '—' : `${fmt(tvlXlm)} XLM`,               sub: stats.tvlUsd > 0 ? `$${fmt(stats.tvlUsd)}` : undefined },
                { label: 'Current APR',       val: isLoading ? '—' : apr > 0 ? `${apr.toFixed(2)}%` : '—', sub: apy.apy30d > 0 ? `30d: ${apy.apy30d.toFixed(2)}%` : undefined },
                { label: 'Exchange Rate',     val: isLoading ? '—' : er.toFixed(4),                        sub: '1 sXLM = ER × XLM' },
                { label: 'Protocol Fee',      val: `${stats.protocolFeePct}%`,                              sub: 'on rewards' },
                { label: 'Stakers',           val: isLoading ? '—' : stats.totalStakers > 0 ? fmt(stats.totalStakers, 0) : '—', sub: 'unique wallets' },
                { label: 'Withdrawal',        val: '~24h',                                                  sub: 'delayed queue' },
                { label: 'Treasury',          val: isLoading ? '—' : `${fmt(stats.treasuryBalance / 1e7)} XLM`, sub: 'collected fees' },
              ] as const).map((s, i) => {
                const lastRow = i >= 4;
                const lastCol = (i + 1) % 4 === 0;
                return (
                  <div key={s.label} style={{
                    padding: '24px 22px',
                    borderRight: lastCol ? 'none' : `1px solid ${BR}`,
                    borderBottom: lastRow ? 'none' : `1px solid ${BR}`,
                    background: 'transparent',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = S)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                    <p style={{ fontSize: 22, fontWeight: 700, color: W, marginBottom: 3, lineHeight: 1 }}>{s.val}</p>
                    {s.sub && <p style={{ fontSize: 11, color: T3, fontFamily: 'monospace', marginBottom: 6 }}>{s.sub}</p>}
                    <p style={{ fontSize: 11, color: T3, textTransform: 'uppercase', letterSpacing: '0.09em' }}>{s.label}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* ══ CTA ═════════════════════════════════════════════════════════ */}
      <section style={{ ...sectionPad(96), background: 'rgba(13,13,13,0.85)', ...divider, borderBottom: `1px solid ${BR}` }}>
        <div style={{ ...wrap(600), textAlign: 'center' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 24 }}>
            <div style={{
              width: 56, height: 56, borderRadius: '50%',
              background: `${Y}15`, border: `1px solid ${Y}30`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <StellarMark size={28} color={Y} />
            </div>
          </div>
          <h2 style={{ ...sh, fontSize: 'clamp(1.8rem, 4vw, 3rem)', marginBottom: 16 }}>
            Start earning on<br />
            <span style={{ color: Y }}>your XLM today</span>
          </h2>
          <p style={{ fontSize: 15, color: T2, marginBottom: 40, lineHeight: 1.75 }}>
            Join the Native XLM Liquid Restaking Protocol.<br />
            Non-custodial. Permissionless. Built on Stellar.
          </p>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Link
              to="/stake"
              style={{
                background: Y, color: B,
                padding: '13px 36px', borderRadius: 6,
                fontSize: 15, fontWeight: 600, textDecoration: 'none',
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = YD)}
              onMouseLeave={(e) => (e.currentTarget.style.background = Y)}
            >
              Stake XLM
            </Link>
            <Link
              to="/analytics"
              style={{
                background: 'transparent', color: W,
                padding: '13px 36px', borderRadius: 6,
                border: `1px solid ${BR}`,
                fontSize: 15, fontWeight: 500, textDecoration: 'none',
                transition: 'border-color 0.15s',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = '#555')}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = BR)}
            >
              View Analytics
            </Link>
          </div>
        </div>
      </section>

      {/* ══ FOOTER ══════════════════════════════════════════════════════ */}
      <footer style={{ borderTop: `1px solid ${BR}`, padding: '48px 0 36px', background: 'rgba(0,0,0,0.9)' }}>
        <div style={wrap()}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 40, marginBottom: 40 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                <StellarMark size={20} color={Y} />
                <span style={{ fontWeight: 700, fontSize: 14, color: W }}>sXLM Protocol</span>
              </div>
              <p style={{ fontSize: 12, color: T3, lineHeight: 1.7 }}>
                Native XLM Liquid Restaking<br />on Stellar · Soroban Smart Contracts
              </p>
            </div>
            {[
              { heading: 'Protocol',   links: [['Stake','/stake'],['Withdraw','/withdraw'],['Analytics','/analytics']] },
              { heading: 'DeFi',       links: [['Lending','/lending'],['Liquidity','/liquidity'],['Leverage','/leverage'],['Restaking','/restaking']] },
              { heading: 'Governance', links: [['Governance','/governance']] },
            ].map((col) => (
              <div key={col.heading}>
                <p style={{ fontSize: 10, color: T3, textTransform: 'uppercase', letterSpacing: '0.13em', marginBottom: 16 }}>
                  {col.heading}
                </p>
                {col.links.map(([label, href]) => (
                  <Link
                    key={href} to={href}
                    style={{ display: 'block', fontSize: 13, color: T2, marginBottom: 9, textDecoration: 'none', transition: 'color 0.15s' }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = W)}
                    onMouseLeave={(e) => (e.currentTarget.style.color = T2)}
                  >{label}</Link>
                ))}
              </div>
            ))}
          </div>

          <div style={{ borderTop: `1px solid ${BR}`, paddingTop: 28, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <p style={{ fontSize: 12, color: T3 }}>
              © 2025 sXLM Protocol · Native XLM Liquid Restaking
            </p>
            <span style={{ fontSize: 11, border: `1px solid ${BR}`, color: T3, padding: '2px 12px', borderRadius: 4 }}>
              Stellar Testnet
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
