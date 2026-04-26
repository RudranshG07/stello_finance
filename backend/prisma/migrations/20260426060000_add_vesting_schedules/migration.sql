-- CreateTable
CREATE TABLE "vesting_schedules" (
    "id" SERIAL NOT NULL,
    "scheduleId" BIGINT NOT NULL,
    "beneficiary" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "tokenSymbol" TEXT NOT NULL DEFAULT 'sXLM',
    "totalAmount" BIGINT NOT NULL,
    "claimed" BIGINT NOT NULL DEFAULT 0,
    "startLedger" INTEGER NOT NULL,
    "cliffLedger" INTEGER NOT NULL,
    "endLedger" INTEGER NOT NULL,
    "revocable" BOOLEAN NOT NULL DEFAULT false,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "vestedAtRevoke" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vesting_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vesting_schedules_scheduleId_key" ON "vesting_schedules"("scheduleId");

-- CreateIndex
CREATE INDEX "vesting_schedules_beneficiary_idx" ON "vesting_schedules"("beneficiary");

-- CreateIndex
CREATE INDEX "vesting_schedules_tokenAddress_idx" ON "vesting_schedules"("tokenAddress");

-- CreateIndex
CREATE INDEX "vesting_schedules_revoked_idx" ON "vesting_schedules"("revoked");
