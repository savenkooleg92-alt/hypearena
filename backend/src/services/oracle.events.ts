/**
 * Events oracle: discovery (upcoming cultural/entertainment events → create markets) and resolution.
 * For halftime performers, award winners, public announcements. Trusted feeds or manual admin creation.
 */

import prisma from '../utils/prisma';
import {
  fetchUpcomingCulturalEvents,
  fetchCulturalEventResult,
} from './events.data';

const ORACLE_SOURCE = 'events';
const CATEGORY = 'events';
const PLATFORM_FEE = 0.015;
const MAX_NEW_EVENTS_PER_RUN = 10;
const RESOLUTION_EVENTS_PER_RUN = 6;

function getOracleCreatorId(): string {
  const id = process.env.ORACLE_CREATOR_USER_ID;
  if (!id) throw new Error('ORACLE_CREATOR_USER_ID is not set');
  return id;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function createMarketIfNotExists(data: {
  creatorId: string;
  oracleMatchId: string;
  marketType: string;
  subCategory: string;
  title: string;
  outcomes: string[];
  line: number | null;
  startsAt: Date;
  endDate: Date | null;
}): Promise<'created' | 'skipped'> {
  const existing = await prisma.market.findUnique({
    where: {
      oracleSource_oracleMatchId_marketType: {
        oracleSource: ORACLE_SOURCE,
        oracleMatchId: data.oracleMatchId,
        marketType: data.marketType,
      },
    },
  });
  if (existing) return 'skipped';
  await prisma.market.create({
    data: {
      title: data.title,
      description: null,
      category: CATEGORY,
      creatorId: data.creatorId,
      outcomes: data.outcomes,
      status: 'OPEN',
      oracleSource: ORACLE_SOURCE,
      oracleMatchId: data.oracleMatchId,
      marketType: data.marketType,
      line: data.line,
      subCategory: data.subCategory,
      startsAt: data.startsAt,
      endDate: data.endDate,
    },
  });
  return 'created';
}

async function resolveMarketById(marketId: string, winningOutcome: string): Promise<void> {
  const market = await prisma.market.findUnique({
    where: { id: marketId },
    include: { bets: true },
  });
  if (!market || market.status !== 'OPEN') return;
  if (!market.outcomes.includes(winningOutcome)) return;

  const totalPool = market.bets.reduce((sum, b) => sum + b.amount, 0);
  const commission = round2(totalPool * PLATFORM_FEE);
  const payoutPool = totalPool - commission;
  const winningBets = market.bets.filter((b) => b.outcome === winningOutcome);
  const totalWinningStake = winningBets.reduce((sum, b) => sum + b.amount, 0);

  await prisma.$transaction(async (tx) => {
    await tx.market.update({
      where: { id: market.id },
      data: { status: 'RESOLVED', winningOutcome, resolvedAt: new Date() },
    });
    if (totalPool > 0) {
      await tx.adminProfit.create({ data: { marketId: market.id, amount: commission } });
    }
    if (totalWinningStake > 0) {
      for (const bet of winningBets) {
        const payout = round2((payoutPool * bet.amount) / totalWinningStake);
        await tx.bet.update({ where: { id: bet.id }, data: { payout, isWinning: true } });
        await tx.user.update({ where: { id: bet.userId }, data: { balance: { increment: payout } } });
        await tx.transaction.create({
          data: {
            userId: bet.userId,
            type: 'BET_WON',
            amount: payout,
            description: JSON.stringify({ marketId: market.id, betId: bet.id, source: 'oracle_events' }),
            marketId: market.id,
            betId: bet.id,
          },
        });
      }
    }
    const losingBets = market.bets.filter((b) => b.outcome !== winningOutcome);
    if (losingBets.length > 0) {
      await tx.bet.updateMany({
        where: { id: { in: losingBets.map((b) => b.id) } },
        data: { isWinning: false, payout: 0 },
      });
    }
  });
}

export async function runDiscovery(): Promise<{
  created: number;
  skipped: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let created = 0;
  let skipped = 0;
  const creatorId = getOracleCreatorId();

  console.log('[oracle/events] discovery tick started');

  let events;
  try {
    events = await fetchUpcomingCulturalEvents();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(msg);
    return { created: 0, skipped: 0, errors };
  }

  const toCreate = events.slice(0, MAX_NEW_EVENTS_PER_RUN);
  for (const ev of toCreate) {
    if (ev.outcomes.length < 2) continue;
    try {
      const result = await createMarketIfNotExists({
        creatorId,
        oracleMatchId: ev.id,
        marketType: 'event_outcome',
        subCategory: ev.eventType,
        title: `${ev.title} — Outcome`,
        outcomes: ev.outcomes,
        line: null,
        startsAt: ev.startsAt,
        endDate: ev.resolveBy,
      });
      if (result === 'created') created++;
      else skipped++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Unique constraint') || msg.includes('unique')) skipped++;
      else errors.push(`create ${ev.id}: ${msg}`);
    }
  }

  console.log('[oracle/events] discovery done: created=', created, ', skipped=', skipped);
  return { created, skipped, errors };
}

export async function runResolution(): Promise<{
  resolved: number;
  matchedCount: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let resolved = 0;
  let matchedCount = 0;
  const now = new Date();

  console.log('[oracle/events] resolver tick started');

  const markets = await prisma.market.findMany({
    where: {
      oracleSource: ORACLE_SOURCE,
      status: 'OPEN',
      endDate: { lte: now },
    },
    orderBy: { endDate: 'asc' },
    take: RESOLUTION_EVENTS_PER_RUN * 5,
  });

  console.log('[oracle/events] markets scanned: count=', markets.length, 'ids=', markets.slice(0, 5).map((m) => m.id).join(', ') + (markets.length > 5 ? '…' : ''));

  for (const market of markets) {
    if (!market.oracleMatchId) {
      console.log('[oracle/events] market skipped (no oracleMatchId): marketId=', market.id);
      continue;
    }
    if (market.marketType !== 'event_outcome') continue;

    console.log('[oracle/events] attempting match: externalEventId=', market.oracleMatchId, '→ marketId=', market.id);

    let result: { winningOutcome: string } | null = null;
    try {
      result = await fetchCulturalEventResult(market.oracleMatchId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`fetch ${market.oracleMatchId}: ${msg}`);
      console.log('[oracle/events] event skipped: fetch failed: eventId=', market.oracleMatchId, 'reason=', msg);
      continue;
    }

    if (!result) {
      console.log('[oracle/events] event skipped: no result data (events provider not integrated): eventId=', market.oracleMatchId);
      continue;
    }

    matchedCount++;
    const winningOutcome = result.winningOutcome;
    if (!market.outcomes.includes(winningOutcome)) {
      console.log('[oracle/events] market skipped: winning outcome not in market outcomes: marketId=', market.id, 'winningOutcome=', winningOutcome, 'outcomes=', market.outcomes.join(', '));
      continue;
    }

    try {
      await resolveMarketById(market.id, winningOutcome);
      resolved++;
      console.log('[oracle/events] market resolved: marketId=', market.id, 'winningOutcome=', winningOutcome);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`resolve ${market.id}: ${msg}`);
    }
  }

  console.log('[oracle/events] resolver tick done: resolved=', resolved, 'matchedCount=', matchedCount, 'errors=', errors.length);
  return { resolved, matchedCount, errors };
}
