import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  rpc,
  Contract,
  Address,
  nativeToScVal,
  scValToNative,
  TransactionBuilder,
  Operation,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { config } from "../../config/index.js";
import { StakingEngine } from "../../staking-engine/index.js";
import { stellarAddressSchema, positiveAmountSchema } from "../middleware/validation.js";

const unstakeSchema = z.object({
  userAddress: stellarAddressSchema,
  amount: positiveAmountSchema,
  instant: z.boolean().optional().default(false),
});

/** Returns the user's on-chain sXLM balance in stroops, or throws with "ENTRY_ARCHIVED" if expired. */
async function querySxlmBalance(
  server: rpc.Server,
  userAddress: string
): Promise<bigint> {
  const tokenContract = new Contract(config.contracts.sxlmTokenContractId);
  const readOp = tokenContract.call(
    "balance",
    new Address(userAddress).toScVal()
  );

  const account = await server.getAccount(config.admin.publicKey);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.stellar.networkPassphrase,
  })
    .addOperation(readOp)
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);

  // Archived entries → balance expired, signal caller
  if (rpc.Api.isSimulationRestore(simResult)) {
    throw new Error("ENTRY_ARCHIVED");
  }

  if (rpc.Api.isSimulationError(simResult)) {
    const errStr = String(simResult.error);
    if (errStr.includes("EntryArchived") || errStr.includes("MissingValue")) {
      throw new Error("ENTRY_ARCHIVED");
    }
    throw new Error(`Balance check failed: ${simResult.error}`);
  }

  if (rpc.Api.isSimulationSuccess(simResult) && simResult.result) {
    return BigInt(scValToNative(simResult.result.retval));
  }

  return BigInt(0);

}

/** Build an unsigned RestoreFootprint transaction for the user's sXLM balance entry. */
async function buildRestoreTx(
  server: rpc.Server,
  userAddress: string
): Promise<string> {
  const tokenContract = new Contract(config.contracts.sxlmTokenContractId);
  const readOp = tokenContract.call(
    "balance",
    new Address(userAddress).toScVal()
  );

  // Simulate using the USER's account so the restore tx is signed by them
  const account = await server.getAccount(userAddress);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.stellar.networkPassphrase,
  })
    .addOperation(readOp)
    .setTimeout(300)
    .build();

  const simResult = await server.simulateTransaction(tx);

  if (!rpc.Api.isSimulationRestore(simResult)) {
    throw new Error("Balance entry is not archived — no restore needed.");
  }

  // Build RestoreFootprint tx using the preamble returned by the RPC
  const restoreAccount = await server.getAccount(userAddress);
  const restoreTx = new TransactionBuilder(restoreAccount, {
    fee: String(2_000_000 + Number(simResult.restorePreamble.minResourceFee)),
    networkPassphrase: config.stellar.networkPassphrase,
  })
    .addOperation(Operation.restoreFootprint({}))
    .setSorobanData(simResult.restorePreamble.transactionData.build())
    .setTimeout(300)
    .build();

  return restoreTx.toXDR();
}

