import { FastifyPluginAsync } from "fastify";
import { PrismaClient } from "@prisma/client";
import { StakingEngine } from "../../staking-engine/index.js";
import { getEventBus } from "../../event-bus/index.js";

const startedAt = Date.now();

interface ServiceHealth {
  status: "healthy" | "degraded" | "down";
  latencyMs?: number;
  message?: string;
}

interface HealthResponse {
  status: "healthy" | "degraded" | "down";
  version: string;
  uptime: number;
  timestamp: string;
  services: {
    database: ServiceHealth;
    redis: ServiceHealth;
    stellarRpc: ServiceHealth;
  };
  protocol: {
    exchangeRate: number;
    isPaused: boolean;
    totalStakedXlm: number;
    totalSxlmSupply: number;
    liquidityBufferXlm: number;
  };
  validators: {
    total: number;
    avgScore: number;
    avgUptime: number;
  };
  staking: {
    pendingWithdrawals: number;
    snapshotCount: number;
    lastSnapshotAge: number | null;
  };
}

/**
 * Check database connectivity by running a lightweight query.
 */
async function checkDatabase(prisma: PrismaClient): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: "healthy", latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: "down",
      latencyMs: Date.now() - start,
      message: err instanceof Error ? err.message : "Database unreachable",
    };
  }
}

/**
 * Check Redis connectivity via the event bus publisher ping.
 */
async function checkRedis(): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    const bus = getEventBus();
    // Access the publisher's ping via the underlying Redis client
    // The EventBus wraps ioredis, which exposes ping()
    const publisher = (bus as any).publisher;
    if (publisher && typeof publisher.ping === "function") {
      const result = await Promise.race([
        publisher.ping(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Redis ping timeout")), 3000)
        ),
      ]);
      if (result === "PONG") {
        return { status: "healthy", latencyMs: Date.now() - start };
      }
    }
    // If we can't access publisher directly, check isConnected flag
    const isConnected = (bus as any).isConnected;
    if (isConnected) {
      return { status: "healthy", latencyMs: Date.now() - start };
    }
    return { status: "degraded", latencyMs: Date.now() - start, message: "Connection state unknown" };
  } catch (err) {
    return {
      status: "down",
      latencyMs: Date.now() - start,
      message: err instanceof Error ? err.message : "Redis unreachable",
    };
  }
}

/**
 * Check Stellar RPC connectivity by fetching the latest ledger.
 */
async function checkStellarRpc(rpcUrl: string): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getHealth",
        params: {},
      }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await response.json() as { result?: { status: string } };
    if (data.result?.status === "healthy") {
      return { status: "healthy", latencyMs: Date.now() - start };
    }
    return {
      status: "degraded",
      latencyMs: Date.now() - start,
      message: `RPC status: ${data.result?.status ?? "unknown"}`,
    };
  } catch (err) {
    return {
      status: "down",
      latencyMs: Date.now() - start,
      message: err instanceof Error ? err.message : "Stellar RPC unreachable",
    };
  }
}

export const healthRoutes: FastifyPluginAsync<{
  prisma: PrismaClient;
  stakingEngine: StakingEngine;
  rpcUrl: string;
}> = async (fastify, opts) => {
  const { prisma, stakingEngine, rpcUrl } = opts;

  /**
   * GET /health/live
   *
   * Lightweight liveness probe for load balancers and orchestrators.
   * Returns 200 if the process is running — no dependency checks.
   */
  fastify.get("/health/live", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
  }));

  /**
   * GET /health/ready
   *
   * Readiness probe that checks whether core dependencies (DB, Redis)
   * are available. Returns 503 if any critical service is down.
   */
  fastify.get("/health/ready", async (_request, reply) => {
    const [db, redis] = await Promise.all([
      checkDatabase(prisma),
      checkRedis(),
    ]);

    const isReady = db.status !== "down" && redis.status !== "down";

    const response = {
      status: isReady ? "ready" : "not_ready",
      timestamp: new Date().toISOString(),
      services: { database: db.status, redis: redis.status },
    };

    return reply.status(isReady ? 200 : 503).send(response);
  });

  /**
   * GET /health/detailed
   *
   * Comprehensive health dashboard that reports on every subsystem:
   * database, Redis, Stellar RPC, protocol state, validators, and
   * staking metrics. Designed for ops dashboards and monitoring.
   *
   * Returns 200 (healthy), 207 (degraded), or 503 (down) based on
   * the worst service status.
   */
  fastify.get("/health/detailed", async (_request, reply) => {
    // Run all health checks and data queries in parallel
    const [db, redis, stellarRpc, protocolStats, validatorData, stakingData] =
      await Promise.all([
        checkDatabase(prisma),
        checkRedis(),
        checkStellarRpc(rpcUrl),
        getProtocolData(prisma, stakingEngine),
        getValidatorData(prisma),
        getStakingData(prisma),
      ]);

    // Determine overall status from the worst service health
    const serviceStatuses = [db.status, redis.status, stellarRpc.status];
    let overallStatus: "healthy" | "degraded" | "down" = "healthy";
    if (serviceStatuses.includes("down")) {
      overallStatus = "down";
    } else if (serviceStatuses.includes("degraded")) {
      overallStatus = "degraded";
    }

    const statusCodeMap = { healthy: 200, degraded: 207, down: 503 };

    const response: HealthResponse = {
      status: overallStatus,
      version: process.env["npm_package_version"] ?? "0.0.0",
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
      services: {
        database: db,
        redis,
        stellarRpc,
      },
      protocol: protocolStats,
      validators: validatorData,
      staking: stakingData,
    };

    return reply.status(statusCodeMap[overallStatus]).send(response);
  });
};

