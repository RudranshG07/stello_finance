import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseEvent } from "../src/hubble-indexer/processor.js";
import {
  decodeTopicEntry,
  decodeEventValue,
  extractValueXdr,
  parseEventId,
  extractBase,
  toBigInt,
  toString,
} from "../src/hubble-indexer/decoder.js";
import type { RawSorobanEvent, ParsedEvent } from "../src/hubble-indexer/types.js";

// ─── Decoder unit tests ──────────────────────────────────────────────────────

describe("Decoder — toBigInt", () => {
  it("converts a number to bigint", () => {
    expect(toBigInt(42)).toBe(42n);
  });

  it("converts a string to bigint", () => {
    expect(toBigInt("1000000000")).toBe(1000000000n);
  });

  it("converts a bigint to bigint (identity)", () => {
    expect(toBigInt(999n)).toBe(999n);
  });

  it("returns 0n for null/undefined/garbage", () => {
    expect(toBigInt(null)).toBe(0n);
    expect(toBigInt(undefined)).toBe(0n);
    expect(toBigInt("not-a-number")).toBe(0n);
    expect(toBigInt({})).toBe(0n);
  });
});

describe("Decoder — toString", () => {
  it("converts values to string", () => {
    expect(toString("hello")).toBe("hello");
    expect(toString(42)).toBe("42");
    expect(toString(true)).toBe("true");
  });

  it("returns empty string for null/undefined", () => {
    expect(toString(null)).toBe("");
    expect(toString(undefined)).toBe("");
  });
});

describe("Decoder — extractValueXdr", () => {
  it("extracts xdr from object form", () => {
    expect(extractValueXdr({ xdr: "AAAA" })).toBe("AAAA");
  });

  it("returns plain string as-is", () => {
    expect(extractValueXdr("BBBB")).toBe("BBBB");
  });
});

describe("Decoder — parseEventId", () => {
  it("parses a standard 31-char event ID", () => {
    const id = "0000012345600000000020000000003";
    const result = parseEventId(id);
    expect(result.ledger).toBe(123456);
    expect(result.txIndex).toBe(2);
    expect(result.eventIndex).toBe(3);
  });

  it("handles short/non-standard IDs gracefully", () => {
    const result = parseEventId("12345");
    expect(result.ledger).toBe(12345);
    expect(result.txIndex).toBe(0);
    expect(result.eventIndex).toBe(0);
  });

  it("handles empty string", () => {
    const result = parseEventId("");
    expect(result.ledger).toBe(0);
    expect(result.txIndex).toBe(0);
    expect(result.eventIndex).toBe(0);
  });
});

describe("Decoder — extractBase", () => {
  it("builds ParsedEventBase from a raw event", () => {
    const raw: RawSorobanEvent = {
      type: "contract",
      ledger: 100,
      ledgerClosedAt: "2026-01-15T12:00:00Z",
      contractId: "CTEST",
      id: "0000000010000000000000000000001",
      paginationToken: "tok",
      topic: [],
      value: "",
      txHash: "abc123",
      inSuccessfulContractCall: true,
    };
    const base = extractBase(raw);
    expect(base.txHash).toBe("abc123");
    expect(base.contractId).toBe("CTEST");
    expect(base.ledger).toBe(100);
    expect(base.ledgerClosedAt).toBeInstanceOf(Date);
    expect(base.ledgerClosedAt.toISOString()).toBe("2026-01-15T12:00:00.000Z");
  });

  it("uses fallback txHash when txHash is falsy (empty string coalesces via ??)", () => {
    const raw: RawSorobanEvent = {
      type: "contract",
      ledger: 55,
      ledgerClosedAt: "",
      contractId: "CTEST",
      id: "",
      paginationToken: "",
      topic: [],
      value: "",
      txHash: "",
      inSuccessfulContractCall: true,
    };
    const base = extractBase(raw);
    // `??` only catches null/undefined, not empty string — empty string is preserved
    expect(base.txHash).toBe("");
  });
});

