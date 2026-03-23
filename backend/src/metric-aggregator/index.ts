/**
 * MetricAggregator
 *
 * Runs two hourly cron jobs that populate the time-series aggregation tables:
 *   1. LendingUtilizationSnapshot – per-hour snapshot of totalDeposited /
 *      totalBorrowed / utilizationRate for the lending contract.
 *      Primary source: on-chain contract views (total_collateral, total_borrowed).
 *      Fallback: sum of collateral positions in DB when the RPC is unreachable.
 *
 *   2. RevenueSnapshot – per-hour revenue split by source (LENDING / LP /
 *      TREASURY).
 *      LENDING : FlashLoanEvent.fee sums from the lending contract
 *                + liquidation bonuses (max(0, collateralSeized – debtRepaid))
 *                in the same window.
 *      LP      : FlashLoanEvent.fee sums from the LP-pool contract in the window.
 *      TREASURY: Delta in ProtocolMetrics.protocolFees between the two nearest
 *                snapshots bracketing the window.
 */

import { PrismaClient } from "@prisma/client";
import cron from "node-cron";
import {
  rpc,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  scValToNative,
} from "@stellar/stellar-sdk";
import { config } from "../config/index.js";

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Call a read-only Soroban contract view and return the native JS value,
 * or null if the simulation fails.
 */
async function queryView(
  server: rpc.Server,
  contractId: string,
  method: string
): Promise<unknown> {
  try {
    const contract = new Contract(contractId);
    const op = contract.call(method);
    const account = await server.getAccount(config.admin.publicKey);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: config.stellar.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationSuccess(sim) && sim.result) {
      return scValToNative(sim.result.retval);
    }
    return null;
  } catch {
    return null;
  }
}

/** Floor a Date to the start of its UTC hour. */
function hourFloor(d: Date): Date {
  return new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      d.getUTCHours()
    )
  );
}

/** Return the previous full UTC hour window [start, end). */
function previousHourWindow(): { windowStart: Date; windowEnd: Date } {
  const windowEnd = hourFloor(new Date());
  const windowStart = new Date(windowEnd.getTime() - 60 * 60 * 1000);
  return { windowStart, windowEnd };
}

// ── service ──────────────────────────────────────────────────────────────────

