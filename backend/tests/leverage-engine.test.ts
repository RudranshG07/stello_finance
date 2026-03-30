import { describe, it, expect, vi } from "vitest";
import { LeverageEngine, type LeverageSimulationInput } from "../src/leverage-engine/index.js";

const engine = new LeverageEngine();

// ─── simulate() ──────────────────────────────────────────────────────────────

describe("LeverageEngine.simulate — basic mechanics", () => {
  it("returns correct maxLeverage for collateralFactor 0.7", () => {
    const result = engine.simulate({
      principal: 1000,
      loops: 5,
      collateralFactor: 0.7,
      stakingAPR: 0.06,
      borrowAPR: 0.04,
    });
    // maxLeverage = 1 / (1 - 0.7) = 3.333...
    expect(result.maxLeverage).toBeCloseTo(3.333, 2);
  });

  it("returns correct maxLeverage for collateralFactor 0.5", () => {
    const result = engine.simulate({
      principal: 1000,
      loops: 3,
      collateralFactor: 0.5,
      stakingAPR: 0.08,
      borrowAPR: 0.03,
    });
    // maxLeverage = 1 / (1 - 0.5) = 2.0
    expect(result.maxLeverage).toBeCloseTo(2.0, 5);
  });

  it("totalStaked grows with each loop", () => {
    const result = engine.simulate({
      principal: 1000,
      loops: 3,
      collateralFactor: 0.7,
      stakingAPR: 0.06,
      borrowAPR: 0.04,
    });
    expect(result.totalStaked).toBeGreaterThan(1000);
  });

  it("totalBorrowed is positive after multiple loops", () => {
    const result = engine.simulate({
      principal: 1000,
      loops: 3,
      collateralFactor: 0.7,
      stakingAPR: 0.06,
      borrowAPR: 0.04,
    });
    expect(result.totalBorrowed).toBeGreaterThan(0);
  });

  it("loop count matches input loops", () => {
    const result = engine.simulate({
      principal: 1000,
      loops: 4,
      collateralFactor: 0.7,
      stakingAPR: 0.06,
      borrowAPR: 0.04,
    });
    expect(result.loops).toHaveLength(4);
  });

  it("single loop — totalStaked equals principal", () => {
    const result = engine.simulate({
      principal: 1000,
      loops: 1,
      collateralFactor: 0.7,
      stakingAPR: 0.06,
      borrowAPR: 0.04,
    });
    expect(result.loops[0].totalStaked).toBeCloseTo(1000, 5);
  });

  it("borrowed amount in each loop = deposited * collateralFactor", () => {
    const result = engine.simulate({
      principal: 1000,
      loops: 3,
      collateralFactor: 0.6,
      stakingAPR: 0.06,
      borrowAPR: 0.04,
    });
    for (const loop of result.loops) {
      expect(loop.borrowed).toBeCloseTo(loop.deposited * 0.6, 5);
    }
  });
});

describe("LeverageEngine.simulate — yield calculations", () => {
  it("netYieldPercent is positive when stakingAPR > borrowAPR", () => {
    const result = engine.simulate({
      principal: 1000,
      loops: 5,
      collateralFactor: 0.7,
      stakingAPR: 0.10,
      borrowAPR: 0.04,
    });
    expect(result.netYieldPercent).toBeGreaterThan(0);
  });

  it("netYieldPercent is negative when borrowAPR > stakingAPR", () => {
    const result = engine.simulate({
      principal: 1000,
      loops: 5,
      collateralFactor: 0.7,
      stakingAPR: 0.02,
      borrowAPR: 0.10,
    });
    expect(result.netYieldPercent).toBeLessThan(0);
  });

  it("grossYield = totalStaked * stakingAPR", () => {
    const input: LeverageSimulationInput = {
      principal: 1000,
      loops: 5,
      collateralFactor: 0.7,
      stakingAPR: 0.06,
      borrowAPR: 0.04,
    };
    const result = engine.simulate(input);
    expect(result.grossYield).toBeCloseTo(result.totalStaked * input.stakingAPR, 5);
  });

  it("borrowCost = totalBorrowed * borrowAPR", () => {
    const input: LeverageSimulationInput = {
      principal: 1000,
      loops: 5,
      collateralFactor: 0.7,
      stakingAPR: 0.06,
      borrowAPR: 0.04,
    };
    const result = engine.simulate(input);
    expect(result.borrowCost).toBeCloseTo(result.totalBorrowed * input.borrowAPR, 5);
  });

  it("netYield = grossYield - borrowCost", () => {
    const result = engine.simulate({
      principal: 1000,
      loops: 5,
      collateralFactor: 0.7,
      stakingAPR: 0.06,
      borrowAPR: 0.04,
    });
    expect(result.netYield).toBeCloseTo(result.grossYield - result.borrowCost, 10);
  });
});

describe("LeverageEngine.simulate — edge cases", () => {
  it("zero loops returns zero totalStaked", () => {
    const result = engine.simulate({
      principal: 1000,
      loops: 0,
      collateralFactor: 0.7,
      stakingAPR: 0.06,
      borrowAPR: 0.04,
    });
    expect(result.totalStaked).toBe(0);
    expect(result.loops).toHaveLength(0);
  });

  it("higher loops increases effectiveLeverage", () => {
    const base = engine.simulate({ principal: 1000, loops: 2, collateralFactor: 0.7, stakingAPR: 0.06, borrowAPR: 0.04 });
    const more = engine.simulate({ principal: 1000, loops: 8, collateralFactor: 0.7, stakingAPR: 0.06, borrowAPR: 0.04 });
    expect(more.effectiveLeverage).toBeGreaterThan(base.effectiveLeverage);
  });

  it("effectiveLeverage never exceeds maxLeverage", () => {
    const result = engine.simulate({
      principal: 1000,
      loops: 20,
      collateralFactor: 0.7,
      stakingAPR: 0.06,
      borrowAPR: 0.04,
    });
    expect(result.effectiveLeverage).toBeLessThanOrEqual(result.maxLeverage + 0.001);
  });

  it("zero stakingAPR produces zero grossYield", () => {
    const result = engine.simulate({
      principal: 1000,
      loops: 5,
      collateralFactor: 0.7,
      stakingAPR: 0,
      borrowAPR: 0.04,
    });
    expect(result.grossYield).toBeCloseTo(0, 10);
  });
});
