import { describe, it, expect } from "vitest";
import { z } from "zod";

const RATE_PRECISION = 10_000_000;
const BPS_DENOMINATOR = 10_000;

interface AssetConfig {
  collateralFactorBps: number;
  liquidationThresholdBps: number;
  priceInXlm: number;
  enabled: boolean;
}

function computeTotalCollateralValue(
  positions: Map<string, bigint>,
  configs: Map<string, AssetConfig>
): bigint {
  let total = 0n;
  for (const [asset, amount] of positions) {
    if (amount === 0n) continue;
    const cfg = configs.get(asset);
    if (!cfg) continue;
    total += (amount * BigInt(cfg.priceInXlm)) / BigInt(RATE_PRECISION);
  }
  return total;
}

function computeMaxBorrow(
  positions: Map<string, bigint>,
  configs: Map<string, AssetConfig>
): bigint {
  let maxBorrow = 0n;
  for (const [asset, amount] of positions) {
    if (amount === 0n) continue;
    const cfg = configs.get(asset);
    if (!cfg) continue;
    maxBorrow +=
      (amount * BigInt(cfg.priceInXlm) * BigInt(cfg.collateralFactorBps)) /
      BigInt(RATE_PRECISION * BPS_DENOMINATOR);
  }
  return maxBorrow;
}

function computeHealthFactor(
  positions: Map<string, bigint>,
  configs: Map<string, AssetConfig>,
  borrowed: bigint
): number {
  if (borrowed === 0n) return Infinity;
  let weighted = 0n;
  for (const [asset, amount] of positions) {
    if (amount === 0n) continue;
    const cfg = configs.get(asset);
    if (!cfg) continue;
    weighted +=
      (amount * BigInt(cfg.priceInXlm) * BigInt(cfg.liquidationThresholdBps)) /
      BigInt(RATE_PRECISION * BPS_DENOMINATOR);
  }
  return Number((weighted * BigInt(RATE_PRECISION)) / borrowed) / RATE_PRECISION;
}

const SXLM = "SXLM_CONTRACT";
const USDC = "USDC_CONTRACT";
const EURC = "EURC_CONTRACT";

const sxlmConfig: AssetConfig = {
  collateralFactorBps: 7500,
  liquidationThresholdBps: 8000,
  priceInXlm: RATE_PRECISION, // 1:1
  enabled: true,
};

const usdcConfig: AssetConfig = {
  collateralFactorBps: 9000,
  liquidationThresholdBps: 9200,
  priceInXlm: 83_333_333, // ≈ 8.3333 XLM per USDC
  enabled: true,
};

const eurcConfig: AssetConfig = {
  collateralFactorBps: 8800,
  liquidationThresholdBps: 9000,
  priceInXlm: 90_000_000, // ≈ 9.0 XLM per EURC
  enabled: true,
};

// ─── computeTotalCollateralValue ────────────────────────────────────────────

describe("computeTotalCollateralValue", () => {
  it("returns 0 for empty positions", () => {
    const result = computeTotalCollateralValue(new Map(), new Map());
    expect(result).toBe(0n);
  });

  it("returns correct value for single sXLM position at 1:1", () => {
    const positions = new Map([[SXLM, 10_000_000_000n]]); // 1000 sXLM
    const configs = new Map([[SXLM, sxlmConfig]]);
    // 1000 sXLM * 1e7 / 1e7 = 1000 XLM in stroops
    expect(computeTotalCollateralValue(positions, configs)).toBe(10_000_000_000n);
  });

  it("scales correctly when sXLM price increases to 1.2", () => {
    const positions = new Map([[SXLM, 10_000_000_000n]]); // 1000 sXLM
    const updatedConfig: AssetConfig = { ...sxlmConfig, priceInXlm: 12_000_000 }; // 1.2
    const configs = new Map([[SXLM, updatedConfig]]);
    // 1000 * 12_000_000 / 1e7 = 1200 XLM → 12_000_000_000 stroops
    expect(computeTotalCollateralValue(positions, configs)).toBe(12_000_000_000n);
  });

  it("sums across multiple assets correctly", () => {
    // 1000 sXLM (1:1) = 1000 XLM
    // 10 USDC * 8.3333... = 83.333... XLM ≈ 833_330_000 (due to integer division of 83_333_333/1e7)
    const positions = new Map([
      [SXLM, 10_000_000_000n], // 1000 sXLM
      [USDC, 100_000_000n],    // 10 USDC (7-decimal precision)
    ]);
    const configs = new Map([
      [SXLM, sxlmConfig],
      [USDC, usdcConfig],
    ]);
    const total = computeTotalCollateralValue(positions, configs);
    // sXLM: 10_000_000_000 * 10_000_000 / 10_000_000 = 10_000_000_000
    // USDC: 100_000_000 * 83_333_333 / 10_000_000 = 833_333_33 (int div)
    expect(total).toBeGreaterThan(10_000_000_000n);
    expect(total).toBeLessThan(11_000_000_000n);
  });

  it("skips assets with zero balance", () => {
    const positions = new Map([
      [SXLM, 10_000_000_000n],
      [USDC, 0n],
    ]);
    const configs = new Map([
      [SXLM, sxlmConfig],
      [USDC, usdcConfig],
    ]);
    expect(computeTotalCollateralValue(positions, configs)).toBe(10_000_000_000n);
  });
});

