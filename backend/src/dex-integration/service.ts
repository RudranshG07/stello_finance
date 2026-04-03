import { PrismaClient } from "@prisma/client";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";
import { config } from "../config/index.js";
import {
  DEFAULT_SWAP_FEE_BPS,
  DexRoute,
  DexTokenSymbol,
  LiquidityMiningEstimate,
  LiquidityMiningProgram,
  OracleObservation,
  OracleSnapshot,
  PoolSnapshot,
  SwapQuote,
  buildDexRoutes,
  computeSpotPrice,
  computeTwapPrice,
  displayAmountToRaw,
  estimateLiquidityMiningRewards,
  parseLiquidityMiningProgramProposal,
  quoteExactIn,
  rawAmountToDisplay,
} from "./index.js";

const READ_ONLY_SIMULATION_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

type OracleRow = {
  observed_at: Date | string;
  reserve_xlm: bigint | string | number;
  reserve_sxlm: bigint | string | number;
  total_lp_supply: bigint | string | number;
  spot_price: number | string;
};

type LiquidityMiningProgramRow = {
  program_key: string;
  title: string;
  status: LiquidityMiningProgram["status"];
  reward_asset: string;
  reward_per_day: bigint | string | number;
  start_at: Date | string;
  end_at: Date | string;
  min_lp_tokens: bigint | string | number;
  total_rewards: bigint | string | number | null;
  distributed_rewards: bigint | string | number | null;
  proposal_id: number | null;
  dexes: unknown;
  metadata: unknown;
};

