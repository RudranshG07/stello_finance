import { FastifyPluginAsync } from "fastify";
import { PrismaClient } from "@prisma/client";

// ── helpers ──────────────────────────────────────────────────────────────────

function parseDate(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const d = new Date(value);
  return isNaN(d.getTime()) ? fallback : d;
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

// ── plugin ───────────────────────────────────────────────────────────────────

export const analyticsRoutes: FastifyPluginAsync<{ prisma: PrismaClient }> = async (
  fastify,
  opts
) => {
  const { prisma } = opts;

  /**
   * GET /analytics/tvl?from&to
   *
   * Returns TVL (total value locked) time-series derived from RewardSnapshot
   * exchange rates and totalStaked values, enriched with tvlUsd when a
   * ProtocolMetrics row is available for the same window.
   *
   * Query params:
   *   from  – ISO-8601 date string (default: 90 days ago)
   *   to    – ISO-8601 date string (default: now)
   */
  fastify.get<{ Querystring: { from?: string; to?: string } }>(
    "/analytics/tvl",
    async (request) => {
      try {
        const from = parseDate(request.query.from, daysAgo(90));
        const to = parseDate(request.query.to, new Date());

        const snapshots = await prisma.rewardSnapshot.findMany({
          where: { timestamp: { gte: from, lte: to } },
          orderBy: { timestamp: "asc" },
          select: {
            timestamp: true,
            totalStaked: true,
            exchangeRate: true,
          },
        });

        // Pull the most-recent ProtocolMetrics row to derive a USD price
        const metrics = await prisma.protocolMetrics.findFirst({
          orderBy: { updatedAt: "desc" },
          select: { tvlUsd: true, totalStaked: true },
        });

        const xlmPriceUsd =
          metrics && Number(metrics.totalStaked) > 0
            ? metrics.tvlUsd / (Number(metrics.totalStaked) / 1e7)
            : 0.12;

        return {
          from: from.toISOString(),
          to: to.toISOString(),
          data: snapshots.map((s) => {
            const stakedXlm = Number(s.totalStaked) / 1e7;
            return {
              timestamp: s.timestamp.toISOString(),
              totalStakedXlm: stakedXlm,
              tvlUsd: stakedXlm * xlmPriceUsd,
              exchangeRate: s.exchangeRate,
            };
          }),
        };
      } catch {
        return { from: null, to: null, data: [] };
      }
    }
  );

  /**
   * GET /analytics/utilization?from&to
   *
   * Returns lending-utilization time-series from LendingUtilizationSnapshot.
   *
   * Query params:
   *   from  – ISO-8601 date string (default: 90 days ago)
   *   to    – ISO-8601 date string (default: now)
   */
  fastify.get<{ Querystring: { from?: string; to?: string } }>(
    "/analytics/utilization",
    async (request) => {
      try {
        const from = parseDate(request.query.from, daysAgo(90));
        const to = parseDate(request.query.to, new Date());

        const rows = await prisma.lendingUtilizationSnapshot.findMany({
          where: { windowStart: { gte: from, lte: to } },
          orderBy: { windowStart: "asc" },
          select: {
            contractId: true,
            windowStart: true,
            windowEnd: true,
            totalDeposited: true,
            totalBorrowed: true,
            utilizationRate: true,
          },
        });

        return {
          from: from.toISOString(),
          to: to.toISOString(),
          data: rows.map((r) => ({
            contractId: r.contractId,
            windowStart: r.windowStart.toISOString(),
            windowEnd: r.windowEnd.toISOString(),
            totalDepositedXlm: Number(r.totalDeposited) / 1e7,
            totalBorrowedXlm: Number(r.totalBorrowed) / 1e7,
            utilizationRate: r.utilizationRate,
          })),
        };
      } catch {
        return { from: null, to: null, data: [] };
      }
    }
  );

  /**
   * GET /analytics/revenue?from&to&groupBy=source
   *
   * Returns revenue breakdown time-series from RevenueSnapshot.
   *
   * Query params:
   *   from    – ISO-8601 date string (default: 90 days ago)
   *   to      – ISO-8601 date string (default: now)
   *   groupBy – "source" (default) | "window"
   *             "source"  → stacked series keyed by RevenueSource enum value
   *             "window"  → flat list ordered by windowStart
   */
  fastify.get<{
    Querystring: { from?: string; to?: string; groupBy?: string };
  }>("/analytics/revenue", async (request) => {
    try {
      const from = parseDate(request.query.from, daysAgo(90));
      const to = parseDate(request.query.to, new Date());
      const groupBy = request.query.groupBy ?? "source";

      const rows = await prisma.revenueSnapshot.findMany({
        where: { windowStart: { gte: from, lte: to } },
        orderBy: { windowStart: "asc" },
        select: {
          source: true,
          windowStart: true,
          windowEnd: true,
          amount: true,
        },
      });

      if (groupBy === "source") {
        // Build map: source → [{windowStart, amountXlm}]
        const bySource: Record<string, { windowStart: string; windowEnd: string; amountXlm: number }[]> = {};
        for (const r of rows) {
          const key = r.source as string;
          bySource[key] ??= [];
          bySource[key].push({
            windowStart: r.windowStart.toISOString(),
            windowEnd: r.windowEnd.toISOString(),
            amountXlm: Number(r.amount) / 1e7,
          });
        }
        return {
          from: from.toISOString(),
          to: to.toISOString(),
          groupBy: "source",
          series: bySource,
        };
      }

      // groupBy=window (flat)
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        groupBy: "window",
        data: rows.map((r) => ({
          source: r.source,
          windowStart: r.windowStart.toISOString(),
          windowEnd: r.windowEnd.toISOString(),
          amountXlm: Number(r.amount) / 1e7,
        })),
      };
    } catch {
      return { from: null, to: null, groupBy: null, data: [] };
    }
  });

  /**
   * GET /analytics/cohorts?cohortWindow=7&maxOffset=30
   *
   * Returns cohort retention and average position-size data.
   *
   * Query params:
   *   cohortWindow – number of recent cohort days to return (default: 30)
   *   maxOffset    – maximum day offset to include (default: 30)
   */
  fastify.get<{
    Querystring: { cohortWindow?: string; maxOffset?: string };
  }>("/analytics/cohorts", async (request) => {
    try {
      const cohortWindow = Math.min(
        parseInt(request.query.cohortWindow ?? "30", 10),
        365
      );
      const maxOffset = Math.min(
        parseInt(request.query.maxOffset ?? "30", 10),
        365
      );

      // The most-recent `cohortWindow` distinct cohort dates
      const cohortDates = await prisma.cohortRetention.findMany({
        distinct: ["cohortDate"],
        orderBy: { cohortDate: "desc" },
        take: cohortWindow,
        select: { cohortDate: true },
      });

      if (cohortDates.length === 0) {
        return { cohorts: [] };
      }

      const dateValues = cohortDates.map((c) => c.cohortDate);
      const oldest = dateValues[dateValues.length - 1];

      const [retentionRows, positionRows] = await Promise.all([
        prisma.cohortRetention.findMany({
          where: {
            cohortDate: { gte: oldest },
            dayOffset: { lte: maxOffset },
          },
          orderBy: [{ cohortDate: "asc" }, { dayOffset: "asc" }],
          select: {
            cohortDate: true,
            dayOffset: true,
            totalWallets: true,
            retainedWallets: true,
            retentionRate: true,
          },
        }),
        prisma.cohortAvgPositionSize.findMany({
          where: {
            cohortDate: { gte: oldest },
            dayOffset: { lte: maxOffset },
          },
          orderBy: [{ cohortDate: "asc" }, { dayOffset: "asc" }],
          select: {
            cohortDate: true,
            dayOffset: true,
            avgCollateralSize: true,
            avgBorrowSize: true,
          },
        }),
      ]);

      // Index position rows by "cohortDate|dayOffset" for O(1) lookup
      const positionIndex = new Map<string, (typeof positionRows)[0]>();
      for (const p of positionRows) {
        positionIndex.set(`${p.cohortDate.toISOString()}|${p.dayOffset}`, p);
      }

      // Group retention rows by cohortDate and merge position data
      const cohortMap = new Map<
        string,
        {
          cohortDate: string;
          offsets: {
            dayOffset: number;
            totalWallets: number;
            retainedWallets: number;
            retentionRate: number;
            avgCollateralSizeXlm: number;
            avgBorrowSizeXlm: number;
          }[];
        }
      >();

      for (const r of retentionRows) {
        const key = r.cohortDate.toISOString();
        if (!cohortMap.has(key)) {
          cohortMap.set(key, { cohortDate: key, offsets: [] });
        }
        const pos = positionIndex.get(`${key}|${r.dayOffset}`);
        cohortMap.get(key)!.offsets.push({
          dayOffset: r.dayOffset,
          totalWallets: r.totalWallets,
          retainedWallets: r.retainedWallets,
          retentionRate: r.retentionRate,
          avgCollateralSizeXlm: pos ? pos.avgCollateralSize / 1e7 : 0,
          avgBorrowSizeXlm: pos ? pos.avgBorrowSize / 1e7 : 0,
        });
      }

      return { cohorts: Array.from(cohortMap.values()) };
    } catch {
      return { cohorts: [] };
    }
  });

  /**
   * GET /analytics/live
   *
   * Returns a small snapshot of the latest protocol state suitable for a
   * "live" ticker: most-recent utilization, last-hour revenue totals, and
   * current TVL from RewardSnapshot.
   */
  fastify.get("/analytics/live", async () => {
    try {
      const [latestUtilization, latestRevenue, latestSnapshot] =
        await Promise.all([
          prisma.lendingUtilizationSnapshot.findFirst({
            orderBy: { windowStart: "desc" },
            select: {
              contractId: true,
              windowStart: true,
              totalDeposited: true,
              totalBorrowed: true,
              utilizationRate: true,
            },
          }),
          prisma.revenueSnapshot.findMany({
            orderBy: { windowStart: "desc" },
            distinct: ["source"],
            select: { source: true, windowStart: true, amount: true },
          }),
          prisma.rewardSnapshot.findFirst({
            orderBy: { timestamp: "desc" },
            select: {
              timestamp: true,
              totalStaked: true,
              exchangeRate: true,
            },
          }),
        ]);

      const revenueBySource: Record<string, number> = {};
      for (const r of latestRevenue) {
        revenueBySource[r.source as string] = Number(r.amount) / 1e7;
      }

      return {
        timestamp: new Date().toISOString(),
        tvl: latestSnapshot
          ? {
              timestamp: latestSnapshot.timestamp.toISOString(),
              totalStakedXlm: Number(latestSnapshot.totalStaked) / 1e7,
              exchangeRate: latestSnapshot.exchangeRate,
            }
          : null,
        utilization: latestUtilization
          ? {
              contractId: latestUtilization.contractId,
              windowStart: latestUtilization.windowStart.toISOString(),
              totalDepositedXlm: Number(latestUtilization.totalDeposited) / 1e7,
              totalBorrowedXlm: Number(latestUtilization.totalBorrowed) / 1e7,
              utilizationRate: latestUtilization.utilizationRate,
            }
          : null,
        revenue: revenueBySource,
      };
    } catch {
      return { timestamp: new Date().toISOString(), tvl: null, utilization: null, revenue: {} };
    }
  });

  /**
   * GET /analytics/export/transactions?wallet
   * Export user transaction history as CSV.
   * Includes: stake, unstake, borrow, repay, liquidation, flash loan events.
   */
  fastify.get<{ Querystring: { wallet?: string } }>(
    "/analytics/export/transactions",
    async (request, reply) => {
      const wallet = request.query.wallet as string | undefined;

      if (!wallet) {
        return reply
          .status(400)
          .send({ error: "wallet query parameter is required" });
      }

      try {
        // Fetch all transaction types for the wallet
        const [stakes, borrows, repays, liquidations, flashLoans] =
          await Promise.all([
            prisma.stakeEvent.findMany({
              where: { wallet },
              orderBy: { ledgerClosedAt: "asc" },
              select: {
                id: true,
                txHash: true,
                type: true,
                amount: true,
                ledgerClosedAt: true,
                createdAt: true,
              },
            }),
            prisma.borrowEvent.findMany({
              where: { wallet },
              orderBy: { ledgerClosedAt: "asc" },
              select: {
                id: true,
                txHash: true,
                amount: true,
                asset: true,
                ledgerClosedAt: true,
                createdAt: true,
              },
            }),
            prisma.repayEvent.findMany({
              where: { wallet },
              orderBy: { ledgerClosedAt: "asc" },
              select: {
                id: true,
                txHash: true,
                amount: true,
                asset: true,
                ledgerClosedAt: true,
                createdAt: true,
              },
            }),
            prisma.liquidationEvent.findMany({
              where: { borrower: wallet },
              orderBy: { ledgerClosedAt: "asc" },
              select: {
                id: true,
                txHash: true,
                borrower: true,
                liquidator: true,
                debtRepaid: true,
                collateralSeized: true,
                ledgerClosedAt: true,
                createdAt: true,
              },
            }),
            prisma.flashLoanEvent.findMany({
              where: { wallet },
              orderBy: { ledgerClosedAt: "asc" },
              select: {
                id: true,
                txHash: true,
                amount: true,
                asset: true,
                fee: true,
                ledgerClosedAt: true,
                createdAt: true,
              },
            }),
          ]);

        // Build CSV rows
        const rows: string[] = [
          "Date,Type,Asset,Amount,Fee,Tx Hash,Status",
        ];

        // Process stake events
        for (const s of stakes) {
          const date = s.ledgerClosedAt
            ?.toISOString()
            .split("T")[0] || new Date().toISOString().split("T")[0];
          const type = s.type === "STAKE" ? "Stake" : "Unstake";
          const amountXlm = (Number(s.amount) / 1e7).toFixed(7);
          rows.push(
            `${date},${type},sXLM,${amountXlm},,${s.txHash},Confirmed`
          );
        }

        // Process borrow events
        for (const b of borrows) {
          const date = b.ledgerClosedAt
            ?.toISOString()
            .split("T")[0] || new Date().toISOString().split("T")[0];
          const amountXlm = (Number(b.amount) / 1e7).toFixed(7);
          rows.push(
            `${date},Borrow,${b.asset},${amountXlm},,${b.txHash},Confirmed`
          );
        }

        // Process repay events
        for (const r of repays) {
          const date = r.ledgerClosedAt
            ?.toISOString()
            .split("T")[0] || new Date().toISOString().split("T")[0];
          const amountXlm = (Number(r.amount) / 1e7).toFixed(7);
          rows.push(
            `${date},Repay,${r.asset},${amountXlm},,${r.txHash},Confirmed`
          );
        }

        // Process liquidation events (as borrower)
        for (const l of liquidations) {
          const date = l.ledgerClosedAt
            ?.toISOString()
            .split("T")[0] || new Date().toISOString().split("T")[0];
          const debtXlm = (Number(l.debtRepaid) / 1e7).toFixed(7);
          const collateralXlm = (Number(l.collateralSeized) / 1e7).toFixed(7);
          rows.push(
            `${date},Liquidated (Debt),XLM,-${debtXlm},,${l.txHash},Confirmed`
          );
          rows.push(
            `${date},Liquidated (Collateral),sXLM,-${collateralXlm},,${l.txHash},Confirmed`
          );
        }

        // Process flash loan events
        for (const f of flashLoans) {
          const date = f.ledgerClosedAt
            ?.toISOString()
            .split("T")[0] || new Date().toISOString().split("T")[0];
          const amountXlm = (Number(f.amount) / 1e7).toFixed(7);
          const feeXlm = (Number(f.fee) / 1e7).toFixed(7);
          rows.push(
            `${date},Flash Loan,${f.asset},${amountXlm},${feeXlm},${f.txHash},Confirmed`
          );
        }

        // Generate CSV
        const csv = rows.join("\n");

        // Return with CSV headers
        reply.header("Content-Type", "text/csv");
        reply.header(
          "Content-Disposition",
          `attachment; filename="sxlm-transactions-${wallet.slice(0, 8)}-${new Date().toISOString().split("T")[0]}.csv"`
        );
        return csv;
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Export failed";
        return reply.status(400).send({ error: message });
      }
    }
  );
};
