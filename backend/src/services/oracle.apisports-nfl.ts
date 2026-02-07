/**
 * NFL oracle: discovery (upcoming games → create match_winner markets) and resolution (finished → resolve).
 * Uses API-Sports American Football API. oracleSource = 'apisports_nfl'.
 * Rate limit: 100 req/day; discovery 5–7 new/day; resolver every 10 min.
 */

import prisma from '../utils/prisma';
import {
  getGamesByDate,
  getGameById,
  isDailyLimitReached,
  getRequestsUsedToday,
  getMaxDiscoveryRequestsThisCycle,
  getMaxResolutionRequestsThisCycle,
  DAILY_LIMIT,
  type ApiSportsNflGame,
} from './apisports-nfl.service';

const ORACLE_SOURCE = 'apisports_nfl';
const CATEGORY = 'sports';
const PLATFORM_FEE = 0.015;
const SAFETY_WINDOW_MINUTES = 180;
/** Max new NFL markets to create per day (total). */
const MAX_NEW_NFL_MARKETS_PER_DAY = 7;
/** Resolver: max markets to process per cycle (bounded by API requests). */
const RESOLUTION_MARKETS_PER_RUN = 50;
/** If match not found (404) and now > startsAt + this → CANCELLED + refund. */
const HARD_TIMEOUT_HOURS = 12;

const FINISHED_STATUSES = new Set(['finished', 'ft', 'aet', 'ended', 'complete', 'completed']);
const CANCELED_STATUSES = new Set(['canceled', 'cancelled', 'postponed', 'abandoned', 'no_show']);

function getOracleCreatorId(): string {
  const id = process.env.ORACLE_CREATOR_USER_ID;
  if (!id) throw new Error('ORACLE_CREATOR_USER_ID is not set');
  return id;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Title date format: YYYY-MM-DD HH:mm UTC */
function formatStartsAtUtc(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/** Parse game date + time to Date (UTC). */
function gameStartsAt(g: ApiSportsNflGame): Date {
  const dateStr = g.date ?? '';
  const timeStr = g.time ?? '00:00';
  const iso = `${dateStr}T${timeStr}:00.000Z`;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? new Date(0) : new Date(t);
}

function gameStatusShort(g: ApiSportsNflGame): string {
  const s = g.status?.short ?? g.status?.long ?? '';
  return String(s).toLowerCase().trim();
}

/** Idempotent: create one market if not exists. Dedup by (oracleSource, oracleMatchId, marketType). */
async function createMarketIfNotExists(data: {
  creatorId: string;
  oracleMatchId: string;
  marketType: string;
  subCategory: string;
  title: string;
  outcomes: string[];
  line: number | null;
  startsAt: Date;
  endDate: Date;
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
            description: JSON.stringify({ marketId: market.id, betId: bet.id, source: 'oracle_nfl' }),
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

async function cancelMarketAndRefund(marketId: string, reason: string): Promise<void> {
  const market = await prisma.market.findUnique({
    where: { id: marketId },
    include: { bets: true },
  });
  if (!market || market.status !== 'OPEN') return;

  await prisma.$transaction(async (tx) => {
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
          description: JSON.stringify({ marketId: market.id, betId: bet.id, source: 'oracle_nfl_refund', reason }),
          marketId: market.id,
          betId: bet.id,
        },
      });
    }
  });
}

/** How many apisports_nfl markets we created today (by createdAt). */
async function countNflMarketsCreatedToday(): Promise<number> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const count = await prisma.market.count({
    where: {
      oracleSource: ORACLE_SOURCE,
      createdAt: { gte: today },
    },
  });
  return count;
}

