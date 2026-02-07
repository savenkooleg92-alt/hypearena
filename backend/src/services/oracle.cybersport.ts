/**
 * Cybersport oracle: discovery (upcoming matches → create 3 markets each) and resolution (finished matches → resolve).
 * All PandaScore calls go through the global rate limiter in pandascore.service.
 */

import prisma from '../utils/prisma';
import {
  shouldStopAllCalls,
  getUpcomingMatches,
  getMatch,
  getMatchFromPast,
  GAMES,
  getGamesOrMapsList,
  hasUsableGamesOrMaps,
  getFirstGameWinnerId,
  getTotalPlayedCount,
  getMatchWinnerIdFromGames,
  type GameSlug,
  type PandaMatch,
} from './pandascore.service';

const ORACLE_SOURCE = 'pandascore';
const CATEGORY = 'cybersport';
const MAX_NEW_MATCHES_PER_HOUR = 20;

/** If set, never create game1_winner / total_maps (e.g. when PandaScore never returns games/maps). */
function isGameMapsMarketsDisabled(): boolean {
  return process.env.DISABLE_GAME_MAPS_MARKETS === 'true' || process.env.DISABLE_GAME_MAPS_MARKETS === '1';
}
/** Max match groups per resolution cycle (each group = up to 3 markets). Process in batches so one bad match does not block. */
const RESOLUTION_MATCH_GROUPS_PER_RUN = 50;
/** Concurrency: max parallel PandaScore match fetches per run. */
const RESOLUTION_FETCH_CONCURRENCY = 2;
const PLATFORM_FEE = 0.015;

const WINDOW_START_MINUTES = 15;
const WINDOW_END_HOURS = 72;
/** Resolution allowed after match start + this window (minutes). Env CYBERSPORT_SAFETY_WINDOW_MINUTES overrides. Default 30 so we check outcome soon after match and resolve. */
const SAFETY_WINDOW_MINUTES = (() => {
  const n = process.env.CYBERSPORT_SAFETY_WINDOW_MINUTES
    ? parseInt(process.env.CYBERSPORT_SAFETY_WINDOW_MINUTES, 10)
    : NaN;
  return Number.isFinite(n) && n > 0 ? n : 30;
})();
/** If match not finished after this many hours from scheduled start, resolve as canceled. */
const HARD_TIMEOUT_HOURS = 12;

