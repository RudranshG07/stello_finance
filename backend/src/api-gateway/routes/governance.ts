import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  rpc,
  Contract,
  Address,
  Keypair,
  nativeToScVal,
  scValToNative,
  TransactionBuilder,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { config } from "../../config/index.js";
import { PrismaClient } from "@prisma/client";

const createProposalSchema = z.object({
  userAddress: z.string().min(56).max(56),
  paramKey: z.string().min(1),
  newValue: z.string().min(1),
});

const proposalActionSchema = z.object({
  userAddress: z.string().min(56).max(56),
  proposalId: z.number().int().min(0),
});

const voteSchema = z.object({
  userAddress: z.string().min(56).max(56),
  proposalId: z.number().int().min(0),
  support: z.boolean(),
});

const APPROX_LEDGER_CLOSE_MS = 5_000;

type ChainProposalView = {
  proposer?: { toString(): string };
  param_key?: string;
  new_value?: unknown;
  votes_for?: unknown;
  votes_against?: unknown;
  start_ledger?: number;
  end_ledger?: number;
  queued_ledger?: number;
  eta_ledger?: number;
  executed?: boolean;
};

type ApiProposalRecord = {
  id: number;
  proposer: string;
  paramKey: string;
  newValue: string;
  votesFor: string;
  votesAgainst: string;
  status: string;
  executed: boolean;
  startLedger: number;
  endLedger: number;
  queuedLedger: number;
  etaLedger: number;
  expiresAt?: string;
  queuedAt?: string;
  etaAt?: string;
  cancelledAt?: string;
  executedAt?: string;
  cancelledBy?: string;
  canQueue: boolean;
  canExecute: boolean;
};

function getReadOnlyPublicKey(): string {
  if (config.governanceRelayer.secretKey) {
    try {
      return Keypair.fromSecret(config.governanceRelayer.secretKey).publicKey();
    } catch {
      // Fall back to the configured read-only public key below.
    }
  }
  return config.admin.publicKey;
}

function toIsoString(value?: Date | null): string | undefined {
  return value ? value.toISOString() : undefined;
}

function estimateTimestampFromLedger(
  targetLedger: number | null | undefined,
  currentLedger: number
): Date | null {
  if (!targetLedger || targetLedger <= 0) {
    return null;
  }

  const deltaLedgers = targetLedger - currentLedger;
  return new Date(Date.now() + deltaLedgers * APPROX_LEDGER_CLOSE_MS);
}

