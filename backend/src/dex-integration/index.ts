import { Asset } from "@stellar/stellar-sdk";

export const STROOPS_PER_XLM = 10_000_000;
export const DEFAULT_SWAP_FEE_BPS = 30;

export type DexTokenSymbol = "XLM" | "sXLM";

export interface PoolSnapshot {
  reserveXlmRaw: bigint;
  reserveSxlmRaw: bigint;
  totalLpSupplyRaw: bigint;
  feeBps: number;
  observedAt: Date;
}

export interface OracleObservation {
  observedAt: Date;
  spotPrice: number;
}

export interface SwapQuote {
  tokenIn: DexTokenSymbol;
  tokenOut: DexTokenSymbol;
  amountInRaw: bigint;
  amountOutRaw: bigint;
  amountIn: number;
  amountOut: number;
  minimumAmountOutRaw: bigint;
  minimumAmountOut: number;
  executionPrice: number;
  spotPrice: number;
  priceImpactBps: number;
  feeBps: number;
  route: "sxlm-xlm-direct";
}

export interface OracleSnapshot {
  spotPrice: number;
  twapPrice: number;
  deviationBps: number;
  windowSeconds: number;
  sampleCount: number;
  startTime: string;
  endTime: string;
  confidence: "low" | "medium" | "high";
}

export interface DexRoute {
  id: "stellarx" | "lumenswap";
  name: string;
  pair: "sXLM/XLM";
  type: "direct";
  tokenIn: DexTokenSymbol;
  tokenOut: DexTokenSymbol;
  amountIn: number;
  expectedAmountOut: number;
  minimumAmountOut: number;
  executionPrice: number;
  priceImpactBps: number;
  estimatedSlippageBps: number;
  steps: Array<{
    dex: string;
    pool: "sXLM/XLM";
    tokenIn: DexTokenSymbol;
    tokenOut: DexTokenSymbol;
  }>;
}

export interface LiquidityMiningProgram {
  programId: string;
  title: string;
  status: "draft" | "pending" | "active" | "ended" | "cancelled";
  rewardAsset: string;
  rewardPerDayRaw: bigint;
  startAt: string;
  endAt: string;
  minLpTokensRaw: bigint;
  totalRewardsRaw?: bigint | null;
  distributedRewardsRaw?: bigint | null;
  dexes: string[];
  governanceProposalId?: number | null;
  metadata: Record<string, unknown>;
}

export interface LiquidityMiningEstimate {
  programId: string;
  title: string;
  status: LiquidityMiningProgram["status"];
  rewardAsset: string;
  estimatedDailyRewardsRaw: bigint;
  estimatedDailyRewards: number;
  sharePercent: number;
  startAt: string;
  endAt: string;
}

function safeNumber(raw: bigint): number {
  return Number(raw) / STROOPS_PER_XLM;
}

export function rawAmountToDisplay(raw: bigint): number {
  return safeNumber(raw);
}

export function displayAmountToRaw(amount: number): bigint {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("Amount must be a non-negative finite number");
  }
  return BigInt(Math.floor(amount * STROOPS_PER_XLM));
}

export function computeSpotPrice(snapshot: PoolSnapshot): number {
  if (snapshot.reserveSxlmRaw <= 0n) {
    return 1;
  }
  return Number(snapshot.reserveXlmRaw) / Number(snapshot.reserveSxlmRaw);
}

function applyConstantProductQuote(
  reserveInRaw: bigint,
  reserveOutRaw: bigint,
  amountInRaw: bigint,
  feeBps: number
): bigint {
  if (reserveInRaw <= 0n || reserveOutRaw <= 0n || amountInRaw <= 0n) {
    return 0n;
  }

  const feeDenominator = 10_000n;
  const amountAfterFee = (amountInRaw * (feeDenominator - BigInt(feeBps))) / feeDenominator;
  if (amountAfterFee <= 0n) {
    return 0n;
  }

  return reserveOutRaw - (reserveInRaw * reserveOutRaw) / (reserveInRaw + amountAfterFee);
}

