import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { UserService } from "../../user-service/index.js";
import { stellarAddressSchema } from "../middleware/validation.js";

export const withdrawalRoutes: FastifyPluginAsync<{ userService: UserService }> = async (
  fastify,
  opts
) => {
  const { userService } = opts;

  /**
   * GET /staking/withdrawals/:wallet
   * Get all withdrawals for a wallet address.
   */
  fastify.get("/staking/withdrawals/:wallet", async (request, reply) => {
    try {
      const params = z.object({ wallet: stellarAddressSchema }).parse(request.params);
      const withdrawals = await userService.getWithdrawalsByWallet(params.wallet);

      return {
        withdrawals: withdrawals.map((w) => ({
          id: String(w.id),
          wallet: w.wallet,
          amount: w.amount.toString(),
          status: w.status,
          unlockTime: w.unlockTime.toISOString(),
          createdAt: w.createdAt.toISOString(),
        })),
        total: withdrawals.length,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to fetch withdrawals";
      reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /staking/withdrawals/mark-claimed
   * Mark a withdrawal as claimed after successful on-chain claim.
   */
  fastify.post("/staking/withdrawals/mark-claimed", async (request, reply) => {
    try {
      const body = z.object({
        wallet: stellarAddressSchema,
        withdrawalId: z.string().min(1, "Withdrawal ID is required"),
      }).parse(request.body);

      await userService.markWithdrawalClaimed(body.wallet, Number(body.withdrawalId));
      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to update withdrawal";
      reply.status(400).send({ error: message });
    }
  });

  /**
   * GET /withdrawals (query param version — backwards compat)
   */
  fastify.get("/withdrawals", async (request, reply) => {
    try {
      const query = z
        .object({ wallet: stellarAddressSchema })
        .parse(request.query);
      const withdrawals = await userService.getWithdrawalsByWallet(query.wallet);

      return {
        withdrawals: withdrawals.map((w) => ({
          id: String(w.id),
          wallet: w.wallet,
          amount: w.amount.toString(),
          status: w.status,
          unlockTime: w.unlockTime.toISOString(),
          createdAt: w.createdAt.toISOString(),
        })),
        total: withdrawals.length,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Invalid query";
      reply.status(400).send({ error: message });
    }
  });
};