function getOracleCreatorId(): string {
  let id = process.env.ORACLE_CREATOR_USER_ID?.trim() ?? '';
  if (id.startsWith('"') && id.endsWith('"')) id = id.slice(1, -1).trim();
  if (id.startsWith("'") && id.endsWith("'")) id = id.slice(1, -1).trim();
  if (!id) throw new Error('ORACLE_CREATOR_USER_ID is not set');
  return id;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Normalize for outcome matching: trim, lowercase, collapse spaces. Agent must match 100% after this. */
function normalizeOutcome(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Find market outcome that matches winningOutcome (normalized: trim + lowercase + collapse spaces). Returns exact outcome string or null. */
function matchOutcome(marketOutcomes: string[], winningOutcome: string): string | null {
  const want = normalizeOutcome(winningOutcome);
  if (!want) return null;
  const found = marketOutcomes.find((o) => normalizeOutcome(o) === want);
  return found ?? null;
}

/** Resolve by PandaScore team id when market has outcomeTeamIds (same order as outcomes). Prevents "BetBoom" ≠ "BetBoom Team" mismatch. */
function matchOutcomeByTeamId(outcomes: string[], outcomeTeamIds: unknown, winnerTeamId: number): string | null {
  if (!Array.isArray(outcomeTeamIds) || outcomeTeamIds.length !== outcomes.length) return null;
  const idx = outcomeTeamIds.findIndex((id) => Number(id) === winnerTeamId);
  if (idx < 0) return null;
  return outcomes[idx] ?? null;
}

/** Fallback when outcomeTeamIds missing (legacy): normalized exact match, then normalized contains (e.g. "BetBoom" → "BetBoom Team"). */
function matchOutcomeRelaxed(marketOutcomes: string[], winnerName: string): string | null {
  const exact = matchOutcome(marketOutcomes, winnerName);
  if (exact) return exact;
  const want = normalizeOutcome(winnerName);
  if (!want) return null;
  const found = marketOutcomes.find((o) => {
    const oNorm = normalizeOutcome(o);
    return oNorm === want || oNorm.includes(want) || want.includes(oNorm);
  });
  return found ?? null;
}

/** Match start in [now+15min, now+72h] and has exactly 2 named opponents. */
function isEligibleForCreation(m: PandaMatch): boolean {
  const scheduled = m.scheduled_at ? new Date(m.scheduled_at).getTime() : 0;
  const now = Date.now();
  const start = now + WINDOW_START_MINUTES * 60 * 1000;
  const end = now + WINDOW_END_HOURS * 60 * 60 * 1000;
  if (scheduled < start || scheduled > end) return false;
  const opponents = m.opponents ?? [];
  if (opponents.length !== 2) return false;
  const names = opponents
    .map((o) => o?.opponent?.name?.trim())
    .filter((n): n is string => Boolean(n));
  if (names.length !== 2) return false;
  return true;
}

function getTeamNames(m: PandaMatch): [string, string] | null {
  const opponents = m.opponents ?? [];
  if (opponents.length !== 2) return null;
  const a = opponents[0]?.opponent?.name?.trim();
  const b = opponents[1]?.opponent?.name?.trim();
  if (!a || !b) return null;
  return [a, b];
}

/** PandaScore opponent team ids in order [first, second]. Used to store outcomeTeamIds for resolve by teamId. */
function getTeamIds(m: PandaMatch): [number, number] | null {
  const opponents = m.opponents ?? [];
  if (opponents.length !== 2) return null;
  const idA = opponents[0]?.opponent?.id;
  const idB = opponents[1]?.opponent?.id;
  if (idA == null || idB == null) return null;
  return [idA, idB];
}

function getLineForBO(numberOfGames: number | undefined): number {
  if (numberOfGames === 5) return 3.5;
  if (numberOfGames === 3) return 2.5;
  return 2.5;
}

/** Distinct oracle match ids created in the last hour (max 20 allowed). */
async function countNewMatchGroupsLastHour(): Promise<number> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const rows = await prisma.market.findMany({
    where: {
      oracleSource: ORACLE_SOURCE,
      oracleMatchId: { not: null },
      createdAt: { gte: oneHourAgo },
    },
    select: { oracleMatchId: true },
    distinct: ['oracleMatchId'],
  });
  return rows.length;
}

/** endDate = resolveAfter (resolution allowed after this time). */
function resolveAfterFromScheduledAt(scheduledAt: Date): Date {
  const d = new Date(scheduledAt.getTime() + SAFETY_WINDOW_MINUTES * 60 * 1000);
  return d;
}

/** Format scheduledAt as "YYYY-MM-DD HH:mm UTC" for title. */
function formatScheduledUtc(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/** Idempotent: create one market if not exists. Sets endDate = resolveAfter (scheduledAt + safety window). outcomeTeamIds: team ids in same order as outcomes (for match_winner/game1_winner). */
async function createMarketIfNotExists(data: {
  creatorId: string;
  oracleMatchId: string;
  marketType: string;
  subCategory: string;
  title: string;
  outcomes: string[];
  line: number | null;
  startsAt: Date;
  endDate?: Date | null;
  outcomeTeamIds?: [number, number] | null;
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
  const endDate = data.endDate ?? resolveAfterFromScheduledAt(data.startsAt);
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
      endDate,
      outcomeTeamIds: data.outcomeTeamIds ?? undefined,
    },
  });
  return 'created';
}