export function quoteExactIn(
  snapshot: PoolSnapshot,
  tokenIn: DexTokenSymbol,
  amountInRaw: bigint,
  slippageBps = 50
): SwapQuote {
  if (amountInRaw <= 0n) {
    throw new Error("Amount in must be positive");
  }
  if (snapshot.reserveXlmRaw <= 0n || snapshot.reserveSxlmRaw <= 0n) {
    throw new Error("Pool has no liquidity");
  }

  const tokenOut: DexTokenSymbol = tokenIn === "XLM" ? "sXLM" : "XLM";
  const reserveInRaw = tokenIn === "XLM" ? snapshot.reserveXlmRaw : snapshot.reserveSxlmRaw;
  const reserveOutRaw = tokenIn === "XLM" ? snapshot.reserveSxlmRaw : snapshot.reserveXlmRaw;
  const amountOutRaw = applyConstantProductQuote(
    reserveInRaw,
    reserveOutRaw,
    amountInRaw,
    snapshot.feeBps
  );

  if (amountOutRaw <= 0n) {
    throw new Error("Pool has insufficient liquidity for this trade");
  }

  const amountIn = rawAmountToDisplay(amountInRaw);
  const amountOut = rawAmountToDisplay(amountOutRaw);
  const spotPrice = computeSpotPrice(snapshot);
  const executionPrice = tokenIn === "XLM" ? amountIn / amountOut : amountOut / amountIn;
  const referencePrice = spotPrice;
  const priceImpactBps =
    referencePrice > 0 ? Math.abs((executionPrice - referencePrice) / referencePrice) * 10_000 : 0;
  const minimumAmountOutRaw =
    (amountOutRaw * BigInt(Math.max(0, 10_000 - slippageBps))) / 10_000n;

  return {
    tokenIn,
    tokenOut,
    amountInRaw,
    amountOutRaw,
    amountIn,
    amountOut,
    minimumAmountOutRaw,
    minimumAmountOut: rawAmountToDisplay(minimumAmountOutRaw),
    executionPrice,
    spotPrice,
    priceImpactBps,
    feeBps: snapshot.feeBps,
    route: "sxlm-xlm-direct",
  };
}

export function buildDexRoutes(
  quote: SwapQuote,
  preferredDexes = ["StellarX", "Lumenswap"]
): DexRoute[] {
  return preferredDexes.map((dexName) => ({
    id: dexName.toLowerCase() === "stellarx" ? "stellarx" : "lumenswap",
    name: dexName,
    pair: "sXLM/XLM",
    type: "direct",
    tokenIn: quote.tokenIn,
    tokenOut: quote.tokenOut,
    amountIn: quote.amountIn,
    expectedAmountOut: quote.amountOut,
    minimumAmountOut: quote.minimumAmountOut,
    executionPrice: quote.executionPrice,
    priceImpactBps: quote.priceImpactBps,
    estimatedSlippageBps: quote.priceImpactBps,
    steps: [
      {
        dex: dexName,
        pool: "sXLM/XLM",
        tokenIn: quote.tokenIn,
        tokenOut: quote.tokenOut,
      },
    ],
  }));
}

function computeConfidence(sampleCount: number, windowSeconds: number): OracleSnapshot["confidence"] {
  if (sampleCount >= 5 && windowSeconds >= 900) return "high";
  if (sampleCount >= 2) return "medium";
  return "low";
}

export function computeTwapPrice(
  observations: OracleObservation[],
  windowSeconds: number,
  now = new Date()
): OracleSnapshot {
  if (windowSeconds <= 0) {
    throw new Error("windowSeconds must be positive");
  }

  const sorted = [...observations].sort(
    (left, right) => left.observedAt.getTime() - right.observedAt.getTime()
  );
  if (sorted.length === 0) {
    throw new Error("At least one observation is required");
  }

  const windowStartMs = now.getTime() - windowSeconds * 1000;
  const firstFutureIndex = sorted.findIndex((item) => item.observedAt.getTime() >= windowStartMs);
  const anchorIndex = firstFutureIndex <= 0 ? 0 : firstFutureIndex - 1;
  const relevant = sorted.slice(anchorIndex);

  let segmentStart = windowStartMs;
  let activePrice = relevant[0]?.spotPrice ?? sorted[sorted.length - 1]!.spotPrice;
  let weighted = 0;

  for (const observation of relevant) {
    const observationTime = observation.observedAt.getTime();
    if (observationTime <= windowStartMs) {
      activePrice = observation.spotPrice;
      continue;
    }
    const segmentEnd = Math.min(observationTime, now.getTime());
    if (segmentEnd > segmentStart) {
      weighted += activePrice * (segmentEnd - segmentStart);
    }
    activePrice = observation.spotPrice;
    segmentStart = segmentEnd;
  }

  if (now.getTime() > segmentStart) {
    weighted += activePrice * (now.getTime() - segmentStart);
  }

  const twapPrice = weighted / (windowSeconds * 1000);
  const spotPrice = sorted[sorted.length - 1]!.spotPrice;
  const deviationBps =
    twapPrice > 0 ? Math.abs((spotPrice - twapPrice) / twapPrice) * 10_000 : 0;

  return {
    spotPrice,
    twapPrice,
    deviationBps,
    windowSeconds,
    sampleCount: sorted.length,
    startTime: new Date(windowStartMs).toISOString(),
    endTime: now.toISOString(),
    confidence: computeConfidence(sorted.length, windowSeconds),
  };
}

