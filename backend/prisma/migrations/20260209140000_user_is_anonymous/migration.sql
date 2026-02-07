-- Add isAnonymous for "Hide my nickname" (show "Anonymous" in public).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "isAnonymous" BOOLEAN NOT NULL DEFAULT false;