/** One discovery cycle: fetch upcoming for csgo, dota2, lol; create up to cap. */
export async function runDiscovery(): Promise<{
  created: number;
  skipped: number;
  errors: string[];
  rateLimited: boolean;
  matchesFound?: number;
}> {
  const errors: string[] = [];
  let created = 0;
  let skipped = 0;
  const creatorId = getOracleCreatorId();

  if (shouldStopAllCalls()) {
    return { created: 0, skipped: 0, errors: ['Hard cap reached'], rateLimited: true, matchesFound: 0 };
  }

  const games: GameSlug[] = [GAMES.CS2, GAMES.DOTA2, GAMES.LOL];
  const subCategoryByGame: Record<string, string> = {
    [GAMES.CS2]: 'cs2',
    [GAMES.DOTA2]: 'dota2',
    [GAMES.LOL]: 'lol',
  };
  const allMatches: { match: PandaMatch; game: GameSlug }[] = [];

  for (const game of games) {
    try {
      const list = await getUpcomingMatches(game, 1, 50);
      for (const m of list) {
        if (isEligibleForCreation(m)) allMatches.push({ match: m, game });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${game}: ${msg}`);
      if (msg.includes('PANDASCORE_RATE_LIMIT')) break;
    }
  }

  const newGroupsInHour = await countNewMatchGroupsLastHour();
  const remainingSlots = Math.max(0, MAX_NEW_MATCHES_PER_HOUR - newGroupsInHour);
  let matchSlotsUsed = 0;

  for (const { match: m, game } of allMatches) {
    if (matchSlotsUsed >= remainingSlots) break;
    if (shouldStopAllCalls()) {
      errors.push('Hard cap during creation');
      break;
    }
    const names = getTeamNames(m);
    if (!names) continue;
    const [teamA, teamB] = names;
    const teamIds = getTeamIds(m); // for resolve by teamId (e.g. CS2 "BetBoom" vs "BetBoom Team")
    const vs = `${teamA} vs ${teamB}`;
    const scheduledAt = m.scheduled_at ? new Date(m.scheduled_at) : new Date();
    const line = getLineForBO(m.number_of_games);
    const matchIdStr = String(m.id);

    const gameLabel = game === GAMES.CS2 ? 'CS2' : game === GAMES.DOTA2 ? 'Dota 2' : 'LoL';
    const dateSuffix = formatScheduledUtc(scheduledAt);
    const gamesMapsList = getGamesOrMapsList(m);
    const hasUsable = hasUsableGamesOrMaps(m);
    console.log('[oracle/cybersport] discovery match', matchIdStr, 'games/maps count:', gamesMapsList.length, 'hasUsable:', hasUsable);
    const createGameMapsMarkets = !isGameMapsMarketsDisabled() && hasUsable;

    const marketsToCreate: { marketType: string; title: string; outcomes: string[]; line: number | null; outcomeTeamIds?: [number, number] | null }[] = [
      { marketType: 'match_winner', title: `${gameLabel}: ${teamA} vs ${teamB} — Match Winner (${dateSuffix})`, outcomes: [teamA, teamB], line: null, outcomeTeamIds: teamIds ?? undefined },
    ];
    if (createGameMapsMarkets) {
      marketsToCreate.push(
        { marketType: 'game1_winner', title: `${gameLabel}: ${vs} — Game 1 Winner (${dateSuffix})`, outcomes: [teamA, teamB], line: null, outcomeTeamIds: teamIds ?? undefined },
        {
          marketType: 'total_maps',
          title: `${gameLabel}: ${vs} — Total Maps Over/Under (${dateSuffix})`,
          outcomes: [`Over ${line}`, `Under ${line}`],
          line,
        }
      );
    }

    for (const mt of marketsToCreate) {
      try {
        const result = await createMarketIfNotExists({
          creatorId,
          oracleMatchId: matchIdStr,
          marketType: mt.marketType,
          subCategory: subCategoryByGame[game],
          title: mt.title,
          outcomes: mt.outcomes,
          line: mt.line,
          startsAt: scheduledAt,
          outcomeTeamIds: mt.outcomeTeamIds ?? undefined,
        });
        if (result === 'created') created++;
        else skipped++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('Unique constraint') || msg.includes('unique')) skipped++;
        else errors.push(`create ${matchIdStr} ${mt.marketType}: ${msg}`);
      }
    }
    matchSlotsUsed++;
  }

  return {
    created,
    skipped,
    errors,
    rateLimited: shouldStopAllCalls(),
    matchesFound: allMatches.length,
  };
}

/** Resolve a single market: RESOLVED + payouts. Single path used by both Agent (watcher) and Admin (button). */
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
      data: {
        status: 'RESOLVED',
        winningOutcome,
        resolvedAt: new Date(),
        oracleLastError: null,
        oracleLastErrorAt: null,
        oracleRetryCount: 0,
      },
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
            description: JSON.stringify({ marketId: market.id, betId: bet.id, source: 'oracle' }),
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

/** PandaScore match status: finished with result. API uses "finished"; include common variants. */
const FINISHED_STATUSES = new Set(['finished', 'completed', 'ended', 'finalized', 'done']);
/** Match canceled/postponed/etc. → cancel market and refund. */
const CANCELED_STATUSES = new Set(['canceled', 'cancelled', 'forfeit', 'postponed', 'no_show']);

/** Max retries for timeout/429/404 before CANCELLED. 404 is retried (not immediate cancel) so finished matches can resolve if API is delayed. */
const ORACLE_RETRY_MAX = (() => {
  const n = process.env.ORACLE_RETRY_MAX ? parseInt(process.env.ORACLE_RETRY_MAX, 10) : NaN;
  return Number.isFinite(n) && n >= 1 ? n : 20;
})();

/** Record fetch error on markets; if oracleRetryCount >= ORACLE_RETRY_MAX after increment, move to AWAITING_RESULT (admin resolves). Returns count of markets moved. */
async function recordOracleErrorAndMaybeCancel(
  group: Array<{ id: string; status: string; oracleRetryCount: number }>,
  matchIdStr: string,
  errorMessage: string,
  errors: string[]
): Promise<number> {
  let moved = 0;
  const truncated = errorMessage.slice(0, 200);
  for (const market of group) {
    if (market.status !== 'OPEN') continue;
    const newCount = (market.oracleRetryCount ?? 0) + 1;
    await prisma.market.update({
      where: { id: market.id },
      data: {
        oracleLastError: truncated,
        oracleLastErrorAt: new Date(),
        oracleRetryCount: newCount,
      },
    });
    if (newCount >= ORACLE_RETRY_MAX) {
      try {
        await moveMarketToAwaitingResult(market.id);
        moved++;
        console.log('[oracle/cybersport] retry limit reached → AWAITING_RESULT marketId=', market.id, 'oracleMatchId=', matchIdStr);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`move awaiting ${market.id}: ${msg}`);
      }
    }
  }
  if (moved === 0) {
    console.log('[oracle/cybersport] skip: timeout/error oracleMatchId=', matchIdStr, '(retry next cycle)');
  }
  return moved;
}

/** Move OPEN market to AWAITING_RESULT so admin can resolve manually (no refund). Used when oracle can't auto-resolve. */
async function moveMarketToAwaitingResult(marketId: string): Promise<void> {
  await prisma.market.updateMany({
    where: { id: marketId, status: 'OPEN' },
    data: { status: 'AWAITING_RESULT' },
  });
}

/** Cancel market and refund all bets (stake returned). Kept for reopen/undo flows. */
async function cancelMarketAndRefund(marketId: string): Promise<void> {
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
          description: JSON.stringify({ marketId: market.id, betId: bet.id, source: 'oracle_refund', reason: 'market_canceled' }),
          marketId: market.id,
          betId: bet.id,
        },
      });
    }
  });
}

/**
 * One resolution cycle (Watcher): OPEN pandascore markets with oracleMatchId, endDate<=now or startsAt<now.
 * For each match: getMatch → if 404 after retries move to AWAITING_RESULT, if timeout skip (retry next cycle), if finished resolve.
 * Agent uses the same resolve path as admin: resolveMarketById(marketId, matchedOutcome) — no separate logic.
 */
export async function runResolution(): Promise<{
  resolved: number;
  errors: string[];
  rateLimited: boolean;
}> {
  const errors: string[] = [];
  let resolved = 0;
  const now = new Date();
  const hardTimeoutMs = HARD_TIMEOUT_HOURS * 60 * 60 * 1000;
  const safetyWindowMs = SAFETY_WINDOW_MINUTES * 60 * 1000;
  const resolveEligibleSince = new Date(now.getTime() - safetyWindowMs);

  console.log('[oracle/cybersport] resolver tick started');

  if (shouldStopAllCalls()) {
    console.log('[oracle/cybersport] skipped: rate limit hard cap reached');
    return { resolved: 0, errors: ['Hard cap reached'], rateLimited: true };
  }

  const markets = await prisma.market.findMany({
    where: {
      oracleSource: ORACLE_SOURCE,
      status: 'OPEN',
      OR: [
        { endDate: { lte: now } },
        { endDate: null, startsAt: { lt: now } },
        { startsAt: { lte: resolveEligibleSince } },
      ],
    },
    orderBy: [{ endDate: 'asc' }, { startsAt: 'asc' }],
    take: RESOLUTION_MATCH_GROUPS_PER_RUN * 3,
  });

  if (markets.length === 0) {
    const openCount = await prisma.market.count({
      where: { oracleSource: ORACLE_SOURCE, status: 'OPEN' },
    });
    const withEndDatePast = await prisma.market.count({
      where: { oracleSource: ORACLE_SOURCE, status: 'OPEN', endDate: { lte: now } },
    });
    const withStartsAtOld = await prisma.market.count({
      where: { oracleSource: ORACLE_SOURCE, status: 'OPEN', startsAt: { lte: resolveEligibleSince } },
    });
    console.log(
      '[oracle/cybersport] 0 eligible. OPEN pandascore total=',
      openCount,
      'endDate<=now=',
      withEndDatePast,
      'startsAt<=now-90min=',
      withStartsAtOld
    );
  }

  console.log(
    '[oracle/cybersport] OPEN markets eligible for resolution (endDate<=now, or endDate null & startsAt<now, or started ' +
      SAFETY_WINDOW_MINUTES +
      '+ min ago):',
    markets.length,
    markets.length > 0 ? 'oracleMatchIds sample: ' + [...new Set(markets.slice(0, 5).map((m) => m.oracleMatchId))].join(', ') : ''
  );

  const byMatch: Map<string, { markets: typeof markets; subCategory: string }> = new Map();
  for (const m of markets) {
    if (!m.oracleMatchId) continue;
    const sub = m.subCategory ?? 'cs2';
    const game: GameSlug = sub === 'dota2' ? GAMES.DOTA2 : sub === 'lol' ? GAMES.LOL : GAMES.CS2;
    const key = `${game}:${m.oracleMatchId}`;
    if (!byMatch.has(key)) byMatch.set(key, { markets: [], subCategory: sub });
    byMatch.get(key)!.markets.push(m);
  }

  const matchKeys = Array.from(byMatch.keys()).slice(0, RESOLUTION_MATCH_GROUPS_PER_RUN);

  const processGroup = async (key: string): Promise<number> => {
    let localResolved = 0;
    const { markets: group } = byMatch.get(key)!;
    const [game, matchIdStr] = key.split(':');
    const gameSlug = game as GameSlug;
    const firstMarket = group[0];
    const scheduledAt = firstMarket?.startsAt ?? new Date(0);

    let matchData: PandaMatch | null = null;
    try {
      matchData = await getMatch(gameSlug, matchIdStr);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith('PANDASCORE_404')) {
        // Try past endpoint: finished matches sometimes 404 on /matches/{id} but exist in /matches/past
        matchData = await getMatchFromPast(gameSlug, matchIdStr);
        if (matchData && (matchData.status ?? '').toLowerCase() === 'finished') {
          console.log('[oracle/cybersport] 404 on main endpoint but found in past, status=', matchData.status, '→ resolving');
          // Fall through to resolution logic below (matchData is set)
        } else {
          matchData = null;
          console.log('[oracle/cybersport] 404 for oracleMatchId=', matchIdStr, '(will retry, cancel only after', ORACLE_RETRY_MAX, 'failures)');
          const cancelled = await recordOracleErrorAndMaybeCancel(group, matchIdStr, 'PANDASCORE_404: match not found', errors);
          return localResolved + cancelled;
        }
      } else {
        const cancelled = await recordOracleErrorAndMaybeCancel(group, matchIdStr, msg, errors);
        return localResolved + cancelled;
      }
    }

    if (!matchData) {
      const cancelled = await recordOracleErrorAndMaybeCancel(
        group,
        matchIdStr,
        'timeout or network error',
        errors
      );
      return localResolved + cancelled;
    }

    const matchStatus = (matchData.status ?? '').toLowerCase();

    if (CANCELED_STATUSES.has(matchStatus)) {
      for (const market of group) {
        if (market.status !== 'OPEN') continue;
        try {
          await moveMarketToAwaitingResult(market.id);
          localResolved++;
          console.log('[oracle/cybersport] market', market.id, '→ AWAITING_RESULT: match status=', matchStatus);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`move awaiting ${market.id}: ${msg}`);
        }
      }
      return localResolved;
    }

    if (Date.now() - scheduledAt.getTime() > hardTimeoutMs && !FINISHED_STATUSES.has(matchStatus)) {
      for (const market of group) {
        if (market.status !== 'OPEN') continue;
        try {
          await moveMarketToAwaitingResult(market.id);
          localResolved++;
          console.log('[oracle/cybersport] market', market.id, '→ AWAITING_RESULT: hard timeout, status=', matchStatus);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`move awaiting ${market.id}: ${msg}`);
        }
      }
      return localResolved;
    }

    if (!FINISHED_STATUSES.has(matchStatus)) {
      console.log('[oracle/cybersport] match', matchIdStr, 'skipped: status="' + matchStatus + '" (not finished). Will retry next run.');
      return 0;
    }

    const opponents = matchData.opponents ?? [];
    const teamById = new Map<number, string>();
    opponents.forEach((o) => {
      const id = o?.opponent?.id;
      const name = o?.opponent?.name?.trim();
      if (id != null && name) teamById.set(id, name);
    });
    // Prefer winner_id / winner.id; when missing use winner from maps so we RESOLVE (by teamId) instead of skip
    let winnerId: number | null = matchData.winner_id ?? matchData.winner?.id ?? null;
    if (winnerId == null) {
      const derived = getMatchWinnerIdFromGames(matchData);
      if (derived != null) {
        winnerId = derived;
        console.log('[oracle/cybersport] match', key, 'winner id derived from games/maps:', winnerId);
      }
    }
    let winnerName: string | null = winnerId != null ? teamById.get(winnerId) ?? null : null;
    if (!winnerName && matchData.winner?.name?.trim()) winnerName = matchData.winner.name.trim();

    console.log(
      '[oracle/cybersport] match',
      key,
      'status=',
      matchStatus,
      'winnerId=',
      winnerId,
      'winnerName=',
      winnerName ?? 'null'
    );

    const gamesOrMapsList = getGamesOrMapsList(matchData);
    const firstGameWinnerId = getFirstGameWinnerId(matchData);
    const firstGameWinnerName = firstGameWinnerId != null ? teamById.get(firstGameWinnerId) ?? null : null;
    const totalMapsPlayed = getTotalPlayedCount(matchData);
    const lineForMatch = getLineForBO(matchData.number_of_games);

    // Diagnostics: log games/maps presence for each resolved match
    console.log(
      '[oracle/cybersport] match',
      key,
      'games/maps:',
      gamesOrMapsList.length,
      'hasGame1Winner:',
      firstGameWinnerId != null,
      'totalPlayed:',
      totalMapsPlayed
    );
    if (gamesOrMapsList.length === 0) {
      console.log(
        '[oracle/cybersport] match',
        key,
        'PandaScore did not return games/maps. Set DISABLE_GAME_MAPS_MARKETS=true to stop creating game1_winner/total_maps markets.'
      );
    }

    for (const market of group) {
      try {
        if (market.status !== 'OPEN') continue;
        let winningOutcome: string | null = null;

        if (market.marketType === 'match_winner') {
          // Resolve by teamId first (CS2: "BetBoom" vs "BetBoom Team"); fallback to name match
          if (winnerId != null) {
            const byId = matchOutcomeByTeamId(market.outcomes, market.outcomeTeamIds, winnerId);
            if (byId) winningOutcome = byId;
          }
          if (!winningOutcome && winnerName)
            winningOutcome = market.outcomes.includes(winnerName) ? winnerName : matchOutcomeRelaxed(market.outcomes, winnerName);
          if (!winningOutcome) {
            console.log('[oracle/cybersport] market', market.id, 'skipped: no winner for match_winner (winnerId=', winnerId, 'winnerName=', winnerName ?? 'null', ')');
            continue;
          }
        } else if (market.marketType === 'game1_winner') {
          if (gamesOrMapsList.length === 0 || firstGameWinnerId == null) {
            await moveMarketToAwaitingResult(market.id);
            localResolved++;
            console.log('[oracle/cybersport] market', market.id, '→ AWAITING_RESULT: no games/maps or no game1 winner');
            continue;
          }
          const byId = matchOutcomeByTeamId(market.outcomes, market.outcomeTeamIds, firstGameWinnerId);
          if (byId) winningOutcome = byId;
          if (!winningOutcome) winningOutcome = firstGameWinnerName ?? null;
          if (!winningOutcome) {
            await moveMarketToAwaitingResult(market.id);
            localResolved++;
            console.log('[oracle/cybersport] market', market.id, '→ AWAITING_RESULT: game1 winner_id not in opponents');
            continue;
          }
        } else if (market.marketType === 'total_maps') {
          if (gamesOrMapsList.length === 0 || totalMapsPlayed === 0) {
            await moveMarketToAwaitingResult(market.id);
            localResolved++;
            console.log('[oracle/cybersport] market', market.id, '→ AWAITING_RESULT: no games/maps or no finished games');
            continue;
          }
          const line = market.line ?? lineForMatch;
          winningOutcome = totalMapsPlayed > line ? `Over ${line}` : `Under ${line}`;
        }

        const matchedOutcome =
          winningOutcome && (market.outcomes.includes(winningOutcome) ? winningOutcome : matchOutcome(market.outcomes, winningOutcome));
        if (matchedOutcome) {
          await resolveMarketById(market.id, matchedOutcome);
          localResolved++;
          console.log('[oracle/cybersport] market resolved: marketId=', market.id, 'winningOutcome=', matchedOutcome);
        } else if (winningOutcome) {
          console.log(
            '[oracle/cybersport] market',
            market.id,
            'skipped: winning outcome "' + winningOutcome + '" not in market outcomes',
            'market.outcomes=',
            market.outcomes
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`resolve ${market.id}: ${msg}`);
        console.log('[oracle/cybersport] market', market.id, 'resolve error:', msg);
      }
    }
    return localResolved;
  };

  for (let i = 0; i < matchKeys.length; i += RESOLUTION_FETCH_CONCURRENCY) {
    if (shouldStopAllCalls()) break;
    const chunk = matchKeys.slice(i, i + RESOLUTION_FETCH_CONCURRENCY);
    const counts = await Promise.all(chunk.map((key) => processGroup(key)));
    resolved += counts.reduce((a, b) => a + b, 0);
  }

  console.log('[oracle/cybersport] resolved markets count:', resolved);
  return { resolved, errors, rateLimited: shouldStopAllCalls() };
}

/** Resolve one match by oracleMatchId (admin-only). Finds OPEN markets, fetches match, resolves all match_winner with same winnerOutcome. */
export async function resolveMatchByOracleMatchId(oracleMatchId: string): Promise<{
  ok: boolean;
  oracleMatchId: string;
  matchStatus?: string;
  winnerOutcome?: string;
  resolvedMarketIds: string[];
  error?: string;
}> {
  const resolvedMarketIds: string[] = [];
  const markets = await prisma.market.findMany({
    where: { oracleSource: ORACLE_SOURCE, status: 'OPEN', oracleMatchId },
    include: { bets: true },
  });
  if (markets.length === 0) {
    return { ok: false, oracleMatchId, resolvedMarketIds: [], error: 'No OPEN markets found for this oracleMatchId' };
  }
  const sub = markets[0].subCategory ?? 'cs2';
  const gameSlug: GameSlug = sub === 'dota2' ? GAMES.DOTA2 : sub === 'lol' ? GAMES.LOL : GAMES.CS2;
  let matchData: PandaMatch | null = null;
  try {
    matchData = await getMatch(gameSlug, oracleMatchId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, oracleMatchId, resolvedMarketIds: [], error: `Fetch failed: ${msg}` };
  }
  if (!matchData) {
    return { ok: false, oracleMatchId, resolvedMarketIds: [], error: 'Match not found (404/timeout)' };
  }
  const matchStatus = (matchData.status ?? '').toLowerCase();
  if (!FINISHED_STATUSES.has(matchStatus)) {
    return { ok: false, oracleMatchId, matchStatus, resolvedMarketIds: [], error: `Match not finished (status=${matchStatus})` };
  }
  const opponents = matchData.opponents ?? [];
  const teamById = new Map<number, string>();
  opponents.forEach((o) => {
    const id = o?.opponent?.id;
    const name = o?.opponent?.name?.trim();
    if (id != null && name) teamById.set(id, name);
  });
  let winnerId: number | null = matchData.winner_id ?? matchData.winner?.id ?? null;
  if (winnerId == null) winnerId = getMatchWinnerIdFromGames(matchData);
  let winnerName: string | null = winnerId != null ? teamById.get(winnerId) ?? null : null;
  if (!winnerName && matchData.winner?.name?.trim()) winnerName = matchData.winner.name.trim();
  if (winnerId == null && !winnerName) {
    return { ok: false, oracleMatchId, matchStatus, resolvedMarketIds: [], error: 'Could not determine winner' };
  }
  for (const market of markets) {
    if (market.marketType !== 'match_winner') continue;
    let matchedOutcome: string | null = null;
    if (winnerId != null) matchedOutcome = matchOutcomeByTeamId(market.outcomes, market.outcomeTeamIds, winnerId);
    if (!matchedOutcome && winnerName)
      matchedOutcome = market.outcomes.includes(winnerName) ? winnerName : matchOutcomeRelaxed(market.outcomes, winnerName);
    if (matchedOutcome) {
      await resolveMarketById(market.id, matchedOutcome);
      resolvedMarketIds.push(market.id);
    }
  }
  const resolvedName = winnerId != null ? teamById.get(winnerId) ?? winnerName ?? null : winnerName;
  return {
    ok: true,
    oracleMatchId,
    matchStatus,
    winnerOutcome: resolvedName ?? undefined,
    resolvedMarketIds,
  };
}

/** Reopen CANCELLED markets by oracleMatchId: reverse refund (deduct balance), set status OPEN. Then admin can call resolve-match. */
export async function reopenMatchByOracleMatchId(oracleMatchId: string): Promise<{
  ok: boolean;
  oracleMatchId: string;
  reopenedMarketIds: string[];
  error?: string;
}> {
  const markets = await prisma.market.findMany({
    where: { oracleSource: ORACLE_SOURCE, status: 'CANCELLED', oracleMatchId },
    include: { bets: true },
  });
  if (markets.length === 0) {
    return { ok: false, oracleMatchId, reopenedMarketIds: [], error: 'No CANCELLED markets found for this oracleMatchId' };
  }
  const reopenedMarketIds: string[] = [];
  for (const market of markets) {
    await prisma.$transaction(async (tx) => {
      for (const bet of market.bets) {
        await tx.user.update({
          where: { id: bet.userId },
          data: { balance: { decrement: bet.amount } },
        });
        await tx.transaction.create({
          data: {
            userId: bet.userId,
            type: 'BET_LOST',
            amount: bet.amount,
            description: JSON.stringify({
              marketId: market.id,
              betId: bet.id,
              source: 'oracle_reopen',
              reason: 'reverse_refund_before_resolve',
            }),
            marketId: market.id,
            betId: bet.id,
          },
        });
      }
      await tx.market.update({
        where: { id: market.id },
        data: {
          status: 'OPEN',
          resolvedAt: null,
          winningOutcome: null,
          oracleLastError: null,
          oracleLastErrorAt: null,
          oracleRetryCount: 0,
        },
      });
    });
    reopenedMarketIds.push(market.id);
  }
  console.log('[oracle/cybersport] reopen oracleMatchId=', oracleMatchId, 'reopened=', reopenedMarketIds);
  return { ok: true, oracleMatchId, reopenedMarketIds };
}

/** Cancel stale OPEN pandascore markets: createdAt older than N days (env CYBERSPORT_STALE_DAYS, default 7) or oracleMatchId null. */
export async function cancelStaleCybersportMarkets(): Promise<{ cancelled: number; errors: string[] }> {
  const errors: string[] = [];
  const staleDays = process.env.CYBERSPORT_STALE_DAYS ? parseInt(process.env.CYBERSPORT_STALE_DAYS, 10) : 7;
  const daysAgo = Number.isFinite(staleDays) && staleDays > 0 ? staleDays : 7;
  const cutoff = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  const stale = await prisma.market.findMany({
    where: {
      oracleSource: ORACLE_SOURCE,
      status: 'OPEN',
      OR: [{ createdAt: { lt: cutoff } }, { oracleMatchId: null }],
    },
    select: { id: true },
  });
  if (stale.length > 0) {
    console.log('[oracle/cybersport] cancel-stale: cutoff=', daysAgo, 'days, found', stale.length, 'OPEN markets');
  }
  let cancelled = 0;
  for (const m of stale) {
    try {
      await cancelMarketAndRefund(m.id);
      cancelled++;
      console.log('[oracle/cybersport] cancelled stale market', m.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${m.id}: ${msg}`);
    }
  }
  return { cancelled, errors };
}
