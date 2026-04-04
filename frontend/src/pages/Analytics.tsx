import { useState, useMemo, useEffect } from 'react';
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import { useProtocol } from '../hooks/useProtocol';
import { useAnalytics, type CohortData, type RevenueSeriesPoint } from '../hooks/useAnalytics';

type TimeRange = '7d' | '30d' | '90d';

const Y = '#F5CF00';

const REVENUE_PALETTE: Record<string, string> = {
  LENDING_FEES: '#F5CF00',
  LP_FEES: '#3B82F6',
  STAKING_REWARDS: '#10B981',
  LIQUIDATION_FEES: '#EF4444',
  TREASURY: '#8B5CF6',
};
const FALLBACK_COLORS = ['#F5CF00', '#3B82F6', '#10B981', '#EF4444', '#8B5CF6', '#F97316'];

function revenueColor(source: string, index: number): string {
  return REVENUE_PALETTE[source] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

function retentionToColor(rate: number): string {
  const a = Math.max(0, Math.min(1, rate));
  if (a < 0.04) return '#111';
  return `rgb(${Math.round(20 + 225 * a)}, ${Math.round(20 + 187 * a)}, ${Math.round(Math.max(0, 20 - 20 * a))})`;
}

function toLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function rangeDays(range: TimeRange): number {
  return range === '7d' ? 7 : range === '30d' ? 30 : 90;
}

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 pt-6 pb-2">
      <div className="h-px flex-1" style={{ background: '#1e1e1e' }} />
      <span className="text-[10px] uppercase tracking-widest font-semibold" style={{ color: '#444' }}>
        {label}
      </span>
      <div className="h-px flex-1" style={{ background: '#1e1e1e' }} />
    </div>
  );
}

const tooltipStyle = {
  background: '#0d0d0d',
  border: '1px solid #1e1e1e',
  borderRadius: '8px',
  color: '#fff',
  fontSize: 12,
};

