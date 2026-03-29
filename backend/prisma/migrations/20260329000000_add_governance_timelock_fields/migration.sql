ALTER TABLE "governance_proposals"
ADD COLUMN "queuedAt" TIMESTAMP(3),
ADD COLUMN "etaAt" TIMESTAMP(3),
ADD COLUMN "cancelledAt" TIMESTAMP(3),
ADD COLUMN "executedAt" TIMESTAMP(3),
ADD COLUMN "cancelledBy" TEXT;
