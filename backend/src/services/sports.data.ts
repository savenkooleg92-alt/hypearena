/**
 * Sports events data source. Uses The Odds API (events only, no odds import).
 * Set THE_ODDS_API_KEY in env. If unset, returns empty (no markets created).
 */

export interface SportsEvent {
  id: string;
  homeTeam: string;
  awayTeam: string;
  commenceAt: Date;
  sport: 'nfl' | 'football' | 'soccer';
  /** Set when event is finished */
  winner?: 'home' | 'away' | 'draw';
  /** Final score for optional sub-markets */
  homeScore?: number;
  awayScore?: number;
}

const WINDOW_START_MS = 15 * 60 * 1000;
const WINDOW_END_MS = 72 * 60 * 60 * 1000;

/** Fetch upcoming events (schedule only). Returns [] if no API key. */
export async function fetchUpcomingSportsEvents(): Promise<SportsEvent[]> {
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) {
    console.log('[sports.data] THE_ODDS_API_KEY not set, skipping fetch');
    return [];
  }
  const now = Date.now();
  const events: SportsEvent[] = [];
  try {
    const res = await fetch(
      `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/events?apiKey=${apiKey}`,
      { headers: { Accept: 'application/json' } }
    );
    if (!res.ok) {
      console.log('[sports.data] NFL events fetch failed:', res.status);
      return events;
    }
    const data = (await res.json()) as Array<{ id: string; home_team: string; away_team: string; commence_time: string }>;
    for (const e of data) {
      const commenceAt = new Date(e.commence_time);
      const t = commenceAt.getTime();
      if (t >= now + WINDOW_START_MS && t <= now + WINDOW_END_MS) {
        events.push({
          id: e.id,
          homeTeam: e.home_team ?? 'Home',
          awayTeam: e.away_team ?? 'Away',
          commenceAt,
          sport: 'nfl',
        });
      }
    }
  } catch (err) {
    console.error('[sports.data] fetch error:', err);
  }
  return events;
}

/** Map our subCategory (from market) to The Odds API sport_key. Must match odds.service SPORTS_TO_SYNC and sportToSubCategory. */
export function subCategoryToSportKey(subCategory: string): string {
  const s = (subCategory || '').toLowerCase();
  if (s === 'nfl') return 'americanfootball_nfl';
  if (s === 'nba') return 'basketball_nba';
  if (s === 'nhl') return 'icehockey_nhl';
  if (s === 'soccer' || s.startsWith('soccer')) return 'soccer_epl'; // fallback; odds may use specific league
  return 'americanfootball_nfl'; // safe default for legacy markets
}

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

/** Diagnostic: fetch scores list for a sport_key; returns fetch params and counts (no parsing). */
export async function fetchSportsScoresForDiagnostic(
  sportKey: string,
  daysFrom = 3
): Promise<{ fetchParams: { sportKey: string; daysFrom: number; endpoint: string }; eventCount: number; completedCount: number }> {
  const apiKey = process.env.THE_ODDS_API_KEY ?? process.env.ODDS_API_KEY ?? '';
  const endpoint = `GET ${ODDS_API_BASE}/sports/${sportKey}/scores?daysFrom=${daysFrom}&apiKey=${apiKey ? '[SET]' : '[MISSING]'}`;
  const fetchParams = { sportKey, daysFrom, endpoint };
  if (!apiKey) {
    return { fetchParams, eventCount: 0, completedCount: 0 };
  }
  const realUrl = `${ODDS_API_BASE}/sports/${encodeURIComponent(sportKey)}/scores?daysFrom=${daysFrom}&apiKey=${apiKey}`;
  try {
    const res = await fetch(realUrl, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      return { fetchParams, eventCount: 0, completedCount: 0 };
    }
    const data = (await res.json()) as Array<{ id: string; completed?: boolean }>;
    const list = Array.isArray(data) ? data : [];
    const completedCount = list.filter((e) => e.completed === true).length;
    return { fetchParams, eventCount: list.length, completedCount };
  } catch {
    return { fetchParams, eventCount: 0, completedCount: 0 };
  }
}

/**
 * Fetch event result (winner) for resolution.
 * Uses GET /v4/sports/{sport_key}/scores?daysFrom=3 so we get completed games for the correct sport.
 * Event IDs are sport-specific: NFL and NBA have different ID spaces, so wrong sport_key would never find the event.
 */
export async function fetchSportsEventResult(
  eventId: string,
  subCategory: string
): Promise<{ winner: 'home' | 'away' | 'draw'; homeScore?: number; awayScore?: number } | null> {
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) {
    console.log('[sports.data] fetchSportsEventResult: THE_ODDS_API_KEY not set');
    return null;
  }
  const sportKey = subCategoryToSportKey(subCategory);
  const url = `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sportKey)}/scores?daysFrom=3&apiKey=${apiKey}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      console.warn('[sports.data] scores fetch failed:', res.status, sportKey, eventId.slice(0, 12) + '…');
      return null;
    }
    const data = (await res.json()) as Array<{
      id: string;
      completed?: boolean;
      home_team?: string;
      away_team?: string;
      scores?: Array<{ name: string; score: string }> | null;
    }>;
    const list = Array.isArray(data) ? data : [];
    if (list.length === 0) {
      console.log('[sports.data] scores: no events returned for sport_key=', sportKey);
    }
    const event = list.find((e) => e.id === eventId);
    if (!event) {
      console.log('[sports.data] event not in scores list: eventId=', eventId.slice(0, 16) + '…', 'sport_key=', sportKey, 'listLen=', list.length);
      return null;
    }
    if (!event.completed) {
      console.log('[sports.data] event not completed: eventId=', eventId.slice(0, 16) + '…');
      return null;
    }
    const scores = event.scores;
    if (!Array.isArray(scores) || scores.length < 2) {
      console.log('[sports.data] event completed but missing scores array: eventId=', eventId.slice(0, 16) + '…');
      return null;
    }
    const homeTeam = event.home_team ?? '';
    const awayTeam = event.away_team ?? '';
    let homeScore: number | undefined;
    let awayScore: number | undefined;
    for (const s of scores) {
      const n = parseInt(s.score, 10);
      if (Number.isNaN(n)) continue;
      if (s.name === homeTeam) homeScore = n;
      else if (s.name === awayTeam) awayScore = n;
    }
    if (homeScore == null || awayScore == null) {
      const byOrder = scores.map((x) => parseInt(x.score, 10)).filter((n) => !Number.isNaN(n));
      if (byOrder.length >= 2) {
        homeScore = byOrder[0];
        awayScore = byOrder[1];
      }
    }
    if (homeScore == null || awayScore == null) {
      console.log('[sports.data] could not parse home/away scores: eventId=', eventId.slice(0, 16) + '…', 'scores=', JSON.stringify(scores));
      return null;
    }
    const winner: 'home' | 'away' | 'draw' = homeScore > awayScore ? 'home' : awayScore > homeScore ? 'away' : 'draw';
    console.log('[sports.data] fetched result: eventId=', eventId.slice(0, 16) + '…', 'winner=', winner, 'score=', homeScore, '-', awayScore);
    return { winner, homeScore, awayScore };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[sports.data] fetchSportsEventResult error:', msg);
    return null;
  }
}
