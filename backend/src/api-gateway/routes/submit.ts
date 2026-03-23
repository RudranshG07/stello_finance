import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  rpc,
  TransactionBuilder,
  Contract,
  Address,
  nativeToScVal,
  scValToNative,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { config } from "../../config/index.js";
import { StakingEngine } from "../../staking-engine/index.js";
import { stellarAddressSchema, signedXdrSchema } from "../middleware/validation.js";

const claimSchema = z.object({
  userAddress: stellarAddressSchema,
  withdrawalId: z.string(),
});

interface WithdrawalEntry {
  user: string;
  claimed: boolean;
  xlm_amount: string;
  unlock_ledger: number;
}

/**
 * Scan the staking contract's withdrawal queue to find the contract-side
 * withdrawal ID for a given user address. The contract uses a global 0-based
 * counter while the DB uses 1-based auto-increment, so they diverge for
 * multi-user scenarios. Returns { id, entry } or null if not found.
 */
async function findContractWithdrawal(
  server: rpc.Server,
  userAddress: string,
  maxScan = 50,
): Promise<{ id: number; entry: WithdrawalEntry } | null> {
  const stakingContract = new Contract(config.contracts.stakingContractId);
  const adminAccount = await server.getAccount(config.admin.publicKey);

  for (let id = 0; id < maxScan; id++) {
    try {
      const tx = new TransactionBuilder(adminAccount, {
        fee: BASE_FEE,
        networkPassphrase: config.stellar.networkPassphrase,
      })
        .addOperation(
          stakingContract.call(
            "get_withdrawal",
            nativeToScVal(id, { type: "u64" })
          )
        )
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);

      if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) break; // past end of queue

      const entry = scValToNative(sim.result.retval) as WithdrawalEntry;

      if (entry.user === userAddress && !entry.claimed) {
        return { id, entry };
      }
    } catch {
      break; // no more entries
    }
  }

  return null;
}