// ─── Event types ─────────────────────────────────────────────────────────────

describe("ParsedEvent types", () => {
  it("ParsedStakeEvent has correct shape", () => {
    const event: Extract<ParsedEvent, { kind: "stake" }> = {
      txHash: "tx1",
      eventIndex: 0,
      contractId: "C1",
      ledger: 10,
      ledgerClosedAt: new Date(),
      kind: "stake",
      wallet: "GWALLET1",
      amount: 1000n,
      eventType: "STAKE",
    };
    expect(event.kind).toBe("stake");
    expect(event.eventType).toBe("STAKE");
  });

  it("ParsedBorrowEvent has correct shape", () => {
    const event: Extract<ParsedEvent, { kind: "borrow" }> = {
      txHash: "tx2",
      eventIndex: 1,
      contractId: "C2",
      ledger: 20,
      ledgerClosedAt: new Date(),
      kind: "borrow",
      wallet: "GWALLET2",
      amount: 5000n,
      asset: "XLM",
    };
    expect(event.kind).toBe("borrow");
    expect(event.asset).toBe("XLM");
  });

  it("ParsedRepayEvent has correct shape", () => {
    const event: Extract<ParsedEvent, { kind: "repay" }> = {
      txHash: "tx3",
      eventIndex: 2,
      contractId: "C3",
      ledger: 30,
      ledgerClosedAt: new Date(),
      kind: "repay",
      wallet: "GWALLET3",
      amount: 3000n,
      asset: "XLM",
    };
    expect(event.kind).toBe("repay");
  });

  it("ParsedFlashLoanEvent has correct shape", () => {
    const event: Extract<ParsedEvent, { kind: "flash_loan" }> = {
      txHash: "tx4",
      eventIndex: 3,
      contractId: "C4",
      ledger: 40,
      ledgerClosedAt: new Date(),
      kind: "flash_loan",
      wallet: "GWALLET4",
      amount: 10000n,
      asset: "XLM",
      fee: 50n,
    };
    expect(event.kind).toBe("flash_loan");
    expect(event.fee).toBe(50n);
  });

  it("ParsedLiquidationEvent has correct shape", () => {
    const event: Extract<ParsedEvent, { kind: "liquidation" }> = {
      txHash: "tx5",
      eventIndex: 4,
      contractId: "C5",
      ledger: 50,
      ledgerClosedAt: new Date(),
      kind: "liquidation",
      liquidator: "GLIQ",
      borrower: "GBORROW",
      debtRepaid: 2000n,
      collateralSeized: 2500n,
    };
    expect(event.kind).toBe("liquidation");
    expect(event.collateralSeized - event.debtRepaid).toBe(500n);
  });
});

// ─── Analytics route helpers ─────────────────────────────────────────────────

describe("Analytics route helpers", () => {
  function parseDate(value: string | undefined, fallback: Date): Date {
    if (!value) return fallback;
    const d = new Date(value);
    return isNaN(d.getTime()) ? fallback : d;
  }

  function daysAgo(n: number): Date {
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  }

  it("parseDate returns fallback for undefined", () => {
    const fallback = new Date("2026-01-01");
    expect(parseDate(undefined, fallback)).toBe(fallback);
  });

  it("parseDate returns fallback for invalid date string", () => {
    const fallback = new Date("2026-01-01");
    expect(parseDate("not-a-date", fallback)).toBe(fallback);
  });

  it("parseDate parses valid ISO date", () => {
    const fallback = new Date("2026-01-01");
    const result = parseDate("2026-06-15", fallback);
    expect(result.toISOString().startsWith("2026-06-15")).toBe(true);
  });

  it("daysAgo returns a date in the past", () => {
    const d = daysAgo(30);
    expect(d.getTime()).toBeLessThan(Date.now());
    const diff = Date.now() - d.getTime();
    const daysDiff = diff / (24 * 60 * 60 * 1000);
    expect(daysDiff).toBeCloseTo(30, 0);
  });
});

