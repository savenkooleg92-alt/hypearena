-- AlterTable: add oracle/cybersport fields to markets
ALTER TABLE "markets" ADD COLUMN IF NOT EXISTS "startsAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "oracleSource" TEXT,
ADD COLUMN IF NOT EXISTS "oracleMatchId" TEXT,
ADD COLUMN IF NOT EXISTS "marketType" TEXT,
ADD COLUMN IF NOT EXISTS "line" DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS "subCategory" TEXT;

-- Unique: one market per (oracleSource, oracleMatchId, marketType). NULLs are distinct in PostgreSQL.
CREATE UNIQUE INDEX IF NOT EXISTS "markets_oracleSource_oracleMatchId_marketType_key"
ON "markets" ("oracleSource", "oracleMatchId", "marketType");
