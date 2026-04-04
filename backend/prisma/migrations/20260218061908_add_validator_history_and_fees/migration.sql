-- AlterTable
ALTER TABLE "protocol_metrics" ADD COLUMN     "protocolFees" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "validator_history" (
    "id" SERIAL NOT NULL,
    "validatorId" INTEGER NOT NULL,
    "uptime" DOUBLE PRECISION NOT NULL,
    "commission" DOUBLE PRECISION NOT NULL,
    "performanceScore" DOUBLE PRECISION NOT NULL,
    "allocatedStake" BIGINT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "validator_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "validator_history_validatorId_timestamp_idx" ON "validator_history"("validatorId", "timestamp");

-- AddForeignKey
ALTER TABLE "validator_history" ADD CONSTRAINT "validator_history_validatorId_fkey" FOREIGN KEY ("validatorId") REFERENCES "validators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
