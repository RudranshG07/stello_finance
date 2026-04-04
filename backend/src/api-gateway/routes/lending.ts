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

const amountSchema = z.object({
  userAddress: z.string().min(56).max(56),
  amount: z.number().positive(),
});

const liquidateSchema = z.object({
  liquidatorAddress: z.string().min(56).max(56),
  borrowerAddress: z.string().min(56).max(56),
});

// Higher inclusion fee to avoid txINSUFFICIENT_FEE when simulation
// slightly underestimates resource costs. assembleTransaction adds
// minResourceFee on top of this, so the total is well above the minimum.
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
    // Translate common WASM trap errors into human-readable messages
    if (errStr.includes("UnreachableCodeReached")) {
      if (method === "deposit_collateral") {
        throw new Error("Insufficient sXLM balance. Stake XLM first to receive sXLM, then deposit it as collateral.");
      }
      if (method === "withdraw_collateral") {
        throw new Error("Withdrawal would make your position unhealthy, or you have no collateral deposited.");
      }
      if (method === "borrow") {
        throw new Error("Borrow exceeds your collateral limit. Deposit more sXLM or reduce the borrow amount.");
      }
      if (method === "repay") {
        throw new Error("Repay amount exceeds your outstanding debt.");
      }
      if (method === "liquidate") {
        throw new Error("This position cannot be liquidated — it may already be healthy or have no debt.");
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
   * Build unsigned tx: deposit sXLM as collateral.
   */
  fastify.post("/lending/deposit-collateral", async (request, reply) => {
    try {
      const body = amountSchema.parse(request.body);
      const stroops = BigInt(Math.floor(body.amount * 1e7));

      // Pre-flight: check user has enough sXLM before simulating
      const sxlmRaw = await queryContractView(
        server,
        config.contracts.sxlmTokenContractId,
        "balance",
        [new Address(body.userAddress).toScVal()]
      );
      const sxlmBalance = BigInt(sxlmRaw ?? 0);
      if (sxlmBalance < stroops) {
        const available = (Number(sxlmBalance) / 1e7).toFixed(7);
        return reply.status(400).send({
          error: `Insufficient sXLM balance. You have ${available} sXLM but tried to deposit ${body.amount} sXLM. Stake XLM first to receive sXLM.`,
        });
      }

      const result = await buildContractTx(
        server,
        lendingContractId,
        "deposit_collateral",
        [
          new Address(body.userAddress).toScVal(),
          nativeToScVal(stroops, { type: "i128" }),
        ],
        body.userAddress
      );

      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : (err as { message?: string })?.message ?? "Deposit failed";
      reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /lending/withdraw-collateral
   * Build unsigned tx: withdraw sXLM collateral.
   */
  fastify.post("/lending/withdraw-collateral", async (request, reply) => {
    try {
      const body = amountSchema.parse(request.body);
      const stroops = BigInt(Math.floor(body.amount * 1e7));

      const result = await buildContractTx(
        server,
        lendingContractId,
        "withdraw_collateral",
        [
          new Address(body.userAddress).toScVal(),
          nativeToScVal(stroops, { type: "i128" }),
        ],
        body.userAddress
      );

      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : (err as { message?: string })?.message ?? "Withdraw failed";
      reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /lending/borrow
   * Build unsigned tx: borrow XLM against sXLM collateral.
   */
  fastify.post("/lending/borrow", async (request, reply) => {
    try {
      const body = amountSchema.parse(request.body);
      const stroops = BigInt(Math.floor(body.amount * 1e7));

      // Pre-flight: check pool has enough XLM liquidity
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
      const message = err instanceof Error ? err.message : (err as { message?: string })?.message ?? "Borrow failed";
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
      const message = err instanceof Error ? err.message : (err as { message?: string })?.message ?? "Repay failed";
      reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /lending/liquidate
   * Build unsigned tx: liquidate an unhealthy position.
   */
  fastify.post("/lending/liquidate", async (request, reply) => {
    try {
      const body = liquidateSchema.parse(request.body);

      const result = await buildContractTx(
        server,
        lendingContractId,
        "liquidate",
        [
          new Address(body.liquidatorAddress).toScVal(),
          new Address(body.borrowerAddress).toScVal(),
        ],
        body.liquidatorAddress
      );

      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : (err as { message?: string })?.message ?? "Liquidation failed";
      reply.status(400).send({ error: message });
    }
  });

  /**
   * GET /lending/position/:wallet
   * Query on-chain position via contract view + sync to DB.
   */
  fastify.get("/lending/position/:wallet", async (request, reply) => {
    try {
      const { wallet } = request.params as { wallet: string };

      // Query on-chain position + protocol params in parallel
      const [position, healthFactor, cfBpsRaw, erRaw] = await Promise.all([
        queryContractView(server, lendingContractId, "get_position", [new Address(wallet).toScVal()]),
        queryContractView(server, lendingContractId, "health_factor", [new Address(wallet).toScVal()]),
        queryContractView(server, lendingContractId, "get_collateral_factor", []),
        queryContractView(server, lendingContractId, "get_exchange_rate", []),
      ]);

      let collateral = BigInt(0);
      let borrowed = BigInt(0);
      let hf = 0;

      if (position) {
        // get_position returns (i128, i128) tuple
        collateral = BigInt(position[0] ?? 0);
        borrowed = BigInt(position[1] ?? 0);
      }
      if (healthFactor !== null) {
        hf = Number(healthFactor) / 1e7; // RATE_PRECISION
      }

      // Compute max borrow matching the contract formula:
      // max_borrow_stroops = collateral * er * cf_bps / (10000 * RATE_PRECISION)
      const cfBps = Number(cfBpsRaw ?? 7000);
      const er = Number(erRaw ?? 10_000_000); // in RATE_PRECISION units
      const maxBorrowStroops = (Number(collateral) * er * cfBps) / (10000 * 1e7);
      const maxBorrow = maxBorrowStroops / 1e7;

      // Sync to DB
      if (collateral > 0 || borrowed > 0) {
        const existing = await prisma.collateralPosition.findFirst({
          where: { wallet },
        });
        if (existing) {
          await prisma.collateralPosition.update({
            where: { id: existing.id },
            data: {
              sxlmDeposited: collateral,
              xlmBorrowed: borrowed,
              healthFactor: hf,
              updatedAt: new Date(),
            },
          });
        } else {
          await prisma.collateralPosition.create({
            data: {
              wallet,
              sxlmDeposited: collateral,
              xlmBorrowed: borrowed,
              healthFactor: hf,
            },
          });
        }
      }

      return {
        wallet,
        sxlmDeposited: Number(collateral) / 1e7,
        sxlmDepositedRaw: collateral.toString(),
        xlmBorrowed: Number(borrowed) / 1e7,
        xlmBorrowedRaw: borrowed.toString(),
        healthFactor: hf,
        maxBorrow,
        collateralFactorBps: cfBps,
        exchangeRate: er / 1e7,
      };
    } catch (err: unknown) {
      // Fallback to DB if contract query fails
      const { wallet } = request.params as { wallet: string };
      const dbPosition = await prisma.collateralPosition.findFirst({
        where: { wallet },
        orderBy: { updatedAt: "desc" },
      });
      return dbPosition
        ? {
            wallet,
            sxlmDeposited: Number(dbPosition.sxlmDeposited) / 1e7,
            sxlmDepositedRaw: dbPosition.sxlmDeposited.toString(),
            xlmBorrowed: Number(dbPosition.xlmBorrowed) / 1e7,
            xlmBorrowedRaw: dbPosition.xlmBorrowed.toString(),
            healthFactor: dbPosition.healthFactor,
            maxBorrow: 0, // cannot compute without on-chain CF/ER
            collateralFactorBps: 7000,
            exchangeRate: 1,
          }
        : {
            wallet,
            sxlmDeposited: 0,
            sxlmDepositedRaw: "0",
            xlmBorrowed: 0,
            xlmBorrowedRaw: "0",
            healthFactor: 0,
            maxBorrow: 0,
            collateralFactorBps: 7000,
            exchangeRate: 1,
          };
    }
  });

  /**
   * GET /lending/stats
   * Query on-chain lending stats.
   */
  fastify.get("/lending/stats", async () => {
    try {
      const [totalCollateral, totalBorrowed, cfBpsRaw, ltBpsRaw, borrowRateBpsRaw, poolBalanceRaw] =
        await Promise.all([
          queryContractView(server, lendingContractId, "total_collateral", []),
          queryContractView(server, lendingContractId, "total_borrowed", []),
          queryContractView(server, lendingContractId, "get_collateral_factor", []),
          queryContractView(server, lendingContractId, "get_liquidation_threshold", []),
          queryContractView(server, lendingContractId, "get_borrow_rate", []),
          queryContractView(server, lendingContractId, "get_pool_balance", []),
        ]);

      const tc = Number(totalCollateral ?? 0);
      const tb = Number(totalBorrowed ?? 0);

      return {
        totalCollateral: tc / 1e7,
        totalCollateralRaw: (totalCollateral ?? 0).toString(),
        totalBorrowed: tb / 1e7,
        totalBorrowedRaw: (totalBorrowed ?? 0).toString(),
        poolBalance: Number(poolBalanceRaw ?? 0) / 1e7,
        collateralFactorBps: Number(cfBpsRaw ?? 7000),
        liquidationThresholdBps: Number(ltBpsRaw ?? 8000),
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
        collateralFactorBps: 7000,
        liquidationThresholdBps: 8000,
        borrowRateBps: 500,
        utilizationRate: 0,
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
