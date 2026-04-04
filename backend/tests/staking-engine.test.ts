import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@prisma/client", () => {
  const PrismaClient = vi.fn().mockImplementation(() => ({}));
  return { PrismaClient };
});

vi.mock("../src/staking-engine/exchangeRateManager.js", () => ({
  startPeriodicRefresh: vi.fn(),
  stopPeriodicRefresh: vi.fn(),
  getCurrentRate: vi.fn().mockReturnValue(1.05),
}));

vi.mock("../src/staking-engine/withdrawalQueueProcessor.js", () => ({
  startWithdrawalQueueProcessor: vi.fn(),
  stopWithdrawalQueueProcessor: vi.fn(),
  getQueueStats: vi.fn().mockResolvedValue({ pending: 0, processing: 0 }),
}));

vi.mock("../src/staking-engine/contractClient.js", () => ({
  getTotalStaked: vi.fn().mockResolvedValue(BigInt(100_000_000)),
  getTotalSupply: vi.fn().mockResolvedValue(BigInt(95_000_000)),
  getLiquidityBuffer: vi.fn().mockResolvedValue(BigInt(10_000_000)),
  getTreasuryBalance: vi.fn().mockResolvedValue(BigInt(5_000_000)),
  getIsPaused: vi.fn().mockResolvedValue(false),
  getProtocolFeeBps: vi.fn().mockResolvedValue(50),
  callApplySlashing: vi.fn().mockResolvedValue(undefined),
  callPause: vi.fn().mockResolvedValue(undefined),
  callUnpause: vi.fn().mockResolvedValue(undefined),
  callRecalibrateRate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/event-bus/index.js", () => ({
  getEventBus: vi.fn(() => ({
    subscribe: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
  })),
  EventType: {
    SLASHING_APPLIED: "SLASHING_APPLIED",
  },
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { StakingEngine } from "../src/staking-engine/index.js";
import { PrismaClient } from "@prisma/client";
import { getCurrentRate } from "../src/staking-engine/exchangeRateManager.js";
import {
  startWithdrawalQueueProcessor,
  stopWithdrawalQueueProcessor,
} from "../src/staking-engine/withdrawalQueueProcessor.js";

// ─── StakingEngine — initialize ───────────────────────────────────────────────

describe("StakingEngine — initialize", () => {
  it("starts exchange rate refresh and withdrawal queue processor", async () => {
    const prisma = new PrismaClient() as any;
    const engine = new StakingEngine(prisma);

    const { startPeriodicRefresh } = await import("../src/staking-engine/exchangeRateManager.js");

    await engine.initialize();

    expect(startPeriodicRefresh).toHaveBeenCalled();
    expect(startWithdrawalQueueProcessor).toHaveBeenCalledWith(prisma);

    await engine.shutdown();
  });
});

// ─── StakingEngine — shutdown ─────────────────────────────────────────────────

describe("StakingEngine — shutdown", () => {
  it("stops exchange rate refresh and withdrawal queue processor", async () => {
    const prisma = new PrismaClient() as any;
    const engine = new StakingEngine(prisma);

    const { stopPeriodicRefresh } = await import("../src/staking-engine/exchangeRateManager.js");

    await engine.initialize();
    await engine.shutdown();

    expect(stopPeriodicRefresh).toHaveBeenCalled();
    expect(stopWithdrawalQueueProcessor).toHaveBeenCalled();
  });
});

// ─── StakingEngine — getExchangeRate ──────────────────────────────────────────

describe("StakingEngine — getExchangeRate", () => {
  it("returns current rate from exchangeRateManager", async () => {
    const prisma = new PrismaClient() as any;
    const engine = new StakingEngine(prisma);

    const rate = await engine.getExchangeRate();
    expect(rate).toBe(1.05);
    expect(getCurrentRate).toHaveBeenCalled();
  });
});

// ─── StakingEngine — getProtocolStats ────────────────────────────────────────

describe("StakingEngine — getProtocolStats", () => {
  it("returns all protocol stats with correct structure", async () => {
    const prisma = new PrismaClient() as any;
    const engine = new StakingEngine(prisma);

    const stats = await engine.getProtocolStats();

    expect(stats).toHaveProperty("totalStaked");
    expect(stats).toHaveProperty("totalSupply");
    expect(stats).toHaveProperty("exchangeRate");
    expect(stats).toHaveProperty("liquidityBuffer");
    expect(stats).toHaveProperty("treasuryBalance");
    expect(stats).toHaveProperty("isPaused");
    expect(stats).toHaveProperty("protocolFeeBps");
  });

  it("returns correct values from contract client", async () => {
    const prisma = new PrismaClient() as any;
    const engine = new StakingEngine(prisma);

    const stats = await engine.getProtocolStats();

    expect(stats.totalStaked).toBe(BigInt(100_000_000));
    expect(stats.totalSupply).toBe(BigInt(95_000_000));
    expect(stats.exchangeRate).toBe(1.05);
    expect(stats.isPaused).toBe(false);
    expect(stats.protocolFeeBps).toBe(50);
  });
});

// ─── Exchange rate math ───────────────────────────────────────────────────────

describe("Exchange rate calculations", () => {
  it("correctly converts XLM to sXLM using exchange rate", () => {
    const xlmAmount = 100;
    const exchangeRate = 1.05;
    const sXlmReceived = xlmAmount / exchangeRate;
    expect(sXlmReceived).toBeCloseTo(95.238);
  });

  it("correctly converts sXLM to XLM using exchange rate", () => {
    const sXlmAmount = 95.238;
    const exchangeRate = 1.05;
    const xlmRedeemed = sXlmAmount * exchangeRate;
    expect(xlmRedeemed).toBeCloseTo(100);
  });

  it("exchange rate of 1.0 means 1:1 conversion", () => {
    const amount = 1000;
    const exchangeRate = 1.0;
    expect(amount / exchangeRate).toBe(1000);
    expect(amount * exchangeRate).toBe(1000);
  });

  it("handles stroop precision correctly", () => {
    const xlmInStroops = BigInt(100_000_000); // 10 XLM
    const exchangeRate = 1.05;
    const sXlmInStroops = BigInt(Math.floor(Number(xlmInStroops) / exchangeRate));
    expect(sXlmInStroops).toBe(BigInt(95_238_095));
  });
});

// ─── Protocol fee math ────────────────────────────────────────────────────────

describe("Protocol fee calculations", () => {
  it("calculates correct fee from basis points", () => {
    const amount = BigInt(10_000_000); // 1 XLM
    const feeBps = 50; // 0.5%
    const fee = BigInt(Math.floor(Number(amount) * feeBps / 10_000));
    expect(fee).toBe(BigInt(50_000)); // 0.005 XLM
  });

  it("zero fee for 0 bps", () => {
    const amount = BigInt(10_000_000);
    const feeBps = 0;
    const fee = BigInt(Math.floor(Number(amount) * feeBps / 10_000));
    expect(fee).toBe(BigInt(0));
  });

  it("100% fee for 10000 bps", () => {
    const amount = BigInt(10_000_000);
    const feeBps = 10_000;
    const fee = BigInt(Math.floor(Number(amount) * feeBps / 10_000));
    expect(fee).toBe(amount);
  });
});
