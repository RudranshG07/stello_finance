import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  rpc,
  Contract,
  Address,
  nativeToScVal,
  scValToNative,
  TransactionBuilder,
  BASE_FEE,
  xdr,
} from "@stellar/stellar-sdk";
import { config } from "../../config/index.js";
import { PrismaClient } from "@prisma/client";

const RATE_PRECISION = 1e7;
// i128::MAX — returned by the contract when the user has no debt.
const I128_MAX = BigInt("170141183460469231731687303715884105727");

/**
 * Schema for deposit/withdraw: require `assetAddress` so the UI can choose
 * which supported collateral to move.
 */
const depositWithdrawSchema = z.object({
  userAddress: z.string().min(56).max(56),
  amount: z.number().positive(),
  assetAddress: z.string().min(56).max(56),
});

/** Schema for borrow / repay: no asset selector needed (XLM only). */
const amountSchema = z.object({
  userAddress: z.string().min(56).max(56),
  amount: z.number().positive(),
});

/**
 * Schema for liquidation.
 * `seizeAssets` is optional — when omitted the endpoint fetches all supported
 * collaterals from the contract and passes them as the seizure list.
 */
const liquidateSchema = z.object({
  liquidatorAddress: z.string().min(56).max(56),
  borrowerAddress: z.string().min(56).max(56),
  seizeAssets: z.array(z.string().min(56).max(56)).optional(),
});

// Higher inclusion fee to avoid txINSUFFICIENT_FEE when simulation
// slightly underestimates resource costs. assembleTransaction adds
// minResourceFee on top of this, so the total is well above the minimum.
const SOROBAN_FEE = "2000000"; // 0.2 XLM

async function buildContractTx(
  server: rpc.Server,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  userAddress: string
) {
  const contract = new Contract(contractId);
  const op = contract.call(method, ...args);

  const account = await server.getAccount(userAddress);
  const tx = new TransactionBuilder(account, {
    fee: SOROBAN_FEE,
    networkPassphrase: config.stellar.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(300)
    .build();

  const simResult = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResult)) {
    const errStr = String(simResult.error);
    // Translate common WASM trap errors into human-readable messages.
    if (errStr.includes("UnreachableCodeReached")) {
      if (method === "deposit_collateral") {
        throw new Error(
          "Insufficient balance or unsupported asset. Make sure you hold enough of the selected collateral."
        );
      }
      if (method === "withdraw_collateral") {
        throw new Error(
          "Withdrawal would make your position unhealthy, or you have no collateral deposited."
        );
      }
      if (method === "borrow") {
        throw new Error(
          "Borrow exceeds your collateral limit. Deposit more collateral or reduce the borrow amount."
        );
      }
      if (method === "repay") {
        throw new Error("Repay amount exceeds your outstanding debt.");
      }
      if (method === "liquidate") {
        throw new Error(
          "This position cannot be liquidated — it may already be healthy or have no debt."
        );
      }
    }
    throw new Error(`Simulation failed: ${simResult.error}`);
  }

  const preparedTx = rpc.assembleTransaction(tx, simResult).build();
  return {
    xdr: preparedTx.toXDR(),
    networkPassphrase: config.stellar.networkPassphrase,
  };
}

async function queryContractView(
  server: rpc.Server,
  contractId: string,
  method: string,
  args: xdr.ScVal[]
) {
  const contract = new Contract(contractId);
  const op = contract.call(method, ...args);

  const account = await server.getAccount(config.admin.publicKey);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.stellar.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationSuccess(simResult) && simResult.result) {
    return scValToNative(simResult.result.retval);
  }
  return null;
}

/** Convert an array of Stellar address strings to a Soroban Vec<Address> ScVal. */
function addressArrayToScVal(addresses: string[]): xdr.ScVal {
  return xdr.ScVal.scvVec(addresses.map((a) => new Address(a).toScVal()));
}

/** Normalise the on-chain health factor (which is i128::MAX when no debt). */
function normaliseHealthFactor(raw: bigint): number {
  if (raw === I128_MAX) {
    return Number.MAX_SAFE_INTEGER; // effectively "no debt / infinitely healthy"
  }
  return Number(raw) / RATE_PRECISION;
}

