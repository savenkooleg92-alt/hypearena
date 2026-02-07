/**
 * Politics feed: POLITICAL BATTLES only (binary outcomes).
 * Source: Reuters Politics RSS only (GDELT, BBC, Google News disabled).
 * No opinions, no analysis — only decisions: votes, elections, sanctions, bills, court decisions.
 */

export type BattleOutcome =
  | 'YES'
  | 'NO'
  | 'PASSED'
  | 'FAILED'
  | 'APPROVED'
  | 'REJECTED'
  | 'IMPOSED'
  | 'LIFTED'
  | 'WIN'
  | 'LOSE'
  | 'WILL'
  | 'WILL NOT';

export type BattleStatus = 'RESOLVED' | 'ONGOING';

export interface PoliticsSuggestion {
  id: string;
  /** Short, clear, binary — ENGLISH ONLY */
  title: string;
  description: string | null;
  source: string;
  url: string | null;
  publishedAt: string;
  /** e.g. YES/NO, PASSED/FAILED, APPROVED/REJECTED */
  outcome: BattleOutcome | null;
  status: BattleStatus;
  /** Suggested outcomes for admin, e.g. ["Yes", "No"] or ["Passed", "Failed"] */
  suggestedOutcomes: string[];
}

/** Politics feed: Reuters only (BBC, Google News, GDELT disabled). */
const RSS_FEEDS: { url: string; source: string }[] = [
  { url: 'https://www.reutersagency.com/feed/?best-topics=political-general&post_type=best', source: 'Reuters' },
];

/** GDELT Doc API (free). Returns articles; we filter for battle-like titles. */
const GDELT_BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';
const GDELT_QUERIES = [
  'election result',
  'parliament vote passed',
  'bill passed senate',
  'sanctions approved',
  'confidence vote',
  'court ruling',
  'referendum result',
];

/** Patterns that indicate a binary political decision (battle). Outcome inferred from keyword. */
const BATTLE_PATTERNS: { regex: RegExp; outcome: BattleOutcome; suggested: [string, string] }[] = [
  { regex: /\b(passes?|passed|approves?|approved|adopts?|adopted)\b/i, outcome: 'PASSED', suggested: ['Passed', 'Failed'] },
  { regex: /\b(fails?|failed|rejects?|rejected|blocks?|blocked)\b/i, outcome: 'FAILED', suggested: ['Passed', 'Failed'] },
  { regex: /\b(survives?|survived)\s+(no[- ]?confidence|vote)/i, outcome: 'PASSED', suggested: ['Survived', 'Ousted'] },
  { regex: /\b(ousted|removed|resigned)\b/i, outcome: 'LOSE', suggested: ['Win', 'Lose'] },
  { regex: /\b(wins?|won)\s+(election|vote)/i, outcome: 'WIN', suggested: ['Win', 'Lose'] },
  { regex: /\b(loses?|lost)\s+(election|vote)/i, outcome: 'LOSE', suggested: ['Win', 'Lose'] },
  { regex: /\b(imposes?|imposed)\s+(sanctions?|tariffs?)/i, outcome: 'IMPOSED', suggested: ['Imposed', 'Lifted'] },
  { regex: /\b(lifts?|lifted)\s+(sanctions?|ban)/i, outcome: 'LIFTED', suggested: ['Imposed', 'Lifted'] },
  { regex: /\b(approves?|approved)\b.*\b(bill|law|sanctions?)\b/i, outcome: 'APPROVED', suggested: ['Approved', 'Rejected'] },
  { regex: /\b(rejects?|rejected)\b.*\b(bill|law|amendment)\b/i, outcome: 'REJECTED', suggested: ['Approved', 'Rejected'] },
  { regex: /\b(ruling|ruled)\s+(against|in favor)/i, outcome: 'YES', suggested: ['Yes', 'No'] },
  { regex: /\b(referendum)\s+(passes?|passed|approves?)/i, outcome: 'YES', suggested: ['Yes', 'No'] },
  { regex: /\b(referendum)\s+(fails?|failed|rejects?)/i, outcome: 'NO', suggested: ['Yes', 'No'] },
];

/** Noise: skip headlines that are clearly not battles. */
const NOISE_PATTERNS = [
  /^(opinion|analysis|comment|editorial|column)\b/i,
  /\b(says?|said|thinks?|believes?|expects?|may|might|could)\b.*\b(will|would)\b/i,
  /^(why|how|what)\s/i,
  /\?$/,
];

/** Headlines that look like upcoming votes/bills (no outcome yet) — create ONGOING markets. */
const UPCOMING_BATTLE_PATTERNS = [
  /\b(to vote on|vote on|scheduled to vote|will vote on|set to vote)\b/i,
  /\b(bill to|bills to|legislature to consider|senate to vote|house to vote)\b/i,
  /\b(referendum on|referendum to|vote scheduled|expected to vote)\b/i,
];

