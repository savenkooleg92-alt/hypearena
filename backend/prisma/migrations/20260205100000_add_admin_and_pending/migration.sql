-- AlterTable User: add isAdmin
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "isAdmin" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable MarketStatus: add PENDING (PostgreSQL: add new enum value)
ALTER TYPE "MarketStatus" ADD VALUE 'PENDING';

-- Ensure default for new markets stays OPEN; user-created will set PENDING in app code.
-- (No change to column default needed.)
