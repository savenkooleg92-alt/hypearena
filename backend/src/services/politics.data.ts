/**
 * Politics prediction markets data source.
 * Resolution: one fetch of battle feed per cycle; match by oracleMatchId (battleId) first, title fallback.
 * Outcome mapping depends on market.outcomes only; UNMAPPED → no resolve, hard-timeout → CANCELLED+refund.
 */

import crypto from 'crypto';
import prisma from '../utils/prisma';
import { fetchPoliticsSuggestions, type PoliticsSuggestion, type BattleOutcome } from './politics-feed.service';

export interface PoliticsEvent {
  id: string;
  title: string;
  eventType: string;
  resolveBy: Date;
  outcomes: string[];
}

/** Normalize title for matching: lowercase, collapse spaces, remove common suffixes. */
export function normalizeTitleForMatch(title: string): string {
  return title
    .replace(/\s*—\s*Outcome\s*$/i, '')
    .replace(/\s*–\s*Outcome\s*$/i, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Stable battle id from title + publishedAt (used as oracleMatchId at discovery). */
export function getStableBattleId(title: string, publishedAt: string): string {
  const norm = normalizeTitleForMatch(title);
  const hash = crypto.createHash('sha256').update(norm + '|' + publishedAt).digest('hex').slice(0, 16);
  return 'battle-' + hash;
}

export type BattleFeedEntry = {
  outcome: BattleOutcome;
  suggestedOutcomes: string[];
  battleId: string;
};

/** One fetch per cycle: battle feed indexed by battleId and by normalized title. */
export async function fetchBattlesFeedForResolution(): Promise<{
  byBattleId: Map<string, BattleFeedEntry>;
  byTitle: Map<string, BattleFeedEntry>;
}> {
  const byBattleId = new Map<string, BattleFeedEntry>();
  const byTitle = new Map<string, BattleFeedEntry>();
  try {
    const suggestions = await fetchPoliticsSuggestions(80);
    for (const s of suggestions) {
      if (s.outcome == null || s.status !== 'RESOLVED') continue;
      const battleId = getStableBattleId(s.title, s.publishedAt);
      const entry: BattleFeedEntry = { outcome: s.outcome, suggestedOutcomes: s.suggestedOutcomes, battleId };
      byBattleId.set(battleId, entry);
      const titleKey = normalizeTitleForMatch(s.title);
      if (!byTitle.has(titleKey)) byTitle.set(titleKey, entry);
    }
    return { byBattleId, byTitle };
  } catch (e) {
    console.warn('[politics.data] fetchBattlesFeedForResolution error:', e instanceof Error ? e.message : String(e));
    return { byBattleId, byTitle };
  }
}

/** Canonical labels for "positive" and "negative" battle result (lowercase for matching). */
const POSITIVE_LABELS = new Set([
  'yes', 'passed', 'approved', 'win', 'imposed', 'lifted', 'will', 'survived', 'adopted',
]);
const NEGATIVE_LABELS = new Set([
  'no', 'failed', 'rejected', 'lose', 'lost', 'ousted', 'will not', 'blocked',
]);
const POSITIVE_OUTCOMES = new Set<BattleOutcome>(['YES', 'PASSED', 'APPROVED', 'WIN', 'IMPOSED', 'LIFTED', 'WILL']);
const NEGATIVE_OUTCOMES = new Set<BattleOutcome>(['NO', 'FAILED', 'REJECTED', 'LOSE', 'WILL NOT']);

/**
 * Map battle outcome to exactly one market outcome. Depends on market.outcomes (and marketType if needed).
 * Returns null (UNMAPPED) if outcome cannot be mapped unambiguously.
 */
export function mapBattleOutcomeToMarketOutcome(
  battleOutcome: BattleOutcome,
  suggestedOutcomes: string[],
  marketOutcomes: string[],
  _marketType?: string
): string | null {
  if (!marketOutcomes.length) return null;
  const isPositive = POSITIVE_OUTCOMES.has(battleOutcome);
  const isNegative = NEGATIVE_OUTCOMES.has(battleOutcome);
  if (!isPositive && !isNegative) return null;

  const targetSet = isPositive ? POSITIVE_LABELS : NEGATIVE_LABELS;
  const norm = (s: string) => s.trim().toLowerCase();
  const normalizedOutcomes = marketOutcomes.map((o) => ({ original: o, norm: norm(o) }));
  const matches = normalizedOutcomes.filter(({ norm: n }) => targetSet.has(n) || targetSet.has((n.split(/\s+/)[0] ?? n)));
  if (matches.length === 1) return matches[0].original;
  if (matches.length > 1) return null;

  if (marketOutcomes.length === 2 && suggestedOutcomes.length >= 2) {
    const s0 = norm(suggestedOutcomes[0]);
    const m0 = norm(marketOutcomes[0]);
    if (s0 === m0 || s0.includes(m0) || m0.includes(s0)) {
      return isPositive ? marketOutcomes[0] : marketOutcomes[1];
    }
  }
  return null;
}

const DATE_WINDOW_DAYS = 30; // past + next N days
/** For ONGOING (no outcome yet): market stays open this many days from article date. */
const ONGOING_RESOLVE_AFTER_DAYS = 7;

/** Fetch upcoming political events from battles feed (for discovery). Returns events + diagnostics. */
export async function fetchUpcomingPoliticsEventsWithDiagnostics(): Promise<{
  events: PoliticsEvent[];
  enabled: boolean;
  fetched: number;
  afterResolvedFilter: number;
  afterDateFilter: number;
  error?: string;
}> {
  const enabled = process.env.POLITICS_ORACLE_ENABLED === 'true' || process.env.POLITICS_ORACLE_ENABLED === '1';
  if (!enabled) {
    return { events: [], enabled: false, fetched: 0, afterResolvedFilter: 0, afterDateFilter: 0 };
  }
  try {
    const suggestions = await fetchPoliticsSuggestions(50);
    const fetched = suggestions.length;
    const now = new Date();
    const windowMs = DATE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    // RESOLVED (headline has outcome) + ONGOING (upcoming vote/bill, no outcome yet) → more "new" open markets
    const forDiscovery = suggestions.filter(
      (s) => (s.outcome != null && s.status === 'RESOLVED') || s.status === 'ONGOING'
    );
    const afterResolvedFilter = forDiscovery.length;
    const events = forDiscovery
      .map((s) => {
        const publishedAt = new Date(s.publishedAt);
        const resolveBy =
          s.status === 'ONGOING'
            ? new Date(publishedAt.getTime() + ONGOING_RESOLVE_AFTER_DAYS * 24 * 60 * 60 * 1000)
            : publishedAt;
        return {
          id: getStableBattleId(s.title, s.publishedAt),
          title: s.title,
          eventType: 'politics',
          resolveBy,
          outcomes: s.suggestedOutcomes,
        };
      })
      .filter((ev) => {
        const t = ev.resolveBy.getTime() - now.getTime();
        return t <= 0 || (t > 0 && t < windowMs);
      });
    return {
      events,
      enabled: true,
      fetched,
      afterResolvedFilter,
      afterDateFilter: events.length,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.warn('[politics.data] fetchUpcomingPoliticsEvents error:', error);
    return {
      events: [],
      enabled: true,
      fetched: 0,
      afterResolvedFilter: 0,
      afterDateFilter: 0,
      error,
    };
  }
}

/** Fetch upcoming political events (for discovery). oracleMatchId = battleId (stable). */
export async function fetchUpcomingPoliticsEvents(): Promise<PoliticsEvent[]> {
  const { events } = await fetchUpcomingPoliticsEventsWithDiagnostics();
  return events;
}

/**
 * Legacy: fetch result for one market (resolver now uses fetchBattlesFeedForResolution + map per cycle).
 * Kept for backward compatibility / manual use.
 */
export async function fetchPoliticsEventResult(
  marketIdOrEventId: string
): Promise<{ winningOutcome: string } | null> {
  const market = await prisma.market.findUnique({
    where: { id: marketIdOrEventId },
    select: { id: true, title: true, outcomes: true, oracleMatchId: true, oracleSource: true, category: true },
  });
  if (!market || (market.oracleSource !== 'politics' && market.category !== 'politics')) return null;
  const titleToMatch = market.title ?? null;
  if (!titleToMatch) return null;
  try {
    const { byBattleId, byTitle } = await fetchBattlesFeedForResolution();
    let entry: BattleFeedEntry | undefined = market.oracleMatchId ? byBattleId.get(market.oracleMatchId) : undefined;
    if (!entry) entry = byTitle.get(normalizeTitleForMatch(titleToMatch));
    if (!entry) return null;
    const winning = mapBattleOutcomeToMarketOutcome(entry.outcome, entry.suggestedOutcomes, market.outcomes);
    return winning != null ? { winningOutcome: winning } : null;
  } catch (e) {
    console.warn('[politics.data] fetchPoliticsEventResult error:', e instanceof Error ? e.message : String(e));
    return null;
  }
}
