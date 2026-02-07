-- Add paidAt to roulette_rounds: set when payout is applied; guard against double payout
ALTER TABLE "roulette_rounds" ADD COLUMN IF NOT EXISTS "paidAt" TIMESTAMP(3);
