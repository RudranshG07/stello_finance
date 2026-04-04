-- CreateTable
CREATE TABLE "validators" (
    "id" SERIAL NOT NULL,
    "pubkey" TEXT NOT NULL,
    "uptime" DOUBLE PRECISION NOT NULL,
    "commission" DOUBLE PRECISION NOT NULL,
    "votingPower" DOUBLE PRECISION,
    "performanceScore" DOUBLE PRECISION NOT NULL,
    "allocatedStake" BIGINT NOT NULL,
    "lastChecked" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "validators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_snapshots" (
    "id" SERIAL NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalStaked" BIGINT NOT NULL,
    "totalSupply" BIGINT NOT NULL,
    "exchangeRate" DOUBLE PRECISION NOT NULL,
    "apy" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "reward_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawals" (
    "id" SERIAL NOT NULL,
    "wallet" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "unlockTime" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "protocol_metrics" (
    "id" SERIAL NOT NULL,
    "totalStaked" BIGINT NOT NULL,
    "totalSupply" BIGINT NOT NULL,
    "tvlUsd" DOUBLE PRECISION NOT NULL,
    "avgValidatorScore" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "protocol_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "validators_pubkey_key" ON "validators"("pubkey");

-- CreateIndex
CREATE INDEX "withdrawals_wallet_idx" ON "withdrawals"("wallet");

-- CreateIndex
CREATE INDEX "withdrawals_status_idx" ON "withdrawals"("status");
