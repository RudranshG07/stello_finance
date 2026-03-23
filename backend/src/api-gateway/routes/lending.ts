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
} from "@stellar/stellar-sdk";
import { config } from "../../config/index.js";
import { PrismaClient } from "@prisma/client";

// Supported collateral assets — must match what is registered in the lending contract.
const SUPPORTED_ASSETS = [
  {
    contractId: config.contracts.sxlmTokenContractId,
    symbol: "sXLM",
    defaultCfBps: 7500,
    defaultLtBps: 8000,
  },
  {
    contractId: config.contracts.usdcContractId,
    symbol: "USDC",
    defaultCfBps: 9000,
    defaultLtBps: 9200,
  },
  {
    contractId: config.contracts.eurcContractId,
    symbol: "EURC",
    defaultCfBps: 8800,
    defaultLtBps: 9000,
  },
  {
    contractId: config.contracts.yxlmContractId,
    symbol: "yXLM",
    defaultCfBps: 7000,
    defaultLtBps: 7500,
  },
] as const;

const amountSchema = z.object({
  userAddress: z.string().min(56).max(56),
  amount: z.number().positive(),
  /** Collateral asset contract ID. Defaults to sXLM when omitted. */
  asset: z.string().min(56).max(56).optional(),
});

const liquidateSchema = z.object({
  liquidatorAddress: z.string().min(56).max(56),
  borrowerAddress: z.string().min(56).max(56),
  /** Which collateral asset to seize. Defaults to sXLM when omitted. */
  collateralAsset: z.string().min(56).max(56).optional(),
});

// Higher inclusion fee to avoid txINSUFFICIENT_FEE during simulation.
const SOROBAN_FEE = "2000000"; // 0.2 XLM