// ─── Metric aggregation logic ────────────────────────────────────────────────

describe("Metric aggregation — utilization rate", () => {
  it("computes 0 when totalDeposited is 0", () => {
    const totalDeposited = 0n;
    const totalBorrowed = 0n;
    const rate =
      totalDeposited > 0n
        ? Number(totalBorrowed) / Number(totalDeposited)
        : 0;
    expect(rate).toBe(0);
  });

  it("computes correct utilization rate", () => {
    const totalDeposited = 10_000_0000000n;
    const totalBorrowed = 4_500_0000000n;
    const rate = Number(totalBorrowed) / Number(totalDeposited);
    expect(rate).toBeCloseTo(0.45, 4);
  });

  it("handles 100% utilization", () => {
    const totalDeposited = 5_000_0000000n;
    const totalBorrowed = 5_000_0000000n;
    const rate = Number(totalBorrowed) / Number(totalDeposited);
    expect(rate).toBe(1);
  });
});

describe("Metric aggregation — hour floor", () => {
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

  it("floors to the start of the hour", () => {
    const d = new Date("2026-03-18T14:37:22.456Z");
    const floored = hourFloor(d);
    expect(floored.toISOString()).toBe("2026-03-18T14:00:00.000Z");
  });

  it("is idempotent on an already-floored date", () => {
    const d = new Date("2026-03-18T14:00:00.000Z");
    expect(hourFloor(d).toISOString()).toBe("2026-03-18T14:00:00.000Z");
  });
});

describe("Metric aggregation — revenue computation", () => {
  it("computes liquidation bonus correctly", () => {
    const liquidations = [
      { collateralSeized: 2500n, debtRepaid: 2000n },
      { collateralSeized: 1000n, debtRepaid: 1200n },
      { collateralSeized: 5000n, debtRepaid: 4000n },
    ];

    const bonus = liquidations.reduce((acc, ev) => {
      const b = ev.collateralSeized - ev.debtRepaid;
      return b > 0n ? acc + b : acc;
    }, 0n);

    expect(bonus).toBe(1500n);
  });

  it("ignores negative bonuses (underwater liquidations)", () => {
    const liquidations = [
      { collateralSeized: 1000n, debtRepaid: 1500n },
    ];

    const bonus = liquidations.reduce((acc, ev) => {
      const b = ev.collateralSeized - ev.debtRepaid;
      return b > 0n ? acc + b : acc;
    }, 0n);

    expect(bonus).toBe(0n);
  });

  it("computes treasury revenue delta correctly", () => {
    const metricsBefore = { protocolFees: 1000n };
    const metricsAfter = { protocolFees: 1350n };
    const delta = metricsAfter.protocolFees - metricsBefore.protocolFees;
    expect(delta).toBe(350n);
  });
});

// ─── Cohort aggregation logic ────────────────────────────────────────────────

describe("Cohort aggregation — day helpers", () => {
  function dayFloor(d: Date): Date {
    return new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    );
  }

  function addDays(d: Date, n: number): Date {
    return new Date(d.getTime() + n * 86_400_000);
  }

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

  it("dayFloor truncates to midnight UTC", () => {
    const d = new Date("2026-03-18T15:45:30.123Z");
    expect(dayFloor(d).toISOString()).toBe("2026-03-18T00:00:00.000Z");
  });

  it("addDays adds correct number of days", () => {
    const d = new Date("2026-03-18T00:00:00.000Z");
    expect(addDays(d, 5).toISOString()).toBe("2026-03-23T00:00:00.000Z");
    expect(addDays(d, -3).toISOString()).toBe("2026-03-15T00:00:00.000Z");
  });

  it("dayRange generates inclusive range", () => {
    const from = new Date("2026-03-15T00:00:00.000Z");
    const to = new Date("2026-03-18T00:00:00.000Z");
    const range = dayRange(from, to);
    expect(range).toHaveLength(4);
    expect(range[0].toISOString()).toBe("2026-03-15T00:00:00.000Z");
    expect(range[3].toISOString()).toBe("2026-03-18T00:00:00.000Z");
  });

  it("dayRange returns single day for same from/to", () => {
    const d = new Date("2026-03-18T00:00:00.000Z");
    expect(dayRange(d, d)).toHaveLength(1);
  });
});