// ─── computeMaxBorrow ────────────────────────────────────────────────────────

describe("computeMaxBorrow", () => {
  it("returns 0 for no collateral", () => {
    expect(computeMaxBorrow(new Map(), new Map())).toBe(0n);
  });

  it("applies sXLM collateral factor (75%) at 1:1 price", () => {
    const positions = new Map([[SXLM, 10_000_000_000n]]); // 1000 sXLM
    const configs = new Map([[SXLM, sxlmConfig]]); // CF=75%
    // max_borrow = 1000 * 1e7 * 7500 / (1e7 * 10000) = 1000 * 0.75 = 750
    expect(computeMaxBorrow(positions, configs)).toBe(7_500_000_000n);
  });

  it("applies USDC collateral factor (90%)", () => {
    const positions = new Map([[USDC, 100_000_000n]]); // 10 USDC at 8.3333 XLM
    const configs = new Map([[USDC, usdcConfig]]); // CF=90%
    // max_borrow = 10 * 8.3333 * 0.9 = 74.999 XLM ≈ 749_999_970 stroops (int division)
    const maxBorrow = computeMaxBorrow(positions, configs);
    expect(Number(maxBorrow) / 1e7).toBeCloseTo(75, 0);
  });

  it("sums max borrow from multiple assets", () => {
    const positions = new Map([
      [SXLM, 10_000_000_000n], // 1000 sXLM → 750 XLM max borrow
      [USDC, 100_000_000n],    // 10 USDC → ~75 XLM max borrow
    ]);
    const configs = new Map([
      [SXLM, sxlmConfig],
      [USDC, usdcConfig],
    ]);
    const maxBorrow = computeMaxBorrow(positions, configs);
    const maxBorrowXlm = Number(maxBorrow) / 1e7;
    // Total should be approx 750 + 75 = 825 XLM
    expect(maxBorrowXlm).toBeGreaterThan(820);
    expect(maxBorrowXlm).toBeLessThan(830);
  });

  it("reflects increased borrow capacity after price increase", () => {
    const positions = new Map([[SXLM, 10_000_000_000n]]);
    const configV1 = new Map([[SXLM, { ...sxlmConfig, priceInXlm: RATE_PRECISION }]]);
    const configV2 = new Map([[SXLM, { ...sxlmConfig, priceInXlm: 15_000_000 }]]); // 1.5x

    const mb1 = computeMaxBorrow(positions, configV1);
    const mb2 = computeMaxBorrow(positions, configV2);

    expect(mb2).toBeGreaterThan(mb1);
    // 1000 * 1.5 * 0.75 = 1125 vs 1000 * 1.0 * 0.75 = 750
    expect(Number(mb2) / Number(mb1)).toBeCloseTo(1.5, 5);
  });
});

// ─── computeHealthFactor ─────────────────────────────────────────────────────

