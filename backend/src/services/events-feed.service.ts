/**
 * Events / entertainment feed: concerts, festivals, cultural events.
 * Can use Ticketmaster (TICKETMASTER_API_KEY) or PredictHQ. Admin can create markets from suggestions.
 */

const TICKETMASTER_BASE = 'https://app.ticketmaster.com/discovery/v2';

function getTicketmasterKey(): string | null {
  return process.env.TICKETMASTER_API_KEY ?? null;
}

export interface EventSuggestion {
  id: string;
  name: string;
  description: string | null;
  startAt: string;
  venue: string | null;
  url: string | null;
  /** e.g. "concert", "festival", "sports" */
  type: string;
  suggestedOutcomes: string[];
}

/**
 * Fetch upcoming events (concerts, etc.) for admin to create markets.
 * Set TICKETMASTER_API_KEY to enable.
 */
export async function fetchEventsSuggestions(limit = 20): Promise<EventSuggestion[]> {
  const apiKey = getTicketmasterKey();
  if (!apiKey) {
    console.log('[events-feed] TICKETMASTER_API_KEY not set');
    return [];
  }
  const url = `${TICKETMASTER_BASE}/events.json?apikey=${apiKey}&size=${Math.min(limit, 200)}&sort=date,asc`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      console.warn('[events-feed] Ticketmaster failed:', res.status);
      return [];
    }
    const data = (await res.json()) as {
      _embedded?: {
        events?: Array<{
          id?: string;
          name?: string;
          info?: string;
          dates?: { start?: { dateTime?: string } };
          _embedded?: { venues?: Array<{ name?: string }> };
          url?: string;
          classifications?: Array<{ segment?: { name?: string } }>;
        }>;
      };
    };
    const events = data._embedded?.events ?? [];
    const suggestions: EventSuggestion[] = [];
    for (const e of events.slice(0, limit)) {
      const name = e.name?.trim() || 'Untitled Event';
      const venue = e._embedded?.venues?.[0]?.name ?? null;
      const startAt = e.dates?.start?.dateTime ?? new Date().toISOString();
      const type = e.classifications?.[0]?.segment?.name ?? 'event';
      suggestions.push({
        id: e.id ?? `ev-${suggestions.length}`,
        name,
        description: e.info?.trim() || null,
        startAt,
        venue,
        url: e.url ?? null,
        type,
        suggestedOutcomes: ['Yes', 'No'],
      });
    }
    return suggestions;
  } catch (err) {
    console.error('[events-feed] fetch error:', err);
    return [];
  }
}

export { getTicketmasterKey };
