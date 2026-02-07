-- CreateTable
CREATE TABLE "deposits" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "walletAddressId" TEXT,
    "depositAddress" TEXT NOT NULL,
    "rawAmount" DOUBLE PRECISION NOT NULL,
    "amountUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "priceUsed" DOUBLE PRECISION,
    "status" TEXT NOT NULL,
    "isBelowMinimum" BOOLEAN NOT NULL DEFAULT false,
    "sweepTxId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deposits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deposits_network_txHash_key" ON "deposits"("network", "txHash");

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_walletAddressId_fkey" FOREIGN KEY ("walletAddressId") REFERENCES "wallet_addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