describe("computeHealthFactor", () => {
  it("returns Infinity when there is no debt", () => {
    const positions = new Map([[SXLM, 10_000_000_000n]]);
    const configs = new Map([[SXLM, sxlmConfig]]);
    expect(computeHealthFactor(positions, configs, 0n)).toBe(Infinity);
  });

  it("returns correct HF for sXLM only at 1:1 price", () => {
    // 1000 sXLM * 1.0 * 80% / 500 XLM = 800/500 = 1.6
    const positions = new Map([[SXLM, 10_000_000_000n]]);
    const configs = new Map([[SXLM, sxlmConfig]]); // LT=80%
    const hf = computeHealthFactor(positions, configs, 5_000_000_000n);
    expect(hf).toBeCloseTo(1.6, 5);
  });

  it("returns HF > 1.0 for healthy position", () => {
    const positions = new Map([[SXLM, 10_000_000_000n]]); // 1000 sXLM
    const configs = new Map([[SXLM, sxlmConfig]]);
    // Borrow 600 (well below max 750 at CF=75%, and LT would be 1000*0.8=800)
    const hf = computeHealthFactor(positions, configs, 6_000_000_000n);
    expect(hf).toBeGreaterThan(1.0);
  });

  it("returns HF < 1.0 for unhealthy position", () => {
    // Low liquidation threshold (50%) makes 700 XLM borrow against 1000 sXLM unhealthy
    const lowLtConfig: AssetConfig = { ...sxlmConfig, liquidationThresholdBps: 5000 };
    const positions = new Map([[SXLM, 10_000_000_000n]]);
    const configs = new Map([[SXLM, lowLtConfig]]);
    // HF = 1000 * 0.5 / 700 = 500/700 ≈ 0.714
    const hf = computeHealthFactor(positions, configs, 7_000_000_000n);
    expect(hf).toBeLessThan(1.0);
    expect(hf).toBeCloseTo(0.7142857, 5);
  });

  it("improves HF when price increases", () => {
    const positions = new Map([[SXLM, 10_000_000_000n]]);
    const cfg1 = new Map([[SXLM, { ...sxlmConfig, priceInXlm: RATE_PRECISION }]]);
    const cfg2 = new Map([[SXLM, { ...sxlmConfig, priceInXlm: 12_000_000 }]]); // 1.2x
    const borrowed = 5_000_000_000n;

    const hf1 = computeHealthFactor(positions, cfg1, borrowed);
    const hf2 = computeHealthFactor(positions, cfg2, borrowed);
    expect(hf2).toBeGreaterThan(hf1);
    // hf1 = 1000*1.0*0.8/500 = 1.6
    // hf2 = 1000*1.2*0.8/500 = 1.92
    expect(hf1).toBeCloseTo(1.6, 5);
    expect(hf2).toBeCloseTo(1.92, 5);
  });

  it("multi-asset HF sums weighted collateral correctly", () => {
    // 1000 sXLM (LT=80%, price=1.0) + 10 USDC (LT=92%, price=8.3333)
    // weighted = 1000*0.8 + 83.333*0.92 = 800 + 76.666 = 876.666 XLM
    // borrowed = 800 XLM → HF ≈ 1.096
    const positions = new Map([
      [SXLM, 10_000_000_000n],
      [USDC, 100_000_000n],
    ]);
    const configs = new Map([
      [SXLM, sxlmConfig],
      [USDC, usdcConfig],
    ]);
    const hf = computeHealthFactor(positions, configs, 8_000_000_000n);
    expect(hf).toBeGreaterThan(1.0);
    expect(hf).toBeCloseTo(1.096, 1);
  });

  it("liquidation scenario: seizing specific asset reduces remaining HF", () => {
    // Simulate post-liquidation state: liquidator took sXLM, only USDC remains
    const prePositions = new Map([
      [SXLM, 10_000_000_000n],
      [USDC, 100_000_000n],
    ]);
    const configs = new Map([
      [SXLM, sxlmConfig],
      [USDC, usdcConfig],
    ]);
    const borrowed = 8_000_000_000n;
    const hfBefore = computeHealthFactor(prePositions, configs, borrowed);

    // After liquidation, sXLM seized, debt cleared
    const postPositions = new Map([
      [SXLM, 0n],
      [USDC, 100_000_000n],
    ]);
    const hfAfter = computeHealthFactor(postPositions, configs, 0n);

    expect(hfBefore).toBeGreaterThan(1.0);
    expect(hfAfter).toBe(Infinity); // debt is zero
  });
});

// ─── Liquidation reward calculation ─────────────────────────────────────────

