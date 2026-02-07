-- AlterTable
ALTER TABLE "wallet_addresses" ADD COLUMN     "derivationIndex" INTEGER;

-- CreateTable
CREATE TABLE "network_counters" (
    "network" TEXT NOT NULL,
    "nextIndex" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "network_counters_pkey" PRIMARY KEY ("network")
);
