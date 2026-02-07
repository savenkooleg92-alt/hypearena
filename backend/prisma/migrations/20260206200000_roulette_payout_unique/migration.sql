-- Hard guard: one payout record per round; UNIQUE on roundId prevents duplicate payouts at DB level
CREATE TABLE IF NOT EXISTS "roulette_payouts" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roulette_payouts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "roulette_payouts_roundId_key" ON "roulette_payouts"("roundId");
