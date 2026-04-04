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

const addLiquiditySchema = z.object({
  userAddress: z.string().min(56).max(56),
  xlmAmount: z.number().positive(),
  sxlmAmount: z.number().positive(),
});

const removeLiquiditySchema = z.object({
  userAddress: z.string().min(56).max(56),
  lpAmount: z.number().positive(),
});

const swapSchema = z.object({
  userAddress: z.string().min(56).max(56),
  amount: z.number().positive(),
  minOut: z.number().min(0).default(0),
});

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
    fee: BASE_FEE,
    networkPassphrase: config.stellar.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(300)
    .build();

  const simResult = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResult)) {
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

export const liquidityRoutes: FastifyPluginAsync<{ prisma: PrismaClient }> = async (
  fastify,
  opts
) => {
  const { prisma } = opts;
  const server = new rpc.Server(config.stellar.rpcUrl);
  const lpContractId = config.contracts.lpPoolContractId;

  /**
   * POST /liquidity/add
   * Build unsigned tx: add liquidity to the sXLM/XLM pool.
   */
  fastify.post("/liquidity/add", async (request, reply) => {
    try {
      const body = addLiquiditySchema.parse(request.body);
      const xlmStroops = BigInt(Math.floor(body.xlmAmount * 1e7));
      const sxlmStroops = BigInt(Math.floor(body.sxlmAmount * 1e7));

      const result = await buildContractTx(
        server,
        lpContractId,
        "add_liquidity",
        [
          new Address(body.userAddress).toScVal(),
          nativeToScVal(xlmStroops, { type: "i128" }),
          nativeToScVal(sxlmStroops, { type: "i128" }),
        ],
        body.userAddress
      );

      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Add liquidity failed";
      reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /liquidity/remove
   * Build unsigned tx: remove liquidity from the pool.
   */
  fastify.post("/liquidity/remove", async (request, reply) => {
    try {
      const body = removeLiquiditySchema.parse(request.body);
      const lpStroops = BigInt(Math.floor(body.lpAmount * 1e7));

      const result = await buildContractTx(
        server,
        lpContractId,
        "remove_liquidity",
        [
          new Address(body.userAddress).toScVal(),
          nativeToScVal(lpStroops, { type: "i128" }),
        ],
        body.userAddress
      );

      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Remove liquidity failed";
      reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /liquidity/swap-xlm-to-sxlm
   * Build unsigned tx: swap XLM for sXLM.
   */
  fastify.post("/liquidity/swap-xlm-to-sxlm", async (request, reply) => {
    try {
      const body = swapSchema.parse(request.body);
      const stroops = BigInt(Math.floor(body.amount * 1e7));

      const minOutStroops = BigInt(Math.floor(body.minOut * 1e7));

      const result = await buildContractTx(
        server,
        lpContractId,
        "swap_xlm_to_sxlm",
        [
          new Address(body.userAddress).toScVal(),
          nativeToScVal(stroops, { type: "i128" }),
          nativeToScVal(minOutStroops, { type: "i128" }),
        ],
        body.userAddress
      );

      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Swap failed";
      reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /liquidity/swap-sxlm-to-xlm
   * Build unsigned tx: swap sXLM for XLM.
   */
  fastify.post("/liquidity/swap-sxlm-to-xlm", async (request, reply) => {
    try {
      const body = swapSchema.parse(request.body);
      const stroops = BigInt(Math.floor(body.amount * 1e7));
      const minOutStroops = BigInt(Math.floor(body.minOut * 1e7));

      const result = await buildContractTx(
        server,
        lpContractId,
        "swap_sxlm_to_xlm",
        [
          new Address(body.userAddress).toScVal(),
          nativeToScVal(stroops, { type: "i128" }),
          nativeToScVal(minOutStroops, { type: "i128" }),
        ],
        body.userAddress
      );

      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Swap failed";
      reply.status(400).send({ error: message });
    }
  });

  /**
   * GET /liquidity/position/:wallet
   * Query on-chain LP position + sync to DB.
   */
  fastify.get("/liquidity/position/:wallet", async (request) => {
    const { wallet } = request.params as { wallet: string };

    try {
      const lpBalance = await queryContractView(
        server,
        lpContractId,
        "get_lp_balance",
        [new Address(wallet).toScVal()]
      );

      const lpTokens = BigInt(lpBalance ?? 0);

      // Get reserves for share calculation
      const reserves = await queryContractView(
        server,
        lpContractId,
        "get_reserves",
        []
      );
      const totalLp = await queryContractView(
        server,
        lpContractId,
        "total_lp_supply",
        []
      );

      const totalLpBig = BigInt(totalLp ?? 0);
      const sharePercent =
        totalLpBig > 0 ? (Number(lpTokens) / Number(totalLpBig)) * 100 : 0;

      const reserveXlm = BigInt(reserves?.[0] ?? 0);
      const reserveSxlm = BigInt(reserves?.[1] ?? 0);

      // Calculate user's share of the pool
      const userXlm =
        totalLpBig > 0
          ? (lpTokens * reserveXlm) / totalLpBig
          : BigInt(0);
      const userSxlm =
        totalLpBig > 0
          ? (lpTokens * reserveSxlm) / totalLpBig
          : BigInt(0);

      // Sync to DB
      if (lpTokens > 0) {
        const existing = await prisma.lPPosition.findFirst({
          where: { wallet },
        });
        if (existing) {
          await prisma.lPPosition.update({
            where: { id: existing.id },
            data: {
              lpTokens,
              xlmDeposited: userXlm,
              sxlmDeposited: userSxlm,
              updatedAt: new Date(),
            },
          });
        } else {
          await prisma.lPPosition.create({
            data: {
              wallet,
              lpTokens,
              xlmDeposited: userXlm,
              sxlmDeposited: userSxlm,
            },
          });
        }
      }

      return {
        wallet,
        lpTokens: Number(lpTokens) / 1e7,
        lpTokensRaw: lpTokens.toString(),
        sharePercent,
        xlmShare: Number(userXlm) / 1e7,
        sxlmShare: Number(userSxlm) / 1e7,
      };
    } catch {
      // Fallback to DB
      const dbPos = await prisma.lPPosition.findFirst({
        where: { wallet },
        orderBy: { updatedAt: "desc" },
      });
      return {
        wallet,
        lpTokens: dbPos ? Number(dbPos.lpTokens) / 1e7 : 0,
        lpTokensRaw: dbPos?.lpTokens.toString() ?? "0",
        sharePercent: 0,
        xlmShare: dbPos ? Number(dbPos.xlmDeposited) / 1e7 : 0,
        sxlmShare: dbPos ? Number(dbPos.sxlmDeposited) / 1e7 : 0,
      };
    }
  });

  /**
   * GET /liquidity/pool-stats
   * Query on-chain pool stats.
   */
  fastify.get("/liquidity/pool-stats", async () => {
    try {
      const reserves = await queryContractView(
        server,
        lpContractId,
        "get_reserves",
        []
      );
      const price = await queryContractView(
        server,
        lpContractId,
        "get_price",
        []
      );
      const totalLp = await queryContractView(
        server,
        lpContractId,
        "total_lp_supply",
        []
      );

      const reserveXlm = Number(reserves?.[0] ?? 0) / 1e7;
      const reserveSxlm = Number(reserves?.[1] ?? 0) / 1e7;

      return {
        reserveXlm,
        reserveSxlm,
        totalLpSupply: Number(totalLp ?? 0) / 1e7,
        price: Number(price ?? 10_000_000) / 1e7,
        feeBps: 30,
        tvl: reserveXlm + reserveSxlm * (Number(price ?? 10_000_000) / 1e7),
      };
    } catch {
      return {
        reserveXlm: 0,
        reserveSxlm: 0,
        totalLpSupply: 0,
        price: 1.0,
        feeBps: 30,
        tvl: 0,
      };
    }
  });
};
