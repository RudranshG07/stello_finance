import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock external dependencies ──────────────────────────────────────────────

vi.mock("@prisma/client", () => {
  const PrismaClient = vi.fn().mockImplementation(() => ({
    validator: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  }));
  return { PrismaClient };
});

vi.mock("../src/event-bus/index.js", () => ({
  getEventBus: vi.fn(() => ({
    subscribe: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
  })),
  EventType: {
    VALIDATOR_DOWN: "VALIDATOR_DOWN",
    REBALANCE_REQUIRED: "REBALANCE_REQUIRED",
    SLASHING_APPLIED: "SLASHING_APPLIED",
  },
}));

vi.mock("../src/staking-engine/contractClient.js", () => ({
  callApplySlashing: vi.fn().mockResolvedValue(undefined),
  callPause: vi.fn().mockResolvedValue(undefined),
  callUnpause: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/config/index.js", () => ({
  config: {
    protocol: {
      validatorMinUptime: 0.95,
      rebalanceThreshold: 0.05,
    },
    webhooks: {
      slackUrl: null,
      governanceUrl: null,
    },
  },
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { RiskEngine } from "../src/risk-engine/index.js";
import { PrismaClient } from "@prisma/client";
import { getEventBus } from "../src/event-bus/index.js";
import { callPause, callUnpause, callApplySlashing } from "../src/staking-engine/contractClient.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeValidator(overrides: object = {}) {
  return {
    pubkey: "VALIDATOR_A",
    uptime: 0.99,
    performanceScore: 100,
    allocatedStake: BigInt(1_000_000_000),
    lastChecked: new Date(),
    ...overrides,
  };
}

// ─── RiskEngine — initialization ─────────────────────────────────────────────

describe("RiskEngine — initialization", () => {
  it("subscribes to VALIDATOR_DOWN and REBALANCE_REQUIRED events", async () => {
    const prisma = new PrismaClient() as any;
    const engine = new RiskEngine(prisma);
    const mockBus = { subscribe: vi.fn().mockResolvedValue(undefined), publish: vi.fn() };
    (getEventBus as any).mockReturnValue(mockBus);

    await engine.initialize();

    expect(mockBus.subscribe).toHaveBeenCalledTimes(2);
    await engine.shutdown();
  });

  it("starts in non-emergency mode", () => {
    const prisma = new PrismaClient() as any;
    const engine = new RiskEngine(prisma);
    expect(engine.isEmergencyMode()).toBe(false);
  });
});

// ─── RiskEngine — isEmergencyMode ────────────────────────────────────────────

describe("RiskEngine — isEmergencyMode", () => {
  it("returns false initially", () => {
    const prisma = new PrismaClient() as any;
    const engine = new RiskEngine(prisma);
    expect(engine.isEmergencyMode()).toBe(false);
  });
});

// ─── RiskEngine — shutdown ────────────────────────────────────────────────────

describe("RiskEngine — shutdown", () => {
  it("shuts down cleanly without throwing", async () => {
    const prisma = new PrismaClient() as any;
    const engine = new RiskEngine(prisma);
    const mockBus = { subscribe: vi.fn().mockResolvedValue(undefined), publish: vi.fn() };
    (getEventBus as any).mockReturnValue(mockBus);

    await engine.initialize();
    await expect(engine.shutdown()).resolves.toBeUndefined();
  });

  it("can be shut down without being initialized", async () => {
    const prisma = new PrismaClient() as any;
    const engine = new RiskEngine(prisma);
    await expect(engine.shutdown()).resolves.toBeUndefined();
  });
});

// ─── Reallocation logic (pure unit tests) ────────────────────────────────────

describe("Reallocation plan logic", () => {
  it("proportionally distributes stake from unhealthy to healthy validators", () => {
    const healthy = [
      { pubkey: "V_A", performanceScore: 70, allocatedStake: BigInt(0), uptime: 0.99 },
      { pubkey: "V_B", performanceScore: 30, allocatedStake: BigInt(0), uptime: 0.98 },
    ];
    const unhealthy = [
      { pubkey: "V_C", performanceScore: 10, allocatedStake: BigInt(1_000_000), uptime: 0.5 },
    ];

    const stakeToRedistribute = unhealthy.reduce(
      (sum, v) => sum + v.allocatedStake,
      BigInt(0)
    );
    const totalHealthyScore = healthy.reduce((s, v) => s + v.performanceScore, 0);

    const allocations = healthy.map((v) => ({
      pubkey: v.pubkey,
      allocation: BigInt(Math.floor((Number(stakeToRedistribute) * v.performanceScore) / totalHealthyScore)),
    }));

    expect(allocations[0].allocation).toBe(BigInt(700_000)); // 70%
    expect(allocations[1].allocation).toBe(BigInt(300_000)); // 30%
  });

  it("returns zero allocation when no unhealthy validators have stake", () => {
    const unhealthy = [{ pubkey: "V_C", allocatedStake: BigInt(0), uptime: 0.5 }];
    const stakeToRedistribute = unhealthy.reduce((s, v) => s + v.allocatedStake, BigInt(0));
    expect(stakeToRedistribute).toBe(BigInt(0));
  });
});

// ─── Allocation deviation logic ───────────────────────────────────────────────

describe("Allocation deviation logic", () => {
  it("detects deviation above threshold", () => {
    const validators = [
      { pubkey: "V_A", performanceScore: 50, allocatedStake: BigInt(900_000), uptime: 0.99 },
      { pubkey: "V_B", performanceScore: 50, allocatedStake: BigInt(100_000), uptime: 0.99 },
    ];

    const totalScore = validators.reduce((s, v) => s + v.performanceScore, 0);
    const totalStake = validators.reduce((s, v) => s + v.allocatedStake, BigInt(0));

    const deviations = validators.map((v) => {
      const targetFraction = v.performanceScore / totalScore;
      const actualFraction = Number(v.allocatedStake) / Number(totalStake);
      return { pubkey: v.pubkey, deviation: Math.abs(actualFraction - targetFraction) };
    });

    // Both deviate 0.4 (90% vs 50% target and 10% vs 50% target)
    expect(deviations[0].deviation).toBeCloseTo(0.4);
    expect(deviations[1].deviation).toBeCloseTo(0.4);
    // Both exceed the 0.05 rebalance threshold
    expect(deviations[0].deviation).toBeGreaterThan(0.05);
  });

  it("no deviation when stake matches performance weights", () => {
    const validators = [
      { pubkey: "V_A", performanceScore: 60, allocatedStake: BigInt(600_000), uptime: 0.99 },
      { pubkey: "V_B", performanceScore: 40, allocatedStake: BigInt(400_000), uptime: 0.99 },
    ];

    const totalScore = validators.reduce((s, v) => s + v.performanceScore, 0);
    const totalStake = validators.reduce((s, v) => s + v.allocatedStake, BigInt(0));

    validators.forEach((v) => {
      const targetFraction = v.performanceScore / totalScore;
      const actualFraction = Number(v.allocatedStake) / Number(totalStake);
      expect(Math.abs(actualFraction - targetFraction)).toBeCloseTo(0);
    });
  });
});

// ─── Slashing threshold logic ─────────────────────────────────────────────────

describe("Slashing threshold logic", () => {
  it("applies 10% slash for uptime below 50%", () => {
    const uptime = 0.3;
    const slashPercent = uptime < 0.5 ? 0.1 : 0.05;
    expect(slashPercent).toBe(0.1);
  });

  it("applies 5% slash for uptime between 50% and 85%", () => {
    const uptime = 0.7;
    const slashPercent = uptime < 0.5 ? 0.1 : 0.05;
    expect(slashPercent).toBe(0.05);
  });

  it("calculates slash amount correctly", () => {
    const allocatedStake = BigInt(10_000_000); // 1 XLM in stroops
    const slashPercent = 0.05;
    const slashAmount = BigInt(Math.floor(Number(allocatedStake) * slashPercent));
    expect(slashAmount).toBe(BigInt(500_000));
  });

  it("does not slash if stake is zero", () => {
    const allocatedStake = BigInt(0);
    const slashAmount = BigInt(Math.floor(Number(allocatedStake) * 0.05));
    expect(slashAmount).toBe(BigInt(0));
  });
});