export const lendingRoutes: FastifyPluginAsync<{ prisma: PrismaClient }> = async (
  fastify,
  opts
) => {
  const { prisma } = opts;
  const server = new rpc.Server(config.stellar.rpcUrl);
  const lendingContractId = config.contracts.lendingContractId;

  function classifyRisk(healthFactor: number): {
    riskLevel: "safe" | "warning" | "critical";
    recommendation: string;
  } {
    if (healthFactor <= 0) {
      return {
        riskLevel: "safe",
        recommendation: "No active debt position detected.",
      };
    }

    if (healthFactor < 1.0) {
      return {
        riskLevel: "critical",
        recommendation: "Position is liquidatable. Repay debt or add collateral immediately.",
      };
    }

    if (healthFactor < 1.5) {
      return {
        riskLevel: "warning",
        recommendation: "Health factor is low. Consider adding collateral or repaying part of your debt.",
      };
    }

    return {
      riskLevel: "safe",
      recommendation: "Position health is stable.",
    };
  }

  /**
   * POST /lending/deposit-collateral
   * Build unsigned tx: deposit a supported collateral asset.
   * Body: { userAddress, amount, assetAddress }
   */
  fastify.post("/lending/deposit-collateral", async (request, reply) => {
    try {
      const body = depositWithdrawSchema.parse(request.body);
      const stroops = BigInt(Math.floor(body.amount * 1e7));

      // Pre-flight: check user holds enough of the requested collateral asset.
      const balanceRaw = await queryContractView(
        server,
        body.assetAddress,
        "balance",
        [new Address(body.userAddress).toScVal()]
      );
      const balance = BigInt(balanceRaw ?? 0);
      if (balance < stroops) {
        const available = (Number(balance) / 1e7).toFixed(7);
        return reply.status(400).send({
          error: `Insufficient balance. You have ${available} of this asset but tried to deposit ${body.amount}. Acquire the asset first.`,
        });
      }

      const result = await buildContractTx(
        server,
        lendingContractId,
        "deposit_collateral",
        [
          new Address(body.userAddress).toScVal(),
          new Address(body.assetAddress).toScVal(),
          nativeToScVal(stroops, { type: "i128" }),
        ],
        body.userAddress
      );

      return result;
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : (err as { message?: string })?.message ?? "Deposit failed";
      reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /lending/withdraw-collateral
   * Build unsigned tx: withdraw a supported collateral asset.
   * Body: { userAddress, amount, assetAddress }
   */
  fastify.post("/lending/withdraw-collateral", async (request, reply) => {
    try {
      const body = depositWithdrawSchema.parse(request.body);
      const stroops = BigInt(Math.floor(body.amount * 1e7));

      const result = await buildContractTx(
        server,
        lendingContractId,
        "withdraw_collateral",
        [
          new Address(body.userAddress).toScVal(),
          new Address(body.assetAddress).toScVal(),
          nativeToScVal(stroops, { type: "i128" }),
        ],
        body.userAddress
      );

      return result;
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : (err as { message?: string })?.message ?? "Withdraw failed";
      reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /lending/borrow
   * Build unsigned tx: borrow XLM against deposited multi-asset collateral.
   */
  fastify.post("/lending/borrow", async (request, reply) => {
    try {
      const body = amountSchema.parse(request.body);
      const stroops = BigInt(Math.floor(body.amount * 1e7));

      // Pre-flight: check pool has enough XLM liquidity.
      const poolBalRaw = await queryContractView(server, lendingContractId, "get_pool_balance", []);
      const poolBalance = BigInt(poolBalRaw ?? 0);
      if (poolBalance < stroops) {
        const available = (Number(poolBalance) / 1e7).toFixed(7);
        return reply.status(400).send({
          error: `Insufficient pool liquidity. Pool has ${available} XLM available but you tried to borrow ${body.amount} XLM.`,
        });
      }

      const result = await buildContractTx(
        server,
        lendingContractId,
        "borrow",
        [
          new Address(body.userAddress).toScVal(),
          nativeToScVal(stroops, { type: "i128" }),
        ],
        body.userAddress
      );

      return result;
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : (err as { message?: string })?.message ?? "Borrow failed";
      reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /lending/repay
   * Build unsigned tx: repay borrowed XLM.
   */
  fastify.post("/lending/repay", async (request, reply) => {
    try {
      const body = amountSchema.parse(request.body);
      const stroops = BigInt(Math.floor(body.amount * 1e7));

      const result = await buildContractTx(
        server,
        lendingContractId,
        "repay",
        [
          new Address(body.userAddress).toScVal(),
          nativeToScVal(stroops, { type: "i128" }),
        ],
        body.userAddress
      );

      return result;
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : (err as { message?: string })?.message ?? "Repay failed";
      reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /lending/liquidate
   * Build unsigned tx: full-debt liquidation of an unhealthy position.
   * Body: { liquidatorAddress, borrowerAddress, seizeAssets?: string[] }
   *
   * When `seizeAssets` is omitted the endpoint fetches the full supported
   * collateral list from the contract and passes it to `liquidate` so that
   * the contract can seize assets in registration order until the debt is
   * fully covered.
   */
  fastify.post("/lending/liquidate", async (request, reply) => {
    try {
      const body = liquidateSchema.parse(request.body);

      let seizeAssets: string[];
      if (body.seizeAssets && body.seizeAssets.length > 0) {
        seizeAssets = body.seizeAssets;
      } else {
        const supported = await queryContractView(
          server,
          lendingContractId,
          "get_supported_collaterals",
          []
        );
        seizeAssets = Array.isArray(supported) ? (supported as string[]) : [];
      }

      if (seizeAssets.length === 0) {
        return reply.status(400).send({ error: "No collateral assets available to seize." });
      }

      const result = await buildContractTx(
        server,
        lendingContractId,
        "liquidate",
        [
          new Address(body.liquidatorAddress).toScVal(),
          new Address(body.borrowerAddress).toScVal(),
          addressArrayToScVal(seizeAssets),
        ],
        body.liquidatorAddress
      );

      return result;
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : (err as { message?: string })?.message ?? "Liquidation failed";
      reply.status(400).send({ error: message });
    }
  });

  /**
   * GET /lending/position/:wallet
   * Query on-chain multi-collateral position via a single `get_user_position_detail`
   * call, then sync the aggregate values to the DB.
   */
  fastify.get("/lending/position/:wallet", async (request, reply) => {
    try {
      const { wallet } = request.params as { wallet: string };

      // `get_user_position_detail` returns everything the UI needs in one round-trip.
      const [posDetail, borrowRateBpsRaw] = await Promise.all([
        queryContractView(server, lendingContractId, "get_user_position_detail", [
          new Address(wallet).toScVal(),
        ]),
        queryContractView(server, lendingContractId, "get_borrow_rate", []),
      ]);

      // Decode UserPositionDetail (scValToNative turns the Soroban ScMap into a plain object).
      type RawEntry = { asset: unknown; amount: unknown };
      type RawDetail = {
        collaterals?: RawEntry[];
        collateral_value_xlm?: unknown;
        borrowed?: unknown;
        health_factor?: unknown;
        max_borrow?: unknown;
      };

      const pd = (posDetail ?? {}) as RawDetail;

      const collateralValueXlm = BigInt(String(pd.collateral_value_xlm ?? 0));
      const borrowed = BigInt(String(pd.borrowed ?? 0));
      const maxBorrow = BigInt(String(pd.max_borrow ?? 0));
      const healthFactor = normaliseHealthFactor(BigInt(String(pd.health_factor ?? 0)));

      const collaterals = (pd.collaterals ?? []).map((entry) => ({
        asset: String(entry.asset),
        amountRaw: BigInt(String(entry.amount ?? 0)).toString(),
        amount: Number(entry.amount ?? 0) / 1e7,
      }));

      // Sync aggregate values to DB.
      if (collateralValueXlm > 0n || borrowed > 0n) {
        await prisma.collateralPosition.upsert({
          where: { wallet },
          create: {
            wallet,
            collateralValueXlm,
            xlmBorrowed: borrowed,
            healthFactor,
            maxBorrow,
          },
          update: {
            collateralValueXlm,
            xlmBorrowed: borrowed,
            healthFactor,
            maxBorrow,
            updatedAt: new Date(),
          },
        });

        // Sync per-asset collateral balances to collateral_deposits.
        await Promise.all(
          collaterals.map((c) =>
            prisma.collateralDeposit.upsert({
              where: { wallet_asset: { wallet, asset: c.asset } },
              create: { wallet, asset: c.asset, amount: BigInt(c.amountRaw) },
              update: { amount: BigInt(c.amountRaw), updatedAt: new Date() },
            })
          )
        );
      }

      return {
        wallet,
        // Per-asset collateral entries (one per supported asset, amount=0 if not deposited).
        collaterals,
        // Aggregate collateral value in XLM.
        collateralValueXlm: Number(collateralValueXlm) / 1e7,
        collateralValueXlmRaw: collateralValueXlm.toString(),
        // Debt.
        xlmBorrowed: Number(borrowed) / 1e7,
        xlmBorrowedRaw: borrowed.toString(),
        // Risk metrics.
        healthFactor,
        maxBorrow: Number(maxBorrow) / 1e7,
        maxBorrowRaw: maxBorrow.toString(),
        // Protocol params.
        borrowRateBps: Number(borrowRateBpsRaw ?? 500),
      };
    } catch (err: unknown) {
      // Fallback to DB if the contract query fails.
      const { wallet } = request.params as { wallet: string };
      const [dbPosition, dbDeposits] = await Promise.all([
        prisma.collateralPosition.findUnique({ where: { wallet } }),
        prisma.collateralDeposit.findMany({ where: { wallet } }),
      ]);
      const collateralsFromDB = dbDeposits.map((d) => ({
        asset: d.asset,
        amountRaw: d.amount.toString(),
        amount: Number(d.amount) / 1e7,
      }));
      return dbPosition
        ? {
            wallet,
            collaterals: collateralsFromDB,
            collateralValueXlm: Number(dbPosition.collateralValueXlm) / 1e7,
            collateralValueXlmRaw: dbPosition.collateralValueXlm.toString(),
            xlmBorrowed: Number(dbPosition.xlmBorrowed) / 1e7,
            xlmBorrowedRaw: dbPosition.xlmBorrowed.toString(),
            healthFactor: dbPosition.healthFactor,
            maxBorrow: Number(dbPosition.maxBorrow) / 1e7,
            maxBorrowRaw: dbPosition.maxBorrow.toString(),
            borrowRateBps: 500,
          }
        : {
            wallet,
            collaterals: [],
            collateralValueXlm: 0,
            collateralValueXlmRaw: "0",
            xlmBorrowed: 0,
            xlmBorrowedRaw: "0",
            healthFactor: 0,
            maxBorrow: 0,
            maxBorrowRaw: "0",
            borrowRateBps: 500,
          };
    }
  });

  /**
   * GET /lending/stats
   * Query on-chain lending stats with per-asset collateral breakdown.
   */
  fastify.get("/lending/stats", async () => {
    try {
      const [supportedRaw, totalBorrowed, borrowRateBpsRaw, poolBalanceRaw] =
        await Promise.all([
          queryContractView(server, lendingContractId, "get_supported_collaterals", []),
          queryContractView(server, lendingContractId, "total_borrowed", []),
          queryContractView(server, lendingContractId, "get_borrow_rate", []),
          queryContractView(server, lendingContractId, "get_pool_balance", []),
        ]);

      const supportedAssets: string[] = Array.isArray(supportedRaw)
        ? (supportedRaw as string[])
        : [];

      // Fetch per-asset totals and risk params in parallel.
      const assetStats = await Promise.all(
        supportedAssets.map(async (asset) => {
          const assetScVal = new Address(asset).toScVal();
          const [totalDeposited, cfBps, ltBps] = await Promise.all([
            queryContractView(server, lendingContractId, "total_collateral_for_asset", [assetScVal]),
            queryContractView(server, lendingContractId, "get_collateral_factor", [assetScVal]),
            queryContractView(server, lendingContractId, "get_liquidation_threshold", [assetScVal]),
          ]);
          return {
            asset,
            totalDeposited: Number(totalDeposited ?? 0) / 1e7,
            totalDepositedRaw: String(totalDeposited ?? 0),
            collateralFactorBps: Number(cfBps ?? 0),
            liquidationThresholdBps: Number(ltBps ?? 0),
          };
        })
      );

      const tb = Number(totalBorrowed ?? 0);

      return {
        totalBorrowed: tb / 1e7,
        totalBorrowedRaw: String(totalBorrowed ?? 0),
        poolBalance: Number(poolBalanceRaw ?? 0) / 1e7,
        borrowRateBps: Number(borrowRateBpsRaw ?? 500),
        supportedAssets,
        assetStats,
      };
    } catch {
      return {
        totalBorrowed: 0,
        totalBorrowedRaw: "0",
        poolBalance: 0,
        borrowRateBps: 500,
        supportedAssets: [],
        assetStats: [],
      };
    }
  });

  /**
   * GET /lending/alerts/:wallet
   * Returns lending risk classification based on health factor.
   */
  fastify.get("/lending/alerts/:wallet", async (request) => {
    const { wallet } = request.params as { wallet: string };

    try {
      const healthFactorRaw = await queryContractView(
        server,
        lendingContractId,
        "health_factor",
        [new Address(wallet).toScVal()]
      );

      const healthFactor = Number(healthFactorRaw ?? 0) / 1e7;
      const classification = classifyRisk(healthFactor);

      return {
        wallet,
        healthFactor,
        ...classification,
        source: "chain",
        timestamp: new Date().toISOString(),
      };
    } catch {
      const dbPosition = await prisma.collateralPosition.findFirst({
        where: { wallet },
        orderBy: { updatedAt: "desc" },
      });

      const healthFactor = dbPosition?.healthFactor ?? 0;
      const classification = classifyRisk(healthFactor);

      return {
        wallet,
        healthFactor,
        ...classification,
        source: "db",
        timestamp: new Date().toISOString(),
      };
    }
  });
};
