-- CreateTable
CREATE TABLE "polygon_tx_submissions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creditedAt" TIMESTAMP(3),
    "amountUsd" DOUBLE PRECISION,
    "depositAddress" TEXT,
    "adminNote" TEXT,

    CONSTRAINT "polygon_tx_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "polygon_tx_submissions_txHash_key" ON "polygon_tx_submissions"("txHash");

-- AddForeignKey
ALTER TABLE "polygon_tx_submissions" ADD CONSTRAINT "polygon_tx_submissions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
