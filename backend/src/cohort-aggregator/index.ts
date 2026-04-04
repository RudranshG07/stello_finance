/**
 * CohortAggregator
 *
 * Populates the cohort and retention tables from indexed event data:
 *
 *   Job 1 – WalletFirstActivity
 *     Scans StakeEvent (type = STAKE) and BorrowEvent tables, keeping the
 *     minimum ledger / timestamp per wallet. Safe to re-run (upsert).
 *
 *   Job 2 – WalletDailyActivity
 *     For each (wallet, calendar-day) computes the cumulative net-staked and
 *     net-borrowed amounts up to the end of that day and derives isStakeActive
 *     / isBorrowActive flags.
 *
 *     Incremental path (daily cron): carry-forward the previous day's balances
 *       and add today's deltas.
 *     Backfill path: query all historical stake/unstake/borrow/repay events,
 *       build per-wallet daily delta maps, then walk the full date range
 *       computing running totals.
 *
 *   Job 3 – CohortRetention
 *     For each cohort day (= UTC calendar day of a wallet's first STAKE event)
 *     and each day offset 0…MAX_COHORT_OFFSET_DAYS, counts how many wallets in
 *     that cohort still have isStakeActive = true on (cohortDate + offset).
 *
 *   Job 4 – CohortAvgPositionSize
 *     For the same cohort × offset grid, computes the mean stakedAmount and
 *     borrowedAmount among the retained wallets.
 *
 * Schedule
 * ────────
 * All four jobs run daily at 01:00 UTC for the previous calendar day.
 * On startup a non-blocking backfill pass processes all historical data,
 * skipping (cohortDate, dayOffset) pairs that are already in the DB.
 */

import { PrismaClient } from "@prisma/client";
import cron from "node-cron";

// ── constants ────────────────────────────────────────────────────────────────

/** Maximum day offset to compute in cohort retention / avg-position tables. */
const MAX_COHORT_OFFSET_DAYS = 365;

/** Maximum number of upserts to send in a single Promise.all batch. */
const UPSERT_BATCH_SIZE = 200;

// ── date helpers ─────────────────────────────────────────────────────────────

/** Truncate a Date to the start of its UTC calendar day (00:00:00.000 UTC). */
function dayFloor(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  );
}

/** Return a new Date that is `n` calendar days after `d`. */
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

/** Generate every UTC calendar day in [from, to] inclusive. */
function dayRange(from: Date, to: Date): Date[] {
  const days: Date[] = [];
  let cur = dayFloor(from);
  const end = dayFloor(to);
  while (cur <= end) {
    days.push(cur);
    cur = addDays(cur, 1);
  }
  return days;
}

// ── types ────────────────────────────────────────────────────────────────────

interface DailyDelta {
  netStake: bigint;
  netBorrow: bigint;
}

/** Row shape returned by the stakeDeltas raw query. */
interface StakeDeltaRow {
  wallet: string;
  day: Date;
  net_stake: bigint | string;
}

/** Row shape returned by the borrow/repay raw queries. */
interface BorrowDeltaRow {
  wallet: string;
  day: Date;
  amount: bigint | string;
}

/** Row shape returned by the cohort grouping raw query. */
interface CohortRow {
  cohort_date: Date;
}

// ── service ──────────────────────────────────────────────────────────────────

export class CohortAggregator {
  private prisma: PrismaClient;
  private jobs: cron.ScheduledTask[] = [];

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    console.log("[CohortAggregator] Initializing...");

    // Non-blocking backfill on startup.
    this.runBackfill().catch((err) =>
      console.error("[CohortAggregator] Backfill error:", err)
    );

    // Daily job at 01:00 UTC for the previous calendar day.
    const dailyTask = cron.schedule("0 1 * * *", async () => {
      const yesterday = dayFloor(addDays(new Date(), -1));
      try {
        await this.runDailyJobs(yesterday);
      } catch (err) {
        console.error("[CohortAggregator] Daily job error:", err);
      }
    });

