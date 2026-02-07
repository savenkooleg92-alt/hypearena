-- Add user-facing sequential round number (display as #1, #2, ...)
ALTER TABLE "roulette_rounds" ADD COLUMN IF NOT EXISTS "roundNumber" INTEGER NOT NULL DEFAULT 0;

-- Backfill existing rows by creation order
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt") AS rn
  FROM "roulette_rounds"
)
UPDATE "roulette_rounds" r
SET "roundNumber" = numbered.rn
FROM numbered
WHERE r.id = numbered.id;
