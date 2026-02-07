-- CreateTable
CREATE TABLE "wallet_addresses" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_addresses_userId_network_key" ON "wallet_addresses"("userId", "network");

-- AddForeignKey
ALTER TABLE "wallet_addresses" ADD CONSTRAINT "wallet_addresses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Drop unique index on walletAddress before dropping column (if exists)
DROP INDEX IF EXISTS "users_walletAddress_key";

-- AlterTable: remove legacy wallet columns from users
ALTER TABLE "users" DROP COLUMN IF EXISTS "walletAddress";
ALTER TABLE "users" DROP COLUMN IF EXISTS "privateKey";
