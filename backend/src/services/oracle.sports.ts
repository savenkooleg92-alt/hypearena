/**
 * Sports oracle: discovery (upcoming events → create markets) and resolution (finished events → resolve).
 * Uses The Odds API for schedule and scores only; odds are pool-based.
 */

import prisma from '../utils/prisma';
import {
  fetchUpcomingSportsEvents,
  fetchSportsEventResult,
  type SportsEvent,
} from './sports.data';

const ORACLE_SOURCE = 'sports';
const CATEGORY = 'sports';
const PLATFORM_FEE = 0.015;
const MAX_NEW_EVENTS_PER_RUN = 15;
const RESOLUTION_EVENTS_PER_RUN = 10;

function getOracleCreatorId(): string {
  const id = process.env.ORACLE_CREATOR_USER_ID;
  if (!id) throw new Error('ORACLE_CREATOR_USER_ID is not set');
  return id;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Idempotent: create one market if not exists. */
async function createMarketIfNotExists(data: {
  creatorId: string;
  oracleMatchId: string;
  marketType: string;
  subCategory: string;
  title: string;
  outcomes: string[];
  line: number | null;
  startsAt: Date;
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
    },
  });
  return 'created';
}

/** Resolve a single market (pool-based payout, 1.5% fee). */
async function resolveMarketById(marketId: string, winningOutcome: string): Promise<void> {
  const market = await prisma.market.findUnique({
    where: { id: marketId },
    include: { bets: true },
  });
  if (!market || market.status !== 'OPEN') return;
  if (!market.outcomes.includes(winningOutcome)) return;

  const totalPool = market.bets.reduce((sum: number, b: { amount: number }) => sum + b.amount, 0);
  const commission = round2(totalPool * PLATFORM_FEE);
  const payoutPool = totalPool - commission;
  const winningBets = market.bets.filter((b: { outcome: string }) => b.outcome === winningOutcome);
  const totalWinningStake = winningBets.reduce((sum: number, b: { amount: number }) => sum + b.amount, 0);

  await prisma.$transaction(async (tx: any) => {
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
            description: JSON.stringify({ marketId: market.id, betId: bet.id, source: 'oracle_sports' }),
            marketId: market.id,
            betId: bet.id,
          },
        });
      }
    }
    const losingBets = market.bets.filter((b: { outcome: string }) => b.outcome !== winningOutcome);
    if (losingBets.length > 0) {
      await tx.bet.updateMany({
        where: { id: { in: losingBets.map((b: { id: string }) => b.id) } },
        data: { isWinning: false, payout: 0 },
      });
    }
  });
}

/** One discovery cycle: fetch upcoming sports events, create match_winner market per event. */
export async function runDiscovery(): Promise<{
  created: number;
  skipped: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let created = 0;
  let skipped = 0;
  const creatorId = getOracleCreatorId();

  console.log('[oracle/sports] discovery tick started');

  let events: SportsEvent[];
  try {
    events = await fetchUpcomingSportsEvents();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(msg);
    console.log('[oracle/sports] discovery fetch error:', msg);
    return { created: 0, skipped: 0, errors };
  }

  const toCreate = events.slice(0, MAX_NEW_EVENTS_PER_RUN);
  console.log('[oracle/sports] events fetched:', events.length, ', creating up to:', toCreate.length);

  for (const ev of toCreate) {
    const vs = `${ev.homeTeam} vs ${ev.awayTeam}`;
    const outcomes = [ev.homeTeam, ev.awayTeam, 'Draw'];
    try {
      const result = await createMarketIfNotExists({
        creatorId,
        oracleMatchId: ev.id,
        marketType: 'match_winner',
        subCategory: ev.sport,
        title: `${vs} — Match Winner`,
        outcomes,
        line: null,
        startsAt: ev.commenceAt,
      });
      if (result === 'created') created++;
      else skipped++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Unique constraint') || msg.includes('unique')) skipped++;
      else {
        errors.push(`create ${ev.id}: ${msg}`);
        console.log('[oracle/sports] create skip:', ev.id, msg);
      }
    }
  }

  console.log('[oracle/sports] discovery done: created=', created, ', skipped=', skipped);
  return { created, skipped, errors };
}

