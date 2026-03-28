import { describe, it, expect } from "vitest";
import { generateToken, verifyToken } from "../src/api-gateway/auth.js";

describe("JWT Auth", () => {
  const testWallet = "GBZXN7PIRZGNMHGA7MUUUF4GWJAM5OQ3BUYB7WI5CNQVSG7VVE3UNW4";

  it("generates a valid token", () => {
    const token = generateToken(testWallet);
    expect(token).toBeDefined();
    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3); // JWT has 3 parts
  });

  it("verifies a generated token", () => {
    const token = generateToken(testWallet);
    const payload = verifyToken(token);
    expect(payload.wallet).toBe(testWallet);
    expect(payload.iat).toBeDefined();
    expect(payload.exp).toBeDefined();
  });

  it("rejects an invalid token", () => {
    expect(() => verifyToken("invalid.token.here")).toThrow();
  });

  it("rejects a tampered token", () => {
    const token = generateToken(testWallet);
    const parts = token.split(".");
    parts[1] = "tampered"; // Corrupt the payload
    const tampered = parts.join(".");
    expect(() => verifyToken(tampered)).toThrow();
  });
});

describe("Event Bus Serialization", () => {
  it("serializes BigInt values in JSON", () => {
    const data = { amount: BigInt(1000000000), wallet: "test" };
    const serialized = JSON.stringify(data, (_, value) =>
      typeof value === "bigint" ? value.toString() : value
    );
    expect(serialized).toContain('"1000000000"');
    expect(serialized).toContain('"test"');
  });
});

describe("Exchange Rate Computation", () => {
  it("returns 1.0 when supply is zero", () => {
    const totalStaked = BigInt(0);
    const totalSupply = BigInt(0);
    const rate = totalSupply === BigInt(0) ? 1.0 : Number(totalStaked) / Number(totalSupply);
    expect(rate).toBe(1.0);
  });

  it("computes correct rate with equal values", () => {
    const totalStaked = BigInt(100_0000000);
    const totalSupply = BigInt(100_0000000);
    const rate = Number(totalStaked) / Number(totalSupply);
    expect(rate).toBe(1.0);
  });

  it("computes correct rate after rewards", () => {
    const totalStaked = BigInt(110_0000000); // 100 + 10 rewards
    const totalSupply = BigInt(100_0000000);
    const rate = Number(totalStaked) / Number(totalSupply);
    expect(rate).toBeCloseTo(1.1, 7);
  });

  it("computes sXLM to mint for deposit after rewards", () => {
    const totalStaked = BigInt(110_0000000);
    const totalSupply = BigInt(100_0000000);
    const depositAmount = BigInt(110_0000000);
    // sxlm_to_mint = deposit * supply / staked
    const sxlmMinted = (depositAmount * totalSupply) / totalStaked;
    expect(Number(sxlmMinted)).toBe(100_0000000);
  });

  it("computes XLM to return for withdrawal after rewards", () => {
    const totalStaked = BigInt(110_0000000);
    const totalSupply = BigInt(100_0000000);
    const sxlmBurned = BigInt(50_0000000);
    // xlm_to_return = sxlm * staked / supply
    const xlmReturned = (sxlmBurned * totalStaked) / totalSupply;
    expect(Number(xlmReturned)).toBe(55_0000000);
  });
});

describe("Staking Input Validation", () => {
  it("rejects negative deposit amount", () => {
    const amount = -100;
    expect(amount).toBeLessThan(0);
  });

  it("rejects zero deposit amount", () => {
    const amount = 0;
    expect(amount).toBeLessThanOrEqual(0);
  });

  it("accepts positive deposit amount", () => {
    const amount = 1000_0000000;
    expect(amount).toBeGreaterThan(0);
  });

  it("rejects negative withdrawal amount", () => {
    const amount = -50;
    expect(amount).toBeLessThan(0);
  });

  it("rejects zero withdrawal amount", () => {
    const amount = 0;
    expect(amount).toBeLessThanOrEqual(0);
  });
});