    this.jobs.push(dailyTask);
    console.log("[CohortAggregator] Initialized – daily cron at 01:00 UTC");
  }

  async shutdown(): Promise<void> {
    for (const job of this.jobs) job.stop();
    this.jobs = [];
    console.log("[CohortAggregator] Shut down");
  }

  // ── orchestration ───────────────────────────────────────────────────────────

  /**
   * Run all four jobs for a single target date.
   * Called by the daily cron (for yesterday) and by tests.
   */
  async runDailyJobs(date: Date): Promise<void> {
    const target = dayFloor(date);
    console.log(
      `[CohortAggregator] Running daily jobs for ${fmtDay(target)}`
    );
    await this.runWalletFirstActivityJob();
    await this.runWalletDailyActivityJob(target);
    await this.runCohortRetentionJob(target);
    await this.runCohortAvgPositionSizeJob(target);
  }

  /**
   * Backfill historical data.
   *
   * 1. Refresh WalletFirstActivity.
   * 2. Compute WalletDailyActivity for all days not yet stored.
   * 3. Compute CohortRetention + CohortAvgPositionSize for every historical
   *    day, skipping (cohortDate, dayOffset) pairs that already exist.
   */
  async runBackfill(): Promise<void> {
    console.log("[CohortAggregator] Starting historical backfill...");

    await this.runWalletFirstActivityJob();

    const earliest = await this.findEarliestEventDate();
    if (!earliest) {
      console.log(
        "[CohortAggregator] No indexed events found; skipping backfill"
      );
      return;
    }

    const today = dayFloor(new Date());
    const allDays = dayRange(earliest, today);

    // ── WalletDailyActivity backfill ────────────────────────────────────────
    const existingDateRows = await this.prisma.walletDailyActivity.findMany({
      distinct: ["date"],
      select: { date: true },
    });
    const existingSet = new Set(
      existingDateRows.map((r) => dayFloor(r.date).toISOString())
    );
    const missingDays = allDays.filter(
      (d) => !existingSet.has(d.toISOString())
    );

    if (missingDays.length > 0) {
      console.log(
        `[CohortAggregator] Backfilling ${missingDays.length} missing day(s) of wallet activity…`
      );
      await this.backfillWalletDailyActivity(missingDays, earliest);
    }

    // ── Cohort metrics backfill ─────────────────────────────────────────────
    console.log(
      `[CohortAggregator] Computing cohort metrics for ${allDays.length} day(s)…`
    );
    for (const day of allDays) {
      await this.runCohortRetentionJob(day);
      await this.runCohortAvgPositionSizeJob(day);
    }

    console.log("[CohortAggregator] Backfill complete");
  }

  // ── Job 1: WalletFirstActivity ──────────────────────────────────────────────

  /**
   * Upsert the first-ever STAKE ledger/timestamp and first-ever BORROW
   * ledger/timestamp for every wallet observed in the indexed event tables.
   */
  async runWalletFirstActivityJob(): Promise<void> {
    const [firstStakes, firstBorrows] = await Promise.all([
      this.prisma.stakeEvent.groupBy({
        by: ["wallet"],
        where: { type: "STAKE" },
        _min: { ledger: true, ledgerClosedAt: true },
      }),
      this.prisma.borrowEvent.groupBy({
        by: ["wallet"],
        _min: { ledger: true, ledgerClosedAt: true },
      }),
    ]);

    type ActivityRecord = {
      wallet: string;
      firstStakeLedger: number | null;
      firstStakeAt: Date | null;
      firstBorrowLedger: number | null;
      firstBorrowAt: Date | null;
    };

    const map = new Map<string, ActivityRecord>();

    for (const r of firstStakes) {
      map.set(r.wallet, {
        wallet: r.wallet,
        firstStakeLedger: r._min.ledger ?? null,
        firstStakeAt: r._min.ledgerClosedAt ?? null,
        firstBorrowLedger: null,
        firstBorrowAt: null,
      });
    }

    for (const r of firstBorrows) {
      const existing = map.get(r.wallet);
      if (existing) {
        existing.firstBorrowLedger = r._min.ledger ?? null;
        existing.firstBorrowAt = r._min.ledgerClosedAt ?? null;
      } else {
        map.set(r.wallet, {
          wallet: r.wallet,
          firstStakeLedger: null,
          firstStakeAt: null,
          firstBorrowLedger: r._min.ledger ?? null,
          firstBorrowAt: r._min.ledgerClosedAt ?? null,
        });
      }
    }

    const records = Array.from(map.values());

    for (let i = 0; i < records.length; i += UPSERT_BATCH_SIZE) {
      await Promise.all(
        records.slice(i, i + UPSERT_BATCH_SIZE).map((r) =>
          this.prisma.walletFirstActivity.upsert({
            where: { wallet: r.wallet },
            create: r,
            update: {
              firstStakeLedger: r.firstStakeLedger,
              firstStakeAt: r.firstStakeAt,
              firstBorrowLedger: r.firstBorrowLedger,
              firstBorrowAt: r.firstBorrowAt,
            },
          })
        )
      );
    }

    console.log(
      `[CohortAggregator] WalletFirstActivity: upserted ${records.length} wallet(s)`
    );
  }

  // ── Job 2a: Backfill WalletDailyActivity ────────────────────────────────────

  /**
   * Efficient backfill for a set of missing days.
   *
   * Queries all historical events once, builds per-wallet daily-delta maps,
   * then walks the full date range from `historyStart` to the last missing day
   * accumulating running totals. Only rows for `missingDays` are upserted.
   *
   * @param missingDays   Calendar days (UTC day-floor) that need rows.
   * @param historyStart  Earliest event date; used as the start of the walking
   *                      range so that running totals are computed correctly.
   */
  private async backfillWalletDailyActivity(
    missingDays: Date[],
    historyStart: Date
  ): Promise<void> {
    if (missingDays.length === 0) return;

    const lastDay = missingDays[missingDays.length - 1];
    const cutoff = addDays(lastDay, 1); // exclusive upper bound

    // Fetch all stake deltas: (wallet, day) → net stake change
    const stakeRows = await this.prisma.$queryRaw<StakeDeltaRow[]>`
      SELECT
        wallet,
        DATE_TRUNC('day', ledger_closed_at) AS day,
        SUM(CASE WHEN type = 'STAKE' THEN amount::numeric ELSE -(amount::numeric) END) AS net_stake
      FROM stake_events
      WHERE ledger_closed_at < ${cutoff}
      GROUP BY wallet, DATE_TRUNC('day', ledger_closed_at)
      ORDER BY wallet, day
    `;

    const borrowRows = await this.prisma.$queryRaw<BorrowDeltaRow[]>`
      SELECT
        wallet,
        DATE_TRUNC('day', ledger_closed_at) AS day,
        SUM(amount::numeric) AS amount
      FROM borrow_events
      WHERE ledger_closed_at < ${cutoff}
      GROUP BY wallet, DATE_TRUNC('day', ledger_closed_at)
      ORDER BY wallet, day
    `;

    const repayRows = await this.prisma.$queryRaw<BorrowDeltaRow[]>`
      SELECT
        wallet,
        DATE_TRUNC('day', ledger_closed_at) AS day,
        SUM(amount::numeric) AS amount
      FROM repay_events
      WHERE ledger_closed_at < ${cutoff}
      GROUP BY wallet, DATE_TRUNC('day', ledger_closed_at)
      ORDER BY wallet, day
    `;

    // Build nested map: wallet → (day key → { netStake, netBorrow })
    const walletDeltas = new Map<string, Map<string, DailyDelta>>();

    const getEntry = (wallet: string, day: Date): DailyDelta => {
      let wmap = walletDeltas.get(wallet);
      if (!wmap) {
        wmap = new Map();
        walletDeltas.set(wallet, wmap);
      }
      const k = fmtDay(dayFloor(day));
      let entry = wmap.get(k);
      if (!entry) {
        entry = { netStake: 0n, netBorrow: 0n };
        wmap.set(k, entry);
      }
      return entry;
    };

    for (const r of stakeRows) {
      getEntry(r.wallet, r.day).netStake += BigInt(r.net_stake);
    }
    for (const r of borrowRows) {
      getEntry(r.wallet, r.day).netBorrow += BigInt(r.amount);
    }
    for (const r of repayRows) {
      getEntry(r.wallet, r.day).netBorrow -= BigInt(r.amount);
    }

    // Walk all days from historyStart to lastDay, building running totals.
    // Only emit rows for the requested missingDays.
    const missingSet = new Set(missingDays.map((d) => d.toISOString()));
    const walkDays = dayRange(historyStart, lastDay);

    type ActivityRow = {
      wallet: string;
      date: Date;
      isStakeActive: boolean;
      isBorrowActive: boolean;
      stakedAmount: bigint;
      borrowedAmount: bigint;
    };

    const toUpsert: ActivityRow[] = [];

    for (const [wallet, wmap] of walletDeltas) {
      let cumStake = 0n;
      let cumBorrow = 0n;

      for (const day of walkDays) {
        const delta = wmap.get(fmtDay(day));
        if (delta) {
          cumStake += delta.netStake;
          cumBorrow += delta.netBorrow;
        }

        if (missingSet.has(day.toISOString())) {
          toUpsert.push({
            wallet,
            date: day,
            isStakeActive: cumStake > 0n,
            isBorrowActive: cumBorrow > 0n,
            stakedAmount: cumStake > 0n ? cumStake : 0n,
            borrowedAmount: cumBorrow > 0n ? cumBorrow : 0n,
          });
        }
      }
    }

    for (let i = 0; i < toUpsert.length; i += UPSERT_BATCH_SIZE) {
      await Promise.all(
        toUpsert.slice(i, i + UPSERT_BATCH_SIZE).map((row) =>
          this.prisma.walletDailyActivity.upsert({
            where: { wallet_date: { wallet: row.wallet, date: row.date } },
            create: row,
            update: {
              isStakeActive: row.isStakeActive,
              isBorrowActive: row.isBorrowActive,
              stakedAmount: row.stakedAmount,
              borrowedAmount: row.borrowedAmount,
            },
          })
        )
      );
    }

    console.log(
      `[CohortAggregator] WalletDailyActivity backfill: upserted ${toUpsert.length} record(s)`
    );
  }

  // ── Job 2b: Incremental WalletDailyActivity for one day ────────────────────

  /**
   * Compute WalletDailyActivity for a single calendar day.
   *
   * Carry-forward strategy: start from the previous day's persisted balances
   * and add/subtract the net event deltas that occurred on `date`.
   *
   * For wallets active before the first persisted day (e.g. immediately after
   * a fresh deployment) the carry-forward baseline will be zero, so the
   * resulting balance is computed purely from events on and before `date`.
   */
  async runWalletDailyActivityJob(date: Date): Promise<void> {
    const dayStart = dayFloor(date);
    const dayEnd = addDays(dayStart, 1);
    const prevDay = addDays(dayStart, -1);

    // Load previous day's balances as carry-forward baseline.
    const prevActivity = await this.prisma.walletDailyActivity.findMany({
      where: { date: prevDay },
    });
    const prevMap = new Map(prevActivity.map((r) => [r.wallet, r]));

    // Today's per-wallet event deltas.
    const [stakeDeltas, borrowDeltas, repayDeltas] = await Promise.all([
      this.prisma.$queryRaw<Array<{ wallet: string; net_stake: bigint | string }>>`
        SELECT
          wallet,
          SUM(CASE WHEN type = 'STAKE' THEN amount::numeric ELSE -(amount::numeric) END) AS net_stake
        FROM stake_events
        WHERE ledger_closed_at >= ${dayStart} AND ledger_closed_at < ${dayEnd}
        GROUP BY wallet
      `,
      this.prisma.$queryRaw<Array<{ wallet: string; amount: bigint | string }>>`
        SELECT wallet, SUM(amount::numeric) AS amount
        FROM borrow_events
        WHERE ledger_closed_at >= ${dayStart} AND ledger_closed_at < ${dayEnd}
        GROUP BY wallet
      `,
      this.prisma.$queryRaw<Array<{ wallet: string; amount: bigint | string }>>`
        SELECT wallet, SUM(amount::numeric) AS amount
        FROM repay_events
        WHERE ledger_closed_at >= ${dayStart} AND ledger_closed_at < ${dayEnd}
        GROUP BY wallet
      `,
    ]);

    // Merge deltas into a single map.
    const deltaMap = new Map<string, { stake: bigint; borrow: bigint }>();
    for (const r of stakeDeltas) {
      deltaMap.set(r.wallet, { stake: BigInt(r.net_stake), borrow: 0n });
    }
    for (const r of borrowDeltas) {
      const e = deltaMap.get(r.wallet) ?? { stake: 0n, borrow: 0n };
      e.borrow += BigInt(r.amount);
      deltaMap.set(r.wallet, e);
    }
    for (const r of repayDeltas) {
      const e = deltaMap.get(r.wallet) ?? { stake: 0n, borrow: 0n };
      e.borrow -= BigInt(r.amount);
      deltaMap.set(r.wallet, e);
    }

    // Combine all wallets seen in either the previous day or today's events.
    const allWallets = new Set([...prevMap.keys(), ...deltaMap.keys()]);
    const rows: Array<{
      wallet: string;
      date: Date;
      isStakeActive: boolean;
      isBorrowActive: boolean;
      stakedAmount: bigint;
      borrowedAmount: bigint;
    }> = [];

    for (const wallet of allWallets) {
      const prev = prevMap.get(wallet);
      const delta = deltaMap.get(wallet);
      const stakedAmount =
        (prev ? prev.stakedAmount : 0n) + (delta ? delta.stake : 0n);
      const borrowedAmount =
        (prev ? prev.borrowedAmount : 0n) + (delta ? delta.borrow : 0n);
      rows.push({
        wallet,
        date: dayStart,
        isStakeActive: stakedAmount > 0n,
        isBorrowActive: borrowedAmount > 0n,
        stakedAmount: stakedAmount > 0n ? stakedAmount : 0n,
        borrowedAmount: borrowedAmount > 0n ? borrowedAmount : 0n,
      });
    }

    for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
      await Promise.all(
        rows.slice(i, i + UPSERT_BATCH_SIZE).map((row) =>
          this.prisma.walletDailyActivity.upsert({
            where: { wallet_date: { wallet: row.wallet, date: row.date } },
            create: row,
            update: {
              isStakeActive: row.isStakeActive,
              isBorrowActive: row.isBorrowActive,
              stakedAmount: row.stakedAmount,
              borrowedAmount: row.borrowedAmount,
            },
          })
        )
      );
    }

    console.log(
      `[CohortAggregator] WalletDailyActivity: upserted ${rows.length} record(s) for ${fmtDay(dayStart)}`
    );
  }

  // ── Job 3: CohortRetention ──────────────────────────────────────────────────

  /**
   * For every cohort whose `cohortDate` ≤ `targetDate`, compute the retention
   * metric at `dayOffset = targetDate − cohortDate`.
   *
   * "Retained" = `isStakeActive = true` on `targetDate` in WalletDailyActivity.
   * Pairs already present in the DB are skipped to make backfill idempotent.
   */
  async runCohortRetentionJob(targetDate: Date): Promise<void> {
    const target = dayFloor(targetDate);

    const cohortRows = await this.prisma.$queryRaw<CohortRow[]>`
      SELECT DISTINCT DATE_TRUNC('day', first_stake_at) AS cohort_date
      FROM wallet_first_activity
      WHERE first_stake_at IS NOT NULL
        AND DATE_TRUNC('day', first_stake_at) <= ${target}
      ORDER BY cohort_date
    `;

    let updated = 0;

    for (const cohortRow of cohortRows) {
      const cohortDate = dayFloor(cohortRow.cohort_date);
      const dayOffset = Math.round(
        (target.getTime() - cohortDate.getTime()) / 86_400_000
      );

      if (dayOffset < 0 || dayOffset > MAX_COHORT_OFFSET_DAYS) continue;

      // Skip if this (cohortDate, dayOffset) already exists.
      const existing = await this.prisma.cohortRetention.findUnique({
        where: { cohortDate_dayOffset: { cohortDate, dayOffset } },
      });
      if (existing) continue;

      const cohortWallets = await this.prisma.walletFirstActivity.findMany({
        where: {
          firstStakeAt: {
            gte: cohortDate,
            lt: addDays(cohortDate, 1),
          },
        },
        select: { wallet: true },
      });

      const walletIds = cohortWallets.map((w) => w.wallet);
      const totalWallets = walletIds.length;
      if (totalWallets === 0) continue;

      const retainedWallets = await this.prisma.walletDailyActivity.count({
        where: {
          wallet: { in: walletIds },
          date: target,
          isStakeActive: true,
        },
      });

      const retentionRate = retainedWallets / totalWallets;

      await this.prisma.cohortRetention.upsert({
        where: { cohortDate_dayOffset: { cohortDate, dayOffset } },
        create: {
          cohortDate,
          dayOffset,
          totalWallets,
          retainedWallets,
          retentionRate,
        },
        update: { totalWallets, retainedWallets, retentionRate },
      });

      updated++;
    }

    if (updated > 0) {
      console.log(
        `[CohortAggregator] CohortRetention: wrote ${updated} cohort(s) for ${fmtDay(target)}`
      );
    }
  }

  // ── Job 4: CohortAvgPositionSize ────────────────────────────────────────────

  /**
   * For every cohort whose `cohortDate` ≤ `targetDate`, compute the average
   * collateral (stakedAmount) and borrow size among wallets that are retained
   * (isStakeActive = true) on `targetDate`.
   *
   * Pairs already present in the DB are skipped to make backfill idempotent.
   */
  async runCohortAvgPositionSizeJob(targetDate: Date): Promise<void> {
    const target = dayFloor(targetDate);

    const cohortRows = await this.prisma.$queryRaw<CohortRow[]>`
      SELECT DISTINCT DATE_TRUNC('day', first_stake_at) AS cohort_date
      FROM wallet_first_activity
      WHERE first_stake_at IS NOT NULL
        AND DATE_TRUNC('day', first_stake_at) <= ${target}
      ORDER BY cohort_date
    `;

    let updated = 0;

    for (const cohortRow of cohortRows) {
      const cohortDate = dayFloor(cohortRow.cohort_date);
      const dayOffset = Math.round(
        (target.getTime() - cohortDate.getTime()) / 86_400_000
      );

      if (dayOffset < 0 || dayOffset > MAX_COHORT_OFFSET_DAYS) continue;

      // Skip if already computed.
      const existing = await this.prisma.cohortAvgPositionSize.findUnique({
        where: { cohortDate_dayOffset: { cohortDate, dayOffset } },
      });
      if (existing) continue;

      const cohortWallets = await this.prisma.walletFirstActivity.findMany({
        where: {
          firstStakeAt: {
            gte: cohortDate,
            lt: addDays(cohortDate, 1),
          },
        },
        select: { wallet: true },
      });

      const walletIds = cohortWallets.map((w) => w.wallet);
      if (walletIds.length === 0) continue;

      const activePositions = await this.prisma.walletDailyActivity.findMany({
        where: {
          wallet: { in: walletIds },
          date: target,
          isStakeActive: true,
        },
        select: { stakedAmount: true, borrowedAmount: true },
      });

      let avgCollateralSize = 0;
      let avgBorrowSize = 0;

      if (activePositions.length > 0) {
        const n = activePositions.length;
        const totalStaked = activePositions.reduce(
          (acc, p) => acc + Number(p.stakedAmount),
          0
        );
        const totalBorrowed = activePositions.reduce(
          (acc, p) => acc + Number(p.borrowedAmount),
          0
        );
        avgCollateralSize = totalStaked / n;
        avgBorrowSize = totalBorrowed / n;
      }

      await this.prisma.cohortAvgPositionSize.upsert({
        where: { cohortDate_dayOffset: { cohortDate, dayOffset } },
        create: { cohortDate, dayOffset, avgCollateralSize, avgBorrowSize },
        update: { avgCollateralSize, avgBorrowSize },
      });

      updated++;
    }

    if (updated > 0) {
      console.log(
        `[CohortAggregator] CohortAvgPositionSize: wrote ${updated} cohort(s) for ${fmtDay(target)}`
      );
    }
  }

  // ── private helpers ─────────────────────────────────────────────────────────

  /** Return the UTC day-floor of the earliest indexed event, or null. */
  private async findEarliestEventDate(): Promise<Date | null> {
    const [earliestStake, earliestBorrow] = await Promise.all([
      this.prisma.stakeEvent.findFirst({
        orderBy: { ledgerClosedAt: "asc" },
        select: { ledgerClosedAt: true },
      }),
      this.prisma.borrowEvent.findFirst({
        orderBy: { ledgerClosedAt: "asc" },
        select: { ledgerClosedAt: true },
      }),
    ]);

    const candidates = [
      earliestStake?.ledgerClosedAt,
      earliestBorrow?.ledgerClosedAt,
    ].filter((d): d is Date => d !== undefined);

    if (candidates.length === 0) return null;
    return dayFloor(candidates.reduce((min, d) => (d < min ? d : min)));
  }
}

// ── module-level helpers ─────────────────────────────────────────────────────

/** Format a Date as "YYYY-MM-DD" for logging. */
function fmtDay(d: Date): string {
  return d.toISOString().substring(0, 10);
}
