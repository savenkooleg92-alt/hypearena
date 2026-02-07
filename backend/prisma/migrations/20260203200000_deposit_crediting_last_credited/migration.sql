-- Add lastCreditedBalance for deposit detection + crediting (inbound only; sweep is separate iteration)
ALTER TABLE "wallet_addresses" ADD COLUMN IF NOT EXISTS "lastCreditedBalance" DOUBLE PRECISION NOT NULL DEFAULT 0;
