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
import { PrismaClient } from "@prisma/client";
import { config } from "../../config/index.js";
import { stellarAddressSchema, signedXdrSchema } from "../middleware/validation.js";

const claimSchema = z.object({
  userAddress: stellarAddressSchema,
  withdrawalId: z.string(),
});

interface WithdrawalEntry {
  user: string;
  claimed: boolean;
  xlm_amount: string | bigint;
  unlock_ledger: number;
}

interface ContractWithdrawalMatch {
  id: number;
  entry: WithdrawalEntry;
}

type RpcAccount = Awaited<ReturnType<rpc.Server["getAccount"]>>;

async function getContractWithdrawal(
  server: rpc.Server,
  adminAccount: RpcAccount,
  withdrawalId: number,
): Promise<WithdrawalEntry | null> {
  const stakingContract = new Contract(config.contracts.stakingContractId);

  try {
    const tx = new TransactionBuilder(adminAccount, {
      fee: BASE_FEE,
      networkPassphrase: config.stellar.networkPassphrase,
    })
      .addOperation(
        stakingContract.call(
          "get_withdrawal",
          nativeToScVal(withdrawalId, { type: "u64" })
        )
      )
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
      return null;
    }

    return scValToNative(sim.result.retval) as WithdrawalEntry;
  } catch {
    return null;
  }
}

async function listUnclaimedContractWithdrawals(
  server: rpc.Server,
  adminAccount: RpcAccount,
  userAddress: string,
  maxScan = 200,
): Promise<ContractWithdrawalMatch[]> {
  const matches: ContractWithdrawalMatch[] = [];

  for (let id = 0; id < maxScan; id++) {
    const entry = await getContractWithdrawal(server, adminAccount, id);
    if (entry === null) {
      break;
    }

    if (entry.user === userAddress && !entry.claimed) {
      matches.push({ id, entry });
    }
  }

  return matches;
}

function estimateUnlockTimeFromLedger(
  currentLedger: number,
  unlockLedger: number,
  now = Date.now(),
): Date {
  const remainingLedgers = Math.max(unlockLedger - currentLedger, 0);
  return new Date(now + remainingLedgers * 5000);
}

export const submitRoutes: FastifyPluginAsync<{ prisma: PrismaClient }> = async (
  fastify,
  opts
) => {
  const { prisma } = opts;
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
   */
  fastify.post("/staking/claim", async (request, reply) => {
    try {
      const body = claimSchema.parse(request.body);
      const dbWithdrawalId = Number.parseInt(body.withdrawalId, 10);
      if (!Number.isSafeInteger(dbWithdrawalId) || dbWithdrawalId <= 0) {
        return reply.status(400).send({ error: "Invalid withdrawal ID." });
      }

      const dbWithdrawal = await prisma.withdrawal.findFirst({
        where: {
          id: dbWithdrawalId,
          wallet: body.userAddress,
          status: { in: ["pending", "processing"] },
        },
      });
      if (!dbWithdrawal) {
        return reply.status(404).send({
          error: "Withdrawal not found for this wallet, or it is no longer claimable.",
        });
      }

      let withdrawal: ContractWithdrawalMatch | null = null;
      const adminAccount = await server.getAccount(config.admin.publicKey);

      if (dbWithdrawal.contractWithdrawalId !== null) {
        if (dbWithdrawal.contractWithdrawalId > BigInt(Number.MAX_SAFE_INTEGER)) {
          return reply.status(400).send({
            error: "Withdrawal ID is too large to handle safely in the API.",
          });
        }

        const contractWithdrawalId = Number(dbWithdrawal.contractWithdrawalId);
        const entry = await getContractWithdrawal(server, adminAccount, contractWithdrawalId);
        if (entry && entry.user === body.userAddress && !entry.claimed) {
          withdrawal = { id: contractWithdrawalId, entry };
        }
      } else {
        const matches = await listUnclaimedContractWithdrawals(server, adminAccount, body.userAddress);
        if (matches.length === 1) {
          withdrawal = matches[0];
        } else if (matches.length > 1) {
          return reply.status(409).send({
            error: "Multiple on-chain withdrawals are pending for this wallet, but this record is missing its contract withdrawal ID. Refresh after the event listener syncs, then try again.",
          });
        }
      }

      if (withdrawal === null) {
        return reply.status(400).send({
          error: "No matching unclaimed contract withdrawal was found. It may already be claimed or still syncing from the chain.",
        });
      }

      // Check cooldown BEFORE simulation — Soroban panic messages don't
      // surface as readable text, just "UnreachableCodeReached".
      const latestLedger = await server.getLatestLedger();
      if (dbWithdrawal.contractWithdrawalId === null) {
        await prisma.withdrawal.update({
          where: { id: dbWithdrawal.id },
          data: {
            amount: BigInt(withdrawal.entry.xlm_amount),
            contractWithdrawalId: BigInt(withdrawal.id),
            unlockLedger: withdrawal.entry.unlock_ledger,
            unlockTime: estimateUnlockTimeFromLedger(
              latestLedger.sequence,
              withdrawal.entry.unlock_ledger,
            ),
          },
        });
      }

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
        withdrawalId: dbWithdrawal.id,
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
