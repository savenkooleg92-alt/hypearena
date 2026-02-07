/**
 * PandaScore API client with global rate limiter and 429 backoff.
 * Limit 950/hour (under 1000) so resolution and discovery can run often and outcomes are resolved reliably.
 */

const BASE_URL = 'https://api.pandascore.co';

// Token bucket: 950/hour (env PANDASCORE_HOURLY_LIMIT overrides). Stop when < 50 tokens or at cap.
const CAPACITY = process.env.PANDASCORE_HOURLY_LIMIT ? Math.min(950, Math.max(100, parseInt(process.env.PANDASCORE_HOURLY_LIMIT, 10) || 950)) : 950;
const REFILL_PER_SECOND = CAPACITY / 3600;
const MIN_TOKENS_BEFORE_STOP = 50;
const MAX_PREDICTED_PER_HOUR = CAPACITY;

// 429 backoff: 30s, 60s, 120s (cap at 10 min = 600s), max 10 retries
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 600_000;
const BACKOFF_MULTIPLIER = 2;
const MAX_RETRIES = 10;

interface TokenBucket {
  tokens: number;
  lastRefillAt: number;
  requestsInLastHour: number[];
}

let bucket: TokenBucket = {
  tokens: CAPACITY,
  lastRefillAt: Date.now(),
  requestsInLastHour: [],
};

function refill(): void {
  const now = Date.now();
  const elapsed = (now - bucket.lastRefillAt) / 1000;
  bucket.tokens = Math.min(CAPACITY, bucket.tokens + elapsed * REFILL_PER_SECOND);
  bucket.lastRefillAt = now;
  // Prune requests older than 1 hour
  const oneHourAgo = now - 3600 * 1000;
  bucket.requestsInLastHour = bucket.requestsInLastHour.filter((t) => t > oneHourAgo);
}

/** Returns true if we must not make any more calls (hard cap). */
export function shouldStopAllCalls(): boolean {
  refill();
  if (bucket.tokens < MIN_TOKENS_BEFORE_STOP) return true;
  if (bucket.requestsInLastHour.length >= MAX_PREDICTED_PER_HOUR) return true;
  return false;
}

/** Consume one token. Returns true if token was available and consumed, false to skip. */
export function consumeToken(): boolean {
  refill();
  if (bucket.tokens < 1) return false;
  if (bucket.requestsInLastHour.length >= MAX_PREDICTED_PER_HOUR) return false;
  bucket.tokens -= 1;
  bucket.requestsInLastHour.push(Date.now());
  return true;
}

/** Stats for GET /api/oracle/status */
export function getLimiterStats(): {
  tokensRemaining: number;
  requestsInLastHour: number;
  shouldStop: boolean;
} {
  refill();
  return {
    tokensRemaining: Math.floor(bucket.tokens),
    requestsInLastHour: bucket.requestsInLastHour.length,
    shouldStop: shouldStopAllCalls(),
  };
}