/** One resolution cycle: OPEN sports markets with startsAt < now, fetch result, resolve if finished. */
export async function runResolution(): Promise<{
  resolved: number;
  matchedCount: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let resolved = 0;
  let matchedCount = 0;
  const now = new Date();

  console.log('[oracle/sports] resolver tick started');

  const markets = await prisma.market.findMany({
    where: {
      oracleSource: ORACLE_SOURCE,
      status: 'OPEN',
      startsAt: { lt: now },
    },
    orderBy: { startsAt: 'asc' },
    take: RESOLUTION_EVENTS_PER_RUN * 3,
  });

  console.log('[oracle/sports] markets scanned: count=', markets.length, 'ids=', markets.slice(0, 5).map((m: { id: string }) => m.id).join(', ') + (markets.length > 5 ? '…' : ''));

  const byEvent = new Map<string, typeof markets>();
  for (const m of markets) {
    if (!m.oracleMatchId) {
      console.log('[oracle/sports] market skipped (no oracleMatchId): marketId=', m.id);
      continue;
    }
    if (!byEvent.has(m.oracleMatchId)) byEvent.set(m.oracleMatchId, []);
    byEvent.get(m.oracleMatchId)!.push(m);
  }

  const eventIds = Array.from(byEvent.keys()).slice(0, RESOLUTION_EVENTS_PER_RUN);
  console.log('[oracle/sports] external events to process: count=', eventIds.length, 'eventIds=', eventIds.map((id) => id.slice(0, 12) + '…').join(', '));

  for (const eventId of eventIds) {
    const group = byEvent.get(eventId)!;
    const first = group[0];
    const subCategory = first?.subCategory ?? 'nfl';

    console.log('[oracle/sports] attempting match: externalEventId=', eventId.slice(0, 16) + '…', '→ marketId=', first?.id, 'subCategory=', subCategory);

    let result: { winner: 'home' | 'away' | 'draw'; homeScore?: number; awayScore?: number } | null = null;
    try {
      result = await fetchSportsEventResult(eventId, subCategory);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`fetch ${eventId}: ${msg}`);
      console.log('[oracle/sports] event skipped: fetch failed: eventId=', eventId.slice(0, 16) + '…', 'reason=', msg);
      continue;
    }

    if (!result) {
      console.log('[oracle/sports] event skipped: event not finished or missing result data: eventId=', eventId.slice(0, 16) + '…');
      continue;
    }

    matchedCount++;
    console.log('[oracle/sports] event matched, result winner=', result.winner);

    for (const market of group) {
      if (market.status !== 'OPEN') continue;
      if (market.marketType !== 'match_winner') continue;

      const homeTeam = market.outcomes[0];
      const awayTeam = market.outcomes[1];
      const drawOutcome = market.outcomes[2] === 'Draw' ? 'Draw' : null;
      let winningOutcome: string | null = null;
      if (result.winner === 'home') winningOutcome = homeTeam;
      else if (result.winner === 'away') winningOutcome = awayTeam;
      else if (result.winner === 'draw' && drawOutcome) winningOutcome = drawOutcome;

      if (!winningOutcome || !market.outcomes.includes(winningOutcome)) {
        console.log('[oracle/sports] market skipped: no matching outcome for winner: marketId=', market.id, 'winner=', result.winner, 'outcomes=', market.outcomes.join(', '));
        continue;
      }

      try {
        await resolveMarketById(market.id, winningOutcome);
        resolved++;
        console.log('[oracle/sports] market resolved: marketId=', market.id, 'winningOutcome=', winningOutcome);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`resolve ${market.id}: ${msg}`);
        console.log('[oracle/sports] market resolve error: marketId=', market.id, 'error=', msg);
      }
    }
  }

  console.log('[oracle/sports] resolver tick done: resolved=', resolved, 'matchedCount=', matchedCount, 'errors=', errors.length);
  return { resolved, matchedCount, errors };
}