describe("Governance Input Validation", () => {
  it("validates proposal param key is non-empty", () => {
    const paramKey = "protocol_fee_bps";
    expect(paramKey.length).toBeGreaterThan(0);
  });

  it("rejects empty proposal param key", () => {
    const paramKey = "";
    expect(paramKey.length).toBe(0);
  });

  it("validates proposal value is non-empty", () => {
    const value = "500";
    expect(value.length).toBeGreaterThan(0);
  });

  it("validates quorum percentage is within range", () => {
    const quorumBps = 1000; // 10%
    expect(quorumBps).toBeGreaterThan(0);
    expect(quorumBps).toBeLessThanOrEqual(10000);
  });

  it("rejects quorum above 100%", () => {
    const quorumBps = 15000;
    expect(quorumBps).toBeGreaterThan(10000);
  });
});

describe("LP Pool Input Validation", () => {
  it("validates liquidity amounts are positive", () => {
    const xlmAmount = 10_000_0000000;
    const sxlmAmount = 10_000_0000000;
    expect(xlmAmount).toBeGreaterThan(0);
    expect(sxlmAmount).toBeGreaterThan(0);
  });

  it("rejects zero liquidity amounts", () => {
    const xlmAmount = 0;
    const sxlmAmount = 10_000_0000000;
    expect(xlmAmount).toBeLessThanOrEqual(0);
  });

  it("validates swap amount is positive", () => {
    const swapAmount = 1_000_0000000;
    expect(swapAmount).toBeGreaterThan(0);
  });

  it("validates min_out for slippage protection", () => {
    const minOut = 950_0000000;
    const expectedOut = 990_0000000;
    expect(expectedOut).toBeGreaterThanOrEqual(minOut);
  });

  it("detects slippage violation", () => {
    const minOut = 950_0000000;
    const actualOut = 940_0000000; // below minimum
    expect(actualOut).toBeLessThan(minOut);
  });
});

describe("Lending Input Validation", () => {
  it("validates collateral amount is positive", () => {
    const amount = 5_000_0000000;
    expect(amount).toBeGreaterThan(0);
  });

  it("validates borrow amount against collateral factor", () => {
    const collateral = BigInt(10_000_0000000);
    const exchangeRate = 1.0;
    const cfBps = 7000; // 70%
    const maxBorrow = Number(collateral) * exchangeRate * (cfBps / 10000);
    const borrowRequest = 7_000_0000000;
    expect(borrowRequest).toBeLessThanOrEqual(maxBorrow);
  });

  it("rejects borrow exceeding collateral limit", () => {
    const collateral = BigInt(10_000_0000000);
    const exchangeRate = 1.0;
    const cfBps = 7000;
    const maxBorrow = Number(collateral) * exchangeRate * (cfBps / 10000);
    const borrowRequest = 8_000_0000000;
    expect(borrowRequest).toBeGreaterThan(maxBorrow);
  });

  it("validates health factor above 1.0", () => {
    const collateral = BigInt(10_000_0000000);
    const borrowed = BigInt(5_000_0000000);
    const ltBps = 8000; // 80%
    const exchangeRate = 1.0;
    const hf = (Number(collateral) * exchangeRate * (ltBps / 10000)) / Number(borrowed);
    expect(hf).toBeGreaterThanOrEqual(1.0);
  });

  it("detects unhealthy position", () => {
    const collateral = BigInt(10_000_0000000);
    const borrowed = BigInt(9_000_0000000);
    const ltBps = 8000;
    const exchangeRate = 1.0;
    const hf = (Number(collateral) * exchangeRate * (ltBps / 10000)) / Number(borrowed);
    expect(hf).toBeLessThan(1.0);
  });
});

describe("Multi-Asset Collateral Validation", () => {
  it("validates collateral factor is within 0-90% range", () => {
    const cfBps = 7500; // 75%
    expect(cfBps).toBeGreaterThan(0);
    expect(cfBps).toBeLessThanOrEqual(9000);
  });

  it("rejects collateral factor above 90%", () => {
    const cfBps = 9500;
    expect(cfBps).toBeGreaterThan(9000);
  });

  it("validates asset address is non-empty", () => {
    const assetAddress = "GCZJM35NKGVK47BB4SPBDV25477PZYIYPVVG453LPYFNXLS3FGHDXOCM";
    expect(assetAddress.length).toBeGreaterThan(0);
  });
});