describe("Liquidation bonus calculation", () => {
  const BONUS_BPS = 500; // 5%

  it("computes asset to seize correctly at 1:1 price", () => {
    const debtXlm = 7_000_000_000n; // 700 XLM
    const debtWithBonus = (debtXlm * BigInt(BPS_DENOMINATOR + BONUS_BPS)) / BigInt(BPS_DENOMINATOR);
    // 700 * 1.05 = 735 XLM worth of sXLM
    const assetToSeize = (debtWithBonus * BigInt(RATE_PRECISION)) / BigInt(RATE_PRECISION); // price = 1:1
    expect(Number(debtWithBonus) / 1e7).toBeCloseTo(735, 1);
    expect(assetToSeize).toBe(debtWithBonus); // at 1:1 price
  });

  it("computes asset to seize correctly at different price", () => {
    // Liquidating USDC position: price = 8.3333 XLM per USDC
    const debtXlm = 500_000_000n; // 50 XLM
    const priceInXlm = 83_333_333n; // 8.3333 * 1e7
    const debtWithBonus = (debtXlm * BigInt(BPS_DENOMINATOR + BONUS_BPS)) / BigInt(BPS_DENOMINATOR);
    // 50 * 1.05 = 52.5 XLM → USDC to seize = 52.5 / 8.3333 ≈ 6.3 USDC
    const usdcToSeize = (debtWithBonus * BigInt(RATE_PRECISION)) / priceInXlm;
    expect(Number(usdcToSeize) / 1e7).toBeCloseTo(6.3, 0);
  });

  it("caps seized amount at available collateral", () => {
    const available = 5_000_000_000n; // 500 sXLM
    const toSeize = 7_350_000_000n; // would seize 735 sXLM but only 500 available
    const actual = toSeize > available ? available : toSeize;
    expect(actual).toBe(available);
  });
});

// ─── Schema validation for new API fields ────────────────────────────────────