// ── Data gathering helpers ──────────────────────────────────────────────────

async function getProtocolData(
  prisma: PrismaClient,
  stakingEngine: StakingEngine,
): Promise<HealthResponse["protocol"]> {
  try {
    const stats = await stakingEngine.getProtocolStats();
    return {
      exchangeRate: stats.exchangeRate,
      isPaused: stats.isPaused,
      totalStakedXlm: Number(stats.totalStaked) / 1e7,
      totalSxlmSupply: Number(stats.totalSupply) / 1e7,
      liquidityBufferXlm: Number(stats.liquidityBuffer) / 1e7,
    };
  } catch {
    // Fallback to DB metrics if on-chain query fails
    try {
      const metrics = await prisma.protocolMetrics.findFirst({
        orderBy: { updatedAt: "desc" },
      });
      return {
        exchangeRate: 1,
        isPaused: false,
        totalStakedXlm: metrics ? Number(metrics.totalStaked) / 1e7 : 0,
        totalSxlmSupply: metrics ? Number(metrics.totalSupply) / 1e7 : 0,
        liquidityBufferXlm: 0,
      };
    } catch {
      return {
        exchangeRate: 0,
        isPaused: false,
        totalStakedXlm: 0,
        totalSxlmSupply: 0,
        liquidityBufferXlm: 0,
      };
    }
  }
}

async function getValidatorData(
  prisma: PrismaClient,
): Promise<HealthResponse["validators"]> {
  try {
    const validators = await prisma.validator.findMany({
      select: { performanceScore: true, uptime: true },
    });

    if (validators.length === 0) {
      return { total: 0, avgScore: 0, avgUptime: 0 };
    }

    const avgScore =
      validators.reduce((sum, v) => sum + v.performanceScore, 0) /
      validators.length;
    const avgUptime =
      validators.reduce((sum, v) => sum + v.uptime, 0) / validators.length;

    return {
      total: validators.length,
      avgScore: Math.round(avgScore * 1000) / 1000,
      avgUptime: Math.round(avgUptime * 10000) / 10000,
    };
  } catch {
    return { total: 0, avgScore: 0, avgUptime: 0 };
  }
}

async function getStakingData(
  prisma: PrismaClient,
): Promise<HealthResponse["staking"]> {
  try {
    const [pendingCount, snapshotCount, lastSnapshot] = await Promise.all([
      prisma.withdrawal.count({ where: { status: "pending" } }),
      prisma.rewardSnapshot.count(),
      prisma.rewardSnapshot.findFirst({
        orderBy: { timestamp: "desc" },
        select: { timestamp: true },
      }),
    ]);

    const lastSnapshotAge = lastSnapshot
      ? Math.floor((Date.now() - lastSnapshot.timestamp.getTime()) / 1000)
      : null;

    return {
      pendingWithdrawals: pendingCount,
      snapshotCount,
      lastSnapshotAge,
    };
  } catch {
    return {
      pendingWithdrawals: 0,
      snapshotCount: 0,
      lastSnapshotAge: null,
    };
  }
}
