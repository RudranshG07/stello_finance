import dotenv from "dotenv";

dotenv.config();

function requireEnv(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function assertProductionConfig(nodeEnv: string, jwtSecret: string, adminSecretKey: string): void {
  if (nodeEnv !== "production") return;

  if (jwtSecret === "sxlm-dev-jwt-secret-change-in-production") {
    throw new Error("Insecure JWT_SECRET detected in production");
  }

  if (!adminSecretKey) {
    throw new Error("Missing ADMIN_SECRET_KEY in production");
  }
}

export const config = {
  stellar: {
    rpcUrl: requireEnv("STELLAR_RPC_URL", "https://mainnet.sorobanrpc.com"),
    networkPassphrase: requireEnv(
      "STELLAR_NETWORK_PASSPHRASE",
      "Public Global Stellar Network ; September 2015"
    ),
    horizonUrl: requireEnv(
      "STELLAR_HORIZON_URL",
      "https://horizon.stellar.org"
    ),
  },

  contracts: {
    sxlmTokenContractId: requireEnv(
      "SXLM_TOKEN_CONTRACT_ID",
      "CCGFHMW3NZD5Z7ATHYHZSEG6ABCJADUHP5HIAWFPR37CP4VGNEDQO7FJ"
    ),
    stakingContractId: requireEnv(
      "STAKING_CONTRACT_ID",
      "CDYXKWVDGEVA6OSIGN7GRAPPRN6AKID35OJL5ZZQIBCMECZ35KGL45PS"
    ),
    lendingContractId: requireEnv(
      "LENDING_CONTRACT_ID",
      "CAOWXZ6BWA2ZYY7GHD75OFKADKUJS4WCKPDYGGXULQWFJRB55TXAQNJG"
    ),
    lpPoolContractId: requireEnv(
      "LP_POOL_CONTRACT_ID",
      "CAW2DRMOI3CCJWKVMEUWYJUEQHXB4S4DR72HNL2DWQCMQQUH3LFFVLHV"
    ),
    governanceContractId: requireEnv(
      "GOVERNANCE_CONTRACT_ID",
      "CB7LV3FBQ7US26GVC7SM7RMX22IEEHAEUL7V3TDDWM32DHA5TDFDDEP4"
    ),
    vestingContractId: requireEnv(
      "VESTING_CONTRACT_ID",
      ""
    ),
    // Additional collateral asset contract IDs (Stellar Soroban SAC addresses)
    usdcContractId: requireEnv(
      "USDC_CONTRACT_ID",
      "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7EJJUD"
    ),
    eurcContractId: requireEnv(
      "EURC_CONTRACT_ID",
      "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP"
    ),
    yxlmContractId: requireEnv(
      "YXLM_CONTRACT_ID",
      "GARDNV3Q7YGT4AKSDF25LT32YSCCW4EV22Y2TV3I2PU2MMXJTEDL5T55"
    ),
  },

  server: {
    port: parseInt(requireEnv("PORT", "3001"), 10),
    host: requireEnv("HOST", "0.0.0.0"),
    nodeEnv: requireEnv("NODE_ENV", "development"),
  },

  database: {
    url: requireEnv(
      "DATABASE_URL",
      "postgresql://sxlm:sxlm_password@localhost:5432/sxlm_protocol"
    ),
  },

  redis: {
    url: requireEnv("REDIS_URL", "redis://localhost:6379"),
  },

  admin: {
    secretKey: requireEnv("ADMIN_SECRET_KEY", ""),
    // Fallback to known active mainnet account used for read-only Soroban simulations
    publicKey: requireEnv("ADMIN_PUBLIC_KEY", "GDWXTIIROGCVBSNQMBJFH6HOWQ4YSRVMKSUS53CH6MP56WSWD6J4VZ5N"),
  },

  jwt: {
    secret: requireEnv("JWT_SECRET", "sxlm-dev-jwt-secret-change-in-production"),
    expiresIn: requireEnv("JWT_EXPIRES_IN", "24h"),
  },

  webhooks: {
    governanceUrl: process.env["GOVERNANCE_WEBHOOK_URL"] ?? "",
    slackUrl: process.env["SLACK_WEBHOOK_URL"] ?? "",
  },

  protocol: {
    unbondingPeriodMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    liquidityBufferPercent: 5, // 5% of TVL — fallback minimum
    liquidityBufferSafetyFactor: 2.5, // α in Required Buffer = D × α
    liquidityBufferLookbackDays: 7, // Days to average withdrawal demand
    minStakeAmount: BigInt(10_000_000), // 1 XLM in stroops
    maxStakeAmount: BigInt(100_000_000_000_000), // 10M XLM in stroops
    rebalanceThreshold: 0.1, // 10% deviation triggers rebalance
    validatorMinUptime: 0.95, // 95%
    exchangeRateRefreshIntervalMs: 60_000, // 1 minute
    rewardSnapshotIntervalMs: 5 * 60_000, // 5 minutes
    withdrawalPollIntervalMs: 30_000, // 30 seconds
  },
} as const;

assertProductionConfig(config.server.nodeEnv, config.jwt.secret, config.admin.secretKey);

export type Config = typeof config;
