-- New users get balance 0 (no starting credit)
ALTER TABLE "users" ALTER COLUMN "balance" SET DEFAULT 0;