export default function Analytics() {
  const {
    apyHistory, exchangeRateHistory, tvlHistory, totalStakedHistory,
    isLoading: protocolLoading,
  } = useProtocol();
  const {
    utilizationData, revenueSeries, cohortData, liveData,
    lastUpdated, isLoading: analyticsLoading, refresh,
  } = useAnalytics(90);

  const [range, setRange] = useState<TimeRange>('30d');
  const [secondsAgo, setSecondsAgo] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const isLoading = protocolLoading || analyticsLoading;

  // ── "X seconds ago" freshness counter ────────────────────────────────────

  useEffect(() => {
    if (!lastUpdated) return;
    const tick = () =>
      setSecondsAgo(Math.round((Date.now() - lastUpdated.getTime()) / 1000));
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, [lastUpdated]);

  const handleRefresh = () => {
    setRefreshing(true);
    refresh();
    setTimeout(() => setRefreshing(false), 600);
  };

  // ── helpers ───────────────────────────────────────────────────────────────

  function filterHistory(data: Array<{ timestamp: string; value: number }>) {
    const cutoff = Date.now() - rangeDays(range) * 24 * 60 * 60 * 1000;
    return data
      .filter((d) => new Date(d.timestamp).getTime() >= cutoff)
      .map((d) => ({ date: toLabel(d.timestamp), value: d.value }));
  }

  // ── utilization chart data ─────────────────────────────────────────────────

  const utilizationChartData = useMemo(() => {
    const cutoff = Date.now() - rangeDays(range) * 24 * 60 * 60 * 1000;
    return utilizationData
      .filter((d) => new Date(d.windowStart).getTime() >= cutoff)
      .map((d) => ({
        date: toLabel(d.windowStart),
        rate: parseFloat((d.utilizationRate * 100).toFixed(2)),
        deposited: Math.round(d.totalDepositedXlm),
        borrowed: Math.round(d.totalBorrowedXlm),
      }));
  }, [utilizationData, range]);

  // ── revenue chart data ─────────────────────────────────────────────────────

  const revenueSources = useMemo(() => Object.keys(revenueSeries), [revenueSeries]);

  const revenueChartData = useMemo((): Array<Record<string, string | number>> => {
    if (revenueSources.length === 0) return [];
    const cutoff = Date.now() - rangeDays(range) * 24 * 60 * 60 * 1000;

    const dateSet = new Set<string>();
    for (const src of revenueSources) {
      for (const p of (revenueSeries[src] as RevenueSeriesPoint[])) {
        if (new Date(p.windowStart).getTime() >= cutoff) {
          dateSet.add(p.windowStart);
        }
      }
    }

    return Array.from(dateSet)
      .sort()
      .map((windowStart) => {
        const point: Record<string, string | number> = { date: toLabel(windowStart) };
        for (const src of revenueSources) {
          const found = (revenueSeries[src] as RevenueSeriesPoint[]).find(
            (p) => p.windowStart === windowStart
          );
          point[src] = found ? parseFloat(found.amountXlm.toFixed(2)) : 0;
        }
        return point;
      });
  }, [revenueSeries, revenueSources, range]);

  // ── cohort data ────────────────────────────────────────────────────────────

  const maxOffset = useMemo(() => {
    let max = 0;
    for (const c of cohortData) {
      for (const o of c.offsets) {
        if (o.dayOffset > max) max = o.dayOffset;
      }
    }
    return max;
  }, [cohortData]);

  // Day-0 snapshot per cohort for avg position size chart
  const avgPositionData = useMemo(() =>
    cohortData.map((c: CohortData) => {
      const day0 = c.offsets.find((o) => o.dayOffset === 0);
      return {
        date: toLabel(c.cohortDate),
        collateral: day0 ? Math.round(day0.avgCollateralSizeXlm) : 0,
        borrow: day0 ? Math.round(day0.avgBorrowSizeXlm) : 0,
      };
    }),
  [cohortData]);

  // ── loading skeleton ───────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-6">
        <div className="h-6 w-32 rounded animate-pulse" style={{ background: 'rgba(255,255,255,0.05)' }} />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="card h-72 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  // ── render ─────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-3">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-widest mb-2" style={{ color: Y }}>
            On-chain · Real-time
          </p>
          <h1 className="text-2xl font-bold text-white mb-1">Analytics</h1>
          <p className="text-sm" style={{ color: '#525252' }}>Protocol performance over time</p>
        </div>
        <div
          className="flex gap-0.5 rounded-lg p-0.5"
          style={{ background: '#0d0d0d', border: '1px solid #1e1e1e' }}
        >
          {(['7d', '30d', '90d'] as TimeRange[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className="px-3 py-1 rounded text-xs font-medium transition-all duration-150"
              style={{
                background: range === r ? Y : 'transparent',
                color: range === r ? '#000' : '#525252',
                fontWeight: range === r ? 600 : 400,
              }}
              onMouseEnter={(e) => { if (range !== r) e.currentTarget.style.color = '#fff'; }}
              onMouseLeave={(e) => { if (range !== r) e.currentTarget.style.color = '#525252'; }}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* Live stats bar */}
      {liveData && (
        <div
          className="flex flex-wrap items-center gap-5 py-3 px-4 rounded-lg"
          style={{ background: '#0d0d0d', border: '1px solid #1e1e1e' }}
        >
          {liveData.utilization && (
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: Y }} />
              <span className="text-[11px]" style={{ color: '#525252' }}>Utilization</span>
              <span className="text-[11px] font-semibold text-white">
                {(liveData.utilization.utilizationRate * 100).toFixed(1)}%
              </span>
            </div>
          )}
          {liveData.tvl && (
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#3B82F6' }} />
              <span className="text-[11px]" style={{ color: '#525252' }}>Staked</span>
              <span className="text-[11px] font-semibold text-white">
                {liveData.tvl.totalStakedXlm.toLocaleString(undefined, { maximumFractionDigits: 0 })} XLM
              </span>
            </div>
          )}
          {Object.keys(liveData.revenue).length > 0 && (
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#10B981' }} />
              <span className="text-[11px]" style={{ color: '#525252' }}>Latest Revenue</span>
              <span className="text-[11px] font-semibold text-white">
                {Object.values(liveData.revenue).reduce((a, b) => a + b, 0).toFixed(1)} XLM
              </span>
            </div>
          )}
          <div className="ml-auto flex items-center gap-3">
            {secondsAgo !== null && (
              <span className="text-[10px]" style={{ color: '#333' }}>
                updated {secondsAgo}s ago
              </span>
            )}
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              title="Refresh now"
              className="flex items-center justify-center rounded transition-opacity"
              style={{
                width: 22,
                height: 22,
                background: 'transparent',
                border: '1px solid #1e1e1e',
                color: refreshing ? Y : '#525252',
                cursor: refreshing ? 'default' : 'pointer',
                opacity: refreshing ? 0.6 : 1,
              }}
              onMouseEnter={(e) => { if (!refreshing) e.currentTarget.style.color = '#fff'; }}
              onMouseLeave={(e) => { if (!refreshing) e.currentTarget.style.color = '#525252'; }}
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                width="11"
                height="11"
                style={{
                  transformOrigin: 'center',
                  animation: refreshing ? 'spin 0.6s linear' : 'none',
                }}
              >
                <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5c1.8 0 3.4.87 4.4 2.2" />
                <polyline points="13.5 2.5 13.5 4.7 11.3 4.7" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* ── Overview ─────────────────────────────────────────────────────── */}
      <SectionDivider label="Overview" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

        <div className="card p-5">
          <h3 className="text-xs font-medium mb-1" style={{ color: Y }}>APY Over Time</h3>
          <p className="text-[10px] mb-4" style={{ color: '#383838' }}>Annual percentage yield</p>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={filterHistory(apyHistory)}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#444' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: '#444' }} tickFormatter={(v) => `${(v as number).toFixed(1)}%`} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: '#666' }} formatter={(v) => [`${(v as number).toFixed(2)}%`, 'APY']} />
              <Line type="monotone" dataKey="value" stroke={Y} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="card p-5">
          <h3 className="text-xs font-medium mb-1" style={{ color: Y }}>Exchange Rate</h3>
          <p className="text-[10px] mb-4" style={{ color: '#383838' }}>1 sXLM in XLM</p>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={filterHistory(exchangeRateHistory)}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#444' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: '#444' }} domain={['auto', 'auto']} tickFormatter={(v) => (v as number).toFixed(4)} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: '#666' }} formatter={(v) => [(v as number).toFixed(6), 'Rate']} />
              <Line type="monotone" dataKey="value" stroke={Y} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="card p-5">
          <h3 className="text-xs font-medium mb-1" style={{ color: Y }}>Total Value Locked</h3>
          <p className="text-[10px] mb-4" style={{ color: '#383838' }}>USD equivalent</p>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={filterHistory(tvlHistory)}>
              <defs>
                <linearGradient id="tvlGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={Y} stopOpacity={0.15} />
                  <stop offset="100%" stopColor={Y} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#444' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: '#444' }} tickFormatter={(v) => `$${((v as number) / 1e6).toFixed(1)}M`} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: '#666' }} formatter={(v) => [`$${(v as number).toLocaleString()}`, 'TVL']} />
              <Area type="monotone" dataKey="value" stroke={Y} fill="url(#tvlGrad)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="card p-5">
          <h3 className="text-xs font-medium mb-1" style={{ color: Y }}>Total XLM Staked</h3>
          <p className="text-[10px] mb-4" style={{ color: '#383838' }}>Protocol deposits</p>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={filterHistory(totalStakedHistory)}>
              <defs>
                <linearGradient id="stakedGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={Y} stopOpacity={0.15} />
                  <stop offset="100%" stopColor={Y} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#444' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: '#444' }} tickFormatter={(v) => `${((v as number) / 1e6).toFixed(1)}M`} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: '#666' }} formatter={(v) => [`${(v as number).toLocaleString()} XLM`, 'Staked']} />
              <Area type="monotone" dataKey="value" stroke={Y} fill="url(#stakedGrad)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Lending Health ────────────────────────────────────────────────── */}
      <SectionDivider label="Lending Health" />

      <div className="card p-5">
        <div className="flex items-start justify-between flex-wrap gap-3 mb-4">
          <div>
            <h3 className="text-xs font-medium mb-1" style={{ color: Y }}>Utilization Rate</h3>
            <p className="text-[10px]" style={{ color: '#383838' }}>Borrowed ÷ deposited over time</p>
          </div>
          {liveData?.utilization && (
            <div className="text-right">
              <p className="text-lg font-bold text-white">
                {(liveData.utilization.utilizationRate * 100).toFixed(1)}%
              </p>
              <p className="text-[10px]" style={{ color: '#525252' }}>live</p>
            </div>
          )}
        </div>
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={utilizationChartData}>
            <defs>
              <linearGradient id="utilizationGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={Y} stopOpacity={0.22} />
                <stop offset="100%" stopColor={Y} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#444' }} axisLine={false} tickLine={false} />
            <YAxis
              tick={{ fontSize: 10, fill: '#444' }}
              tickFormatter={(v) => `${v}%`}
              domain={[0, 100]}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={{ color: '#666' }}
              formatter={(v) => [`${(v as number).toFixed(2)}%`, 'Utilization']}
            />
            <Area type="monotone" dataKey="rate" stroke={Y} fill="url(#utilizationGrad)" strokeWidth={2} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="card p-5">
          <h3 className="text-xs font-medium mb-1" style={{ color: '#3B82F6' }}>Total Deposited</h3>
          <p className="text-[10px] mb-4" style={{ color: '#383838' }}>Lending pool deposits (XLM)</p>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={utilizationChartData}>
              <defs>
                <linearGradient id="depositGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3B82F6" stopOpacity={0.2} />
                  <stop offset="100%" stopColor="#3B82F6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#444' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: '#444' }} tickFormatter={(v) => `${((v as number) / 1e6).toFixed(1)}M`} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: '#666' }} formatter={(v) => [`${(v as number).toLocaleString()} XLM`, 'Deposited']} />
              <Area type="monotone" dataKey="deposited" stroke="#3B82F6" fill="url(#depositGrad)" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="card p-5">
          <h3 className="text-xs font-medium mb-1" style={{ color: '#10B981' }}>Total Borrowed</h3>
          <p className="text-[10px] mb-4" style={{ color: '#383838' }}>Outstanding borrows (XLM)</p>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={utilizationChartData}>
              <defs>
                <linearGradient id="borrowGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#10B981" stopOpacity={0.2} />
                  <stop offset="100%" stopColor="#10B981" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#444' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: '#444' }} tickFormatter={(v) => `${((v as number) / 1e6).toFixed(1)}M`} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: '#666' }} formatter={(v) => [`${(v as number).toLocaleString()} XLM`, 'Borrowed']} />
              <Area type="monotone" dataKey="borrowed" stroke="#10B981" fill="url(#borrowGrad)" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Revenue Breakdown ─────────────────────────────────────────────── */}
      <SectionDivider label="Revenue Breakdown" />

      <div className="card p-5">
        <div className="flex items-start justify-between flex-wrap gap-3 mb-4">
          <div>
            <h3 className="text-xs font-medium mb-1" style={{ color: Y }}>Revenue by Source</h3>
            <p className="text-[10px]" style={{ color: '#383838' }}>XLM accrued per revenue stream (stacked)</p>
          </div>
          <div className="flex flex-wrap gap-3">
            {revenueSources.map((src, i) => (
              <div key={src} className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full" style={{ background: revenueColor(src, i) }} />
                <span className="text-[10px]" style={{ color: '#525252' }}>
                  {src.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                </span>
              </div>
            ))}
          </div>
        </div>
        {revenueChartData.length === 0 ? (
          <p className="text-xs text-center py-10" style={{ color: '#525252' }}>No revenue data</p>
        ) : (
          <ResponsiveContainer width="100%" height={270}>
            <AreaChart data={revenueChartData}>
              <defs>
                {revenueSources.map((src, i) => (
                  <linearGradient key={src} id={`revGrad_${src}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={revenueColor(src, i)} stopOpacity={0.4} />
                    <stop offset="100%" stopColor={revenueColor(src, i)} stopOpacity={0.05} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#444' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: '#444' }} tickFormatter={(v) => `${v}`} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={tooltipStyle}
                labelStyle={{ color: '#666' }}
                formatter={(v, name) => [
                  `${(v as number).toFixed(2)} XLM`,
                  (name as string).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
                ]}
              />
              {revenueSources.map((src, i) => (
                <Area
                  key={src}
                  type="monotone"
                  dataKey={src}
                  stackId="rev"
                  stroke={revenueColor(src, i)}
                  fill={`url(#revGrad_${src})`}
                  strokeWidth={1.5}
                  dot={false}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── User Cohorts ──────────────────────────────────────────────────── */}
      <SectionDivider label="User Cohorts" />

      <div className="card p-5">
        <h3 className="text-xs font-medium mb-1" style={{ color: Y }}>Cohort Retention Heatmap</h3>
        <p className="text-[10px] mb-4" style={{ color: '#383838' }}>
          % of wallets still active at day N after first activity — brighter cell = higher retention
        </p>
        {cohortData.length === 0 ? (
          <p className="text-xs text-center py-10" style={{ color: '#525252' }}>No cohort data available</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="text-[10px]" style={{ borderCollapse: 'separate', borderSpacing: '2px', width: '100%' }}>
              <thead>
                <tr>
                  <th
                    className="text-left pb-2 pr-4 font-medium"
                    style={{ color: '#525252', whiteSpace: 'nowrap' }}
                  >
                    Cohort
                  </th>
                  {Array.from({ length: maxOffset + 1 }, (_, d) => (
                    <th
                      key={d}
                      className="text-center pb-2 font-medium"
                      style={{ color: '#525252', minWidth: '30px' }}
                    >
                      {d === 0 ? 'D0' : `D${d}`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cohortData.map((c: CohortData) => {
                  const offsetMap = new Map(c.offsets.map((o) => [o.dayOffset, o]));
                  return (
                    <tr key={c.cohortDate}>
                      <td
                        className="pr-4 py-0.5 font-medium"
                        style={{ color: '#555', whiteSpace: 'nowrap' }}
                      >
                        {toLabel(c.cohortDate)}
                      </td>
                      {Array.from({ length: maxOffset + 1 }, (_, d) => {
                        const cell = offsetMap.get(d);
                        return (
                          <td
                            key={d}
                            title={
                              cell
                                ? `${(cell.retentionRate * 100).toFixed(1)}% — ${cell.retainedWallets}/${cell.totalWallets} wallets`
                                : '—'
                            }
                            style={{
                              background: cell ? retentionToColor(cell.retentionRate) : '#0f0f0f',
                              borderRadius: '3px',
                              width: '30px',
                              height: '22px',
                              textAlign: 'center',
                              color: cell && cell.retentionRate > 0.55 ? '#000' : '#777',
                              fontWeight: 500,
                              padding: '0 2px',
                              cursor: cell ? 'default' : 'not-allowed',
                            }}
                          >
                            {cell ? `${Math.round(cell.retentionRate * 100)}` : ''}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="card p-5">
          <h3 className="text-xs font-medium mb-1" style={{ color: Y }}>Avg Collateral Size</h3>
          <p className="text-[10px] mb-4" style={{ color: '#383838' }}>
            Mean collateral per active wallet at cohort inception (day 0)
          </p>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={avgPositionData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#444' }} axisLine={false} tickLine={false} />
              <YAxis
                tick={{ fontSize: 10, fill: '#444' }}
                tickFormatter={(v) => `${((v as number) / 1e3).toFixed(1)}k`}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                labelStyle={{ color: '#666' }}
                formatter={(v) => [`${(v as number).toLocaleString()} XLM`, 'Avg Collateral']}
              />
              <Line
                type="monotone"
                dataKey="collateral"
                stroke={Y}
                strokeWidth={2}
                dot={{ fill: Y, r: 3, strokeWidth: 0 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="card p-5">
          <h3 className="text-xs font-medium mb-1" style={{ color: '#3B82F6' }}>Avg Borrow Size</h3>
          <p className="text-[10px] mb-4" style={{ color: '#383838' }}>
            Mean borrowed per active wallet at cohort inception (day 0)
          </p>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={avgPositionData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#444' }} axisLine={false} tickLine={false} />
              <YAxis
                tick={{ fontSize: 10, fill: '#444' }}
                tickFormatter={(v) => `${((v as number) / 1e3).toFixed(1)}k`}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                labelStyle={{ color: '#666' }}
                formatter={(v) => [`${(v as number).toLocaleString()} XLM`, 'Avg Borrow']}
              />
              <Line
                type="monotone"
                dataKey="borrow"
                stroke="#3B82F6"
                strokeWidth={2}
                dot={{ fill: '#3B82F6', r: 3, strokeWidth: 0 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

    </div>
  );
}