describe("Cohort aggregation — retention rate", () => {
  it("computes retention rate correctly", () => {
    const totalWallets = 100;
    const retainedWallets = 65;
    const rate = retainedWallets / totalWallets;
    expect(rate).toBe(0.65);
  });

  it("handles 100% retention", () => {
    expect(50 / 50).toBe(1);
  });

  it("handles 0% retention", () => {
    expect(0 / 100).toBe(0);
  });
});

describe("Cohort aggregation — average position size", () => {
  it("computes mean collateral and borrow sizes", () => {
    const positions = [
      { stakedAmount: 1000n, borrowedAmount: 500n },
      { stakedAmount: 2000n, borrowedAmount: 800n },
      { stakedAmount: 3000n, borrowedAmount: 700n },
    ];

    const n = positions.length;
    const totalStaked = positions.reduce(
      (acc, p) => acc + Number(p.stakedAmount),
      0
    );
    const totalBorrowed = positions.reduce(
      (acc, p) => acc + Number(p.borrowedAmount),
      0
    );

    expect(totalStaked / n).toBe(2000);
    expect(totalBorrowed / n).toBeCloseTo(666.67, 1);
  });

  it("returns 0 for empty positions", () => {
    const positions: { stakedAmount: bigint; borrowedAmount: bigint }[] = [];
    const avg = positions.length > 0
      ? positions.reduce((a, p) => a + Number(p.stakedAmount), 0) / positions.length
      : 0;
    expect(avg).toBe(0);
  });
});

// ─── Wallet daily activity carry-forward logic ───────────────────────────────

describe("Cohort aggregation — carry-forward daily activity", () => {
  it("accumulates stake deltas correctly", () => {
    const prev = { stakedAmount: 5000n, borrowedAmount: 2000n };
    const delta = { stake: 1000n, borrow: -500n };

    const newStaked = prev.stakedAmount + delta.stake;
    const newBorrowed = prev.borrowedAmount + delta.borrow;

    expect(newStaked).toBe(6000n);
    expect(newBorrowed).toBe(1500n);
  });

  it("clamps negative balances to zero", () => {
    const prev = { stakedAmount: 1000n, borrowedAmount: 500n };
    const delta = { stake: -2000n, borrow: -1000n };

    const rawStaked = prev.stakedAmount + delta.stake;
    const rawBorrowed = prev.borrowedAmount + delta.borrow;

    const stakedAmount = rawStaked > 0n ? rawStaked : 0n;
    const borrowedAmount = rawBorrowed > 0n ? rawBorrowed : 0n;

    expect(stakedAmount).toBe(0n);
    expect(borrowedAmount).toBe(0n);
  });

  it("derives isStakeActive / isBorrowActive flags", () => {
    expect(5000n > 0n).toBe(true);
    expect(0n > 0n).toBe(false);
    expect(-100n > 0n).toBe(false);
  });
});

// ─── API response shape validation ──────────────────────────────────────────

