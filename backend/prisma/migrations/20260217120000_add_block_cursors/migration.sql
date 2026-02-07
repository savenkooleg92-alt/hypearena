-- CreateTable
CREATE TABLE "block_cursors" (
    "network" TEXT NOT NULL,
    "lastBlockTimestamp" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "block_cursors_pkey" PRIMARY KEY ("network")
);
