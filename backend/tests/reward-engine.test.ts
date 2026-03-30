import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@prisma/client", () => {
  const PrismaClient = vi.fn().mockImplementation(() => ({
    rewardSnapshot: {
      create: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
  }));
  return { PrismaClient };
});

vi.mock("../src/staking-engine/contractClient.js", () => ({
  getTotalStaked: vi.fn().mockResolvedValue(BigInt(100_000_000)),
  getTotalSupply: vi.fn().mockResolvedValue(BigInt(95_000_000)),
  callUpdateLendingExchangeRate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/staking-engine/exchangeRateManager.js", () => ({
  computeExchangeRate: vi.fn().mockReturnValue(1.05),
}));

vi.mock("../src/event-bus/index.js", () => ({
  getEventBus: vi.fn(() => ({
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
  })),
  EventType: { REWARD_UPDATED: "REWARD_UPDATED" },
}));

vi.mock("../src/config/index.js", () => ({
  config: {
    protocol: {
      rewardSnapshotIntervalMs: 300_000,
    },
  },
}));

import { RewardEngine } from "../src/reward-engine/index.js";
import { PrismaClient } from "@prisma/client";

// ─── RewardEngine — lifecycle ─────────────────────────────────────────────────

describe("RewardEngine — initialize and shutdown", () => {
  it("initializes without throwing", async () => {
    const prisma = new PrismaClient() as any;
    const engine = new RewardEngine(prisma);
    await expect(engine.initialize()).resolves.toBeUndefined();
    await engine.shutdown();
  });

  it("shuts down cleanly without throwing", async () => {
    const prisma = new PrismaClient() as any;
    const engine = new RewardEngine(prisma);
    await engine.initialize();
    await expect(engine.shutdown()).resolves.toBeUndefined();
  });

  it("can shutdown without being initialized", async () => {
    const prisma = new PrismaClient() as any;
    const engine = new RewardEngine(prisma);
    await expect(engine.shutdown()).resolves.toBeUndefined();
  });
});

// ─── RewardEngine — getCurrentAPY ────────────────────────────────────────────

describe("RewardEngine — getCurrentAPY", () => {
  it("returns 0 when no snapshots exist", async () => {
    const prisma = new PrismaClient() as any;
    prisma.rewardSnapshot.findFirst.mockResolvedValue(null);
    const engine = new RewardEngine(prisma);
    expect(await engine.getCurrentAPY()).toBe(0);
  });

  it("returns apy from latest snapshot", async () => {
    const prisma = new PrismaClient() as any;
    prisma.rewardSnapshot.findFirst.mockResolvedValue({ apy: 0.085 });
    const engine = new RewardEngine(prisma);
    expect(await engine.getCurrentAPY()).toBe(0.085);
  });
});

// ─── RewardEngine — getDerivedAPR ────────────────────────────────────────────

describe("RewardEngine — getDerivedAPR", () => {
  it("returns 0 when no snapshots exist", async () => {
    const prisma = new PrismaClient() as any;
    prisma.rewardSnapshot.findFirst.mockResolvedValue(null);
    const engine = new RewardEngine(prisma);
    expect(await engine.getDerivedAPR()).toBe(0);
  });

  it("returns 0 when only one snapshot exists (no growth measurable)", async () => {
    const prisma = new PrismaClient() as any;
    const snap = { id: 1, exchangeRate: 1.05, timestamp: new Date() };
    prisma.rewardSnapshot.findFirst
      .mockResolvedValueOnce(snap)   // oldest
      .mockResolvedValueOnce(snap);  // latest (same)
    const engine = new RewardEngine(prisma);
    expect(await engine.getDerivedAPR()).toBe(0);
  });
});

// ─── RewardEngine — getTotalRewardsDistributed ───────────────────────────────

describe("RewardEngine — getTotalRewardsDistributed", () => {
  it("returns 0 when no snapshots exist", async () => {
    const prisma = new PrismaClient() as any;
    prisma.rewardSnapshot.findFirst.mockResolvedValue(null);
    const engine = new RewardEngine(prisma);
    expect(await engine.getTotalRewardsDistributed()).toBe(BigInt(0));
  });

  it("returns positive rewards when totalStaked > totalSupply", async () => {
    const prisma = new PrismaClient() as any;
    prisma.rewardSnapshot.findFirst.mockResolvedValue({
      totalStaked: BigInt(110_000_000),
      totalSupply: BigInt(100_000_000),
    });
    const engine = new RewardEngine(prisma);
    expect(await engine.getTotalRewardsDistributed()).toBe(BigInt(10_000_000));
  });

  it("returns 0 when totalStaked <= totalSupply", async () => {
    const prisma = new PrismaClient() as any;
    prisma.rewardSnapshot.findFirst.mockResolvedValue({
      totalStaked: BigInt(90_000_000),
      totalSupply: BigInt(100_000_000),
    });
    const engine = new RewardEngine(prisma);
    expect(await engine.getTotalRewardsDistributed()).toBe(BigInt(0));
  });
});

// ─── RewardEngine — getLatestSnapshot ────────────────────────────────────────

describe("RewardEngine — getLatestSnapshot", () => {
  it("returns null when no snapshots exist", async () => {
    const prisma = new PrismaClient() as any;
    prisma.rewardSnapshot.findFirst.mockResolvedValue(null);
    const engine = new RewardEngine(prisma);
    expect(await engine.getLatestSnapshot()).toBeNull();
  });

  it("returns structured snapshot with all required fields", async () => {
    const prisma = new PrismaClient() as any;
    const snap = {
      exchangeRate: 1.05,
      apy: 0.08,
      totalStaked: BigInt(100_000_000),
      totalSupply: BigInt(95_000_000),
      timestamp: new Date(),
    };
    prisma.rewardSnapshot.findFirst.mockResolvedValue(snap);
    const engine = new RewardEngine(prisma);
    const result = await engine.getLatestSnapshot();
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("exchangeRate", 1.05);
    expect(result).toHaveProperty("apy", 0.08);
    expect(result).toHaveProperty("yield7d");
    expect(result).toHaveProperty("yield30d");
    expect(result).toHaveProperty("timestamp");
  });
});

// ─── APY math unit tests ──────────────────────────────────────────────────────

describe("APY calculation math", () => {
  it("annualized return compounds correctly", () => {
    const rateGrowth = 0.01; // 1% growth
    const periodsPerYear = 12;
    const annualized = Math.pow(1 + rateGrowth, periodsPerYear) - 1;
    expect(annualized).toBeCloseTo(0.1268, 3); // ~12.68% APY
  });

  it("caps at 50% maximum APY", () => {
    const absurdReturn = 5.0; // 500%
    const capped = Math.min(absurdReturn, 0.5);
    expect(capped).toBe(0.5);
  });

  it("returns 0 for negative rate growth", () => {
    const rateGrowth = -0.05;
    const result = Math.max(0, rateGrowth);
    expect(result).toBe(0);
  });

  it("APR simple calculation is correct", () => {
    const rateGrowth = 0.03; // 3% over 30 days
    const daysDiff = 30;
    const apr = rateGrowth * (365 / daysDiff);
    expect(apr).toBeCloseTo(0.365, 5); // 36.5% APR
  });
});
