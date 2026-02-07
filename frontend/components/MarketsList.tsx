'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { marketsAPI } from '@/lib/api';

const SEARCH_DEBOUNCE_MS = 400;

interface Market {
  id: string;
  title: string;
  description?: string;
  category?: string;
  subCategory?: string;
  status: string;
  outcomes: string[];
  odds: Record<string, number>;
  totalVolume: number;
  createdAt: string;
  startsAt?: string | null;
  endDate?: string | null;
  resolvedAt?: string | null;
  winningOutcome?: string | null;
  oracleSource?: string | null;
  oracleMatchId?: string | null;
  marketType?: string | null;
  creator: {
    username: string;
  };
  _count: {
    bets: number;
  };
}

/** Format date in UTC for display (Politics: no local conversion). */
function formatUTC(date: string): string {
  return new Date(date).toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) + ' UTC';
}

/** Lifecycle for non-Politics (sports/cybersport): UPCOMING / LIVE / ENDED / AWAITING_RESULT. Uses endDate when set. */
function getMarketLifecycleStatus(market: Market): 'UPCOMING' | 'LIVE' | 'ENDED' | 'AWAITING_RESULT' {
  if (market.status === 'AWAITING_RESULT') return 'AWAITING_RESULT';
  if (market.status === 'RESOLVED' || market.status === 'CLOSED' || market.status === 'CANCELLED') return 'ENDED';
  const now = Date.now();
  const startsAt = market.startsAt ? new Date(market.startsAt).getTime() : null;
  const endAt = market.endDate ? new Date(market.endDate).getTime() : null;
  if (endAt != null && now >= endAt) return 'AWAITING_RESULT'; // match ended, awaiting resolution (OPEN or AWAITING_RESULT)
  if (startsAt != null && startsAt > now) return 'UPCOMING';
  if (startsAt != null && startsAt <= now) return 'LIVE';
  return market.status === 'OPEN' ? 'LIVE' : 'ENDED';
}

/** Politics-only: UPCOMING / LIVE / ENDED / AWAITING_RESULT / RESOLVED. Strict time boundaries. */
function getPoliticsLifecycleStatus(market: Market): 'UPCOMING' | 'LIVE' | 'ENDED' | 'AWAITING_RESULT' | 'RESOLVED' {
  if (market.status === 'AWAITING_RESULT') return 'AWAITING_RESULT';
  const now = Date.now();
  const startsAt = market.startsAt ? new Date(market.startsAt).getTime() : null;
  const endsAt = market.endDate ? new Date(market.endDate).getTime() : null;
  if (market.status === 'RESOLVED' || market.status === 'CLOSED' || market.status === 'CANCELLED') return 'RESOLVED';
  if (startsAt != null && now < startsAt) return 'UPCOMING';
  if (endsAt != null && now >= endsAt) return 'ENDED'; // betting closed, awaiting resolution
  if (startsAt != null && endsAt != null && now >= startsAt && now < endsAt) return 'LIVE';
  if (startsAt == null && endsAt != null && now < endsAt) return 'LIVE';
  if (startsAt != null && endsAt == null && now >= startsAt) return 'LIVE';
  return 'ENDED';
}

/** One card = one match. Politics uses 5-state lifecycle (incl. AWAITING_RESULT). */
type MarketGroup = {
  matchId: string;
  mainMarket: Market;
  subMarkets: Market[];
  lifecycleStatus: 'UPCOMING' | 'LIVE' | 'ENDED' | 'AWAITING_RESULT' | 'RESOLVED';
  startsAt: number | null;
  isPolitics: boolean;
};

