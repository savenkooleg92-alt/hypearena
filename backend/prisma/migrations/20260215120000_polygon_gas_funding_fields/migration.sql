-- AlterTable: Polygon gas funding idempotency (cooldown)
ALTER TABLE "wallet_addresses" ADD COLUMN "gasFundingTxId" TEXT;
ALTER TABLE "wallet_addresses" ADD COLUMN "gasFundedAt" TIMESTAMP(3);