async function buildContractTx(
  server: rpc.Server,
  contractId: string,
  method: string,
  args: any[],
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
    if (errStr.includes("UnreachableCodeReached")) {
      if (method === "deposit_collateral") {
        throw new Error(
          "Insufficient asset balance. Make sure you hold the selected collateral token."
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
  args: any[]
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

export const lendingRoutes: FastifyPluginAsync<{ prisma: PrismaClient }> = async (
  fastify,
  opts
) => {
  const { prisma } = opts;
  const server = new rpc.Server(config.stellar.rpcUrl);
  const lendingContractId = config.contracts.lendingContractId;

  /**
   * GET /lending/assets
   * Returns all supported collateral assets with their on-chain config.
   */
  fastify.get("/lending/assets", async () => {
    const results = await Promise.allSettled(
      SUPPORTED_ASSETS.map(async (a) => {
        try {
          const cfg = await queryContractView(
            server,
            lendingContractId,
            "get_asset_config",
            [new Address(a.contractId).toScVal()]
          );
          return {
            contractId: a.contractId,
            symbol: a.symbol,
            collateralFactorBps: cfg ? Number(cfg.collateral_factor_bps) : a.defaultCfBps,
            liquidationThresholdBps: cfg
              ? Number(cfg.liquidation_threshold_bps)
              : a.defaultLtBps,
            priceInXlm: cfg ? Number(cfg.price_in_xlm) / 1e7 : 1,
            enabled: cfg ? Boolean(cfg.enabled) : false,
          };
        } catch {
          return {
            contractId: a.contractId,
            symbol: a.symbol,
            collateralFactorBps: a.defaultCfBps,
            liquidationThresholdBps: a.defaultLtBps,
            priceInXlm: 1,
            enabled: false,
          };
        }
      })
    );

    return results.map((r) => (r.status === "fulfilled" ? r.value : null)).filter(Boolean);
  });

  /**
   * POST /lending/deposit-collateral
   * Build unsigned tx: deposit a supported collateral asset.
   */
  fastify.post("/lending/deposit-collateral", async (request, reply) => {
    try {
      const body = amountSchema.parse(request.body);
      const assetId = body.asset ?? config.contracts.sxlmTokenContractId;
      const stroops = BigInt(Math.floor(body.amount * 1e7));

      // Pre-flight: check user holds enough of the collateral asset.
      const balanceRaw = await queryContractView(server, assetId, "balance", [
        new Address(body.userAddress).toScVal(),
      ]);
      const balance = BigInt(balanceRaw ?? 0);
      if (balance < stroops) {
        const available = (Number(balance) / 1e7).toFixed(7);
        const assetMeta = SUPPORTED_ASSETS.find((a) => a.contractId === assetId);
        const symbol = assetMeta?.symbol ?? "tokens";
        return reply.status(400).send({
          error: `Insufficient ${symbol} balance. You have ${available} ${symbol} but tried to deposit ${body.amount}.`,
        });
      }

      const result = await buildContractTx(
        server,
        lendingContractId,
        "deposit_collateral",
        [
          new Address(body.userAddress).toScVal(),
          new Address(assetId).toScVal(),
          nativeToScVal(stroops, { type: "i128" }),
        ],
        body.userAddress
      );

      return result;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : String(err) || "Deposit failed";
      return reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /lending/withdraw-collateral
   * Build unsigned tx: withdraw collateral.
   */
  fastify.post("/lending/withdraw-collateral", async (request, reply) => {
    try {
      const body = amountSchema.parse(request.body);
      const assetId = body.asset ?? config.contracts.sxlmTokenContractId;
      const stroops = BigInt(Math.floor(body.amount * 1e7));

      const result = await buildContractTx(
        server,
        lendingContractId,
        "withdraw_collateral",
        [
          new Address(body.userAddress).toScVal(),
          new Address(assetId).toScVal(),
          nativeToScVal(stroops, { type: "i128" }),
        ],
        body.userAddress
      );

      return result;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : String(err) || "Withdraw failed";
      return reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /lending/borrow
   * Build unsigned tx: borrow XLM against deposited collateral.
   */
  fastify.post("/lending/borrow", async (request, reply) => {
    try {
      const body = amountSchema.parse(request.body);
      const stroops = BigInt(Math.floor(body.amount * 1e7));

      const poolBalRaw = await queryContractView(
        server,
        lendingContractId,
        "get_pool_balance",
        []
      );
      const poolBalance = BigInt(poolBalRaw ?? 0);
      if (poolBalance < stroops) {
        const available = (Number(poolBalance) / 1e7).toFixed(7);
        return reply.status(400).send({
          error: `Insufficient pool liquidity. Pool has ${available} XLM available.`,
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
        err instanceof Error ? err.message : String(err) || "Borrow failed";
      return reply.status(400).send({ error: message });
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
        err instanceof Error ? err.message : String(err) || "Repay failed";
      return reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /lending/liquidate
   * Build unsigned tx: liquidate an unhealthy position.
   */
  fastify.post("/lending/liquidate", async (request, reply) => {
    try {
      const body = liquidateSchema.parse(request.body);
      const collateralAsset =
        body.collateralAsset ?? config.contracts.sxlmTokenContractId;

      const result = await buildContractTx(
        server,
        lendingContractId,
        "liquidate",
        [
          new Address(body.liquidatorAddress).toScVal(),
          new Address(body.borrowerAddress).toScVal(),
          new Address(collateralAsset).toScVal(),
        ],
        body.liquidatorAddress
      );

      return result;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : String(err) || "Liquidation failed";
      return reply.status(400).send({ error: message });
    }
  });

  /**
   * GET /lending/position/:wallet
   * Returns on-chain position with per-asset breakdown.
   */
  fastify.get("/lending/position/:wallet", async (request, reply) => {
    try {
      const { wallet } = request.params as { wallet: string };
      const userScVal = new Address(wallet).toScVal();

      const [position, healthFactor, maxBorrowRaw] = await Promise.all([
        queryContractView(server, lendingContractId, "get_position", [userScVal]),
        queryContractView(server, lendingContractId, "health_factor", [userScVal]),
        queryContractView(server, lendingContractId, "get_user_max_borrow", [userScVal]),
      ]);

      let totalCollateralXlm = BigInt(0);
      let borrowed = BigInt(0);
      let hf = 0;
      if (position) {
        totalCollateralXlm = BigInt(position[0] ?? 0);
        borrowed = BigInt(position[1] ?? 0);
      }
      if (healthFactor !== null) {
        hf = Number(healthFactor) / 1e7;
      }
      const maxBorrow = Number(maxBorrowRaw ?? 0) / 1e7;


      const assetPositions = await Promise.allSettled(
        SUPPORTED_ASSETS.map(async (a) => {
          const amountRaw = await queryContractView(
            server,
            lendingContractId,
            "get_asset_position",
            [userScVal, new Address(a.contractId).toScVal()]
          );
          const amount = BigInt(amountRaw ?? 0);


          const cfgRaw = await queryContractView(
            server,
            lendingContractId,
            "get_asset_config",
            [new Address(a.contractId).toScVal()]
          );

          const priceInXlm = cfgRaw ? Number(cfgRaw.price_in_xlm) / 1e7 : 1;
          return {
            contractId: a.contractId,
            symbol: a.symbol,
            amountDeposited: Number(amount) / 1e7,
            amountDepositedRaw: amount.toString(),
            xlmValue: (Number(amount) / 1e7) * priceInXlm,
            collateralFactorBps: cfgRaw
              ? Number(cfgRaw.collateral_factor_bps)
              : a.defaultCfBps,
            liquidationThresholdBps: cfgRaw
              ? Number(cfgRaw.liquidation_threshold_bps)
              : a.defaultLtBps,
            priceInXlm,
          };
        })
      );

      const assetBreakdown = assetPositions
        .map((r) => (r.status === "fulfilled" ? r.value : null))
        .filter(Boolean);

      if (totalCollateralXlm > 0 || borrowed > 0) {
        await prisma.collateralPosition.upsert({
          where: { wallet_collateralAsset: { wallet, collateralAsset: "AGGREGATE" } },
          update: {
            amountDeposited: totalCollateralXlm,
            xlmBorrowed: borrowed,
            healthFactor: hf,
            updatedAt: new Date(),
          },
          create: {
            wallet,
            collateralAsset: "AGGREGATE",
            amountDeposited: totalCollateralXlm,
            xlmBorrowed: borrowed,
            healthFactor: hf,
          },
        });
      }

      return {
        wallet,
        totalCollateralXlm: Number(totalCollateralXlm) / 1e7,
        totalCollateralXlmRaw: totalCollateralXlm.toString(),
        xlmBorrowed: Number(borrowed) / 1e7,
        xlmBorrowedRaw: borrowed.toString(),
        healthFactor: hf,
        maxBorrow,
        assetPositions: assetBreakdown,
      };
    } catch (err: unknown) {
      // Fallback to DB.
      const { wallet } = request.params as { wallet: string };
      const dbPosition = await prisma.collateralPosition.findFirst({
        where: { wallet, collateralAsset: "AGGREGATE" },
        orderBy: { updatedAt: "desc" },
      });
      return dbPosition
        ? {
            wallet,
            totalCollateralXlm: Number(dbPosition.amountDeposited) / 1e7,
            totalCollateralXlmRaw: dbPosition.amountDeposited.toString(),
            xlmBorrowed: Number(dbPosition.xlmBorrowed) / 1e7,
            xlmBorrowedRaw: dbPosition.xlmBorrowed.toString(),
            healthFactor: dbPosition.healthFactor,
            maxBorrow: 0,
            assetPositions: [],
          }
        : {
            wallet,
            totalCollateralXlm: 0,
            totalCollateralXlmRaw: "0",
            xlmBorrowed: 0,
            xlmBorrowedRaw: "0",
            healthFactor: 0,
            maxBorrow: 0,
            assetPositions: [],
          };
    }
  });

  /**
   * GET /lending/stats
   * Protocol-level lending statistics.
   */
  fastify.get("/lending/stats", async () => {
    try {
      const [totalCollateral, totalBorrowed, borrowRateBpsRaw, poolBalanceRaw] =
        await Promise.all([
          queryContractView(server, lendingContractId, "total_collateral", []),
          queryContractView(server, lendingContractId, "total_borrowed", []),
          queryContractView(server, lendingContractId, "get_borrow_rate", []),
          queryContractView(server, lendingContractId, "get_pool_balance", []),
        ]);

      const sxlmCfg = await queryContractView(
        server,
        lendingContractId,
        "get_asset_config",
        [new Address(config.contracts.sxlmTokenContractId).toScVal()]
      );

      const tc = Number(totalCollateral ?? 0);
      const tb = Number(totalBorrowed ?? 0);

      return {
        totalCollateral: tc / 1e7,
        totalCollateralRaw: (totalCollateral ?? 0).toString(),
        totalBorrowed: tb / 1e7,
        totalBorrowedRaw: (totalBorrowed ?? 0).toString(),
        poolBalance: Number(poolBalanceRaw ?? 0) / 1e7,
        collateralFactorBps: sxlmCfg ? Number(sxlmCfg.collateral_factor_bps) : 7500,
        liquidationThresholdBps: sxlmCfg
          ? Number(sxlmCfg.liquidation_threshold_bps)
          : 8000,
        borrowRateBps: Number(borrowRateBpsRaw ?? 500),
        utilizationRate: tc > 0 ? tb / tc : 0,
      };
    } catch {
      return {
        totalCollateral: 0,
        totalCollateralRaw: "0",
        totalBorrowed: 0,
        totalBorrowedRaw: "0",
        poolBalance: 0,
        collateralFactorBps: 7500,
        liquidationThresholdBps: 8000,
        borrowRateBps: 500,
        utilizationRate: 0,
      };
    }
  });
};
