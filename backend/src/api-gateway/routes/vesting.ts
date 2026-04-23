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

// ─── Schemas ───────────────────────────────────────────────────────────────

const claimSchema = z.object({
  userAddress: z.string().min(56).max(56),
  scheduleId: z.number().int().min(0),
});

const createScheduleSchema = z.object({
  userAddress: z.string().min(56).max(56), // must be admin
  beneficiary: z.string().min(56).max(56),
  tokenAddress: z.string().min(56).max(56),
  /** Total amount in stroops (7-decimal integer). */
  totalAmount: z.number().int().positive(),
  startLedger: z.number().int().positive(),
  cliffLedger: z.number().int().positive(),
  endLedger: z.number().int().positive(),
  revocable: z.boolean(),
});

const revokeSchema = z.object({
  userAddress: z.string().min(56).max(56), // must be admin
  scheduleId: z.number().int().min(0),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const SOROBAN_FEE = "2000000"; // 0.2 XLM

function getServer(): rpc.Server {
  return new rpc.Server(config.stellar.rpcUrl, {
    allowHttp: config.stellar.rpcUrl.startsWith("http://"),
  });
}

function getVestingContractId(): string {
  const id = config.contracts.vestingContractId;
  if (!id) throw new Error("VESTING_CONTRACT_ID is not configured");
  return id;
}

/**
 * Build a Soroban transaction for the vesting contract, simulate it,
 * and return the assembled XDR ready for user signing.
 */
async function buildVestingTx(
  method: string,
  args: ReturnType<typeof nativeToScVal>[],
  userAddress: string
) {
  const server = getServer();
  const contract = new Contract(getVestingContractId());
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
    if (errStr.includes("nothing to claim yet")) {
      throw new Error("No tokens are unlocked yet — cliff period has not passed.");
    }
    if (errStr.includes("not your schedule")) {
      throw new Error("This vesting schedule does not belong to your wallet.");
    }
    if (errStr.includes("schedule already revoked")) {
      throw new Error("This schedule has already been revoked.");
    }
    if (errStr.includes("schedule is not revocable")) {
      throw new Error("This schedule cannot be revoked.");
    }
    if (errStr.includes("only admin")) {
      throw new Error("Only the protocol admin can perform this action.");
    }
    throw new Error(`Simulation failed: ${simResult.error}`);
  }

  const preparedTx = rpc.assembleTransaction(tx, simResult).build();
  return {
    xdr: preparedTx.toXDR(),
    networkPassphrase: config.stellar.networkPassphrase,
  };
}

/**
 * Query a read-only view function from the vesting contract.
 */
async function queryVestingView(method: string, args: ReturnType<typeof nativeToScVal>[]) {
  const server = getServer();
  const contract = new Contract(getVestingContractId());
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

// ─── Route plugin ──────────────────────────────────────────────────────────

export const vestingRoutes: FastifyPluginAsync<{ prisma: PrismaClient }> = async (
  fastify,
  opts
) => {
  const { prisma } = opts;

  /**
   * GET /api/vesting/stats
   *
   * Protocol-level vesting overview — must be registered BEFORE /:wallet
   * to prevent Fastify from treating "stats" as a wallet address.
   */
  fastify.get("/vesting/stats", async (_request, reply) => {
    try {
      const [total, revoked, agg] = await Promise.all([
        prisma.vestingSchedule.count(),
        prisma.vestingSchedule.count({ where: { revoked: true } }),
        prisma.vestingSchedule.aggregate({
          _sum: { totalAmount: true, claimed: true },
        }),
      ]);

      return {
        totalSchedules: total,
        revokedSchedules: revoked,
        totalLockedStroops: agg._sum.totalAmount?.toString() ?? "0",
        totalClaimedStroops: agg._sum.claimed?.toString() ?? "0",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch stats";
      return reply.status(500).send({ error: message });
    }
  });

  /**
   * GET /api/vesting/schedule/:scheduleId
   *
   * Returns a single schedule by on-chain schedule ID.
   * Must be registered BEFORE /:wallet to avoid route collision.
   */
  fastify.get<{ Params: { scheduleId: string } }>(
    "/vesting/schedule/:scheduleId",
    async (request, reply) => {
      const id = parseInt(request.params.scheduleId, 10);
      if (isNaN(id) || id < 0) {
        return reply.status(400).send({ error: "Invalid scheduleId" });
      }

      try {
        const [schedule, claimable] = await Promise.all([
          queryVestingView("get_schedule", [
            nativeToScVal(id, { type: "u64" }),
          ]),
          queryVestingView("get_claimable", [
            nativeToScVal(id, { type: "u64" }),
          ]),
        ]);

        if (!schedule) {
          return reply.status(404).send({ error: "Schedule not found" });
        }

        return {
          schedule: {
            ...schedule,
            claimable: claimable !== null ? String(claimable) : "0",
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to fetch schedule";
        return reply.status(500).send({ error: message });
      }
    }
  );

  /**
   * GET /api/vesting/:wallet
   *
   * Returns all vesting schedules for a beneficiary wallet.
   * Registered AFTER /stats and /schedule/:id to avoid route collision.
   */
  fastify.get<{ Params: { wallet: string } }>(
    "/vesting/:wallet",
    async (request, reply) => {
      const { wallet } = request.params;

      if (!wallet || wallet.length < 56) {
        return reply.status(400).send({ error: "Invalid wallet address" });
      }

      const dbSchedules = await prisma.vestingSchedule.findMany({
        where: { beneficiary: wallet },
        orderBy: { scheduleId: "asc" },
      });

      const enriched = await Promise.all(
        dbSchedules.map(async (s) => {
          let claimableStroops = "0";
          try {
            const onChain = await queryVestingView("get_claimable", [
              nativeToScVal(Number(s.scheduleId), { type: "u64" }),
            ]);
            if (onChain !== null) {
              claimableStroops = String(onChain);
            }
          } catch {
            // RPC unavailable — return 0 claimable
          }

          return {
            id: s.id,
            scheduleId: Number(s.scheduleId),
            beneficiary: s.beneficiary,
            tokenAddress: s.tokenAddress,
            tokenSymbol: s.tokenSymbol,
            totalAmount: s.totalAmount.toString(),
            claimed: s.claimed.toString(),
            claimable: claimableStroops,
            startLedger: s.startLedger,
            cliffLedger: s.cliffLedger,
            endLedger: s.endLedger,
            revocable: s.revocable,
            revoked: s.revoked,
            vestedAtRevoke: s.vestedAtRevoke.toString(),
            createdAt: s.createdAt.toISOString(),
          };
        })
      );

      return { schedules: enriched };
    }
  );

  /**
   * POST /api/vesting/claim
   *
   * Build an unsigned transaction for claiming vested tokens.
   * User signs with Freighter and submits via /api/staking/submit.
   *
   * Body: { userAddress, scheduleId }
   */
  fastify.post("/vesting/claim", async (request, reply) => {
    const body = claimSchema.parse(request.body);

    try {
      const txData = await buildVestingTx(
        "claim",
        [
          new Address(body.userAddress).toScVal(),
          nativeToScVal(body.scheduleId, { type: "u64" }),
        ],
        body.userAddress
      );

      return txData;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to build claim transaction";
      return reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /api/vesting/create
   *
   * Build an unsigned transaction to create a new vesting schedule.
   * Tokens are pulled from the caller's wallet when the transaction executes.
   * Anyone with sufficient token balance can create a schedule.
   *
   * Body: { userAddress (caller), beneficiary, tokenAddress, totalAmount,
   *         startLedger, cliffLedger, endLedger, revocable }
   */
  fastify.post("/vesting/create", async (request, reply) => {
    const body = createScheduleSchema.parse(request.body);

    try {
      const txData = await buildVestingTx(
        "create_schedule",
        [
          new Address(body.userAddress).toScVal(),
          new Address(body.beneficiary).toScVal(),
          new Address(body.tokenAddress).toScVal(),
          nativeToScVal(body.totalAmount, { type: "i128" }),
          nativeToScVal(body.startLedger, { type: "u32" }),
          nativeToScVal(body.cliffLedger, { type: "u32" }),
          nativeToScVal(body.endLedger, { type: "u32" }),
          nativeToScVal(body.revocable, { type: "bool" }),
        ],
        body.userAddress
      );

      return txData;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to build create transaction";
      return reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /api/vesting/sync/:wallet
   *
   * Reads all on-chain vesting schedules for a beneficiary and upserts them
   * into the DB. Call this after creating a schedule so the frontend can
   * display it without waiting for the Hubble indexer.
   */
  fastify.post<{ Params: { wallet: string } }>(
    "/vesting/sync/:wallet",
    async (request, reply) => {
      const { wallet } = request.params;
      if (!wallet || wallet.length < 56) {
        return reply.status(400).send({ error: "Invalid wallet address" });
      }

      try {
        // 1. Get all schedule IDs for this beneficiary from chain
        const ids = await queryVestingView("get_schedules", [
          new Address(wallet).toScVal(),
        ]);
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
          return { synced: 0, schedules: [] };
        }

        // 2. Fetch each schedule from chain and upsert into DB
        const NATIVE_XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
        const upserted: number[] = [];

        for (const rawId of ids) {
          const scheduleId = Number(rawId);
          const s = await queryVestingView("get_schedule", [
            nativeToScVal(scheduleId, { type: "u64" }),
          ]);
          if (!s) continue;

          const tokenAddr: string = s.token?.toString() ?? "";
          const tokenSymbol = tokenAddr === NATIVE_XLM_SAC ? "XLM" : "sXLM";

          await prisma.vestingSchedule.upsert({
            where: { scheduleId: BigInt(scheduleId) },
            create: {
              scheduleId: BigInt(scheduleId),
              beneficiary: s.beneficiary?.toString() ?? wallet,
              tokenAddress: tokenAddr,
              tokenSymbol,
              totalAmount: BigInt(s.total_amount ?? 0),
              claimed: BigInt(s.claimed ?? 0),
              startLedger: Number(s.start_ledger),
              cliffLedger: Number(s.cliff_ledger),
              endLedger: Number(s.end_ledger),
              revocable: Boolean(s.revocable),
              revoked: Boolean(s.revoked),
              vestedAtRevoke: BigInt(s.vested_at_revoke ?? 0),
            },
            update: {
              claimed: BigInt(s.claimed ?? 0),
              revoked: Boolean(s.revoked),
              vestedAtRevoke: BigInt(s.vested_at_revoke ?? 0),
            },
          });
          upserted.push(scheduleId);
        }

        return { synced: upserted.length, scheduleIds: upserted };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Sync failed";
        return reply.status(500).send({ error: message });
      }
    }
  );

  /**
   * POST /api/vesting/revoke
   *
   * Admin-only: build an unsigned transaction to revoke a vesting schedule.
   *
   * Body: { userAddress (admin), scheduleId }
   */
  fastify.post("/vesting/revoke", async (request, reply) => {
    const body = revokeSchema.parse(request.body);

    try {
      const txData = await buildVestingTx(
        "revoke",
        [
          new Address(body.userAddress).toScVal(),
          nativeToScVal(body.scheduleId, { type: "u64" }),
        ],
        body.userAddress
      );

      return txData;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to build revoke transaction";
      return reply.status(400).send({ error: message });
    }
  });
};