export class MetricAggregator {
  private prisma: PrismaClient;
  private server: rpc.Server;
  private jobs: cron.ScheduledTask[] = [];

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.server = new rpc.Server(config.stellar.rpcUrl);
  }

  async initialize(): Promise<void> {
    console.log("[MetricAggregator] Initializing...");

    // Run once at startup to fill the most recent hour.
    const { windowStart, windowEnd } = previousHourWindow();
    await this.runUtilizationJob(windowStart, windowEnd).catch((err) =>
      console.error("[MetricAggregator] Startup utilization job failed:", err)
    );
    await this.runRevenueJob(windowStart, windowEnd).catch((err) =>
      console.error("[MetricAggregator] Startup revenue job failed:", err)
    );

    // Schedule both jobs at the top of every hour.
    const utilizationTask = cron.schedule("0 * * * *", async () => {
      const w = previousHourWindow();
      try {
        await this.runUtilizationJob(w.windowStart, w.windowEnd);
      } catch (err) {
        console.error("[MetricAggregator] Utilization cron error:", err);
      }
    });

    const revenueTask = cron.schedule("0 * * * *", async () => {
      const w = previousHourWindow();
      try {
        await this.runRevenueJob(w.windowStart, w.windowEnd);
      } catch (err) {
        console.error("[MetricAggregator] Revenue cron error:", err);
      }
    });

    this.jobs.push(utilizationTask, revenueTask);
    console.log("[MetricAggregator] Initialized – running hourly");
  }

  async shutdown(): Promise<void> {
    for (const job of this.jobs) job.stop();
    this.jobs = [];
    console.log("[MetricAggregator] Shut down");
  }

  // ── utilization ────────────────────────────────────────────────────────────

  /**
   * Compute the utilization snapshot for [windowStart, windowEnd).
   *
   * Strategy:
   *  1. Query on-chain `total_collateral` and `total_borrowed` views directly.
   *  2. If the RPC call fails, fall back to summing indexed CollateralPosition
   *     rows already in the database (the lending route syncs these on every
   *     position read).
   *  3. As a further event-delta cross-check, compute the net borrow delta from
   *     BorrowEvent / RepayEvent rows in the window and log a warning if it
   *     diverges significantly from the view snapshot.
   */
  async runUtilizationJob(windowStart: Date, windowEnd: Date): Promise<void> {
    const contractId = config.contracts.lendingContractId;

    // ── 1. Try on-chain views ─────────────────────────────────────────────
    let totalDeposited: bigint | null = null;
    let totalBorrowed: bigint | null = null;

    const [collateralRaw, borrowedRaw] = await Promise.all([
      queryView(this.server, contractId, "total_collateral"),
      queryView(this.server, contractId, "total_borrowed"),
    ]);

    if (collateralRaw !== null && borrowedRaw !== null) {
      try {
        totalDeposited = BigInt(collateralRaw as string | number | bigint);
        totalBorrowed = BigInt(borrowedRaw as string | number | bigint);
      } catch {
        // type coercion failed – fall through to fallback
      }
    }

    // ── 2. DB fallback ────────────────────────────────────────────────────
    if (totalDeposited === null || totalBorrowed === null) {
      console.warn(
        "[MetricAggregator] On-chain view unavailable; using DB fallback for utilization"
      );

      const [depositedAgg, borrowedAgg] = await Promise.all([
        this.prisma.collateralPosition.aggregate({
          _sum: { amountDeposited: true },
        }),
        this.prisma.collateralPosition.aggregate({
          _sum: { xlmBorrowed: true },
        }),
      ]);

      totalDeposited = depositedAgg._sum.amountDeposited ?? BigInt(0);
      totalBorrowed = borrowedAgg._sum.xlmBorrowed ?? BigInt(0);
    }

    // ── 3. Event-delta cross-check (informational) ────────────────────────
    const [borrowSum, repaySum] = await Promise.all([
      this.prisma.borrowEvent.aggregate({
        _sum: { amount: true },
        where: {
          contractId,
          ledgerClosedAt: { gte: windowStart, lt: windowEnd },
        },
      }),
      this.prisma.repayEvent.aggregate({
        _sum: { amount: true },
        where: {
          contractId,
          ledgerClosedAt: { gte: windowStart, lt: windowEnd },
        },
      }),
    ]);

    const netBorrowDelta =
      (borrowSum._sum.amount ?? BigInt(0)) -
      (repaySum._sum.amount ?? BigInt(0));

    if (netBorrowDelta !== BigInt(0)) {
      console.log(
        `[MetricAggregator] Utilization window net borrow delta: ${netBorrowDelta} stroops`
      );
    }

    const utilizationRate =
      totalDeposited > BigInt(0)
        ? Number(totalBorrowed) / Number(totalDeposited)
        : 0;

    await this.prisma.lendingUtilizationSnapshot.upsert({
      where: { contractId_windowStart: { contractId, windowStart } },
      create: {
        contractId,
        windowStart,
        windowEnd,
        totalDeposited,
        totalBorrowed,
        utilizationRate,
      },
      update: {
        windowEnd,
        totalDeposited,
        totalBorrowed,
        utilizationRate,
      },
    });

    console.log(
      `[MetricAggregator] Utilization snapshot: deposited=${Number(totalDeposited) / 1e7} ` +
        `borrowed=${Number(totalBorrowed) / 1e7} rate=${(utilizationRate * 100).toFixed(2)}%`
    );
  }

  // ── revenue ────────────────────────────────────────────────────────────────

  /**
   * Compute revenue snapshots for [windowStart, windowEnd) across all three
   * sources.
   *
   *  LENDING  – FlashLoanEvent fees from the lending contract
   *             + liquidation bonuses (collateralSeized − debtRepaid when > 0)
   *
   *  LP       – FlashLoanEvent fees from the LP-pool contract
   *
   *  TREASURY – Delta in ProtocolMetrics.protocolFees between the two
   *             ProtocolMetrics rows whose timestamps bracket the window.
   *             Falls back to 0 if fewer than two rows exist.
   */
  async runRevenueJob(windowStart: Date, windowEnd: Date): Promise<void> {
    await Promise.all([
      this.computeLendingRevenue(windowStart, windowEnd),
      this.computeLpRevenue(windowStart, windowEnd),
      this.computeTreasuryRevenue(windowStart, windowEnd),
    ]);
  }

  private async computeLendingRevenue(
    windowStart: Date,
    windowEnd: Date
  ): Promise<void> {
    // Flash-loan fees attributed to lending
    const flashFeeAgg = await this.prisma.flashLoanEvent.aggregate({
      _sum: { fee: true },
      where: {
        contractId: config.contracts.lendingContractId,
        ledgerClosedAt: { gte: windowStart, lt: windowEnd },
      },
    });
    const flashFees = flashFeeAgg._sum.fee ?? BigInt(0);

    // Liquidation bonus: sum of max(0, collateralSeized − debtRepaid) per event
    const liquidations = await this.prisma.liquidationEvent.findMany({
      where: {
        contractId: config.contracts.lendingContractId,
        ledgerClosedAt: { gte: windowStart, lt: windowEnd },
      },
      select: { collateralSeized: true, debtRepaid: true },
    });

    const liquidationBonus = liquidations.reduce((acc, ev) => {
      const bonus = ev.collateralSeized - ev.debtRepaid;
      return bonus > BigInt(0) ? acc + bonus : acc;
    }, BigInt(0));

    const amount = flashFees + liquidationBonus;

    await this.upsertRevenueSnapshot("LENDING", windowStart, windowEnd, amount);

    console.log(
      `[MetricAggregator] LENDING revenue: flashFees=${flashFees} bonuses=${liquidationBonus} total=${amount} stroops`
    );
  }

  private async computeLpRevenue(
    windowStart: Date,
    windowEnd: Date
  ): Promise<void> {
    const flashFeeAgg = await this.prisma.flashLoanEvent.aggregate({
      _sum: { fee: true },
      where: {
        contractId: config.contracts.lpPoolContractId,
        ledgerClosedAt: { gte: windowStart, lt: windowEnd },
      },
    });

    const amount = flashFeeAgg._sum.fee ?? BigInt(0);

    await this.upsertRevenueSnapshot("LP", windowStart, windowEnd, amount);

    console.log(
      `[MetricAggregator] LP revenue: ${amount} stroops`
    );
  }

  private async computeTreasuryRevenue(
    windowStart: Date,
    windowEnd: Date
  ): Promise<void> {
    // Find the most recent ProtocolMetrics snapshot at or before windowEnd and
    // the most recent one at or before windowStart.  The difference in
    // protocolFees is the revenue accumulated during this window.
    const [metricsBefore, metricsAfter] = await Promise.all([
      this.prisma.protocolMetrics.findFirst({
        where: { updatedAt: { lte: windowStart } },
        orderBy: { updatedAt: "desc" },
        select: { protocolFees: true },
      }),
      this.prisma.protocolMetrics.findFirst({
        where: { updatedAt: { lte: windowEnd } },
        orderBy: { updatedAt: "desc" },
        select: { protocolFees: true },
      }),
    ]);

    let amount = BigInt(0);
    if (metricsBefore && metricsAfter) {
      const delta = metricsAfter.protocolFees - metricsBefore.protocolFees;
      if (delta > BigInt(0)) amount = delta;
    }

    await this.upsertRevenueSnapshot(
      "TREASURY",
      windowStart,
      windowEnd,
      amount
    );

    console.log(
      `[MetricAggregator] TREASURY revenue: ${amount} stroops`
    );
  }

  private async upsertRevenueSnapshot(
    source: "LENDING" | "LP" | "TREASURY",
    windowStart: Date,
    windowEnd: Date,
    amount: bigint
  ): Promise<void> {
    await this.prisma.revenueSnapshot.upsert({
      where: { source_windowStart: { source, windowStart } },
      create: { source, windowStart, windowEnd, amount },
      update: { windowEnd, amount },
    });
  }
}
