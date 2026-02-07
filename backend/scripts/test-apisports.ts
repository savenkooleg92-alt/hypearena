/**
 * One-off: trigger one NFL API-Sports request and print result + same counter as GET /api/oracle/status.
 * Run: npx tsx scripts/test-apisports.ts (from backend dir). Requires .env with APISPORTS_API_KEY.
 */
import 'dotenv/config';
import { getGamesByDate, getRequestsUsedToday } from '../src/services/apisports-nfl.service';

async function main() {
  const requestsBefore = getRequestsUsedToday();
  const today = new Date().toISOString().slice(0, 10);
  const season = new Date().getFullYear();
  console.error('[script] Calling getGamesByDate(%s, %s)...', today, season);
  try {
    const games = await getGamesByDate(today, season);
    const requestsAfter = getRequestsUsedToday();
    console.log(
      JSON.stringify(
        {
          ok: true,
          sport: 'nfl',
          requestsUsedBefore: requestsBefore,
          requestsUsedAfter: requestsAfter,
          gamesCount: games.length,
          message:
            requestsAfter > requestsBefore
              ? `One request sent. Dashboard counter = ${requestsAfter}.`
              : 'No request consumed (limit reached or skip).',
        },
        null,
        2
      )
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[script] Error:', message);
    console.log(
      JSON.stringify({
        ok: false,
        error: message,
        requestsUsedToday: getRequestsUsedToday(),
      })
    );
    process.exit(1);
  }
}

main();
