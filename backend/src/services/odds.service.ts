/**
 * Odds API service: fetch upcoming matches + odds, create/update sports markets.
 * Uses ODDS_API_KEY or THE_ODDS_API_KEY. Markets use pool-based payouts (1.5% fee); external odds are data only.
 * Prevents duplicates via oracleSource + oracleMatchId (external match id).
 */

import prisma from '../utils/prisma';

const BASE = 'https://api.the-odds-api.com/v4';
const ORACLE_SOURCE = 'sports';
const CATEGORY = 'sports';
const WINDOW_START_MS = 15 * 60 * 1000;
const WINDOW_END_MS = 72 * 60 * 60 * 1000;
const SPORTS_TO_SYNC = ['americanfootball_nfl', 'basketball_nba'] as const;
const MAX_EVENTS_PER_SPORT = 25;

function getApiKey(): string | null {
  return process.env.ODDS_API_KEY ?? process.env.THE_ODDS_API_KEY ?? null;
}

function getOracleCreatorId(): string {
  const id = process.env.ORACLE_CREATOR_USER_ID;
  if (!id) throw new Error('ORACLE_CREATOR_USER_ID is not set');
  return id;
}

export interface OddsEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: Array<{
    key: string;
    title: string;
    markets: Array<{
      key: string;
      outcomes: Array<{ name: string; price: number }>;
    }>;
  }>;
}

/** Map sport_key to our subCategory (e.g. americanfootball_nfl → nfl). */
function sportToSubCategory(sportKey: string): string {
  if (sportKey === 'americanfootball_nfl') return 'nfl';
  if (sportKey === 'basketball_nba') return 'nba';
  if (sportKey === 'icehockey_nhl') return 'nhl';
  if (sportKey.startsWith('soccer_')) return 'soccer';
  return sportKey.replace(/^[a-z]+_/, '').slice(0, 12) || 'sports';
}

/**
 * Fetch upcoming events with h2h (match winner) odds for a sport.
 * GET /v4/sports/{sport}/odds?regions=us&markets=h2h
 */
export async function fetchOddsForSport(sportKey: string): Promise<OddsEvent[]> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.log('[odds.service] ODDS_API_KEY / THE_ODDS_API_KEY not set');
    return [];
  }
  const url = `${BASE}/sports/${encodeURIComponent(sportKey)}/odds?regions=us&markets=h2h&apiKey=${apiKey}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const remaining = res.headers.get('x-requests-remaining');
    if (remaining != null) {
      console.log('[odds.service] quota remaining:', remaining);
    }
    if (!res.ok) {
      console.warn('[odds.service] fetch failed:', res.status, await res.text());
      return [];
    }
    const data = (await res.json()) as OddsEvent[];
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('[odds.service] fetch error:', err);
    return [];
  }
}

/**
 * Fetch events only (no quota cost). Use for sync when odds are not needed for creation.
 * GET /v4/sports/{sport}/events
 */
export async function fetchEventsForSport(sportKey: string): Promise<OddsEvent[]> {
  const apiKey = getApiKey();
  if (!apiKey) return [];
  const url = `${BASE}/sports/${encodeURIComponent(sportKey)}/events?apiKey=${apiKey}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const data = (await res.json()) as OddsEvent[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Idempotent: create Match Winner market if not exists (oracleMatchId = external event id). */
async function createMarketIfNotExists(data: {
  creatorId: string;
  oracleMatchId: string;
  marketType: string;
  subCategory: string;
  title: string;
  outcomes: string[];
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
      line: null,
      subCategory: data.subCategory,
      startsAt: data.startsAt,
    },
  });
  return 'created';
}

/**
 * Sync sports markets from Odds API: fetch upcoming events, create Match Winner market per event.
 * Duplicates prevented by (oracleSource, oracleMatchId, marketType). Run every 5 min via cron.
 */
export async function runOddsSync(): Promise<{
  created: number;
  skipped: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let created = 0;
  let skipped = 0;
  if (!getApiKey()) {
    console.log('[odds.service] sync skipped: no API key');
    return { created: 0, skipped: 0, errors: [] };
  }
  let creatorId: string;
  try {
    creatorId = getOracleCreatorId();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log('[odds.service] sync skipped:', msg);
    return { created: 0, skipped: 0, errors: [msg] };
  }
  const now = Date.now();
  console.log('[odds.service] sync started');

  for (const sportKey of SPORTS_TO_SYNC) {
    let events: OddsEvent[];
    try {
      events = await fetchEventsForSport(sportKey);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${sportKey}: ${msg}`);
      continue;
    }
    const subCategory = sportToSubCategory(sportKey);
    const inWindow = events.filter((e) => {
      const t = new Date(e.commence_time).getTime();
      return t >= now + WINDOW_START_MS && t <= now + WINDOW_END_MS;
    });
    const toProcess = inWindow.slice(0, MAX_EVENTS_PER_SPORT);

    for (const ev of toProcess) {
      const home = ev.home_team?.trim() || 'Home';
      const away = ev.away_team?.trim() || 'Away';
      const title = `${home} vs ${away} — Match Winner`;
      const outcomes = [home, away];
      try {
        const result = await createMarketIfNotExists({
          creatorId,
          oracleMatchId: ev.id,
          marketType: 'match_winner',
          subCategory,
          title,
          outcomes,
          startsAt: new Date(ev.commence_time),
        });
        if (result === 'created') created++;
        else skipped++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('Unique constraint') || msg.includes('unique')) skipped++;
        else errors.push(`${ev.id}: ${msg}`);
      }
    }
  }

  console.log('[odds.service] sync done: created=', created, ', skipped=', skipped);
  return { created, skipped, errors };
}

export { getApiKey };