/** Discovery: add 5–7 new NFL matches per day; nearest (today + next 13 days). */
export async function runDiscovery(): Promise<{
  created: number;
  skipped: number;
  errors: string[];
  rateLimited: boolean;
  requestsUsedToday: number;
  enabled: boolean;
  fetched: number;
  afterFilter: number;
  skipReasons: { dailyCap: number; dedup: number; status: number; datePast: number; error: number };
}> {
  const errors: string[] = [];
  let created = 0;
  let skipped = 0;
  const skipReasons = { dailyCap: 0, dedup: 0, status: 0, datePast: 0, error: 0 };
  const creatorId = getOracleCreatorId();
  const enabled = Boolean(process.env.APISPORTS_API_KEY && process.env.ORACLE_CREATOR_USER_ID);
  const requestsUsedToday = getRequestsUsedToday();

  console.log('[oracle/nfl] discovery tick started, enabled=', enabled, 'API requests used today=', requestsUsedToday);

  if (!enabled) {
    return {
      created: 0,
      skipped: 0,
      errors: [],
      rateLimited: false,
      requestsUsedToday: 0,
      enabled: false,
      fetched: 0,
      afterFilter: 0,
      skipReasons,
    };
  }

  if (isDailyLimitReached()) {
    console.log('[oracle/nfl] discovery skipped: daily API limit reached');
    return {
      created: 0,
      skipped: 0,
      errors: ['Daily API limit reached'],
      rateLimited: true,
      requestsUsedToday,
      enabled: true,
      fetched: 0,
      afterFilter: 0,
      skipReasons: { ...skipReasons, dailyCap: 1 },
    };
  }

  const alreadyCreatedToday = await countNflMarketsCreatedToday();
  const slotLeft = Math.max(0, MAX_NEW_NFL_MARKETS_PER_DAY - alreadyCreatedToday);
  if (slotLeft === 0) {
    skipReasons.dailyCap++;
    console.log('[oracle/nfl] discovery skipped: max new NFL markets per day reached (', MAX_NEW_NFL_MARKETS_PER_DAY, ')');
    return {
      created: 0,
      skipped: 0,
      errors: [],
      rateLimited: false,
      requestsUsedToday,
      enabled: true,
      fetched: 0,
      afterFilter: 0,
      skipReasons,
    };
  }

  const maxRequests = getMaxDiscoveryRequestsThisCycle();
  if (maxRequests === 0) {
    return {
      created: 0,
      skipped: 0,
      errors: [],
      rateLimited: true,
      requestsUsedToday,
      enabled: true,
      fetched: 0,
      afterFilter: 0,
      skipReasons: { ...skipReasons, dailyCap: 1 },
    };
  }

  const dates: string[] = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }

  const now = Date.now();
  const twoHoursAgo = now - 2 * 60 * 60 * 1000;
  let fetched = 0;
  const allGames: ApiSportsNflGame[] = [];
  const season = new Date().getFullYear();

  for (const date of dates) {
    if (getRequestsUsedToday() >= DAILY_LIMIT) break;
    const games = await getGamesByDate(date, season);
    fetched += games.length;
    for (const g of games) {
      const status = gameStatusShort(g);
      if (FINISHED_STATUSES.has(status) || CANCELED_STATUSES.has(status)) {
        skipReasons.status++;
        continue;
      }
      const start = gameStartsAt(g).getTime();
      if (start < twoHoursAgo) {
        skipReasons.datePast++;
        continue;
      }
      allGames.push(g);
    }
  }

  const byId = new Map<number, ApiSportsNflGame>();
  for (const g of allGames) {
    if (g.id != null && !byId.has(g.id)) byId.set(g.id, g);
  }
  const uniqueGames = Array.from(byId.values()).sort((a, b) => gameStartsAt(a).getTime() - gameStartsAt(b).getTime());
  const afterFilter = uniqueGames.length;

  let createdThisRun = 0;
  for (const g of uniqueGames) {
    if (createdThisRun >= slotLeft) break;

    const homeName = g.teams?.home?.name?.trim() ?? 'Home';
    const awayName = g.teams?.away?.name?.trim() ?? 'Away';
    const startsAt = gameStartsAt(g);
    const endDate = new Date(startsAt.getTime() + SAFETY_WINDOW_MINUTES * 60 * 1000);
    const title = `NFL: ${homeName} vs ${awayName} — Match Winner (${formatStartsAtUtc(startsAt)})`;
    const oracleMatchId = String(g.id);

    try {
      const result = await createMarketIfNotExists({
        creatorId,
        oracleMatchId,
        marketType: 'match_winner',
        subCategory: 'nfl',
        title,
        outcomes: ['HOME', 'AWAY'],
        line: null,
        startsAt,
        endDate,
      });
      if (result === 'created') {
        created++;
        createdThisRun++;
        console.log('[oracle/nfl] created market:', oracleMatchId, title.slice(0, 50) + '…');
      } else {
        skipped++;
        skipReasons.dedup++;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Unique constraint') || msg.includes('unique')) {
        skipped++;
        skipReasons.dedup++;
      } else {
        errors.push(`create ${oracleMatchId}: ${msg}`);
        skipReasons.error++;
      }
    }
  }

  console.log('[oracle/nfl] discovery done: fetched=', fetched, 'afterFilter=', afterFilter, 'created=', created, 'skipped=', skipped, 'API requests used today=', getRequestsUsedToday());
  return {
    created,
    skipped,
    errors,
    rateLimited: isDailyLimitReached(),
    requestsUsedToday: getRequestsUsedToday(),
    enabled: true,
    fetched,
    afterFilter,
    skipReasons,
  };
}

