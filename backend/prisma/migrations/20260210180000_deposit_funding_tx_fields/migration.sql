-- AlterTable
ALTER TABLE "deposits" ADD COLUMN "fundingTxId" TEXT,
ADD COLUMN "fundedAt" TIMESTAMP(3);
