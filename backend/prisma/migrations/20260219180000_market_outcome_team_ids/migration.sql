-- AlterTable
ALTER TABLE "markets" ADD COLUMN IF NOT EXISTS "outcomeTeamIds" JSONB;
