-- AlterTable: Deposit - add timestamps, retry and ATA fields
ALTER TABLE "deposits" ADD COLUMN "ataAddress" TEXT;
ALTER TABLE "deposits" ADD COLUMN "detectedAt" TIMESTAMP(3);
ALTER TABLE "deposits" ADD COLUMN "confirmedAt" TIMESTAMP(3);
ALTER TABLE "deposits" ADD COLUMN "sweptAt" TIMESTAMP(3);
ALTER TABLE "deposits" ADD COLUMN "creditedAt" TIMESTAMP(3);
ALTER TABLE "deposits" ADD COLUMN "errorCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "deposits" ADD COLUMN "lastError" TEXT;
ALTER TABLE "deposits" ADD COLUMN "nextRetryAt" TIMESTAMP(3);

-- AlterTable: Transaction - add externalId for idempotent credit (unique)
ALTER TABLE "transactions" ADD COLUMN "externalId" TEXT;
CREATE UNIQUE INDEX "transactions_externalId_key" ON "transactions"("externalId");
