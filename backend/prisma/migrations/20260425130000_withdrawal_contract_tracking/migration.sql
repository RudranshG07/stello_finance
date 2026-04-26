ALTER TABLE "withdrawals"
ADD COLUMN "unlockLedger" INTEGER,
ADD COLUMN "contractWithdrawalId" BIGINT;

CREATE UNIQUE INDEX "withdrawals_contractWithdrawalId_key"
ON "withdrawals"("contractWithdrawalId");

CREATE INDEX "withdrawals_wallet_contractWithdrawalId_idx"
ON "withdrawals"("wallet", "contractWithdrawalId");