function groupMarkets(markets: Market[]): MarketGroup[] {
  const groups = new Map<string, Market[]>();

  for (const m of markets) {
    const isEventGroup =
      (m.category === 'cybersport' || m.category === 'sports' || m.category === 'politics' || m.category === 'events') &&
      m.oracleSource &&
      m.oracleMatchId;
    const key = isEventGroup ? `${m.category}:${m.oracleMatchId}` : `single:${m.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }

  const result: MarketGroup[] = [];
  for (const [, arr] of groups) {
    if (arr.length === 0) continue;
    const main =
      arr.find((m) => m.marketType === 'match_winner') ?? arr.find((m) => m.marketType === 'event_outcome') ?? arr[0];
    const sub = arr.filter((m) => m.id !== main.id);
    const isPolitics = main.category === 'politics';
    const lifecycleStatus = isPolitics
      ? getPoliticsLifecycleStatus(main)
      : getMarketLifecycleStatus(main);
    const startsAt = main.startsAt ? new Date(main.startsAt).getTime() : null;
    result.push({
      matchId: main.oracleMatchId ?? main.id,
      mainMarket: main,
      subMarkets: sub,
      lifecycleStatus,
      startsAt,
      isPolitics,
    });
  }
  return result;
}

/** Sort: LIVE first, then UPCOMING (by startsAt asc), then ENDED, AWAITING_RESULT, RESOLVED. */
function sortGroups(groups: MarketGroup[]): MarketGroup[] {
  const order = (s: string) =>
    s === 'LIVE' ? 0 : s === 'UPCOMING' ? 1 : s === 'ENDED' ? 2 : s === 'AWAITING_RESULT' ? 3 : 4;
  return [...groups].sort((a, b) => {
    const oa = order(a.lifecycleStatus);
    const ob = order(b.lifecycleStatus);
    if (oa !== ob) return oa - ob;
    if (a.lifecycleStatus === 'UPCOMING' && b.lifecycleStatus === 'UPCOMING') {
      const sa = a.startsAt ?? Infinity;
      const sb = b.startsAt ?? Infinity;
      return sa - sb;
    }
    return (b.startsAt ?? 0) - (a.startsAt ?? 0);
  });
}

type StatusFilter = 'all' | 'LIVE' | 'UPCOMING' | 'AWAITING_RESULT' | 'RESOLVED';
type CategoryFilter = 'all' | 'cybersport' | 'sports' | 'politics' | 'events' | 'crypto';
type SubCategoryFilter = 'all' | 'cs2' | 'dota2' | 'lol' | 'nfl' | 'btc' | 'eth' | 'sol';

export default function MarketsList() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const [subCategoryFilter, setSubCategoryFilter] = useState<SubCategoryFilter>('all');
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedMatchId, setExpandedMatchId] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput]);

  const groupedAndSorted = useMemo(() => {
    const groups = groupMarkets(markets);
    const sorted = sortGroups(groups);
    if (statusFilter === 'all') return sorted;
    if (statusFilter === 'LIVE') return sorted.filter((g) => g.lifecycleStatus === 'LIVE');
    if (statusFilter === 'UPCOMING') return sorted.filter((g) => g.lifecycleStatus === 'UPCOMING');
    if (statusFilter === 'AWAITING_RESULT') return sorted.filter((g) => g.lifecycleStatus === 'AWAITING_RESULT');
    if (statusFilter === 'RESOLVED') return sorted.filter((g) => g.mainMarket.status === 'RESOLVED');
    return sorted;
  }, [markets, statusFilter]);

  useEffect(() => {
    fetchMarkets();
  }, [statusFilter, categoryFilter, subCategoryFilter, searchQuery]);

  const fetchMarkets = async () => {
    try {
      setLoading(true);
      const params: { category?: string; subCategory?: string; q?: string } = {};
      if (categoryFilter === 'cybersport') params.category = 'cybersport';
      if (categoryFilter === 'sports') params.category = 'sports';
      if (categoryFilter === 'politics') params.category = 'politics';
      if (categoryFilter === 'events') params.category = 'events';
      if (categoryFilter === 'crypto') params.category = 'crypto';
      if (categoryFilter === 'cybersport' && subCategoryFilter !== 'all') params.subCategory = subCategoryFilter;
      if (categoryFilter === 'sports' && subCategoryFilter !== 'all' && subCategoryFilter === 'nfl') params.subCategory = subCategoryFilter;
      if (categoryFilter === 'crypto' && subCategoryFilter !== 'all' && ['btc', 'eth', 'sol'].includes(subCategoryFilter)) params.subCategory = subCategoryFilter;
      if (searchQuery) params.q = searchQuery;
      const response = await marketsAPI.getAll(params);
      setMarkets(response.data);
    } catch (error) {
      console.error('Failed to fetch markets:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12 min-h-[120px]" aria-busy="true" aria-label="Loading markets">
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input
          type="search"
          placeholder="Search by keywords..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="px-3 py-2 rounded-lg border border-gray-300 dark:border-[rgba(255,255,255,0.2)] bg-white dark:bg-dark-secondary text-gray-900 dark:text-dark-text-primary placeholder-gray-500 dark:placeholder-dark-text-muted text-sm w-48 min-w-0 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
          aria-label="Search markets"
        />
      </div>
      <div className="flex flex-wrap gap-2 mb-4">
        <span className="text-sm text-gray-500 dark:text-dark-text-secondary self-center mr-1">Status:</span>
        {(['all', 'LIVE', 'UPCOMING', 'AWAITING_RESULT', 'RESOLVED'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setStatusFilter(f)}
            className={`px-4 py-2 rounded-lg transition ${
              statusFilter === f
                ? 'bg-primary-600 text-white'
                : 'bg-white dark:bg-dark-card text-gray-700 dark:text-dark-text-primary hover:dark:bg-dark-card-hover'
            }`}
          >
            {f === 'all' ? 'All' : f === 'LIVE' ? 'Live' : f === 'UPCOMING' ? 'Upcoming' : f === 'AWAITING_RESULT' ? 'Awaiting' : 'Resolved'}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 mb-6">
        <span className="text-sm text-gray-500 dark:text-dark-text-secondary self-center mr-1">Category:</span>
        <button
          onClick={() => { setCategoryFilter('all'); setSubCategoryFilter('all'); }}
          className={`px-4 py-2 rounded-lg transition ${
            categoryFilter === 'all'
              ? 'bg-primary-600 text-white'
              : 'bg-white dark:bg-dark-card text-gray-700 dark:text-dark-text-primary hover:dark:bg-dark-card-hover'
          }`}
        >
          All
        </button>
        <button
          onClick={() => setCategoryFilter('cybersport')}
          className={`px-4 py-2 rounded-lg transition ${
            categoryFilter === 'cybersport'
              ? 'bg-primary-600 text-white'
              : 'bg-white dark:bg-dark-card text-gray-700 dark:text-dark-text-primary hover:dark:bg-dark-card-hover'
          }`}
        >
          Cybersport
        </button>
        <button
          onClick={() => { setCategoryFilter('sports'); setSubCategoryFilter('all'); }}
          className={`px-4 py-2 rounded-lg transition ${
            categoryFilter === 'sports'
              ? 'bg-primary-600 text-white'
              : 'bg-white dark:bg-dark-card text-gray-700 dark:text-dark-text-primary hover:dark:bg-dark-card-hover'
          }`}
        >
          Sports
        </button>
        <button
          onClick={() => { setCategoryFilter('politics'); setSubCategoryFilter('all'); }}
          className={`px-4 py-2 rounded-lg transition ${
            categoryFilter === 'politics'
              ? 'bg-primary-600 text-white'
              : 'bg-white dark:bg-dark-card text-gray-700 dark:text-dark-text-primary hover:dark:bg-dark-card-hover'
          }`}
        >
          Politics
        </button>
        <button
          onClick={() => { setCategoryFilter('events'); setSubCategoryFilter('all'); }}
          className={`px-4 py-2 rounded-lg transition ${
            categoryFilter === 'events'
              ? 'bg-primary-600 text-white'
              : 'bg-white dark:bg-dark-card text-gray-700 dark:text-dark-text-primary hover:dark:bg-dark-card-hover'
          }`}
        >
          Events
        </button>
        <button
          onClick={() => { setCategoryFilter('crypto'); setSubCategoryFilter('all'); }}
          className={`px-4 py-2 rounded-lg transition ${
            categoryFilter === 'crypto'
              ? 'bg-primary-600 text-white'
              : 'bg-white dark:bg-dark-card text-gray-700 dark:text-dark-text-primary hover:dark:bg-dark-card-hover'
          }`}
        >
          Crypto
        </button>
        {categoryFilter === 'sports' && (
          <>
            <span className="text-sm text-gray-500 dark:text-dark-text-secondary self-center mx-1">|</span>
            {(['all', 'nfl'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSubCategoryFilter(s)}
                className={`px-3 py-1.5 text-sm rounded transition ${
                  subCategoryFilter === s
                    ? 'bg-primary-500 text-white'
                    : 'bg-gray-100 dark:bg-dark-secondary text-gray-700 dark:text-dark-text-primary hover:dark:bg-dark-card-hover'
                }`}
              >
                {s === 'all' ? 'All' : 'NFL'}
              </button>
            ))}
          </>
        )}
        {categoryFilter === 'cybersport' && (
          <>
            <span className="text-sm text-gray-500 dark:text-dark-text-secondary self-center mx-1">|</span>
            {(['all', 'cs2', 'dota2', 'lol'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSubCategoryFilter(s)}
                className={`px-3 py-1.5 text-sm rounded transition ${
                  subCategoryFilter === s
                    ? 'bg-primary-500 text-white'
                    : 'bg-gray-100 dark:bg-dark-secondary text-gray-700 dark:text-dark-text-primary hover:dark:bg-dark-card-hover'
                }`}
              >
                {s === 'all' ? 'All' : s.toUpperCase()}
              </button>
            ))}
          </>
        )}
        {categoryFilter === 'crypto' && (
          <>
            <span className="text-sm text-gray-500 dark:text-dark-text-secondary self-center mx-1">|</span>
            {(['all', 'btc', 'eth', 'sol'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSubCategoryFilter(s)}
                className={`px-3 py-1.5 text-sm rounded transition ${
                  subCategoryFilter === s
                    ? 'bg-primary-500 text-white'
                    : 'bg-gray-100 dark:bg-dark-secondary text-gray-700 dark:text-dark-text-primary hover:dark:bg-dark-card-hover'
                }`}
              >
                {s === 'all' ? 'All' : s.toUpperCase()}
              </button>
            ))}
          </>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {groupedAndSorted.map((group) => {
          const m = group.mainMarket;
          const isExpanded = expandedMatchId === group.matchId;
          const isLive = group.lifecycleStatus === 'LIVE';
          return (
            <div
              key={group.matchId}
              className="relative rounded-lg overflow-hidden transition-[transform,box-shadow] duration-150 ease-out hover:scale-[1.01] hover:shadow-xl dark:hover:shadow-xl/80"
            >
              {/* Live event: subtle pulsating green glow – #22c55e, opacity 0.15 → 0.3 → 0.15 */}
              {isLive && (
                <div
                  className="absolute inset-0 rounded-lg pointer-events-none animate-live-glow"
                  style={{
                    backgroundColor: 'rgb(34, 197, 94)',
                    boxShadow: 'inset 0 0 50px rgb(34, 197, 94)',
                  }}
                  aria-hidden
                />
              )}
              <div className="group/card relative bg-white dark:bg-dark-card rounded-lg shadow-md dark:hover:bg-dark-card-hover p-6 flex flex-col h-full">
              <div className="flex justify-between items-start mb-2">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-dark-text-primary">
                  {(m.title || '').replace(/\s*—\s*Match Winner$/, '').replace(/\s*—\s*Outcome$/, '') || m.title}
                </h3>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {m.category === 'cybersport' && m.subCategory && (
                    <span className="px-2 py-0.5 text-xs rounded bg-purple-100 text-purple-800 dark:bg-dark-secondary dark:text-dark-text-secondary">
                      {m.subCategory.toUpperCase()}
                    </span>
                  )}
                  {m.category === 'sports' && m.subCategory && (
                    <span className="px-2 py-0.5 text-xs rounded bg-emerald-100 text-emerald-800 dark:bg-dark-secondary dark:text-dark-text-secondary">
                      {m.subCategory.toUpperCase()}
                    </span>
                  )}
                  {m.category === 'politics' && (
                    <span className="px-2 py-0.5 text-xs rounded bg-blue-100 text-blue-800 dark:bg-dark-secondary dark:text-dark-text-secondary">
                      POLITICS
                    </span>
                  )}
                  {m.category === 'events' && m.subCategory && (
                    <span className="px-2 py-0.5 text-xs rounded bg-pink-100 text-pink-800 dark:bg-dark-secondary dark:text-dark-text-secondary">
                      {m.subCategory.toUpperCase()}
                    </span>
                  )}
                  {m.category === 'crypto' && m.subCategory && (
                    <span className="px-2 py-0.5 text-xs rounded bg-amber-100 text-amber-800 dark:bg-dark-secondary dark:text-dark-text-secondary">
                      {m.subCategory.toUpperCase()}
                    </span>
                  )}
                  <span
                    className={`px-2 py-1 text-xs rounded ${
                      group.lifecycleStatus === 'UPCOMING'
                        ? 'bg-slate-100 text-slate-700 dark:bg-dark-upcoming-bg dark:text-dark-upcoming-text'
                        : group.lifecycleStatus === 'LIVE'
                        ? 'bg-green-100 text-green-800 dark:bg-dark-live-bg dark:text-dark-live-text animate-live-badge'
                        : group.lifecycleStatus === 'ENDED'
                        ? 'bg-blue-100 text-blue-800 dark:bg-dark-ended-bg dark:text-dark-ended-text'
                        : group.lifecycleStatus === 'AWAITING_RESULT'
                        ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400'
                        : group.lifecycleStatus === 'RESOLVED'
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400'
                        : 'bg-gray-100 text-gray-800 dark:bg-dark-secondary dark:text-dark-text-secondary'
                    }`}
                  >
                    {group.lifecycleStatus === 'AWAITING_RESULT' ? 'Awaiting' : group.lifecycleStatus}
                  </span>
                </div>
              </div>

              {group.isPolitics ? (
                <>
                  {m.startsAt && (
                    <p className="text-xs text-gray-500 dark:text-dark-text-secondary mb-0.5">
                      Starts at: {formatUTC(m.startsAt)}
                    </p>
                  )}
                  {m.endDate && (
                    <p className="text-xs text-gray-500 dark:text-dark-text-secondary mb-1">
                      Ends at: {formatUTC(m.endDate)}
                    </p>
                  )}
                  {group.lifecycleStatus === 'LIVE' && (
                    <p className="text-xs text-green-600 dark:text-dark-live-text mb-1">Live now — betting open</p>
                  )}
                  {group.lifecycleStatus === 'ENDED' && (
                    <p className="text-xs text-gray-600 dark:text-dark-text-secondary mb-1">
                      Ended at: {m.endDate ? formatUTC(m.endDate) : '—'}. Betting closed. Awaiting political outcome.
                    </p>
                  )}
                  {group.lifecycleStatus === 'AWAITING_RESULT' && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mb-1">Under review. Result will be confirmed soon.</p>
                  )}
                  {group.lifecycleStatus === 'RESOLVED' && m.winningOutcome && (
                    <p className="text-xs text-emerald-600 dark:text-emerald-400 mb-1">
                      Resolved: {m.winningOutcome}
                      {m.resolvedAt && ` at ${formatUTC(m.resolvedAt)}`}
                    </p>
                  )}
                </>
              ) : (
                <>
                  {m.startsAt && (
                    <p className="text-xs text-gray-500 dark:text-dark-text-secondary mb-1">
                      Starts at: {formatUTC(m.startsAt)}
                    </p>
                  )}
                  {group.lifecycleStatus === 'LIVE' && (
                    <p className="text-xs text-green-600 dark:text-dark-live-text mb-1">Live now</p>
                  )}
                  {group.lifecycleStatus === 'ENDED' && m.winningOutcome && (
                    <p className="text-xs text-blue-600 dark:text-dark-ended-text mb-1">
                      Resolved: {m.winningOutcome}
                    </p>
                  )}
                  {group.lifecycleStatus === 'AWAITING_RESULT' && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mb-1">Under review. Result will be confirmed soon.</p>
                  )}
                  {group.lifecycleStatus === 'ENDED' && !m.winningOutcome && (
                    <p className="text-xs text-gray-500 dark:text-dark-text-muted mb-1">Awaiting result</p>
                  )}
                </>
              )}

              {/* Match Winner (main) — always visible */}
              <div className="space-y-2 mb-4">
                {m.marketType !== 'match_winner' && (
                  <p className="text-xs font-medium text-gray-500 dark:text-dark-text-muted uppercase">Primary</p>
                )}
                {m.outcomes.map((outcome) => (
                  <Link
                    key={outcome}
                    href={`/markets/${m.id}`}
                    className="flex justify-between items-center p-2 bg-gray-50 dark:bg-dark-secondary rounded hover:bg-gray-100 dark:hover:bg-dark-card-hover transition-[background-color,transform] duration-150 ease-out"
                  >
                    <span className="text-sm font-medium text-gray-700 dark:text-dark-text-primary">{outcome}</span>
                    <span className="text-sm font-bold text-primary-600 dark:text-primary-400 group-hover/card:text-primary-500 dark:group-hover/card:text-primary-300 transition-colors duration-150">{m.odds[outcome]?.toFixed(2)}x</span>
                  </Link>
                ))}
              </div>

              {/* Show more: Game 1 Winner, Total Maps, etc. — inherits dark card */}
              {group.subMarkets.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => setExpandedMatchId(isExpanded ? null : group.matchId)}
                    className="text-sm text-primary-600 dark:text-primary-400 font-medium mb-2 self-start"
                  >
                    {isExpanded ? 'Show less' : 'Show more'}
                  </button>
                  {isExpanded && (
                    <div className="space-y-3 pt-2 border-t border-gray-200 dark:border-[rgba(255,255,255,0.08)]">
                      {group.subMarkets.map((sub) => (
                        <div key={sub.id}>
                          <Link
                            href={`/markets/${sub.id}`}
                            className="text-sm font-medium text-gray-700 dark:text-dark-text-primary hover:text-primary-600 dark:hover:text-primary-400 block mb-1"
                          >
                            {sub.title}
                          </Link>
                          <div className="space-y-1">
                            {sub.outcomes.map((outcome) => (
                              <Link
                                key={outcome}
                                href={`/markets/${sub.id}`}
                                className="flex justify-between items-center px-2 py-1 bg-gray-50 dark:bg-dark-secondary rounded text-sm hover:dark:bg-dark-card-hover transition"
                              >
                                <span className="text-gray-600 dark:text-dark-text-secondary">{outcome}</span>
                                <span className="font-bold text-primary-600 dark:text-primary-400">{sub.odds[outcome]?.toFixed(2)}x</span>
                              </Link>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              <div className="flex justify-between items-center text-xs text-gray-500 dark:text-dark-text-muted mt-auto pt-2">
                <span>By {m.creator.username}</span>
                <span>${m.totalVolume.toFixed(2)} volume</span>
              </div>
              </div>
            </div>
          );
        })}
      </div>

      {groupedAndSorted.length === 0 && (
        <div className="text-center py-12 max-w-md mx-auto">
          <p className="text-gray-500 dark:text-dark-text-secondary">
            No markets found. Be the first to create one!
          </p>
        </div>
      )}
    </div>
  );
}