function isNoise(title: string): boolean {
  return NOISE_PATTERNS.some((p) => p.test(title));
}

/** True if title looks like an upcoming vote/bill (no outcome in headline). */
function isUpcomingBattle(title: string): boolean {
  if (isNoise(title)) return false;
  if (inferBattle(title)) return false; // already has outcome
  return UPCOMING_BATTLE_PATTERNS.some((p) => p.test(title));
}

function inferBattle(title: string): { outcome: BattleOutcome; suggested: [string, string] } | null {
  if (isNoise(title)) return null;
  for (const { regex, outcome, suggested } of BATTLE_PATTERNS) {
    if (regex.test(title)) return { outcome, suggested };
  }
  return null;
}

/** Ensure title is in English: keep as-is if already Latin/EN; truncate and clean. */
function normalizeTitle(title: string): string {
  const t = title.replace(/\s+/g, ' ').trim();
  if (t.length > 120) return t.slice(0, 117) + '...';
  return t;
}

/** Parse RSS XML and return items (title, link, pubDate). */
async function fetchRssFeed(url: string): Promise<Array<{ title: string; link: string; pubDate: string }>> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'PoliticsBattlesFeed/1.0' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const items: Array<{ title: string; link: string; pubDate: string }> = [];
    const itemBlocks = xml.split(/<item\s*>/i).slice(1);
    for (const block of itemBlocks) {
      const titleMatch = block.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i);
      const linkMatch = block.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i);
      const dateMatch = block.match(/<(?:pubDate|dc:date)(?:\s[^>]*)?>([\s\S]*?)<\/(?:pubDate|dc:date)>/i);
      let title = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
      if (!title) continue;
      const link = linkMatch ? linkMatch[1].trim() : '';
      const pubDate = dateMatch ? dateMatch[1].trim() : new Date().toISOString();
      items.push({ title, link, pubDate });
    }
    return items;
  } catch {
    return [];
  }
}

/** Fetch GDELT Doc API (free). Returns list of articles. */
async function fetchGdelt(query: string, maxRecords: number): Promise<Array<{ title: string; url: string; date: string }>> {
  try {
    const params = new URLSearchParams({
      query,
      mode: 'ArtList',
      format: 'json',
      maxrecords: String(maxRecords),
    });
    const res = await fetch(`${GDELT_BASE}?${params}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { articles?: Array<{ title?: string; url?: string; socialimage?: string; seendate?: string }> };
    const articles = data.articles ?? [];
    return articles
      .filter((a) => a.title?.trim())
      .map((a) => ({
        title: (a.title ?? '').trim(),
        url: a.url ?? '',
        date: a.seendate ?? new Date().toISOString(),
      }));
  } catch {
    return [];
  }
}

/** Parse pubDate string to ISO. */
function parsePubDate(s: string): string {
  try {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/** Dedupe by normalized title (lowercase, no extra spaces). */
function dedupeByTitle<T extends { title: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const key = i.title.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Fetch political BATTLES only (binary decisions).
 * Source: Reuters RSS only.
 * Titles in English; outcome and status set when detectable.
 */
export async function fetchPoliticsSuggestions(limit = 20): Promise<PoliticsSuggestion[]> {
  const all: PoliticsSuggestion[] = [];
  let idSeq = 0;
  const makeId = () => `battle-${Date.now()}-${++idSeq}`;

  // --- Reuters RSS only (GDELT, BBC, Google News disabled) ---
  for (const feed of RSS_FEEDS) {
    const items = await fetchRssFeed(feed.url);
    for (const item of items) {
      const inferred = inferBattle(item.title);
      const normTitle = normalizeTitle(item.title);
      if (inferred) {
        all.push({
          id: makeId(),
          title: normTitle,
          description: null,
          source: feed.source,
          url: item.link || null,
          publishedAt: parsePubDate(item.pubDate),
          outcome: inferred.outcome,
          status: 'RESOLVED',
          suggestedOutcomes: inferred.suggested,
        });
      } else if (isUpcomingBattle(item.title)) {
        all.push({
          id: makeId(),
          title: normTitle,
          description: null,
          source: feed.source,
          url: item.link || null,
          publishedAt: parsePubDate(item.pubDate),
          outcome: null,
          status: 'ONGOING',
          suggestedOutcomes: ['Passed', 'Failed'],
        });
      }
    }
  }

  const deduped = dedupeByTitle(all);
  const sorted = deduped.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  return sorted.slice(0, limit);
}

export function getNewsApiKey(): string | null {
  return process.env.NEWS_API_KEY ?? null;
}
