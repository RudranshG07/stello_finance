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