function parseProgramStatus(value: unknown): LiquidityMiningProgram["status"] {
  if (
    value === "draft" ||
    value === "pending" ||
    value === "active" ||
    value === "ended" ||
    value === "cancelled"
  ) {
    return value;
  }
  return "pending";
}

function normalizeBigIntField(
  source: Record<string, unknown>,
  field: string,
  fallback: bigint
): bigint {
  const value = source[field];
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return BigInt(value);
  }
  return fallback;
}

function normalizeRewardAsset(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "sXLM";
  }

  const normalized = value.trim();
  return normalized.toUpperCase() === Asset.native().getCode()
    ? Asset.native().getCode()
    : normalized;
}

export function parseLiquidityMiningProgramProposal(
  paramKey: string,
  newValue: string,
  proposalId?: number
): LiquidityMiningProgram | null {
  if (!paramKey.startsWith("liquidity_mining_program")) {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(newValue) as Record<string, unknown>;
  } catch {
    return null;
  }
  const suffix = paramKey.split(":")[1];
  const programId =
    typeof parsed.programId === "string" && parsed.programId.length > 0
      ? parsed.programId
      : suffix || `proposal-${proposalId ?? "draft"}`;

  const title =
    typeof parsed.title === "string" && parsed.title.length > 0
      ? parsed.title
      : `Liquidity Mining ${programId}`;

  const startAt =
    typeof parsed.startAt === "string" && parsed.startAt.length > 0
      ? parsed.startAt
      : new Date().toISOString();
  const endAt =
    typeof parsed.endAt === "string" && parsed.endAt.length > 0
      ? parsed.endAt
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const dexes = Array.isArray(parsed.dexes)
    ? parsed.dexes.filter((item): item is string => typeof item === "string")
    : ["StellarX", "Lumenswap"];

  return {
    programId,
    title,
    status: parseProgramStatus(parsed.status),
    rewardAsset: normalizeRewardAsset(parsed.rewardAsset),
    rewardPerDayRaw: normalizeBigIntField(parsed, "rewardPerDayRaw", 0n),
    startAt,
    endAt,
    minLpTokensRaw: normalizeBigIntField(parsed, "minLpTokensRaw", 0n),
    totalRewardsRaw: normalizeBigIntField(parsed, "totalRewardsRaw", 0n),
    distributedRewardsRaw: normalizeBigIntField(parsed, "distributedRewardsRaw", 0n),
    dexes,
    governanceProposalId: proposalId ?? null,
    metadata: parsed,
  };
}

export function estimateLiquidityMiningRewards(params: {
  program: LiquidityMiningProgram;
  userLpTokensRaw: bigint;
  totalLpSupplyRaw: bigint;
}): LiquidityMiningEstimate {
  const { program, userLpTokensRaw, totalLpSupplyRaw } = params;
  const share =
    totalLpSupplyRaw > 0n ? Number(userLpTokensRaw) / Number(totalLpSupplyRaw) : 0;
  const estimatedDailyRewardsRaw =
    totalLpSupplyRaw > 0n ? (program.rewardPerDayRaw * userLpTokensRaw) / totalLpSupplyRaw : 0n;

  return {
    programId: program.programId,
    title: program.title,
    status: program.status,
    rewardAsset: program.rewardAsset,
    estimatedDailyRewardsRaw,
    estimatedDailyRewards: rawAmountToDisplay(estimatedDailyRewardsRaw),
    sharePercent: share * 100,
    startAt: program.startAt,
    endAt: program.endAt,
  };
}
