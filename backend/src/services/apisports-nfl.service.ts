/**
 * API-Sports American Football (NFL) API client.
 * Base URL from NFL_BASE_URL; auth via x-apisports-key.
 * Rate limit: 100 requests/day (free tier). Track per calendar day; skip cycle if limit reached.
 */

const DEFAULT_BASE_URL = 'https://v1.american-football.api-sports.io';

const DAILY_LIMIT = 100;
/** Max requests per resolution cycle to avoid burning the daily quota. */
const MAX_REQUESTS_PER_RESOLUTION_CYCLE = 30;
/** Max requests per discovery cycle. */
const MAX_REQUESTS_PER_DISCOVERY_CYCLE = 5;

/** Calendar day key (YYYY-MM-DD) -> number of requests made that day. */
const requestsByDay = new Map<string, number>();

/** Mask for logging: "https://v1.american-football.api-sports.io" -> "https://v1.amer***sports.io" */
function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname;
    if (host.length <= 10) return host + '***';
    return host.slice(0, 4) + '***' + host.slice(-6);
  } catch {
    return '***';
  }
}

/** Mask API key for logging: first 4 + ... + last 4 */
function maskKey(key: string): string {
  if (!key || key.length < 12) return '***';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

let configLogged = false;
function logConfigOnce(): void {
  if (configLogged) return;
  configLogged = true;
  const base = getBaseUrl();
  const key = process.env.APISPORTS_API_KEY;
  console.log(
    '[apisports-nfl] config: baseURL=' + maskUrl(base) + ', apiKey=' + (key ? maskKey(key) : 'NOT SET') + ', enabledSports=[nfl]'
  );
}

function getTodayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function getApiKey(): string {
  const key = process.env.APISPORTS_API_KEY;
  if (!key) throw new Error('APISPORTS_API_KEY is not set');
  return key;
}

function getBaseUrl(): string {
  const url = process.env.NFL_BASE_URL ?? DEFAULT_BASE_URL;
  return url.replace(/\/$/, '');
}

/** Current requests used today (for logging). */
export function getRequestsUsedToday(): number {
  return requestsByDay.get(getTodayKey()) ?? 0;
}

/** Returns true if we must not make more calls this day (daily limit reached). */
export function isDailyLimitReached(): boolean {
  return (requestsByDay.get(getTodayKey()) ?? 0) >= DAILY_LIMIT;
}

/** Consume one request. Returns true if allowed and consumed, false if limit reached. */
function consumeRequest(): boolean {
  const key = getTodayKey();
  const used = requestsByDay.get(key) ?? 0;
  if (used >= DAILY_LIMIT) return false;
  requestsByDay.set(key, used + 1);
  return true;
}

/** Optional: prune old keys to avoid unbounded map growth (keep last 2 days). */
function pruneOldKeys(): void {
  const today = getTodayKey();
  for (const key of requestsByDay.keys()) {
    if (key < today) requestsByDay.delete(key);
  }
}

export interface ApiSportsNflGame {
  id: number;
  date: string;
  time?: string;
  timestamp?: number;
  status?: { short?: string; long?: string };
  league?: { id?: number; name?: string };
  season?: string;
  teams?: {
    home?: { id?: number; name?: string };
    away?: { id?: number; name?: string };
  };
  scores?: {
    home?: number | null;
    away?: number | null;
  };
}

/** Raw API response: response array or wrapper with response/key. */
type ApiResponse = { response?: ApiSportsNflGame[] } | ApiSportsNflGame[];

const SPORT_LABEL = 'nfl';

async function request<T>(path: string): Promise<T> {
  logConfigOnce();
  pruneOldKeys();
  if (!consumeRequest()) {
    throw new Error('APISPORTS_NFL_DAILY_LIMIT: 100 requests/day reached, skip cycle');
  }
  const base = getBaseUrl();
  const url = path.startsWith('http') ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`;
  const endpoint = path.startsWith('http') ? path : path;
  const start = Date.now();
  let status: number;
  try {
    const res = await fetch(url, {
      headers: {
        'x-apisports-key': getApiKey(),
        Accept: 'application/json',
      },
    });
    status = res.status;
    if (res.status === 404) {
      console.log(
        `[apisports-nfl] request sport=${SPORT_LABEL} endpoint=${endpoint} status=${status} latencyMs=${Date.now() - start}`
      );
      return { response: [] } as T;
    }
    if (!res.ok) {
      const text = await res.text();
      console.log(
        `[apisports-nfl] request sport=${SPORT_LABEL} endpoint=${endpoint} status=${status} latencyMs=${Date.now() - start} error=${text.slice(0, 80)}`
      );
      throw new Error(`APISPORTS_NFL_HTTP_${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as ApiResponse;
    console.log(
      `[apisports-nfl] request sport=${SPORT_LABEL} endpoint=${endpoint} status=${status} latencyMs=${Date.now() - start}`
    );
    return data as T;
  } catch (e) {
    status = 0;
    console.log(
      `[apisports-nfl] request sport=${SPORT_LABEL} endpoint=${endpoint} status=err latencyMs=${Date.now() - start} msg=${e instanceof Error ? e.message : String(e)}`
    );
    throw e;
  }
}

/** Parse response: API may return { response: [...] } or direct array. */
function parseGamesResponse(data: ApiResponse): ApiSportsNflGame[] {
  const arr = Array.isArray(data) ? data : (data as { response?: ApiSportsNflGame[] }).response;
  return Array.isArray(arr) ? arr : [];
}

/** Fetch games for a given date (YYYY-MM-DD). Optional season (e.g. 2024) for APIs that require it. */
export async function getGamesByDate(date: string, season?: number): Promise<ApiSportsNflGame[]> {
  try {
    let path = `/games?date=${date}`;
    if (season != null) path += `&season=${season}`;
    const data = await request<ApiResponse>(path);
    return parseGamesResponse(data);
  } catch (e) {
    if (e instanceof Error && e.message.includes('APISPORTS_NFL_DAILY_LIMIT')) throw e;
    console.warn('[apisports-nfl] getGamesByDate error:', date, e instanceof Error ? e.message : String(e));
    return [];
  }
}

/** Fetch single game by id (fixture/game id). Returns null if 404 or error. */
export async function getGameById(id: string | number): Promise<ApiSportsNflGame | null> {
  try {
    const data = await request<ApiResponse>(`/games?id=${id}`);
    const list = parseGamesResponse(data ?? { response: [] });
    return list.length > 0 ? list[0] : null;
  } catch (e) {
    if (e instanceof Error && e.message.includes('APISPORTS_NFL_DAILY_LIMIT')) throw e;
    return null;
  }
}

/** Get max requests we're allowed to use in resolution this cycle (without exceeding daily limit). */
export function getMaxResolutionRequestsThisCycle(): number {
  const used = getRequestsUsedToday();
  const remaining = Math.max(0, DAILY_LIMIT - used);
  return Math.min(remaining, MAX_REQUESTS_PER_RESOLUTION_CYCLE);
}

/** Get max requests for discovery cycle. */
export function getMaxDiscoveryRequestsThisCycle(): number {
  const used = getRequestsUsedToday();
  const remaining = Math.max(0, DAILY_LIMIT - used);
  return Math.min(remaining, MAX_REQUESTS_PER_DISCOVERY_CYCLE);
}

export { DAILY_LIMIT };