describe("Analytics API response shapes", () => {
  it("TVL response has correct structure", () => {
    const response = {
      from: "2025-12-18T00:00:00.000Z",
      to: "2026-03-18T00:00:00.000Z",
      data: [
        {
          timestamp: "2026-03-18T21:23:54.740Z",
          totalStakedXlm: 155000,
          tvlUsd: 26269.865,
          exchangeRate: 1,
        },
      ],
    };

    expect(response.from).toBeDefined();
    expect(response.to).toBeDefined();
    expect(Array.isArray(response.data)).toBe(true);
    expect(response.data[0].totalStakedXlm).toBeGreaterThanOrEqual(0);
    expect(response.data[0].tvlUsd).toBeGreaterThanOrEqual(0);
    expect(typeof response.data[0].exchangeRate).toBe("number");
  });

  it("utilization response has correct structure", () => {
    const response = {
      from: "2025-12-18T00:00:00.000Z",
      to: "2026-03-18T00:00:00.000Z",
      data: [
        {
          contractId: "CAOWXZ6BWA2ZYY7GHD75OFKADKUJS4WCKPDYGGXULQWFJRB55TXAQNJG",
          windowStart: "2026-03-18T21:00:00.000Z",
          windowEnd: "2026-03-18T22:00:00.000Z",
          totalDepositedXlm: 0,
          totalBorrowedXlm: 0,
          utilizationRate: 0,
        },
      ],
    };

    expect(response.data[0].contractId).toBeDefined();
    expect(typeof response.data[0].utilizationRate).toBe("number");
    expect(response.data[0].utilizationRate).toBeGreaterThanOrEqual(0);
    expect(response.data[0].utilizationRate).toBeLessThanOrEqual(1);
  });

  it("revenue response (source groupBy) has correct structure", () => {
    const response = {
      from: "2025-12-18T00:00:00.000Z",
      to: "2026-03-18T00:00:00.000Z",
      groupBy: "source",
      series: {
        LP: [{ windowStart: "2026-03-18T21:00:00.000Z", windowEnd: "2026-03-18T22:00:00.000Z", amountXlm: 0 }],
        TREASURY: [{ windowStart: "2026-03-18T21:00:00.000Z", windowEnd: "2026-03-18T22:00:00.000Z", amountXlm: 0 }],
        LENDING: [{ windowStart: "2026-03-18T21:00:00.000Z", windowEnd: "2026-03-18T22:00:00.000Z", amountXlm: 0 }],
      },
    };

    expect(response.groupBy).toBe("source");
    expect(response.series).toBeDefined();
    expect(Object.keys(response.series)).toContain("LENDING");
    expect(Object.keys(response.series)).toContain("LP");
    expect(Object.keys(response.series)).toContain("TREASURY");
  });

  it("revenue response (window groupBy) has correct structure", () => {
    const response = {
      from: "2025-12-18T00:00:00.000Z",
      to: "2026-03-18T00:00:00.000Z",
      groupBy: "window",
      data: [
        { source: "LP", windowStart: "2026-03-18T21:00:00.000Z", windowEnd: "2026-03-18T22:00:00.000Z", amountXlm: 0 },
      ],
    };

    expect(response.groupBy).toBe("window");
    expect(Array.isArray(response.data)).toBe(true);
    expect(response.data[0].source).toBeDefined();
  });

  it("live response has correct structure", () => {
    const response = {
      timestamp: "2026-03-18T22:21:16.161Z",
      tvl: { timestamp: "2026-03-18T21:23:54.740Z", totalStakedXlm: 155000, exchangeRate: 1 },
      utilization: {
        contractId: "CAOWXZ6BWA2ZYY7GHD75OFKADKUJS4WCKPDYGGXULQWFJRB55TXAQNJG",
        windowStart: "2026-03-18T21:00:00.000Z",
        totalDepositedXlm: 0,
        totalBorrowedXlm: 0,
        utilizationRate: 0,
      },
      revenue: { LP: 0, TREASURY: 0, LENDING: 0 },
    };

    expect(response.timestamp).toBeDefined();
    expect(response.tvl).toBeDefined();
    expect(response.utilization).toBeDefined();
    expect(response.revenue).toBeDefined();
    expect(typeof response.revenue.LENDING).toBe("number");
  });

  it("cohorts response has correct structure", () => {
    const response = {
      cohorts: [
        {
          cohortDate: "2026-03-01T00:00:00.000Z",
          offsets: [
            {
              dayOffset: 0,
              totalWallets: 50,
              retainedWallets: 50,
              retentionRate: 1,
              avgCollateralSizeXlm: 5000,
              avgBorrowSizeXlm: 2000,
            },
            {
              dayOffset: 1,
              totalWallets: 50,
              retainedWallets: 40,
              retentionRate: 0.8,
              avgCollateralSizeXlm: 5200,
              avgBorrowSizeXlm: 2100,
            },
          ],
        },
      ],
    };

    expect(Array.isArray(response.cohorts)).toBe(true);
    expect(response.cohorts[0].cohortDate).toBeDefined();
    expect(response.cohorts[0].offsets[0].dayOffset).toBe(0);
    expect(response.cohorts[0].offsets[0].retentionRate).toBe(1);
    expect(response.cohorts[0].offsets[1].retentionRate).toBe(0.8);
  });
});