function asBigInt(value: bigint | string | number | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  return BigInt(value);
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function parseJsonField<T>(value: unknown, fallback: T): T {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return (value as T) ?? fallback;
}

export class DexIntegrationService {
  private readonly server = new rpc.Server(config.stellar.rpcUrl);
  private readonly lpContract = new Contract(config.contracts.lpPoolContractId);
  private refreshHandle: NodeJS.Timeout | null = null;
  private initialized = false;

  constructor(private readonly prisma: PrismaClient) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.ensureTables();
    await this.syncLiquidityMiningProgramsFromGovernance();
    await this.safeRecordObservation();
    this.refreshHandle = setInterval(() => {
      void this.safeRecordObservation();
    }, 60_000);
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    if (this.refreshHandle) {
      clearInterval(this.refreshHandle);
      this.refreshHandle = null;
    }
    this.initialized = false;
  }

  async getCurrentPoolSnapshot(): Promise<PoolSnapshot> {
    const [reserves, totalLpSupply] = await Promise.all([
      this.queryContractView("get_reserves", []),
      this.queryContractView("total_lp_supply", []),
    ]);

    return {
      reserveXlmRaw: asBigInt(reserves?.[0] ?? 0),
      reserveSxlmRaw: asBigInt(reserves?.[1] ?? 0),
      totalLpSupplyRaw: asBigInt(totalLpSupply ?? 0),
      feeBps: DEFAULT_SWAP_FEE_BPS,
      observedAt: new Date(),
    };
  }

  async getOracleSnapshot(windowSeconds = 900): Promise<OracleSnapshot> {
    const snapshot = await this.getCurrentPoolSnapshot();
    return this.buildOracleSnapshot(windowSeconds, snapshot);
  }

  async getQuote(params: {
    tokenIn: DexTokenSymbol;
    amount: number;
    slippageBps?: number;
  }): Promise<SwapQuote> {
    const snapshot = await this.getCurrentPoolSnapshot();
    const quote = quoteExactIn(
      snapshot,
      params.tokenIn,
      displayAmountToRaw(params.amount),
      params.slippageBps ?? 50
    );
    await this.recordObservation(snapshot);
    return quote;
  }

  async getRoutes(params: {
    tokenIn: DexTokenSymbol;
    amount: number;
    slippageBps?: number;
  }): Promise<{ quote: SwapQuote; routes: DexRoute[] }> {
    const quote = await this.getQuote(params);
    const programs = await this.getLiquidityMiningPrograms();
    const preferredDexes =
      programs.flatMap((program) => program.dexes).filter(Boolean).length > 0
        ? Array.from(new Set(programs.flatMap((program) => program.dexes)))
        : ["StellarX", "Lumenswap"];
    return {
      quote,
      routes: buildDexRoutes(quote, preferredDexes),
    };
  }

  async getMarkets(): Promise<{
    pair: string;
    pool: {
      reserveXlm: number;
      reserveSxlm: number;
      totalLpSupply: number;
      spotPrice: number;
    };
    oracle: OracleSnapshot;
    dexes: Array<{
      id: string;
      name: string;
      quoteEndpoint: string;
      routeEndpoint: string;
      rewardsEnabled: boolean;
    }>;
  }> {
    const [snapshot, programs] = await Promise.all([
      this.getCurrentPoolSnapshot(),
      this.getLiquidityMiningPrograms(),
    ]);
    const oracle = await this.buildOracleSnapshot(900, snapshot);

    const rewardsEnabled = programs.some((program) => program.status === "active");

    return {
      pair: "sXLM/XLM",
      pool: {
        reserveXlm: rawAmountToDisplay(snapshot.reserveXlmRaw),
        reserveSxlm: rawAmountToDisplay(snapshot.reserveSxlmRaw),
        totalLpSupply: rawAmountToDisplay(snapshot.totalLpSupplyRaw),
        spotPrice: computeSpotPrice(snapshot),
      },
      oracle,
      dexes: [
        {
          id: "stellarx",
          name: "StellarX",
          quoteEndpoint: "/api/dex/quote",
          routeEndpoint: "/api/dex/route",
          rewardsEnabled,
        },
        {
          id: "lumenswap",
          name: "Lumenswap",
          quoteEndpoint: "/api/dex/quote",
          routeEndpoint: "/api/dex/route",
          rewardsEnabled,
        },
      ],
    };
  }

  async getLiquidityMiningPrograms(): Promise<LiquidityMiningProgram[]> {
    await this.syncLiquidityMiningProgramsFromGovernance();
    const rows = await this.prisma.$queryRawUnsafe<LiquidityMiningProgramRow[]>(
      `
        SELECT
          program_key,
          title,
          status,
          reward_asset,
          reward_per_day,
          start_at,
          end_at,
          min_lp_tokens,
          total_rewards,
          distributed_rewards,
          proposal_id,
          dexes,
          metadata
        FROM liquidity_mining_programs
        ORDER BY start_at DESC, created_at DESC
      `
    );

    return rows.map((row) => ({
      programId: row.program_key,
      title: row.title,
      status: row.status,
      rewardAsset: row.reward_asset,
      rewardPerDayRaw: asBigInt(row.reward_per_day),
      startAt: asDate(row.start_at).toISOString(),
      endAt: asDate(row.end_at).toISOString(),
      minLpTokensRaw: asBigInt(row.min_lp_tokens),
      totalRewardsRaw: row.total_rewards === null ? null : asBigInt(row.total_rewards),
      distributedRewardsRaw:
        row.distributed_rewards === null ? null : asBigInt(row.distributed_rewards),
      governanceProposalId: row.proposal_id,
      dexes: parseJsonField<unknown[]>(row.dexes, []).filter(
        (item): item is string => typeof item === "string"
      ),
      metadata: parseJsonField<Record<string, unknown>>(row.metadata, {}),
    }));
  }

  async getLiquidityMiningPosition(wallet: string): Promise<{
    wallet: string;
    lpTokens: number;
    lpTokensRaw: string;
    eligiblePrograms: LiquidityMiningEstimate[];
  }> {
    const [snapshot, liveLpBalance, programs] = await Promise.all([
      this.getCurrentPoolSnapshot(),
      this.loadLiveLpBalance(wallet),
      this.getLiquidityMiningPrograms(),
    ]);

    const userLpTokensRaw = asBigInt(liveLpBalance ?? 0);
    const now = Date.now();
    const eligiblePrograms = programs
      .filter((program) => {
        const activeWindow =
          new Date(program.startAt).getTime() <= now && new Date(program.endAt).getTime() >= now;
        return activeWindow && userLpTokensRaw >= program.minLpTokensRaw;
      })
      .map((program) =>
        estimateLiquidityMiningRewards({
          program,
          userLpTokensRaw,
          totalLpSupplyRaw: snapshot.totalLpSupplyRaw,
        })
      );

    return {
      wallet,
      lpTokens: rawAmountToDisplay(userLpTokensRaw),
      lpTokensRaw: userLpTokensRaw.toString(),
      eligiblePrograms,
    };
  }

  async applyLiquidityMiningProposal(
    proposalId: number,
    paramKey: string,
    newValue: string
  ): Promise<LiquidityMiningProgram | null> {
    const program = parseLiquidityMiningProgramProposal(paramKey, newValue, proposalId);
    if (!program) {
      return null;
    }

    await this.prisma.$executeRawUnsafe(
      `
        INSERT INTO liquidity_mining_programs (
          program_key,
          title,
          status,
          reward_asset,
          reward_per_day,
          start_at,
          end_at,
          min_lp_tokens,
          total_rewards,
          distributed_rewards,
          proposal_id,
          dexes,
          metadata,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6::timestamptz,
          $7::timestamptz,
          $8,
          $9,
          $10,
          $11,
          $12::jsonb,
          $13::jsonb,
          NOW()
        )
        ON CONFLICT (program_key) DO UPDATE SET
          title = EXCLUDED.title,
          status = EXCLUDED.status,
          reward_asset = EXCLUDED.reward_asset,
          reward_per_day = EXCLUDED.reward_per_day,
          start_at = EXCLUDED.start_at,
          end_at = EXCLUDED.end_at,
          min_lp_tokens = EXCLUDED.min_lp_tokens,
          total_rewards = EXCLUDED.total_rewards,
          distributed_rewards = EXCLUDED.distributed_rewards,
          proposal_id = EXCLUDED.proposal_id,
          dexes = EXCLUDED.dexes,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
      `,
      program.programId,
      program.title,
      program.status,
      program.rewardAsset,
      program.rewardPerDayRaw.toString(),
      program.startAt,
      program.endAt,
      program.minLpTokensRaw.toString(),
      program.totalRewardsRaw?.toString() ?? null,
      program.distributedRewardsRaw?.toString() ?? "0",
      proposalId,
      JSON.stringify(program.dexes),
      JSON.stringify(program.metadata)
    );

    return program;
  }

  private async queryContractView(method: string, args: any[]): Promise<any> {
    const op = this.lpContract.call(method, ...args);
    const account = this.getReadOnlySimulationAccount();
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: config.stellar.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const simResult = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationSuccess(simResult) && simResult.result) {
      return scValToNative(simResult.result.retval);
    }
    return null;
  }

  private async safeRecordObservation(): Promise<void> {
    try {
      const snapshot = await this.getCurrentPoolSnapshot();
      await this.recordObservation(snapshot);
    } catch (error) {
      console.warn("[DEX] Failed to refresh oracle observation:", error);
    }
  }

  private async buildOracleSnapshot(
    windowSeconds: number,
    snapshot: PoolSnapshot
  ): Promise<OracleSnapshot> {
    await this.recordObservation(snapshot);
    const observations = await this.loadOracleObservations(windowSeconds, snapshot);
    return computeTwapPrice(observations, windowSeconds, snapshot.observedAt);
  }

  private async recordObservation(snapshot: PoolSnapshot): Promise<void> {
    const latest = await this.prisma.$queryRawUnsafe<OracleRow[]>(
      `
        SELECT observed_at, reserve_xlm, reserve_sxlm, total_lp_supply, spot_price
        FROM liquidity_oracle_observations
        ORDER BY observed_at DESC
        LIMIT 1
      `
    );

    const latestRow = latest[0];
    const nowMs = snapshot.observedAt.getTime();
    const spotPrice = computeSpotPrice(snapshot);
    const shouldInsert =
      !latestRow ||
      nowMs - asDate(latestRow.observed_at).getTime() >= 30_000 ||
      Math.abs(Number(latestRow.spot_price) - spotPrice) >= 0.0001;

    if (!shouldInsert) {
      return;
    }

    await this.prisma.$executeRawUnsafe(
      `
        INSERT INTO liquidity_oracle_observations (
          observed_at,
          reserve_xlm,
          reserve_sxlm,
          total_lp_supply,
          spot_price,
          source
        )
        VALUES ($1::timestamptz, $2, $3, $4, $5, 'lp_pool')
      `,
      snapshot.observedAt.toISOString(),
      snapshot.reserveXlmRaw.toString(),
      snapshot.reserveSxlmRaw.toString(),
      snapshot.totalLpSupplyRaw.toString(),
      spotPrice
    );
  }

  private async loadOracleObservations(
    windowSeconds: number,
    snapshot: PoolSnapshot
  ): Promise<OracleObservation[]> {
    const rows = await this.prisma.$queryRawUnsafe<OracleRow[]>(
      `
        SELECT observed_at, reserve_xlm, reserve_sxlm, total_lp_supply, spot_price
        FROM liquidity_oracle_observations
        WHERE observed_at >= $1::timestamptz - ($2 * INTERVAL '1 second')
           OR observed_at = (
             SELECT observed_at
             FROM liquidity_oracle_observations
             WHERE observed_at < $1::timestamptz - ($2 * INTERVAL '1 second')
             ORDER BY observed_at DESC
             LIMIT 1
           )
        ORDER BY observed_at ASC
      `,
      snapshot.observedAt.toISOString(),
      windowSeconds
    );

    const observations = rows.map((row) => ({
      observedAt: asDate(row.observed_at),
      spotPrice: Number(row.spot_price),
    }));

    const currentObservation = {
      observedAt: snapshot.observedAt,
      spotPrice: computeSpotPrice(snapshot),
    };
    const latestObservation = observations[observations.length - 1];
    if (
      !latestObservation ||
      latestObservation.observedAt.getTime() !== currentObservation.observedAt.getTime() ||
      latestObservation.spotPrice !== currentObservation.spotPrice
    ) {
      observations.push(currentObservation);
    }

    return observations;
  }

  private async syncLiquidityMiningProgramsFromGovernance(): Promise<void> {
    const executedProposals = await this.prisma.governanceProposal.findMany({
      where: {
        status: "executed",
        paramKey: {
          startsWith: "liquidity_mining_program",
        },
      },
      orderBy: { createdAt: "desc" },
    });

    for (const proposal of executedProposals) {
      await this.applyLiquidityMiningProposal(
        proposal.id,
        proposal.paramKey,
        proposal.newValue
      );
    }
  }

  private getReadOnlySimulationAccount(): Account {
    try {
      return new Account(config.admin.publicKey, "0");
    } catch {
      return new Account(READ_ONLY_SIMULATION_ACCOUNT, "0");
    }
  }

  private async loadLiveLpBalance(wallet: string): Promise<bigint> {
    const fallback = async () => {
      const cachedPosition = await this.prisma.lPPosition.findFirst({
        where: { wallet },
        orderBy: { updatedAt: "desc" },
        select: { lpTokens: true },
      });
      return cachedPosition?.lpTokens ?? 0n;
    };

    let walletAddress: Address;
    try {
      walletAddress = new Address(wallet);
    } catch {
      return fallback();
    }

    try {
      const liveLpBalance = await this.queryContractView("get_lp_balance", [walletAddress.toScVal()]);
      return asBigInt(liveLpBalance ?? 0);
    } catch {
      return fallback();
    }
  }

  private async ensureTables(): Promise<void> {
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS liquidity_oracle_observations (
        id SERIAL PRIMARY KEY,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reserve_xlm BIGINT NOT NULL,
        reserve_sxlm BIGINT NOT NULL,
        total_lp_supply BIGINT NOT NULL DEFAULT 0,
        spot_price DOUBLE PRECISION NOT NULL,
        source TEXT NOT NULL DEFAULT 'lp_pool'
      )
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_liquidity_oracle_observations_observed_at
      ON liquidity_oracle_observations (observed_at DESC)
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS liquidity_mining_programs (
        id SERIAL PRIMARY KEY,
        program_key TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        reward_asset TEXT NOT NULL DEFAULT 'sXLM',
        reward_per_day BIGINT NOT NULL,
        start_at TIMESTAMPTZ NOT NULL,
        end_at TIMESTAMPTZ NOT NULL,
        min_lp_tokens BIGINT NOT NULL DEFAULT 0,
        total_rewards BIGINT,
        distributed_rewards BIGINT NOT NULL DEFAULT 0,
        proposal_id INTEGER,
        dexes JSONB NOT NULL DEFAULT '[]'::jsonb,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_liquidity_mining_programs_status_window
      ON liquidity_mining_programs (status, start_at, end_at)
    `);
  }
}