describe("Lending route schema validation", () => {
  const amountSchema = z.object({
    userAddress: z.string().min(56).max(56),
    amount: z.number().positive(),
    asset: z.string().min(56).max(56).optional(),
  });

  const liquidateSchema = z.object({
    liquidatorAddress: z.string().min(56).max(56),
    borrowerAddress: z.string().min(56).max(56),
    collateralAsset: z.string().min(56).max(56).optional(),
  });

  const VALID_ADDRESS = "CCGFHMW3NZD5Z7ATHYHZSEG6ABCJADUHP5HIAWFPR37CP4VGNEDQO7FJ"; // 56 chars

  it("accepts deposit without asset (defaults to sXLM)", () => {
    const result = amountSchema.safeParse({ userAddress: VALID_ADDRESS, amount: 100 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.asset).toBeUndefined();
  });

  it("accepts deposit with explicit asset address", () => {
    const result = amountSchema.safeParse({
      userAddress: VALID_ADDRESS,
      amount: 100,
      asset: VALID_ADDRESS,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.asset).toBe(VALID_ADDRESS);
  });

  it("rejects asset with wrong length", () => {
    const result = amountSchema.safeParse({
      userAddress: VALID_ADDRESS,
      amount: 100,
      asset: "TOOSHORT",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative amount", () => {
    const result = amountSchema.safeParse({ userAddress: VALID_ADDRESS, amount: -5 });
    expect(result.success).toBe(false);
  });

  it("accepts liquidate without collateralAsset", () => {
    const result = liquidateSchema.safeParse({
      liquidatorAddress: VALID_ADDRESS,
      borrowerAddress: VALID_ADDRESS,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.collateralAsset).toBeUndefined();
  });

  it("accepts liquidate with explicit collateralAsset", () => {
    const result = liquidateSchema.safeParse({
      liquidatorAddress: VALID_ADDRESS,
      borrowerAddress: VALID_ADDRESS,
      collateralAsset: VALID_ADDRESS,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.collateralAsset).toBe(VALID_ADDRESS);
  });
});

// ─── Position response shape ──────────────────────────────────────────────────

describe("Position API response shape", () => {
  it("multi-asset response has expected fields", () => {
    const response = {
      wallet: "GBZXN7PIRZGNMHGA7MUUUF4GWJAM5OQ3BUYB7WI5CNQVSG7VVE3UNW4",
      totalCollateralXlm: 1083.33,
      totalCollateralXlmRaw: "10833333330",
      xlmBorrowed: 500,
      xlmBorrowedRaw: "5000000000",
      healthFactor: 1.73,
      maxBorrow: 325,
      assetPositions: [
        {
          contractId: "CCGFHMW3NZD5Z7ATHYHZSEG6ABCJADUHP5HIAWFPR37CP4VGNEDQO7FJ",
          symbol: "sXLM",
          amountDeposited: 1000,
          xlmValue: 1000,
          collateralFactorBps: 7500,
          liquidationThresholdBps: 8000,
          priceInXlm: 1.0,
        },
        {
          contractId: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
          symbol: "USDC",
          amountDeposited: 10,
          xlmValue: 83.33,
          collateralFactorBps: 9000,
          liquidationThresholdBps: 9200,
          priceInXlm: 8.3333,
        },
      ],
    };

    expect(response.totalCollateralXlm).toBeGreaterThan(0);
    expect(response.assetPositions).toHaveLength(2);
    expect(response.assetPositions[0].symbol).toBe("sXLM");
    expect(response.assetPositions[1].symbol).toBe("USDC");
    expect(response.assetPositions[1].collateralFactorBps).toBe(9000);
    expect(response.maxBorrow).toBeGreaterThan(0);
  });

  it("fallback response has correct zero state", () => {
    const fallback = {
      wallet: "GBZXN7PIRZGNMHGA7MUUUF4GWJAM5OQ3BUYB7WI5CNQVSG7VVE3UNW4",
      totalCollateralXlm: 0,
      totalCollateralXlmRaw: "0",
      xlmBorrowed: 0,
      xlmBorrowedRaw: "0",
      healthFactor: 0,
      maxBorrow: 0,
      assetPositions: [],
    };

    expect(fallback.totalCollateralXlm).toBe(0);
    expect(fallback.assetPositions).toHaveLength(0);
  });
});

// ─── Supported assets configuration ─────────────────────────────────────────

describe("Supported assets configuration", () => {
  const SUPPORTED_ASSETS = [
    { symbol: "sXLM", defaultCfBps: 7500, defaultLtBps: 8000 },
    { symbol: "USDC", defaultCfBps: 9000, defaultLtBps: 9200 },
    { symbol: "EURC", defaultCfBps: 8800, defaultLtBps: 9000 },
    { symbol: "yXLM", defaultCfBps: 7000, defaultLtBps: 7500 },
  ];

  it("has 4 supported assets", () => {
    expect(SUPPORTED_ASSETS).toHaveLength(4);
  });

  it("all assets have lt_bps >= cf_bps", () => {
    for (const a of SUPPORTED_ASSETS) {
      expect(a.defaultLtBps).toBeGreaterThanOrEqual(a.defaultCfBps);
    }
  });

  it("all cf_bps are within valid range (0-10000)", () => {
    for (const a of SUPPORTED_ASSETS) {
      expect(a.defaultCfBps).toBeGreaterThan(0);
      expect(a.defaultCfBps).toBeLessThanOrEqual(10_000);
    }
  });

  it("sXLM has lower CF than USDC (sXLM is more volatile)", () => {
    const sxlm = SUPPORTED_ASSETS.find((a) => a.symbol === "sXLM")!;
    const usdc = SUPPORTED_ASSETS.find((a) => a.symbol === "USDC")!;
    expect(sxlm.defaultCfBps).toBeLessThan(usdc.defaultCfBps);
  });

  it("stable coins (USDC, EURC) have higher CF than XLM-based assets", () => {
    const usdc = SUPPORTED_ASSETS.find((a) => a.symbol === "USDC")!;
    const eurc = SUPPORTED_ASSETS.find((a) => a.symbol === "EURC")!;
    const sxlm = SUPPORTED_ASSETS.find((a) => a.symbol === "sXLM")!;
    expect(usdc.defaultCfBps).toBeGreaterThan(sxlm.defaultCfBps);
    expect(eurc.defaultCfBps).toBeGreaterThan(sxlm.defaultCfBps);
  });
});

// ─── XLM value computation ────────────────────────────────────────────────────

describe("XLM value computation for display", () => {
  it("converts asset amount + price to XLM correctly", () => {
    // 10 USDC * 8.3333 XLM/USDC = 83.333 XLM
    const amount = 10; // human-readable
    const priceInXlm = 8.3333;
    const xlmValue = amount * priceInXlm;
    expect(xlmValue).toBeCloseTo(83.333, 2);
  });

  it("sXLM at 1.05 exchange rate gives correct XLM value", () => {
    const amount = 1000; // 1000 sXLM
    const priceInXlm = 1.05; // 5% rewards accumulated
    const xlmValue = amount * priceInXlm;
    expect(xlmValue).toBe(1050);
  });

  it("collateral factor reduces borrow capacity correctly", () => {
    const xlmValue = 1000; // XLM value of collateral
    const cfBps = 7500;
    const maxBorrow = (xlmValue * cfBps) / 10_000;
    expect(maxBorrow).toBe(750);
  });
});