function parseProposalValue(raw: string): bigint {
  const normalized = raw.trim();
  if (!/^-?\d+$/.test(normalized)) {
    throw new Error("Governance proposal values must be whole numbers");
  }
  return BigInt(normalized);
}

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
    const errStr = String(simResult.error);
    if (errStr.includes("UnreachableCodeReached")) {
      if (method === "vote") {
        throw new Error("You need sXLM to vote. Stake XLM first to receive sXLM, then vote.");
      }
      if (method === "create_proposal") {
        throw new Error("Proposal creation failed. Ensure the action is supported and you hold at least 100 sXLM.");
      }
      if (method === "queue_proposal") {
        throw new Error("Proposal cannot be queued yet. Voting may still be active, quorum may be unmet, or it may already be queued.");
      }
      if (method === "execute_proposal") {
        throw new Error("Proposal cannot be executed yet. It must be queued, not cancelled, and past the timelock delay.");
      }
      if (method === "cancel") {
        throw new Error("Only the configured emergency guardian can cancel a queued proposal.");
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

  const account = await server.getAccount(getReadOnlyPublicKey());
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

function stringifyValue(value: unknown): string {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return String(value ?? "");
}

function formatDbProposal(
  proposal: {
    id: number;
    chainProposalId: number | null;
    proposer: string;
    paramKey: string;
    newValue: string;
    votesFor: bigint;
    votesAgainst: bigint;
    status: string;
    startLedger: number | null;
    endLedger: number | null;
    queuedLedger: number | null;
    etaLedger: number | null;
    expiresAt: Date;
    queuedAt: Date | null;
    etaAt: Date | null;
    cancelledAt: Date | null;
    executedAt: Date | null;
    cancelledBy: string | null;
    canQueue: boolean;
    canExecute: boolean;
  }
): ApiProposalRecord {
  return {
    id: proposal.chainProposalId ?? proposal.id - 1,
    proposer: proposal.proposer,
    paramKey: proposal.paramKey,
    newValue: proposal.newValue,
    votesFor: proposal.votesFor.toString(),
    votesAgainst: proposal.votesAgainst.toString(),
    status: proposal.status,
    executed: proposal.status === "executed" || Boolean(proposal.executedAt),
    startLedger: proposal.startLedger ?? 0,
    endLedger: proposal.endLedger ?? 0,
    queuedLedger: proposal.queuedLedger ?? 0,
    etaLedger: proposal.etaLedger ?? 0,
    expiresAt: proposal.expiresAt.toISOString(),
    queuedAt: toIsoString(proposal.queuedAt),
    etaAt: toIsoString(proposal.etaAt),
    cancelledAt: toIsoString(proposal.cancelledAt),
    executedAt: toIsoString(proposal.executedAt),
    cancelledBy: proposal.cancelledBy ?? undefined,
    canQueue: proposal.canQueue,
    canExecute: proposal.canExecute,
  };
}

function formatChainProposal(
  id: number,
  proposal: ChainProposalView,
  status: string,
  canQueue: boolean,
  canExecute: boolean,
  currentLedger: number
): ApiProposalRecord {
  const queuedLedger = proposal.queued_ledger ?? 0;
  const etaLedger = proposal.eta_ledger ?? 0;
  const queuedAt = estimateTimestampFromLedger(queuedLedger, currentLedger);
  const etaAt = estimateTimestampFromLedger(etaLedger, currentLedger);
  const expiresAt = estimateTimestampFromLedger(proposal.end_ledger ?? 0, currentLedger);

  return {
    id,
    proposer: proposal.proposer?.toString() ?? "",
    paramKey: proposal.param_key ?? "",
    newValue: stringifyValue(proposal.new_value),
    votesFor: stringifyValue(proposal.votes_for ?? 0),
    votesAgainst: stringifyValue(proposal.votes_against ?? 0),
    status,
    executed: Boolean(proposal.executed ?? false),
    startLedger: proposal.start_ledger ?? 0,
    endLedger: proposal.end_ledger ?? 0,
    queuedLedger,
    etaLedger,
    expiresAt: toIsoString(expiresAt),
    queuedAt: toIsoString(queuedAt),
    etaAt: toIsoString(etaAt),
    canQueue,
    canExecute,
  };
}

async function persistProposalSnapshot(
  prisma: PrismaClient,
  proposal: ApiProposalRecord
): Promise<void> {
  const existing = await prisma.governanceProposal.findFirst({
    where: {
      OR: [
        { chainProposalId: proposal.id },
        {
          chainProposalId: null,
          proposer: proposal.proposer,
          paramKey: proposal.paramKey,
          newValue: proposal.newValue,
        },
      ],
    },
    orderBy: { createdAt: "desc" },
  });

  const nextCancelledAt =
    proposal.status === "cancelled"
      ? proposal.cancelledAt
        ? new Date(proposal.cancelledAt)
        : existing?.cancelledAt ?? new Date()
      : existing?.cancelledAt ?? null;
  const nextExecutedAt =
    proposal.status === "executed"
      ? proposal.executedAt
        ? new Date(proposal.executedAt)
        : existing?.executedAt ?? new Date()
      : existing?.executedAt ?? null;

  const data = {
    chainProposalId: proposal.id,
    proposer: proposal.proposer,
    paramKey: proposal.paramKey,
    newValue: proposal.newValue,
    votesFor: BigInt(proposal.votesFor),
    votesAgainst: BigInt(proposal.votesAgainst),
    status: proposal.status,
    startLedger: proposal.startLedger || null,
    endLedger: proposal.endLedger || null,
    queuedLedger: proposal.queuedLedger || null,
    etaLedger: proposal.etaLedger || null,
    canQueue: proposal.canQueue,
    canExecute: proposal.canExecute,
    expiresAt: proposal.expiresAt ? new Date(proposal.expiresAt) : new Date(),
    queuedAt: proposal.queuedAt ? new Date(proposal.queuedAt) : existing?.queuedAt ?? null,
    etaAt: proposal.etaAt ? new Date(proposal.etaAt) : existing?.etaAt ?? null,
    cancelledAt: nextCancelledAt,
    executedAt: nextExecutedAt,
    cancelledBy: proposal.cancelledBy ?? existing?.cancelledBy ?? null,
  };

  if (existing) {
    await prisma.governanceProposal.update({
      where: { id: existing.id },
      data,
    });
    return;
  }

  await prisma.governanceProposal.create({ data });
}

export const governanceRoutes: FastifyPluginAsync<{ prisma: PrismaClient }> = async (
  fastify,
  opts
) => {
  const { prisma } = opts;
  const server = new rpc.Server(config.stellar.rpcUrl);
  const govContractId = config.contracts.governanceContractId;
  const timelockContractId = config.contracts.timelockContractId;

  fastify.post("/governance/create-proposal", async (request, reply) => {
    try {
      const body = createProposalSchema.parse(request.body);
      const numericValue = parseProposalValue(body.newValue);

      const result = await buildContractTx(
        server,
        govContractId,
        "create_proposal",
        [
          new Address(body.userAddress).toScVal(),
          nativeToScVal(body.paramKey, { type: "string" }),
          nativeToScVal(numericValue, { type: "i128" }),
        ],
        body.userAddress
      );

      const votingPeriodLedgers = 17_280;
      await prisma.governanceProposal.create({
        data: {
          proposer: body.userAddress,
          paramKey: body.paramKey,
          newValue: body.newValue,
          status: "active",
          canQueue: false,
          canExecute: false,
          expiresAt: new Date(Date.now() + votingPeriodLedgers * 5 * 1000),
        },
      });

      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Create proposal failed";
      reply.status(400).send({ error: message });
    }
  });

  fastify.post("/governance/vote", async (request, reply) => {
    try {
      const body = voteSchema.parse(request.body);

      const sxlmRaw = await queryContractView(
        server,
        config.contracts.sxlmTokenContractId,
        "balance",
        [new Address(body.userAddress).toScVal()]
      );
      const sxlmBalance = BigInt(sxlmRaw ?? 0);
      if (sxlmBalance <= BigInt(0)) {
        return reply.status(400).send({
          error: "You have no sXLM to vote with. Stake XLM first to receive sXLM, then vote.",
        });
      }

      return await buildContractTx(
        server,
        govContractId,
        "vote",
        [
          new Address(body.userAddress).toScVal(),
          nativeToScVal(BigInt(body.proposalId), { type: "u64" }),
          nativeToScVal(body.support, { type: "bool" }),
        ],
        body.userAddress
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Vote failed";
      reply.status(400).send({ error: message });
    }
  });

  fastify.post("/governance/queue", async (request, reply) => {
    try {
      const body = proposalActionSchema.parse(request.body);
      return await buildContractTx(
        server,
        govContractId,
        "queue_proposal",
        [nativeToScVal(BigInt(body.proposalId), { type: "u64" })],
        body.userAddress
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Queue failed";
      reply.status(400).send({ error: message });
    }
  });

  fastify.post("/governance/cancel", async (request, reply) => {
    try {
      const body = proposalActionSchema.parse(request.body);
      return await buildContractTx(
        server,
        timelockContractId,
        "cancel",
        [
          new Address(body.userAddress).toScVal(),
          nativeToScVal(BigInt(body.proposalId), { type: "u64" }),
        ],
        body.userAddress
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Cancel failed";
      reply.status(400).send({ error: message });
    }
  });

  fastify.post("/governance/execute", async (request, reply) => {
    try {
      const body = proposalActionSchema.parse(request.body);
      return await buildContractTx(
        server,
        govContractId,
        "execute_proposal",
        [nativeToScVal(BigInt(body.proposalId), { type: "u64" })],
        body.userAddress
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Execution failed";
      reply.status(400).send({ error: message });
    }
  });

  fastify.get("/governance/proposals", async () => {
    try {
      const [proposalCount, latestLedger] = await Promise.all([
        queryContractView(server, govContractId, "proposal_count", []),
        server.getLatestLedger(),
      ]);
      const count = Number(proposalCount ?? 0);
      const proposals: ApiProposalRecord[] = [];
      const currentLedger = latestLedger.sequence;

      for (let i = 0; i < Math.min(count, 50); i++) {
        try {
          const [proposal, state, canQueue, canExecute] = await Promise.all([
            queryContractView(server, govContractId, "get_proposal", [
              nativeToScVal(BigInt(i), { type: "u64" }),
            ]),
            queryContractView(server, govContractId, "get_proposal_state", [
              nativeToScVal(BigInt(i), { type: "u64" }),
            ]),
            queryContractView(server, govContractId, "can_queue_proposal", [
              nativeToScVal(BigInt(i), { type: "u64" }),
            ]),
            queryContractView(server, govContractId, "can_execute_proposal", [
              nativeToScVal(BigInt(i), { type: "u64" }),
            ]),
          ]);

          if (!proposal) {
            continue;
          }

          const proposalRecord = formatChainProposal(
            i,
            proposal as ChainProposalView,
            stringifyValue(state || "active"),
            Boolean(canQueue),
            Boolean(canExecute),
            currentLedger
          );

          proposals.push(proposalRecord);
          await persistProposalSnapshot(prisma, proposalRecord);
        } catch {
          // Skip malformed proposal records and continue.
        }
      }

      if (proposals.length === 0) {
        const dbProposals = await prisma.governanceProposal.findMany({
          orderBy: { createdAt: "desc" },
        });
        return {
          proposals: dbProposals.map(formatDbProposal),
          total: dbProposals.length,
          source: "cache",
        };
      }

      return { proposals, total: proposals.length, source: "chain" };
    } catch {
      const dbProposals = await prisma.governanceProposal.findMany({
        orderBy: { createdAt: "desc" },
      });
      return {
        proposals: dbProposals.map(formatDbProposal),
        total: dbProposals.length,
        source: "cache",
      };
    }
  });

  fastify.get("/governance/proposals/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const proposalId = parseInt(id, 10);

    try {
      const [proposal, state, canQueue, canExecute, latestLedger] = await Promise.all([
        queryContractView(server, govContractId, "get_proposal", [
          nativeToScVal(BigInt(proposalId), { type: "u64" }),
        ]),
        queryContractView(server, govContractId, "get_proposal_state", [
          nativeToScVal(BigInt(proposalId), { type: "u64" }),
        ]),
        queryContractView(server, govContractId, "can_queue_proposal", [
          nativeToScVal(BigInt(proposalId), { type: "u64" }),
        ]),
        queryContractView(server, govContractId, "can_execute_proposal", [
          nativeToScVal(BigInt(proposalId), { type: "u64" }),
        ]),
        server.getLatestLedger(),
      ]);

      if (!proposal) {
        return reply.status(404).send({ error: "Proposal not found" });
      }

      const proposalRecord = formatChainProposal(
        proposalId,
        proposal as ChainProposalView,
        stringifyValue(state || "active"),
        Boolean(canQueue),
        Boolean(canExecute),
        latestLedger.sequence
      );
      await persistProposalSnapshot(prisma, proposalRecord);
      return { ...proposalRecord, source: "chain" };
    } catch {
      const dbProposal = await prisma.governanceProposal.findFirst({
        where: {
          OR: [{ chainProposalId: proposalId }, { id: proposalId + 1 }],
        },
      });
      if (!dbProposal) {
        return reply.status(404).send({ error: "Proposal not found" });
      }
      return { ...formatDbProposal(dbProposal), source: "cache" };
    }
  });

  fastify.get("/governance/metadata", async () => {
    try {
      const [guardian, minDelayLedgers] = await Promise.all([
        queryContractView(server, timelockContractId, "guardian", []),
        queryContractView(server, timelockContractId, "min_delay_ledgers", []),
      ]);

      return {
        guardianAddress: stringifyValue(guardian || config.governanceGuardian.address),
        timelockContractId,
        minDelayLedgers: Number(minDelayLedgers ?? 0),
        source: "chain",
      };
    } catch {
      return {
        guardianAddress: config.governanceGuardian.address,
        timelockContractId,
        minDelayLedgers: 0,
        source: "cache",
      };
    }
  });

  fastify.get("/governance/params", async () => {
    const readParam = async (
      contractId: string,
      method: string,
      args: any[],
      fallback: string
    ) => {
      try {
        const value = await queryContractView(server, contractId, method, args);
        return stringifyValue(value ?? fallback);
      } catch {
        return fallback;
      }
    };

    const params = await Promise.all([
      readParam(config.contracts.stakingContractId, "protocol_fee_bps", [], "1000").then(
        (currentValue) => ({
          key: "protocol_fee_bps",
          currentValue,
          description: "Staking protocol fee in basis points (10% = 1000)",
        })
      ),
      readParam(config.contracts.stakingContractId, "get_cooldown_period", [], "17280").then(
        (currentValue) => ({
          key: "cooldown_period",
          currentValue,
          description: "Withdrawal cooldown in ledgers (~24h)",
        })
      ),
      readParam(config.contracts.lendingContractId, "get_collateral_factor", [], "7000").then(
        (currentValue) => ({
          key: "collateral_factor",
          currentValue,
          description: "Lending collateral factor in bps (70%)",
        })
      ),
      readParam(config.contracts.lendingContractId, "get_borrow_rate", [], "400").then(
        (currentValue) => ({
          key: "borrow_rate_bps",
          currentValue,
          description: "Lending borrow rate in basis points (4% = 400)",
        })
      ),
      readParam(
        config.contracts.lendingContractId,
        "get_liquidation_threshold",
        [],
        "8000"
      ).then((currentValue) => ({
        key: "liquidation_threshold",
        currentValue,
        description: "Liquidation threshold in bps (80% = 8000)",
      })),
      readParam(config.contracts.lpPoolContractId, "protocol_fee_bps", [], "5").then(
        (currentValue) => ({
          key: "lp_protocol_fee_bps",
          currentValue,
          description: "LP pool protocol fee in basis points (5 = 0.05% of swap input)",
        })
      ),
    ]);

    return { params };
  });
};
