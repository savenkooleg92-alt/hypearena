-- CreateTable
CREATE TABLE "roulette_rounds" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "seedHash" TEXT,
    "serverSeed" TEXT,
    "clientSeed" TEXT NOT NULL DEFAULT 'public',
    "nonce" INTEGER NOT NULL DEFAULT 0,
    "totalTickets" INTEGER NOT NULL DEFAULT 0,
    "potCents" INTEGER NOT NULL DEFAULT 0,
    "feeCents" INTEGER NOT NULL DEFAULT 0,
    "winnerUserId" TEXT,
    "winningTicket" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roulette_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roulette_bets" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "ticketsFrom" INTEGER NOT NULL,
    "ticketsTo" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roulette_bets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "roulette_bets_roundId_userId_idx" ON "roulette_bets"("roundId", "userId");

-- AddForeignKey
ALTER TABLE "roulette_bets" ADD CONSTRAINT "roulette_bets_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "roulette_rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roulette_bets" ADD CONSTRAINT "roulette_bets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