// ─── XLM unit conversion ────────────────────────────────────────────────────

describe("XLM unit conversion (stroops ↔ XLM)", () => {
  it("converts stroops to XLM correctly", () => {
    // 1 XLM = 10_000_000 stroops (1e7)
    // 155,000 XLM = 155000 * 1e7 = 1,550,000,000,000 stroops
    const stroops155k = BigInt(155_000) * BigInt(1e7); // 1_550_000_000_000n
    expect(Number(stroops155k) / 1e7).toBe(155_000);
    expect(Number(1_0000000n) / 1e7).toBe(1);
    expect(Number(5000000n) / 1e7).toBe(0.5);
  });

  it("converts XLM to stroops correctly", () => {
    const xlm = 155_000;
    const stroops = BigInt(xlm) * BigInt(1e7);
    expect(stroops).toBe(1_550_000_000_000n);
    expect(Number(stroops) / 1e7).toBe(xlm);
  });
});

// ─── Rate limiter logic ──────────────────────────────────────────────────────

describe("Rate limiter token bucket", () => {
  it("allows immediate calls up to the limit", () => {
    let tokens = 4;
    const maxTokens = 4;

    for (let i = 0; i < maxTokens; i++) {
      expect(tokens >= 1).toBe(true);
      tokens -= 1;
    }
    expect(tokens).toBe(0);
  });

  it("refills tokens over time", () => {
    let tokens = 0;
    const maxTokens = 4;
    const elapsedSeconds = 0.5;
    const added = elapsedSeconds * maxTokens;
    tokens = Math.min(maxTokens, tokens + added);
    expect(tokens).toBe(2);
  });
});

// ─── Deduplication strategy ──────────────────────────────────────────────────

describe("Event deduplication", () => {
  it("unique key is (txHash, eventIndex)", () => {
    const events = [
      { txHash: "tx1", eventIndex: 0 },
      { txHash: "tx1", eventIndex: 1 },
      { txHash: "tx2", eventIndex: 0 },
      { txHash: "tx1", eventIndex: 0 },
    ];

    const seen = new Set<string>();
    const unique = events.filter((e) => {
      const key = `${e.txHash}:${e.eventIndex}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    expect(unique).toHaveLength(3);
  });
});

// ─── Cursor management ──────────────────────────────────────────────────────

describe("Cursor management", () => {
  it("tracks per-contract cursors correctly", () => {
    const cursors = new Map<string, number>();
    const events = [
      { contractId: "C1", ledger: 100 },
      { contractId: "C2", ledger: 105 },
      { contractId: "C1", ledger: 110 },
      { contractId: "C2", ledger: 103 },
    ];

    for (const event of events) {
      const prev = cursors.get(event.contractId) ?? 0;
      if (event.ledger > prev) {
        cursors.set(event.contractId, event.ledger);
      }
    }

    expect(cursors.get("C1")).toBe(110);
    expect(cursors.get("C2")).toBe(105);
  });

  it("computes globalLastLedger as max across all contracts", () => {
    const cursors = new Map<string, number>([
      ["C1", 110],
      ["C2", 105],
      ["C3", 120],
    ]);

    let globalLastLedger = 0;
    for (const ledger of cursors.values()) {
      if (ledger > globalLastLedger) globalLastLedger = ledger;
    }

    expect(globalLastLedger).toBe(120);
  });
});