export const unstakeRoutes: FastifyPluginAsync<{ stakingEngine: StakingEngine }> = async (
  fastify,
  opts
) => {
  const { stakingEngine } = opts;
  const server = new rpc.Server(config.stellar.rpcUrl);

  /**
   * GET /balance/:address
   * Returns the user's sXLM balance (in XLM-equivalent display units).
   */
  fastify.get("/balance/:address", async (request, reply) => {
    try {
      const params = z.object({ address: stellarAddressSchema }).parse(request.params);
      const exchangeRate = await stakingEngine.getExchangeRate();

      try {
        const balanceStroops = await querySxlmBalance(server, params.address);
        return {
          sxlmBalance: Number(balanceStroops) / 1e7,
          sxlmBalanceRaw: balanceStroops.toString(),
          xlmValue: (Number(balanceStroops) / 1e7) * exchangeRate,
          exchangeRate,
          archived: false,
        };
      } catch (balErr: unknown) {
        if (balErr instanceof Error && balErr.message === "ENTRY_ARCHIVED") {
          return {
            sxlmBalance: 0,
            sxlmBalanceRaw: "0",
            xlmValue: 0,
            exchangeRate,
            archived: true,
          };
        }
        throw balErr;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to fetch balance";
      reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /staking/restore-balance
   * Builds an unsigned RestoreFootprint transaction to revive expired sXLM balance.
   */
  fastify.post("/staking/restore-balance", async (request, reply) => {
    try {
      const body = z.object({ userAddress: stellarAddressSchema }).parse(request.body);
      const xdr = await buildRestoreTx(server, body.userAddress);
      return { xdr, networkPassphrase: config.stellar.networkPassphrase };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Restore failed";
      reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /staking/unstake
   * Builds an unsigned withdrawal request transaction for user to sign.
   */
  fastify.post("/staking/unstake", async (request, reply) => {
    try {
      const body = unstakeSchema.parse(request.body);
      const sxlmStroops = BigInt(Math.floor(body.amount * 1e7));

      if (sxlmStroops <= BigInt(0)) {
        return reply.status(400).send({ error: "Amount must be positive" });
      }

      // Check user's sXLM balance before simulation
      let userBalance: bigint;
      try {
        userBalance = await querySxlmBalance(server, body.userAddress);
      } catch (balErr: unknown) {
        if (balErr instanceof Error && balErr.message === "ENTRY_ARCHIVED") {
          return reply.status(400).send({
            error: "Your sXLM balance entry has expired (TTL) on testnet. Use the Restore Balance button to recover it first.",
            code: "ENTRY_ARCHIVED",
          });
        }
        throw balErr;
      }

      if (userBalance < sxlmStroops) {
        const available = Number(userBalance) / 1e7;
        return reply.status(400).send({
          error: `Insufficient sXLM balance. You have ${available.toFixed(7)} sXLM but tried to withdraw ${body.amount} sXLM.`,
        });
      }

      // Build unsigned transaction
      const contract = new Contract(config.contracts.stakingContractId);
      const withdrawOp = contract.call(
        "request_withdrawal",
        new Address(body.userAddress).toScVal(),
        nativeToScVal(sxlmStroops, { type: "i128" })
      );

      const account = await server.getAccount(body.userAddress);
      const tx = new TransactionBuilder(account, {
        fee: "2000000", // 0.2 XLM — assembleTransaction adds minResourceFee on top
        networkPassphrase: config.stellar.networkPassphrase,
      })
        .addOperation(withdrawOp)
        .setTimeout(300)
        .build();

      const simResult = await server.simulateTransaction(tx);

      if (rpc.Api.isSimulationError(simResult)) {
        // Provide a friendlier error message
        const errorStr = String(simResult.error);
        if (errorStr.includes("UnreachableCodeReached")) {
          return reply.status(400).send({
            error: "Withdrawal failed. Please check your sXLM balance and try a smaller amount.",
          });
        }
        return reply.status(400).send({
          error: `Transaction simulation failed: ${simResult.error}`,
        });
      }

      const preparedTx = rpc.assembleTransaction(tx, simResult).build();
      const exchangeRate = await stakingEngine.getExchangeRate();
      // This is only an estimate for the unsigned tx preview. The real
      // withdrawal row is created from the confirmed on-chain event.
      const estimatedUnlockTime = new Date(Date.now() + config.protocol.unbondingPeriodMs);

      return {
        xdr: preparedTx.toXDR(),
        networkPassphrase: config.stellar.networkPassphrase,
        estimatedXlm: (body.amount * exchangeRate).toFixed(7),
        exchangeRate,
        estimatedUnlockTime: estimatedUnlockTime.toISOString(),
        unlockTime: estimatedUnlockTime.toISOString(),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : (err as { message?: string })?.message ?? "Unstake failed";
      reply.status(400).send({ error: message });
    }
  });
};
