-- AlterTable: rename sxlmDeposited -> amountDeposited and add collateralAsset column
ALTER TABLE "collateral_positions" RENAME COLUMN "sxlmDeposited" TO "amountDeposited";

ALTER TABLE "collateral_positions" ADD COLUMN "collateralAsset" TEXT NOT NULL DEFAULT 'sXLM';

-- CreateIndex: unique constraint on (wallet, collateralAsset)
CREATE UNIQUE INDEX "collateral_positions_wallet_collateralAsset_key" ON "collateral_positions"("wallet", "collateralAsset");