function getApiKey(): string {
  let key = process.env.PANDASCORE_API_KEY?.trim() ?? '';
  if (key.startsWith('"') && key.endsWith('"')) key = key.slice(1, -1).trim();
  if (key.startsWith("'") && key.endsWith("'")) key = key.slice(1, -1).trim();
  if (!key) throw new Error('PANDASCORE_API_KEY is not set');
  return key;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PANDASCORE_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Fetch from PandaScore with Bearer auth, rate limit, 429 backoff.
 * 404: throws PANDASCORE_404 (no retry). Optional timeout (default 15s for match fetches).
 */
export async function pandascoreRequest<T>(
  path: string,
  options?: { method?: string; body?: unknown; timeoutMs?: number }
): Promise<T> {
  if (shouldStopAllCalls()) {
    throw new Error('PANDASCORE_RATE_LIMIT: hard cap reached, skip and try later');
  }
  if (!consumeToken()) {
    throw new Error('PANDASCORE_RATE_LIMIT: no tokens, skip and try later');
  }

  const url = path.startsWith('http') ? path : `${BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`;
  const method = options?.method ?? 'GET';
  const timeoutMs = options?.timeoutMs ?? PANDASCORE_REQUEST_TIMEOUT_MS;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${getApiKey()}`,
    Accept: 'application/json',
  };
  let body: string | undefined;
  if (options?.body != null) {
    body = JSON.stringify(options.body);
    headers['Content-Type'] = 'application/json';
  }

  let lastError: Error | null = null;
  let backoffMs = BACKOFF_BASE_MS;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, headers, body, signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.status === 429) {
        if (attempt >= MAX_RETRIES) {
          throw new Error(`PANDASCORE_429: max retries (${MAX_RETRIES}) exceeded`);
        }
        const wait = Math.min(backoffMs, BACKOFF_MAX_MS);
        await sleep(wait);
        backoffMs *= BACKOFF_MULTIPLIER;
        continue;
      }
      if (res.status === 404) {
        throw new Error('PANDASCORE_404: match not found');
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`PANDASCORE_HTTP_${res.status}: ${text.slice(0, 200)}`);
      }
      const data = await res.json();
      return data as T;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      clearTimeout(timeoutId);
      if (lastError.message.startsWith('PANDASCORE_404')) throw lastError;
      if (lastError.message.startsWith('PANDASCORE_TIMEOUT')) throw lastError;
      if (lastError.name === 'AbortError') throw new Error('PANDASCORE_TIMEOUT: request timed out');
      if (lastError.message.startsWith('PANDASCORE_429') && attempt < MAX_RETRIES) {
        const wait = Math.min(backoffMs, BACKOFF_MAX_MS);
        await sleep(wait);
        backoffMs *= BACKOFF_MULTIPLIER;
        continue;
      }
      throw lastError;
    }
  }
  throw lastError ?? new Error('PANDASCORE_REQUEST_FAILED');
}

/** Game slugs for PandaScore: csgo (CS2), dota2, lol */
export const GAMES = {
  CS2: 'csgo',
  DOTA2: 'dota2',
  LOL: 'lol',
} as const;

export type GameSlug = (typeof GAMES)[keyof typeof GAMES];

/** Upcoming matches for a game. Pagination: per_page=50, page=1..n */
export async function getUpcomingMatches(
  game: GameSlug,
  page = 1,
  perPage = 50
): Promise<PandaMatch[]> {
  const path = `/${game}/matches/upcoming?per_page=${perPage}&page=${page}`;
  const data = await pandascoreRequest<PandaMatch[]>(path);
  return Array.isArray(data) ? data : [];
}

/** Thrown when PandaScore returns 404 (match not found). Caller should CANCELLED+refund. */
export const PANDASCORE_404 = 'PANDASCORE_404';

/** Single match by id (game-specific endpoint). 404 → throws Error(PANDASCORE_404). Timeout/other → null (retry later). */
export async function getMatch(game: GameSlug, matchId: string | number): Promise<PandaMatch | null> {
  try {
    const path = `/${game}/matches/${matchId}`;
    return await pandascoreRequest<PandaMatch>(path, { timeoutMs: PANDASCORE_REQUEST_TIMEOUT_MS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith('PANDASCORE_404')) throw e;
    return null;
  }
}

/** Past matches filtered by id. Use when GET /matches/{id} returns 404 (e.g. finished match not yet in main endpoint). */
export async function getMatchFromPast(game: GameSlug, matchId: string | number): Promise<PandaMatch | null> {
  try {
    const path = `/${game}/matches/past?filter[id]=${encodeURIComponent(String(matchId))}&per_page=1`;
    const data = await pandascoreRequest<PandaMatch[]>(path, { timeoutMs: PANDASCORE_REQUEST_TIMEOUT_MS });
    const match = Array.isArray(data) && data.length > 0 ? data[0] : null;
    return match ?? null;
  } catch {
    return null;
  }
}

/** Single game/map item: PandaScore may use `games` (LoL/Dota) or `maps` (CS). */
export interface PandaGameOrMap {
  id?: number;
  number?: number;
  position?: number;
  winner_id?: number | null;
  winner?: { id: number } | null;
  status?: string;
  score?: unknown; // game-specific
}

// Minimal types for PandaScore match (fixtures)
export interface PandaMatch {
  id: number;
  name?: string;
  scheduled_at?: string; // ISO date
  status?: string; // not_started | running | finished
  number_of_games?: number; // BO3 → 3, BO5 → 5
  opponents?: Array<{
    opponent?: { id: number; name: string; image_url?: string } | null;
  }>;
  winner_id?: number | null;
  /** Some PandaScore responses use winner object instead of/in addition to winner_id */
  winner?: { id: number; name?: string; type?: string } | null;
  games?: PandaGameOrMap[];
  maps?: PandaGameOrMap[];
}

/** Unified list: games or maps (PandaScore uses one per title). */
export function getGamesOrMapsList(m: PandaMatch): PandaGameOrMap[] {
  const arr = m.games ?? m.maps ?? [];
  return Array.isArray(arr) ? arr : [];
}

/** True if item has position/number and has a result (winner_id or winner.id or score). */
function gameOrMapHasResult(item: PandaGameOrMap): boolean {
  const hasOrder = item.number != null || item.position != null;
  const hasWinner = item.winner_id != null || (item.winner?.id != null);
  const hasScore = item.score != null;
  return Boolean(hasOrder && (hasWinner || hasScore));
}

/** True if match has at least one game/map with order and result (safe to create game1/total_maps markets). */
export function hasUsableGamesOrMaps(m: PandaMatch): boolean {
  const list = getGamesOrMapsList(m);
  if (list.length === 0) return false;
  return list.some(gameOrMapHasResult);
}

/** First played game/map (min number/position) that has winner_id or winner.id. Returns winner id or null. */
export function getFirstGameWinnerId(m: PandaMatch): number | null {
  const list = getGamesOrMapsList(m);
  const withWinner = list.filter(
    (g) => (g.winner_id != null || g.winner?.id != null) && (g.number != null || g.position != null)
  );
  if (withWinner.length === 0) return null;
  const sorted = [...withWinner].sort((a, b) => {
    const na = a.number ?? a.position ?? 0;
    const nb = b.number ?? b.position ?? 0;
    return na - nb;
  });
  const first = sorted[0];
  const id = first.winner_id ?? first.winner?.id ?? null;
  return id != null ? id : null;
}

/** Count of games/maps that have a winner (finished). */
export function getTotalPlayedCount(m: PandaMatch): number {
  const list = getGamesOrMapsList(m);
  return list.filter((g) => g.winner_id != null || g.winner?.id != null).length;
}

/** Derive match winner from games/maps when winner_id is missing. Returns team id that won the majority, or null if tie/no data. */
export function getMatchWinnerIdFromGames(m: PandaMatch): number | null {
  const list = getGamesOrMapsList(m);
  const wins = new Map<number, number>();
  for (const g of list) {
    const id = g.winner_id ?? g.winner?.id ?? null;
    if (id == null) continue;
    wins.set(id, (wins.get(id) ?? 0) + 1);
  }
  if (wins.size === 0) return null;
  const sorted = [...wins.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted[0][1] === (sorted[1]?.[1] ?? 0)) return null; // tie
  return sorted[0][0];
}
