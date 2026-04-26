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

const createProposalSchema = z.object({
  userAddress: z.string().min(56).max(56),
  paramKey: z.string().min(1),
  newValue: z.string().min(1),
});

const voteSchema = z.object({
  userAddress: z.string().min(56).max(56),
  proposalId: z.number().int().min(0),
  support: z.boolean(),
});

const executeSchema = z.object({
  userAddress: z.string().min(56).max(56),
  proposalId: z.number().int().min(0),
});

const proposalIdSchema = z.object({
  userAddress: z.string().min(56).max(56),
  proposalId: z.number().int().min(0),
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
    const errStr = String(simResult.error);
    if (errStr.includes("UnreachableCodeReached")) {
      if (method === "vote") {
        throw new Error("You need sXLM to vote. Stake XLM first to receive sXLM, then vote.");
      }
      if (method === "create_proposal") {
        throw new Error("You need at least 100 sXLM to create a proposal. Stake XLM first.");
      }
      if (method === "execute_proposal") {
        throw new Error("Proposal cannot be executed — voting period may not be over, quorum not met, or it already executed.");
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

export const governanceRoutes: FastifyPluginAsync<{ prisma: PrismaClient }> = async (
  fastify,
  opts
) => {
  const { prisma } = opts;
  const server = new rpc.Server(config.stellar.rpcUrl);
  const govContractId = config.contracts.governanceContractId;

  /**
   * POST /governance/create-proposal
   * Build unsigned tx: create a new governance proposal.
   */
  fastify.post("/governance/create-proposal", async (request, reply) => {
    try {
      const body = createProposalSchema.parse(request.body);

      const result = await buildContractTx(
        server,
        govContractId,
        "create_proposal",
        [
          new Address(body.userAddress).toScVal(),
          nativeToScVal(body.paramKey, { type: "string" }),
          nativeToScVal(body.newValue, { type: "string" }),
        ],
        body.userAddress
      );

      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Create proposal failed";
      reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /governance/vote
   * Build unsigned tx: vote on a proposal.
   */
  fastify.post("/governance/vote", async (request, reply) => {
    try {
      const body = voteSchema.parse(request.body);

      // Pre-flight: check user has sXLM to vote with
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

      const result = await buildContractTx(
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

      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Vote failed";
      reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /governance/execute
   * Build unsigned tx: execute a passed proposal (legacy admin bypass, skips timelock).
   */
  fastify.post("/governance/execute", async (request, reply) => {
    try {
      const body = executeSchema.parse(request.body);

      const result = await buildContractTx(
        server,
        govContractId,
        "execute_proposal",
        [nativeToScVal(BigInt(body.proposalId), { type: "u64" })],
        body.userAddress
      );

      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Execution failed";
      reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /governance/queue
   * Queue a passed proposal into the timelock. Anyone can call.
   */
  fastify.post("/governance/queue", async (request, reply) => {
    try {
      const body = proposalIdSchema.parse(request.body);

      const result = await buildContractTx(
        server,
        govContractId,
        "queue_proposal",
        [nativeToScVal(BigInt(body.proposalId), { type: "u64" })],
        body.userAddress
      );

      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Queue failed";
      reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /governance/cancel
   * Cancel a queued proposal. Guardian or admin only (auth enforced on-chain).
   */
  fastify.post("/governance/cancel", async (request, reply) => {
    try {
      const body = proposalIdSchema.parse(request.body);

      const result = await buildContractTx(
        server,
        govContractId,
        "cancel_proposal",
        [nativeToScVal(BigInt(body.proposalId), { type: "u64" })],
        body.userAddress
      );

      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Cancel failed";
      reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /governance/execute-queued
   * Execute a queued proposal after its timelock has elapsed. Anyone can call.
   */
  fastify.post("/governance/execute-queued", async (request, reply) => {
    try {
      const body = proposalIdSchema.parse(request.body);

      const result = await buildContractTx(
        server,
        govContractId,
        "execute_queued",
        [nativeToScVal(BigInt(body.proposalId), { type: "u64" })],
        body.userAddress
      );

      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Execute queued failed";
      reply.status(400).send({ error: message });
    }
  });

  /**
   * GET /governance/proposals
   * Fetch proposals from on-chain + DB.
   */
  fastify.get("/governance/proposals", async () => {
    try {
      const proposalCount = await queryContractView(
        server,
        govContractId,
        "proposal_count",
        []
      );

      const count = Number(proposalCount ?? 0);
      const proposals = [];

      // Fetch each proposal from contract
      for (let i = 0; i < Math.min(count, 50); i++) {
        try {
          const proposal = await queryContractView(
            server,
            govContractId,
            "get_proposal",
            [nativeToScVal(BigInt(i), { type: "u64" })]
          );

          if (proposal) {
            const voteCount = await queryContractView(
              server,
              govContractId,
              "get_vote_count",
              [nativeToScVal(BigInt(i), { type: "u64" })]
            );

            // Determine proposal status
            const endLedger = proposal.end_ledger ?? 0;
            const votesForBig = BigInt(voteCount?.[0] ?? 0);
            const votesAgainstBig = BigInt(voteCount?.[1] ?? 0);
            let status = "active";
            let timelockEta: number | null = null;

            if (proposal.executed) {
              status = "executed";
            } else if (proposal.queued) {
              // Fetch timelock entry for eta
              try {
                const entry = await queryContractView(
                  server,
                  govContractId,
                  "get_timelock_entry",
                  [nativeToScVal(BigInt(i), { type: "u64" })]
                );
                if (entry?.cancelled) {
                  status = "cancelled";
                } else {
                  status = "queued";
                  timelockEta = entry?.eta_ledger ?? null;
                }
              } catch {
                status = "queued";
              }
            } else if (endLedger > 0) {
              const startLedger = proposal.start_ledger ?? 0;
              const votingPeriod = endLedger - startLedger;
              const elapsedMs = Date.now() - (proposal.created_at ? new Date(proposal.created_at).getTime() : Date.now());
              const expectedDurationMs = votingPeriod * 5 * 1000;
              if (elapsedMs > expectedDurationMs) {
                status = votesForBig > votesAgainstBig ? "passed" : "rejected";
              }
            }

            proposals.push({
              id: i,
              proposer: proposal.proposer?.toString() ?? "",
              paramKey: proposal.param_key ?? "",
              newValue: proposal.new_value ?? "",
              votesFor: (voteCount?.[0] ?? 0).toString(),
              votesAgainst: (voteCount?.[1] ?? 0).toString(),
              startLedger: proposal.start_ledger ?? 0,
              endLedger: endLedger,
              executed: proposal.executed ?? false,
              queued: proposal.queued ?? false,
              timelockEta,
              status,
            });

            // Sync to DB
            const existing = await prisma.governanceProposal.findFirst({
              where: {
                proposer: proposal.proposer?.toString() ?? "",
                paramKey: proposal.param_key ?? "",
              },
            });
            if (existing) {
              await prisma.governanceProposal.update({
                where: { id: existing.id },
                data: {
                  votesFor: BigInt(voteCount?.[0] ?? 0),
                  votesAgainst: BigInt(voteCount?.[1] ?? 0),
                  status: proposal.executed ? "executed" : "active",
                },
              });
            }
          }
        } catch {
          // Skip proposal if query fails
        }
      }

      // If no on-chain proposals, return from DB
      if (proposals.length === 0) {
        const dbProposals = await prisma.governanceProposal.findMany({
          orderBy: { createdAt: "desc" },
        });
        return {
          proposals: dbProposals.map((p) => ({
            id: p.id - 1,
            proposer: p.proposer,
            paramKey: p.paramKey,
            newValue: p.newValue,
            votesFor: p.votesFor.toString(),
            votesAgainst: p.votesAgainst.toString(),
            status: p.status,
            expiresAt: p.expiresAt.toISOString(),
          })),
          total: dbProposals.length,
        };
      }

      return { proposals, total: proposals.length };
    } catch {
      // Fallback to DB
      const dbProposals = await prisma.governanceProposal.findMany({
        orderBy: { createdAt: "desc" },
      });
      return {
        proposals: dbProposals.map((p) => ({
          id: p.id - 1,
          proposer: p.proposer,
          paramKey: p.paramKey,
          newValue: p.newValue,
          votesFor: p.votesFor.toString(),
          votesAgainst: p.votesAgainst.toString(),
          status: p.status,
          expiresAt: p.expiresAt.toISOString(),
        })),
        total: dbProposals.length,
      };
    }
  });

  /**
   * GET /governance/proposals/:id
   */
  fastify.get("/governance/proposals/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const proposalId = parseInt(id, 10);

    try {
      const proposal = await queryContractView(
        server,
        govContractId,
        "get_proposal",
        [nativeToScVal(proposalId, { type: "u64" })]
      );

      if (!proposal) {
        return reply.status(404).send({ error: "Proposal not found" });
      }

      const voteCount = await queryContractView(
        server,
        govContractId,
        "get_vote_count",
        [nativeToScVal(proposalId, { type: "u64" })]
      );

      return {
        id: proposalId,
        proposer: proposal.proposer?.toString() ?? "",
        paramKey: proposal.param_key ?? "",
        newValue: proposal.new_value ?? "",
        votesFor: (voteCount?.[0] ?? 0).toString(),
        votesAgainst: (voteCount?.[1] ?? 0).toString(),
        startLedger: proposal.start_ledger ?? 0,
        endLedger: proposal.end_ledger ?? 0,
        executed: proposal.executed ?? false,
        status: proposal.executed ? "executed" : "active",
      };
    } catch {
      // Fallback to DB
      const dbProposal = await prisma.governanceProposal.findFirst({
        where: { id: proposalId + 1 },
      });
      if (!dbProposal) {
        return reply.status(404).send({ error: "Proposal not found" });
      }
      return {
        id: proposalId,
        proposer: dbProposal.proposer,
        paramKey: dbProposal.paramKey,
        newValue: dbProposal.newValue,
        votesFor: dbProposal.votesFor.toString(),
        votesAgainst: dbProposal.votesAgainst.toString(),
        status: dbProposal.status,
        expiresAt: dbProposal.expiresAt.toISOString(),
      };
    }
  });

  /**
   * GET /governance/params
   * Get current governable parameters.
   */
  fastify.get("/governance/params", async () => {
    const paramKeys = [
      { key: "protocol_fee_bps", defaultValue: "1000", description: "Protocol fee in basis points (10% = 1000)" },
      { key: "cooldown_period", defaultValue: "17280", description: "Withdrawal cooldown in ledgers (~24h)" },
      { key: "collateral_factor", defaultValue: "7000", description: "Lending collateral factor in bps (70%)" },
      { key: "borrow_rate_bps", defaultValue: "400", description: "Lending borrow rate in basis points (4% = 400)" },
      { key: "liquidation_threshold", defaultValue: "8000", description: "Liquidation threshold in bps (80% = 8000)" },
      { key: "lp_protocol_fee_bps", defaultValue: "5", description: "LP pool protocol fee in basis points (5 = 0.05% of swap input)" },
      { key: "buffer_safety_factor", defaultValue: "250", description: "Liquidity buffer safety factor (2.5x)" },
    ];

    const params = await Promise.all(
      paramKeys.map(async ({ key, defaultValue, description }) => {
        let currentValue = defaultValue;
        try {
          const onChainValue = await queryContractView(
            server,
            govContractId,
            "get_param",
            [nativeToScVal(key, { type: "string" })]
          );
          if (onChainValue && String(onChainValue) !== "") {
            currentValue = String(onChainValue);
          }
        } catch {
          // Use default if on-chain query fails
        }
        return { key, currentValue, description };
      })
    );

    return { params };
  });
};
