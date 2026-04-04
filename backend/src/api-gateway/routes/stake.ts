import { FastifyPluginAsync } from "fastify";
import {
  rpc,
  Contract,
  Address,
  nativeToScVal,
  TransactionBuilder,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { config } from "../../config/index.js";
import { StakingEngine } from "../../staking-engine/index.js";
import { userAmountSchema } from "../middleware/validation.js";

export const stakeRoutes: FastifyPluginAsync<{ stakingEngine: StakingEngine }> = async (
  fastify,
  opts
) => {
  const { stakingEngine } = opts;
  const server = new rpc.Server(config.stellar.rpcUrl);

  /**
   * POST /staking/stake
   * Builds an unsigned deposit transaction for the user to sign with Freighter.
   */
  fastify.post("/staking/stake", async (request, reply) => {
    const body = userAmountSchema.parse(request.body);
    const xlmStroops = BigInt(Math.floor(body.amount * 1e7));

    // Validate bounds
    if (xlmStroops < config.protocol.minStakeAmount) {
      return reply.status(400).send({
        error: `Minimum stake is ${Number(config.protocol.minStakeAmount) / 1e7} XLM`,
      });
    }
    if (xlmStroops > config.protocol.maxStakeAmount) {
      return reply.status(400).send({
        error: `Maximum stake is ${Number(config.protocol.maxStakeAmount) / 1e7} XLM`,
      });
    }

    try {
      // Build unsigned transaction
      const contract = new Contract(config.contracts.stakingContractId);
      const depositOp = contract.call(
        "deposit",
        new Address(body.userAddress).toScVal(),
        nativeToScVal(xlmStroops, { type: "i128" })
      );

      const account = await server.getAccount(body.userAddress);
      const tx = new TransactionBuilder(account, {
        fee: "2000000", // 0.2 XLM — assembleTransaction adds minResourceFee on top
        networkPassphrase: config.stellar.networkPassphrase,
      })
        .addOperation(depositOp)
        .setTimeout(300)
        .build();

      // Simulate to get proper footprint/resources
      const simResult = await server.simulateTransaction(tx);

      if (rpc.Api.isSimulationError(simResult)) {
        return reply.status(400).send({
          error: `Transaction simulation failed: ${simResult.error}`,
        });
      }

      // Assemble the transaction with simulation results
      const preparedTx = rpc.assembleTransaction(tx, simResult).build();

      return {
        xdr: preparedTx.toXDR(),
        networkPassphrase: config.stellar.networkPassphrase,
        estimatedSxlm: (body.amount / (await stakingEngine.getExchangeRate())).toFixed(7),
        exchangeRate: await stakingEngine.getExchangeRate(),
      };
    } catch (err: unknown) {
      // SDK throws plain objects (not Error instances) for some RPC errors
      const rawMsg: string =
        err instanceof Error
          ? err.message
          : (err as { message?: string })?.message ?? "Stake failed";

      // Give a clearer message when the account isn't funded on testnet
      const message = rawMsg.toLowerCase().includes("account not found")
        ? "Your testnet account has no XLM. Please fund it via the Stellar Friendbot (https://friendbot.stellar.org/?addr=YOUR_ADDRESS) before staking."
        : rawMsg;

      reply.status(400).send({ error: message });
    }
  });
};
