/**
 * Politics oracle: discovery (oracleMatchId = battleId from feed), resolution by battleId first, title fallback.
 * One battle feed fetch per cycle; outcome mapping by market.outcomes only; UNMAPPED → no resolve; hard-timeout → CANCELLED+refund.
 */

import prisma from '../utils/prisma';
import {
  fetchUpcomingPoliticsEventsWithDiagnostics,
  fetchBattlesFeedForResolution,
  normalizeTitleForMatch,
  mapBattleOutcomeToMarketOutcome,
} from './politics.data';

const ORACLE_SOURCE = 'politics';
const CATEGORY = 'politics';
const PLATFORM_FEE = 0.015;
const MAX_NEW_EVENTS_PER_RUN = 10;
/** Max politics markets to resolve per cycle (one feed fetch, then resolve from local map). */
const RESOLUTION_MARKETS_PER_RUN = 50;
/** If market still OPEN after this many hours past endDate → CANCELLED + refund. */
const HARD_TIMEOUT_HOURS = 72;

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
            description: JSON.stringify({ marketId: market.id, betId: bet.id, source: 'oracle_politics' }),
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

/** Cancel market and refund all bets (stake returned). */
async function cancelMarketAndRefund(marketId: string): Promise<void> {
  const market = await prisma.market.findUnique({
    where: { id: marketId },
    include: { bets: true },
  });
  if (!market || market.status !== 'OPEN') return;

  await prisma.$transaction(async (tx: any) => {
    await tx.market.update({
      where: { id: market.id },
      data: { status: 'CANCELLED', resolvedAt: new Date(), winningOutcome: null },
    });
    for (const bet of market.bets) {
      await tx.user.update({
        where: { id: bet.userId },
        data: { balance: { increment: bet.amount } },
      });
      await tx.bet.update({
        where: { id: bet.id },
        data: { payout: 0, isWinning: false },
      });
      await tx.transaction.create({
        data: {
          userId: bet.userId,
          type: 'BET_WON',
          amount: bet.amount,
          description: JSON.stringify({ marketId: market.id, betId: bet.id, source: 'oracle_politics_refund', reason: 'hard_timeout_or_unmapped' }),
          marketId: market.id,
          betId: bet.id,
        },
      });
    }
  });
}

export async function runDiscovery(): Promise<{
  created: number;
  skipped: number;
  errors: string[];
  enabled: boolean;
  fetched: number;
  afterFilter: number;
  skipReasons: { dedup: number; outcomesLessThan2: number; error: number };
}> {
  const errors: string[] = [];
  let created = 0;
  let skipped = 0;
  const skipReasons = { dedup: 0, outcomesLessThan2: 0, error: 0 };
  const creatorId = getOracleCreatorId();
  console.log('[oracle/politics] discovery tick started');

  let diagnostics;
  try {
    diagnostics = await fetchUpcomingPoliticsEventsWithDiagnostics();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(msg);
    return {
      created: 0,
      skipped: 0,
      errors,
      enabled: true,
      fetched: 0,
      afterFilter: 0,
      skipReasons,
    };
  }

  const { events, enabled, fetched, afterDateFilter: afterFilter, error: fetchError } = diagnostics;
  if (fetchError) errors.push(fetchError);

  const toCreate = events.slice(0, MAX_NEW_EVENTS_PER_RUN);
  for (const ev of toCreate) {
    if (ev.outcomes.length < 2) {
      skipReasons.outcomesLessThan2++;
      continue;
    }
    try {
      const result = await createMarketIfNotExists({
        creatorId,
        oracleMatchId: ev.id,
        marketType: 'event_outcome',
        subCategory: ev.eventType,
        title: `${ev.title} — Outcome`,
        outcomes: ev.outcomes,
        line: null,
        startsAt: ev.resolveBy,
        endDate: ev.resolveBy,
      });
      if (result === 'created') created++;
      else {
        skipped++;
        skipReasons.dedup++;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Unique constraint') || msg.includes('unique')) {
        skipped++;
        skipReasons.dedup++;
      } else {
        errors.push(`create ${ev.id}: ${msg}`);
        skipReasons.error++;
      }
    }
  }
  console.log('[oracle/politics] discovery done: enabled=', enabled, 'fetched=', fetched, 'afterFilter=', afterFilter, 'created=', created, 'skipped=', skipped);
  return {
    created,
    skipped,
    errors,
    enabled,
    fetched,
    afterFilter,
    skipReasons,
  };
}

export async function runResolution(): Promise<{ resolved: number; matchedCount: number; errors: string[] }> {
  const errors: string[] = [];
  let resolved = 0;
  let matchedCount = 0;
  const now = new Date();
  const hardTimeoutMs = HARD_TIMEOUT_HOURS * 60 * 60 * 1000;
  console.log('[oracle/politics] resolver tick started');

  const markets = await prisma.market.findMany({
    where: {
      oracleSource: ORACLE_SOURCE,
      status: 'OPEN',
      OR: [
        { endDate: { lte: now } },
        { AND: [{ endDate: null }, { startsAt: { lte: now } }] },
      ],
    },
    orderBy: [{ endDate: 'asc' }, { startsAt: 'asc' }],
    take: RESOLUTION_MARKETS_PER_RUN,
  });

  let byBattleId: Awaited<ReturnType<typeof fetchBattlesFeedForResolution>>['byBattleId'];
  let byTitle: Awaited<ReturnType<typeof fetchBattlesFeedForResolution>>['byTitle'];
  try {
    const feed = await fetchBattlesFeedForResolution();
    byBattleId = feed.byBattleId;
    byTitle = feed.byTitle;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(msg);
    console.log('[oracle/politics] fetch feed failed:', msg);
    return { resolved: 0, matchedCount: 0, errors };
  }

  console.log('[oracle/politics] feed loaded: byBattleId=', byBattleId.size, 'byTitle=', byTitle.size, 'markets=', markets.length);

  for (const market of markets) {
    if (market.marketType !== 'event_outcome') continue;

    if (market.endDate && now.getTime() - market.endDate.getTime() > hardTimeoutMs) {
      try {
        await cancelMarketAndRefund(market.id);
        resolved++;
        console.log('[oracle/politics] market CANCELLED+refund: hard timeout, marketId=', market.id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`cancel ${market.id}: ${msg}`);
      }
      continue;
    }

    let entry = market.oracleMatchId ? byBattleId.get(market.oracleMatchId) : undefined;
    if (!entry && market.title) entry = byTitle.get(normalizeTitleForMatch(market.title));
    if (!entry) continue;

    matchedCount++;
    const winningOutcome = mapBattleOutcomeToMarketOutcome(
      entry.outcome,
      entry.suggestedOutcomes,
      market.outcomes,
      market.marketType ?? undefined
    );
    if (winningOutcome == null) {
      console.log('[oracle/politics] UNMAPPED: marketId=', market.id, 'battleOutcome=', entry.outcome, 'marketOutcomes=', market.outcomes.join(', '));
      continue;
    }
    if (!market.outcomes.includes(winningOutcome)) {
      console.log('[oracle/politics] UNMAPPED: winning outcome not in market outcomes: marketId=', market.id, 'winningOutcome=', winningOutcome);
      continue;
    }
    try {
      await resolveMarketById(market.id, winningOutcome);
      resolved++;
      console.log('[oracle/politics] market resolved: marketId=', market.id, 'winningOutcome=', winningOutcome);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`resolve ${market.id}: ${msg}`);
    }
  }
  console.log('[oracle/politics] resolver tick done: resolved=', resolved, 'matchedCount=', matchedCount, 'errors=', errors.length);
  return { resolved, matchedCount, errors };
}
