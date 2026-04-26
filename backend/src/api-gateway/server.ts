import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import helmet from "@fastify/helmet";
import { config } from "../config/index.js";
import { StakingEngine } from "../staking-engine/index.js";
import { RewardEngine } from "../reward-engine/index.js";
import { UserService } from "../user-service/index.js";
import { PrismaClient } from "@prisma/client";
import { registerErrorHandling } from "./middleware/errorHandler.js";
import { healthRoutes } from "./routes/health.js";
import { stakeRoutes } from "./routes/stake.js";
import { unstakeRoutes } from "./routes/unstake.js";
import { submitRoutes } from "./routes/submit.js";
import { statsRoutes } from "./routes/stats.js";
import { apyRoutes } from "./routes/apy.js";
import { withdrawalRoutes } from "./routes/withdrawals.js";
import { authRoutes } from "./routes/auth.js";
import { adminRoutes } from "./routes/admin.js";
import { leverageRoutes } from "./routes/leverage.js";
import { restakingRoutes } from "./routes/restaking.js";
import { lendingRoutes } from "./routes/lending.js";
import { liquidityRoutes } from "./routes/liquidity.js";
import { governanceRoutes } from "./routes/governance.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { vestingRoutes } from "./routes/vesting.js";

export interface GatewayDeps {
  prisma: PrismaClient;
  stakingEngine: StakingEngine;
  rewardEngine: RewardEngine;
  userService: UserService;
}

export async function startApiGateway(deps: GatewayDeps) {
  const fastify = Fastify({
    logger: true,
    // Limit request body size to 1 MB to prevent abuse
    bodyLimit: 1_048_576,
  });

  await fastify.register(cors, { origin: true });
  await fastify.register(helmet, {
    // Content-Security-Policy tailored for a JSON API — no scripts or frames needed
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    // HSTS: force HTTPS for 1 year including subdomains
    hsts: {
      maxAge: 31_536_000,
      includeSubDomains: true,
      preload: true,
    },
  });
  await fastify.register(rateLimit, {
    max: 200,
    timeWindow: "1 minute",
    // Use X-Forwarded-For so Render's proxy doesn't collapse all IPs into one
    keyGenerator: (request) =>
      (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
      request.ip,
  });

  // Decorate request with wallet and requestId fields for auth and tracing
  fastify.decorateRequest("wallet", "");
  fastify.decorateRequest("requestId", "");

  // Register centralized error handling (request IDs, Zod formatting, 404s)
  registerErrorHandling(fastify);

  // Health check — simple endpoint for load balancers (backwards compatible)
  fastify.get("/health", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
  }));

  // Detailed health dashboard routes
  await fastify.register(healthRoutes, {
    prisma: deps.prisma,
    stakingEngine: deps.stakingEngine,
    rpcUrl: config.stellar.rpcUrl,
  });

  // Auth routes (public)
  await fastify.register(authRoutes, { prefix: "/api" });

  // Public read-only routes
  await fastify.register(statsRoutes, {
    prisma: deps.prisma,
    stakingEngine: deps.stakingEngine,
    prefix: "/api",
  });
  await fastify.register(apyRoutes, {
    rewardEngine: deps.rewardEngine,
    stakingEngine: deps.stakingEngine,
    prefix: "/api",
  });

  // Transaction routes (public — wallet signature is the auth)
  await fastify.register(stakeRoutes, {
    stakingEngine: deps.stakingEngine,
    prefix: "/api",
  });
  await fastify.register(unstakeRoutes, {
    stakingEngine: deps.stakingEngine,
    prefix: "/api",
  });
  await fastify.register(submitRoutes, {
    prisma: deps.prisma,
    prefix: "/api",
  });

  // Withdrawal query routes (public — read-only by wallet address)
  await fastify.register(withdrawalRoutes, {
    userService: deps.userService,
    prefix: "/api",
  });

  // Admin routes (protected by X-Admin-Key header)
  await fastify.register(adminRoutes, {
    stakingEngine: deps.stakingEngine,
    prefix: "/api",
  });

  // Milestone 5: Leverage, Restaking, Lending, Liquidity, Governance
  await fastify.register(leverageRoutes, { prefix: "/api" });
  await fastify.register(restakingRoutes, {
    prisma: deps.prisma,
    prefix: "/api",
  });
  await fastify.register(lendingRoutes, {
    prisma: deps.prisma,
    prefix: "/api",
  });
  await fastify.register(liquidityRoutes, {
    prisma: deps.prisma,
    prefix: "/api",
  });
  await fastify.register(governanceRoutes, {
    prisma: deps.prisma,
    prefix: "/api",
  });

  // Public analytics routes (read-only, no auth required)
  await fastify.register(analyticsRoutes, {
    prisma: deps.prisma,
    prefix: "/api",
  });

  // Vesting schedules (read-only public + claim/create/revoke for signed wallets)
  await fastify.register(vestingRoutes, {
    prisma: deps.prisma,
    prefix: "/api",
  });

  await fastify.listen({ port: config.server.port, host: "0.0.0.0" });
  console.log(`[API Gateway] Listening on port ${config.server.port}`);

  return fastify;
}