/** Resolution: OPEN apisports_nfl markets with endDate <= now or startsAt <= now; resolve by game result. */
export async function runResolution(): Promise<{
  resolved: number;
  cancelled: number;
  errors: string[];
  rateLimited: boolean;
  requestsUsedToday: number;
}> {
  const errors: string[] = [];
  let resolved = 0;
  let cancelled = 0;
  const now = new Date();
  const hardTimeoutMs = HARD_TIMEOUT_HOURS * 60 * 60 * 1000;
  const requestsUsedTodayStart = getRequestsUsedToday();

  console.log('[oracle/nfl] resolver tick started, API requests used today:', requestsUsedTodayStart);

  if (isDailyLimitReached()) {
    console.log('[oracle/nfl] resolver skipped: daily API limit reached');
    return { resolved: 0, cancelled: 0, errors: ['Daily API limit reached'], rateLimited: true, requestsUsedToday: getRequestsUsedToday() };
  }

  const markets = await prisma.market.findMany({
    where: {
      oracleSource: ORACLE_SOURCE,
      status: 'OPEN',
      OR: [{ endDate: { lte: now } }, { startsAt: { lte: now } }],
    },
    orderBy: [{ endDate: 'asc' }, { startsAt: 'asc' }],
    take: RESOLUTION_MARKETS_PER_RUN,
  });

  const maxRequests = getMaxResolutionRequestsThisCycle();
  const toProcess = markets.slice(0, maxRequests);

  for (const market of toProcess) {
    if (getRequestsUsedToday() >= DAILY_LIMIT) break;

    const oracleMatchId = market.oracleMatchId;
    if (!oracleMatchId) continue;

    const game = await getGameById(oracleMatchId);
    const startsAt = market.startsAt ?? new Date(0);

    if (!game) {
      if (now.getTime() - startsAt.getTime() > hardTimeoutMs) {
        try {
          await cancelMarketAndRefund(market.id, 'match_not_found_timeout');
          cancelled++;
          console.log('[oracle/nfl] CANCELLED+refund: match not found (timeout), marketId=', market.id);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`cancel ${market.id}: ${msg}`);
        }
      }
      continue;
    }

    const status = gameStatusShort(game);

    if (CANCELED_STATUSES.has(status)) {
      try {
        await cancelMarketAndRefund(market.id, `match_${status}`);
        cancelled++;
        console.log('[oracle/nfl] CANCELLED+refund: match status=', status, 'marketId=', market.id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`cancel ${market.id}: ${msg}`);
      }
      continue;
    }

    if (FINISHED_STATUSES.has(status)) {
      const home = Number(game.scores?.home) ?? 0;
      const away = Number(game.scores?.away) ?? 0;
      if (home === away) {
        try {
          await cancelMarketAndRefund(market.id, 'tie');
          cancelled++;
          console.log('[oracle/nfl] CANCELLED+refund: tie score', home, '-', away, 'marketId=', market.id);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`cancel ${market.id}: ${msg}`);
        }
        continue;
      }
      const winningOutcome = home > away ? 'HOME' : 'AWAY';
      if (!market.outcomes.includes(winningOutcome)) continue;
      try {
        await resolveMarketById(market.id, winningOutcome);
        resolved++;
        console.log('[oracle/nfl] RESOLVED: marketId=', market.id, 'winningOutcome=', winningOutcome, 'score', home, '-', away);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`resolve ${market.id}: ${msg}`);
      }
    }
  }

  const requestsUsedToday = getRequestsUsedToday();
  console.log('[oracle/nfl] resolver tick done: resolved=', resolved, ', cancelled=', cancelled, ', API requests used today=', requestsUsedToday);
  return {
    resolved,
    cancelled,
    errors,
    rateLimited: isDailyLimitReached(),
    requestsUsedToday,
  };
}
