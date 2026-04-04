import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { LeverageEngine } from "../../leverage-engine/index.js";

const simulateSchema = z.object({
  principal: z.number().positive(),
  loops: z.number().int().min(1).max(20),
  collateralFactor: z.number().min(0.1).max(0.95),
  stakingAPR: z.number().min(0).max(1),
  borrowAPR: z.number().min(0).max(1),
});

export const leverageRoutes: FastifyPluginAsync = async (fastify) => {
  const engine = new LeverageEngine();

  /**
   * POST /leverage/simulate
   * Simulate leveraged staking with given parameters.
   */
  fastify.post("/leverage/simulate", async (request, reply) => {
    try {
      const body = simulateSchema.parse(request.body);
      const result = engine.simulate(body);
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Simulation failed";
      reply.status(400).send({ error: message });
    }
  });

  /**
   * GET /leverage/optimal
   * Get optimal leverage for current rates.
   */
  fastify.get("/leverage/optimal", async () => {
    const result = engine.optimal();
    return result;
  });
};
