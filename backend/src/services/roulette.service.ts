/**
 * Roulette (CSGO Lounge style): credits-based, 2-min rounds, tickets = cents, provably fair.
 * Balance in DB is Float; we use cents (Int) for all roulette math.
 */

import crypto from 'crypto';
import prisma from '../utils/prisma';

const ROUND_DURATION_MS = 2 * 60 * 1000;
const MIN_BET_CENTS = 10; // $0.10
const FEE_RATE = 0.05;
const WINNER_PROB_FEE_WAIVE = 0.95;

function centsFromBalance(balance: number): number {
  return Math.round(balance * 100);
}

/** Convert cents to dollars for DB balance (User.balance is in dollars). */
function balanceFromCents(cents: number): number {
  return Math.round(cents) / 100;
}

const ROUND_INCLUDE = {
  bets: {
    include: { user: { select: { id: true, username: true, isAnonymous: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
};

/** Get a round by id with bets and user (for returning after resolve). */
export async function getRoundById(roundId: string) {
  return prisma.rouletteRound.findUnique({
    where: { id: roundId },
    include: ROUND_INCLUDE,
  });
}

/** Get or create the single OPEN round. */
export async function getOrCreateCurrentRound() {
  let round = await prisma.rouletteRound.findFirst({
    where: { status: 'OPEN' },
    include: ROUND_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
  if (round) return round;

  const serverSeed = crypto.randomBytes(32).toString('hex');
  const seedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
  const [lastRound, maxRound] = await Promise.all([
    prisma.rouletteRound.findFirst({ where: {}, orderBy: { nonce: 'desc' }, select: { nonce: true } }),
    prisma.rouletteRound.aggregate({ _max: { roundNumber: true } }),
  ]);
  const nonce = (lastRound?.nonce ?? 0) + 1;
  const roundNumber = (maxRound._max.roundNumber ?? 0) + 1;

  round = await prisma.rouletteRound.create({
    data: {
      roundNumber,
      status: 'OPEN',
      seedHash,
      serverSeed,
      clientSeed: 'public',
      nonce,
    },
    include: ROUND_INCLUDE,
  });
  return round;
}

export type PlaceBetResult =
  | { ok: true; round: Awaited<ReturnType<typeof getOrCreateCurrentRound>> }
  | { ok: false; error: string };

/** Place a bet: deduct balance, add bet with ticket range, update round. Amount in dollars (converted to cents). */
export async function placeBet(
  userId: string,
  amountDollars: number
): Promise<PlaceBetResult> {
  const amountCents = Math.round(amountDollars * 100);
  if (amountCents < MIN_BET_CENTS) {
    return { ok: false, error: `Minimum bet is $${(MIN_BET_CENTS / 100).toFixed(2)}` };
  }

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) return { ok: false, error: 'User not found' };
    const balanceCents = centsFromBalance(user.balance);
    if (balanceCents < amountCents) return { ok: false, error: 'Insufficient balance' };

    let round = await tx.rouletteRound.findFirst({
      where: { status: 'OPEN' },
      orderBy: { createdAt: 'desc' },
    });
    if (!round) {
      const serverSeed = crypto.randomBytes(32).toString('hex');
      const seedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
      const [lastRound, maxRound] = await Promise.all([
        tx.rouletteRound.findFirst({ where: {}, orderBy: { nonce: 'desc' }, select: { nonce: true } }),
        tx.rouletteRound.aggregate({ _max: { roundNumber: true } }),
      ]);
      const roundNumber = (maxRound._max.roundNumber ?? 0) + 1;
      round = await tx.rouletteRound.create({
        data: {
          roundNumber,
          status: 'OPEN',
          seedHash,
          serverSeed,
          clientSeed: 'public',
          nonce: (lastRound?.nonce ?? 0) + 1,
        },
      });
    }

    const isFirstBet = round.totalTickets === 0;
    if (isFirstBet) {
      const now = new Date();
      await tx.rouletteRound.update({
        where: { id: round.id },
        data: {
          startsAt: now,
          endsAt: new Date(now.getTime() + ROUND_DURATION_MS),
        },
      });
      round = await tx.rouletteRound.findUniqueOrThrow({ where: { id: round.id } });
    }

    const now = new Date();
    if (round.endsAt && now >= round.endsAt) {
      return { ok: false, error: 'Round has ended' };
    }

    // Lock round row so concurrent bets get correct sequential ticket ranges (all tickets 1..totalTickets participate)
    await tx.$executeRawUnsafe(
      'SELECT id FROM roulette_rounds WHERE id = $1 FOR UPDATE',
      round.id
    );
    const lockedRound = await tx.rouletteRound.findUniqueOrThrow({
      where: { id: round.id },
      select: { totalTickets: true, potCents: true },
    });

    const ticketsFrom = lockedRound.totalTickets + 1;
    const ticketsTo = lockedRound.totalTickets + amountCents;

    await tx.user.update({
      where: { id: userId },
      data: { balance: { decrement: amountDollars } },
    });
    await tx.rouletteBet.create({
      data: {
        roundId: round.id,
        userId,
        amountCents,
        ticketsFrom,
        ticketsTo,
      },
    });
    await tx.rouletteRound.update({
      where: { id: round.id },
      data: {
        totalTickets: ticketsTo,
        potCents: lockedRound.potCents + amountCents,
      },
    });
    await tx.transaction.create({
      data: {
        userId,
        type: 'BET_PLACED',
        amount: -amountDollars,
        description: JSON.stringify({ source: 'roulette', roundId: round.id }),
      },
    });

    const updated = await getOrCreateCurrentRound();
    return { ok: true, round: updated };
  });
}

/** Deterministic roll: winningTicket in [1, totalTickets]. */
function rollWinner(serverSeed: string, clientSeed: string, nonce: number, totalTickets: number): number {
  const str = `${serverSeed}:${clientSeed}:${nonce}`;
  const hash = crypto.createHash('sha256').update(str).digest('hex');
  const hex = hash.slice(0, 16);
  const big = BigInt('0x' + hex);
  return Number(big % BigInt(totalTickets)) + 1;
}

/**
 * Resolve one round: strictly idempotent and atomic.
 * - Single DB transaction.
 * - First step: updateMany(where: { id, status: 'OPEN' }, data: { status: 'RESOLVING' }).
 *   Proceed ONLY if updatedCount === 1; if 0, another resolver already handled it.
 * - Hard guard: RoulettePayout has roundId UNIQUE; insert before paying. Second payout attempt fails at DB level.
 * - paidAt on round is a second guard; we set it when paying.
 * - Payout amount: always cents/100 → dollars (User.balance is dollars).
 */
export async function resolveRound(roundId: string): Promise<{ ok: boolean; error?: string; winningTicket?: number; totalTickets?: number }> {
  try {
    const before = await prisma.rouletteRound.findUnique({ where: { id: roundId }, select: { status: true } });
    console.log('[round-resolve] start roundId=', roundId, 'status=', before?.status ?? 'not_found');

    let resolvedWinningTicket: number | undefined;
    let resolvedTotalTickets: number | undefined;

    await prisma.$transaction(async (tx) => {
      // 1. Atomic claim: only one resolver can transition OPEN -> RESOLVING
      const claim = await tx.rouletteRound.updateMany({
        where: { id: roundId, status: 'OPEN' },
        data: { status: 'RESOLVING' },
      });
      if (claim.count !== 1) {
        // 0 = already resolved/cancelled or another resolver claimed; >1 impossible for one id
        return;
      }

      // 2. Load round with bets (we hold the row for this transaction)
      const round = await tx.rouletteRound.findUniqueOrThrow({
        where: { id: roundId },
        include: { bets: { include: { user: true } } },
      });

      if (round.totalTickets === 0) {
        await tx.rouletteRound.update({
          where: { id: roundId },
          data: { status: 'CANCELLED' },
        });
        return;
      }

      const winningTicket = rollWinner(
        round.serverSeed!,
        round.clientSeed,
        round.nonce,
        round.totalTickets
      );
      const winnerBet = round.bets.find((b) => winningTicket >= b.ticketsFrom && winningTicket <= b.ticketsTo);
      const winnerUserId = winnerBet?.userId ?? null;

      let feeCents = Math.floor(round.potCents * FEE_RATE);
      if (winnerBet) {
        const winnerTickets = winnerBet.ticketsTo - winnerBet.ticketsFrom + 1;
        const winnerProb = winnerTickets / round.totalTickets;
        if (winnerProb >= WINNER_PROB_FEE_WAIVE) feeCents = 0;
      }
      const payoutCents = round.potCents - feeCents;
      // User.balance is in DOLLARS. Single player $10 bet → potCents 1000, fee waived → payout 1000 cents = $10 (balance restored)
      const payoutDollars = Math.round(payoutCents) / 100;

      // 3. Hard guard: unique payout record per round; insert fails if round already paid
      try {
        await tx.roulettePayout.create({ data: { roundId } });
      } catch (e: unknown) {
        const err = e as { code?: string };
        if (err.code === 'P2002') return; // unique violation = already paid
        throw e;
      }

      // 4. paidAt guard (second layer)
      const paidClaim = await tx.rouletteRound.updateMany({
        where: { id: roundId, paidAt: null },
        data: { paidAt: new Date() },
      });
      if (paidClaim.count !== 1) return;

      if (winnerUserId) {
        await tx.user.update({
          where: { id: winnerUserId },
          data: { balance: { increment: payoutDollars } },
        });
        await tx.transaction.create({
          data: {
            userId: winnerUserId,
            type: 'BET_WON',
            amount: payoutDollars,
            description: JSON.stringify({ source: 'roulette', roundId, winningTicket }),
          },
        });
      }
      if (feeCents > 0) {
        await tx.adminProfit.create({
          data: { marketId: 'roulette', amount: feeCents / 100 },
        });
      }
      resolvedWinningTicket = winningTicket;
      resolvedTotalTickets = round.totalTickets;

      await tx.rouletteRound.update({
        where: { id: roundId },
        data: {
          status: 'FINISHED',
          winnerUserId,
          winningTicket,
          feeCents,
        },
      });
    });

    if (resolvedWinningTicket != null && resolvedTotalTickets != null) {
      console.log('[round-resolve] finished roundId=', roundId, 'winningTicket=', resolvedWinningTicket, 'totalTickets=', resolvedTotalTickets);
    }
    return { ok: true, winningTicket: resolvedWinningTicket, totalTickets: resolvedTotalTickets };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Find all OPEN rounds where endsAt <= now and resolve them. Idempotent: already FINISHED/RESOLVING rounds are not selected. */
export async function resolveDueRounds(): Promise<{ resolved: number; errors: string[] }> {
  const now = new Date();
  const due = await prisma.rouletteRound.findMany({
    where: { status: 'OPEN', endsAt: { lte: now } },
    select: { id: true },
  });
  const dueIds = due.map((r) => r.id);
  if (dueIds.length > 0) {
    console.log(`[roulette] resolveDueRounds: found ${dueIds.length} due round(s): ${dueIds.join(', ')}`);
  }
  const errors: string[] = [];
  let resolved = 0;
  for (const r of due) {
    try {
      const result = await resolveRound(r.id);
      if (result.ok) {
        resolved++;
      } else if (result.error) {
        errors.push(`${r.id}: ${result.error}`);
        console.warn(`[roulette] resolve round ${r.id} failed:`, result.error);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${r.id}: ${msg}`);
      console.error(`[roulette] resolve round ${r.id} threw:`, e);
    }
  }
  if (dueIds.length > 0) {
    console.log(`[roulette] resolveDueRounds: resolved ${resolved}/${dueIds.length}`);
  }
  return { resolved, errors };
}

export async function getHistory(limit: number) {
  return prisma.rouletteRound.findMany({
    where: { status: 'FINISHED' },
    include: {
      bets: { include: { user: { select: { id: true, username: true, isAnonymous: true } } } },
    },
    orderBy: { roundNumber: 'desc' },
    take: limit,
  });
}

export async function getRouletteStats(): Promise<{
  totalVolumeCents: number;
  totalFeesCents: number;
  feesWaivedCount: number;
}> {
  const rounds = await prisma.rouletteRound.findMany({
    where: { status: 'FINISHED' },
    select: { potCents: true, feeCents: true },
  });
  let totalVolumeCents = 0;
  let totalFeesCents = 0;
  let feesWaivedCount = 0;
  for (const r of rounds) {
    totalVolumeCents += r.potCents;
    totalFeesCents += r.feeCents;
    if (r.feeCents === 0) feesWaivedCount++;
  }
  return { totalVolumeCents, totalFeesCents, feesWaivedCount };
}

export { MIN_BET_CENTS, ROUND_DURATION_MS };
