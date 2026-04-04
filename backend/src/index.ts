import { PrismaClient } from "@prisma/client";
import { initEventBus, shutdownEventBus } from "./event-bus/index.js";
import { StakingEngine } from "./staking-engine/index.js";
import { RewardEngine } from "./reward-engine/index.js";
import { RiskEngine } from "./risk-engine/index.js";
import { EventListenerService } from "./event-listener/index.js";
import { HubbleIndexer } from "./hubble-indexer/index.js";
import { UserService } from "./user-service/index.js";
import { MetricsCron } from "./metrics-cron/index.js";
import { MetricAggregator } from "./metric-aggregator/index.js";
import { CohortAggregator } from "./cohort-aggregator/index.js";
import { KeeperBot } from "./keeper/index.js";
import { startApiGateway } from "./api-gateway/server.js";
import { config } from "./config/index.js";

const prisma = new PrismaClient();

async function main() {
  console.log("=== sXLM Protocol Backend ===");
  console.log(`Environment: ${config.server.nodeEnv}`);
  console.log(`Stellar Network: ${config.stellar.networkPassphrase}`);

  // Connect to database
  await prisma.$connect();
  console.log("[DB] Connected to PostgreSQL");

  // Initialize event bus (Redis)
  await initEventBus();
  console.log("[EventBus] Redis connected");

  // Initialize services
  const stakingEngine = new StakingEngine(prisma);
  const rewardEngine = new RewardEngine(prisma);
  const riskEngine = new RiskEngine(prisma);
  const eventListener = new EventListenerService(prisma);
  const hubbleIndexer = new HubbleIndexer(prisma);
  const userService = new UserService(prisma);
  const metricsCron = new MetricsCron(prisma);
  const metricAggregator = new MetricAggregator(prisma);
  const cohortAggregator = new CohortAggregator(prisma);
  const keeperBot = new KeeperBot();

  await stakingEngine.initialize();
  await rewardEngine.initialize();
  await riskEngine.initialize();
  await eventListener.initialize();
  await hubbleIndexer.initialize();
  await userService.initialize();
  await metricsCron.initialize();
  await metricAggregator.initialize();
  await cohortAggregator.initialize();
  await keeperBot.initialize();

  // Start API Gateway
  const server = await startApiGateway({
    prisma,
    stakingEngine,
    rewardEngine,
    userService,
  });

  console.log("=== All services running ===");

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    await server.close();
    await stakingEngine.shutdown();
    await rewardEngine.shutdown();
    await riskEngine.shutdown();
    await eventListener.shutdown();
    await hubbleIndexer.shutdown();
    await userService.shutdown();
    await metricsCron.shutdown();
    await metricAggregator.shutdown();
    await cohortAggregator.shutdown();
    await keeperBot.shutdown();
    await shutdownEventBus();
    await prisma.$disconnect();
    console.log("Goodbye.");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
