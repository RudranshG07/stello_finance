-- Multi-collateral lending migration
-- Replaces the single sxlmDeposited field with a per-asset collateral_deposits
-- table, adds per-asset seizure tracking for liquidations, and introduces
-- on-chain event log tables for collateral deposit / withdrawal actions.

-- ─── collateral_positions ──────────────────────────────────────────────────

-- sxlmDeposited is superseded by the new collateral_deposits table.
ALTER TABLE "collateral_positions" DROP COLUMN "sxlmDeposited";

-- Each wallet now has at most one summary row; enforce that uniqueness.
ALTER TABLE "collateral_positions" ADD CONSTRAINT "collateral_positions_wallet_key" UNIQUE ("wallet");

-- Total cross-asset collateral value expressed in XLM stroops (kept in sync by backend).
ALTER TABLE "collateral_positions" ADD COLUMN "collateralValueXlm" BIGINT NOT NULL DEFAULT 0;

-- Convenience view of max borrowable XLM (in stroops) kept in sync by backend.
ALTER TABLE "collateral_positions" ADD COLUMN "maxBorrow" BIGINT NOT NULL DEFAULT 0;

-- ─── collateral_deposits ───────────────────────────────────────────────────

-- Per-asset collateral balance for a wallet.  Upserted on every
-- deposit_collateral / withdraw_collateral call.
CREATE TABLE "collateral_deposits" (
    "id"        SERIAL       NOT NULL,
    "wallet"    TEXT         NOT NULL,
    "asset"     TEXT         NOT NULL,
    "amount"    BIGINT       NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collateral_deposits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "collateral_deposits_wallet_asset_key"
    ON "collateral_deposits"("wallet", "asset");

CREATE INDEX "collateral_deposits_wallet_idx"
    ON "collateral_deposits"("wallet");

-- ─── liquidation_events ────────────────────────────────────────────────────

-- collateralSeized (a single BigInt) is replaced by the new
-- liquidation_seized_assets relation table.
ALTER TABLE "liquidation_events" DROP COLUMN "collateralSeized";

-- ─── liquidation_seized_assets ─────────────────────────────────────────────

-- One row per collateral asset seized in a liquidation event.
CREATE TABLE "liquidation_seized_assets" (
    "id"                 SERIAL  NOT NULL,
    "liquidationEventId" INTEGER NOT NULL,
    "asset"              TEXT    NOT NULL,
    "amount"             BIGINT  NOT NULL,

    CONSTRAINT "liquidation_seized_assets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "liquidation_seized_assets_liquidationEventId_idx"
    ON "liquidation_seized_assets"("liquidationEventId");

ALTER TABLE "liquidation_seized_assets"
    ADD CONSTRAINT "liquidation_seized_assets_liquidationEventId_fkey"
    FOREIGN KEY ("liquidationEventId")
    REFERENCES "liquidation_events"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── deposit_collateral_events ─────────────────────────────────────────────

-- On-chain event log for deposit_collateral calls; mirrors BorrowEvent style.
CREATE TABLE "deposit_collateral_events" (
    "id"             SERIAL       NOT NULL,
    "txHash"         TEXT         NOT NULL,
    "eventIndex"     INTEGER      NOT NULL,
    "contractId"     TEXT         NOT NULL,
    "ledger"         INTEGER      NOT NULL,
    "ledgerClosedAt" TIMESTAMP(3) NOT NULL,
    "wallet"         TEXT         NOT NULL,
    "asset"          TEXT         NOT NULL,
    "amount"         BIGINT       NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deposit_collateral_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "deposit_collateral_events_txHash_eventIndex_key"
    ON "deposit_collateral_events"("txHash", "eventIndex");

CREATE INDEX "deposit_collateral_events_wallet_idx"
    ON "deposit_collateral_events"("wallet");

CREATE INDEX "deposit_collateral_events_ledger_idx"
    ON "deposit_collateral_events"("ledger");

CREATE INDEX "deposit_collateral_events_contractId_ledger_idx"
    ON "deposit_collateral_events"("contractId", "ledger");

-- ─── withdraw_collateral_events ────────────────────────────────────────────

-- On-chain event log for withdraw_collateral calls.
CREATE TABLE "withdraw_collateral_events" (
    "id"             SERIAL       NOT NULL,
    "txHash"         TEXT         NOT NULL,
    "eventIndex"     INTEGER      NOT NULL,
    "contractId"     TEXT         NOT NULL,
    "ledger"         INTEGER      NOT NULL,
    "ledgerClosedAt" TIMESTAMP(3) NOT NULL,
    "wallet"         TEXT         NOT NULL,
    "asset"          TEXT         NOT NULL,
    "amount"         BIGINT       NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdraw_collateral_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "withdraw_collateral_events_txHash_eventIndex_key"
    ON "withdraw_collateral_events"("txHash", "eventIndex");

CREATE INDEX "withdraw_collateral_events_wallet_idx"
    ON "withdraw_collateral_events"("wallet");

CREATE INDEX "withdraw_collateral_events_ledger_idx"
    ON "withdraw_collateral_events"("ledger");

CREATE INDEX "withdraw_collateral_events_contractId_ledger_idx"
    ON "withdraw_collateral_events"("contractId", "ledger");
