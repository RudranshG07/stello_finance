-- CreateTable
CREATE TABLE "collateral_positions" (
    "id" SERIAL NOT NULL,
    "wallet" TEXT NOT NULL,
    "sxlmDeposited" BIGINT NOT NULL,
    "xlmBorrowed" BIGINT NOT NULL,
    "healthFactor" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collateral_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lp_positions" (
    "id" SERIAL NOT NULL,
    "wallet" TEXT NOT NULL,
    "lpTokens" BIGINT NOT NULL,
    "xlmDeposited" BIGINT NOT NULL,
    "sxlmDeposited" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lp_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "governance_proposals" (
    "id" SERIAL NOT NULL,
    "proposer" TEXT NOT NULL,
    "paramKey" TEXT NOT NULL,
    "newValue" TEXT NOT NULL,
    "votesFor" BIGINT NOT NULL DEFAULT 0,
    "votesAgainst" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "governance_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "liquidation_events" (
    "id" SERIAL NOT NULL,
    "liquidator" TEXT NOT NULL,
    "borrower" TEXT NOT NULL,
    "debtRepaid" BIGINT NOT NULL,
    "collateralSeized" BIGINT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "liquidation_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "collateral_positions_wallet_idx" ON "collateral_positions"("wallet");

-- CreateIndex
CREATE INDEX "lp_positions_wallet_idx" ON "lp_positions"("wallet");

-- CreateIndex
CREATE INDEX "liquidation_events_borrower_idx" ON "liquidation_events"("borrower");

-- CreateIndex
CREATE INDEX "liquidation_events_liquidator_idx" ON "liquidation_events"("liquidator");