export const submitRoutes: FastifyPluginAsync<{ stakingEngine: StakingEngine }> = async (
  fastify,
  opts
) => {
  const server = new rpc.Server(config.stellar.rpcUrl);

  /**
   * POST /staking/submit
   * Submit a user-signed transaction XDR to the Stellar network.
   * Sends raw XDR directly to Soroban RPC to avoid SDK parsing issues.
   */
  fastify.post("/staking/submit", async (request, reply) => {
    try {
      const body = signedXdrSchema.parse(request.body);

      // Send the signed XDR directly to Soroban RPC via JSON-RPC
      // This avoids TransactionBuilder.fromXDR parsing issues with Soroban envelopes
      const rpcResponse = await fetch(config.stellar.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "sendTransaction",
          params: { transaction: body.signedXdr },
        }),
      });

      const rpcResult = await rpcResponse.json() as {
        result?: { hash: string; status: string; errorResultXdr?: string };
        error?: { message: string };
      };

      if (rpcResult.error) {
        return reply.status(400).send({
          error: `RPC error: ${rpcResult.error.message}`,
        });
      }

      if (!rpcResult.result) {
        return reply.status(400).send({ error: "No result from RPC" });
      }

      const { hash, status } = rpcResult.result;

      if (status === "ERROR") {
        return reply.status(400).send({
          error: `Transaction rejected: ${rpcResult.result.errorResultXdr || "unknown error"}`,
        });
      }

      // Poll for confirmation using raw JSON-RPC (avoids SDK XDR parse errors)
      const confirmed = await pollTransaction(config.stellar.rpcUrl, hash);

      return {
        txHash: hash,
        status: confirmed.status,
        ledger: confirmed.ledger,
        pending: confirmed.pending ?? false,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : (err as { message?: string })?.message ?? "Submit failed";
      reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /staking/claim
   * Build an unsigned claim withdrawal transaction for user to sign.
   *
   * The contract uses a 0-based auto-increment counter for withdrawal IDs,
   * but the frontend DB uses 1-based auto-increment IDs. To avoid mismatches,
   * we scan the contract's withdrawal queue to find the correct contract-side
   * ID for this user rather than blindly trusting the DB-provided withdrawalId.
   */
  fastify.post("/staking/claim", async (request, reply) => {
    try {
      const body = claimSchema.parse(request.body);

      // Find the correct contract withdrawal ID by scanning the queue.
      // Contract IDs start at 0 and auto-increment globally (not per-user).
      const withdrawal = await findContractWithdrawal(server, body.userAddress);
      if (withdrawal === null) {
        return reply.status(400).send({
          error: "No unclaimed withdrawal found for your address. It may already be claimed or the cooldown has not started yet.",
        });
      }

      // Check cooldown BEFORE simulation — Soroban panic messages don't
      // surface as readable text, just "UnreachableCodeReached".
      const latestLedger = await server.getLatestLedger();
      if (latestLedger.sequence < withdrawal.entry.unlock_ledger) {
        const remaining = withdrawal.entry.unlock_ledger - latestLedger.sequence;
        const minsLeft = Math.ceil((remaining * 5) / 60);
        return reply.status(400).send({
          error: `Cooldown not expired yet. Approximately ${minsLeft} minutes remaining (~${remaining} ledgers).`,
        });
      }

      const contract = new Contract(config.contracts.stakingContractId);
      const claimOp = contract.call(
        "claim_withdrawal",
        new Address(body.userAddress).toScVal(),
        nativeToScVal(withdrawal.id, { type: "u64" })
      );

      const account = await server.getAccount(body.userAddress);
      const tx = new TransactionBuilder(account, {
        fee: "2000000", // 0.2 XLM — assembleTransaction adds minResourceFee on top
        networkPassphrase: config.stellar.networkPassphrase,
      })
        .addOperation(claimOp)
        .setTimeout(300)
        .build();

      const simResult = await server.simulateTransaction(tx);

      if (rpc.Api.isSimulationError(simResult)) {
        return reply.status(400).send({
          error: `Simulation failed: ${simResult.error}`,
        });
      }

      const preparedTx = rpc.assembleTransaction(tx, simResult).build();

      return {
        xdr: preparedTx.toXDR(),
        networkPassphrase: config.stellar.networkPassphrase,
        contractWithdrawalId: withdrawal.id,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : (err as { message?: string })?.message ?? "Claim failed";
      reply.status(400).send({ error: message });
    }
  });
};

/**
 * Poll for transaction confirmation using raw JSON-RPC to avoid SDK XDR
 * parse errors ("Bad union switch") that occur with newer protocol versions.
 *
 * Strategy: poll up to 60s with increasing back-off to survive rate limits.
 * If still unconfirmed, return PENDING (not an error) so the frontend can
 * show the hash and let the user verify manually.
 */
async function pollTransaction(
  rpcUrl: string,
  hash: string,
): Promise<{ status: string; ledger?: number; pending?: boolean }> {
  // Poll schedule: 6×2s, then 6×4s, then 6×6s ≈ 72s total, 18 requests
  const schedule = [
    ...Array(6).fill(2000),
    ...Array(6).fill(4000),
    ...Array(6).fill(6000),
  ];

  for (const intervalMs of schedule) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));

    let rpcResult: {
      result?: { status: string; ledger?: number; errorResultXdr?: string };
      error?: { message: string };
    };

    try {
      const rpcResponse = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: { hash },
        }),
      });

      // If rate-limited (429), skip this attempt and wait the next interval
      if (rpcResponse.status === 429) continue;

      rpcResult = await rpcResponse.json() as typeof rpcResult;
    } catch {
      // Network error during poll — skip and retry
      continue;
    }

    const result = rpcResult.result;

    if (result?.status === "SUCCESS") {
      return { status: "SUCCESS", ledger: result.ledger };
    }

    if (result?.status === "FAILED") {
      throw new Error(`Transaction failed on-chain: ${result.errorResultXdr || "unknown error"}`);
    }

    // NOT_FOUND → still pending, keep waiting
  }

  // Timed out — return PENDING so frontend shows success with hash
  return { status: "PENDING", pending: true };
}
