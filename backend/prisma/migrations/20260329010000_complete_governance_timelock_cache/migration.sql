ALTER TABLE "governance_proposals"
ADD COLUMN "chainProposalId" INTEGER,
ADD COLUMN "startLedger" INTEGER,
ADD COLUMN "endLedger" INTEGER,
ADD COLUMN "queuedLedger" INTEGER,
ADD COLUMN "etaLedger" INTEGER,
ADD COLUMN "canQueue" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "canExecute" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "governance_proposals_chainProposalId_key"
ON "governance_proposals"("chainProposalId");
