import express from 'express';
import prisma from '../utils/prisma';
import { getLimiterStats } from '../services/pandascore.service';
import { runDiscovery, runResolution } from '../services/oracle.cybersport';
import { runCryptoSync, runCryptoResolution, getCryptoOracleStatus } from '../services/oracle.crypto';
import { runDiscovery as runSportsDiscovery, runResolution as runSportsResolution } from '../services/oracle.sports';
import { runDiscovery as runPoliticsDiscovery, runResolution as runPoliticsResolution } from '../services/oracle.politics';
import { runDiscovery as runEventsDiscovery, runResolution as runEventsResolution } from '../services/oracle.events';
import { runDiscovery as runNflDiscovery, runResolution as runNflResolution } from '../services/oracle.apisports-nfl';
import { getRequestsUsedToday as getNflRequestsUsedToday } from '../services/apisports-nfl.service';
import { runOddsSync } from '../services/odds.service';

const router = express.Router();

function requireCronSecret(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-cron-secret'] !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

/** GET /api/oracle/status — limiter stats (PandaScore + NFL API-Sports requests today) */
router.get('/status', (_req, res) => {
  try {
    const stats = getLimiterStats();
    const nflRequestsToday = getNflRequestsUsedToday();
    res.json({
      ok: true,
      ...stats,
      nfl: { requestsUsedToday: nflRequestsToday, dailyLimit: 100 },
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get status', message: e instanceof Error ? e.message : String(e) });
  }
});

/** GET /api/oracle/cybersport/eligible — count OPEN pandascore markets and how many are eligible for resolution (for debugging). */
router.get('/cybersport/eligible', async (_req, res) => {
  try {
    const now = new Date();
    const windowMin = process.env.CYBERSPORT_SAFETY_WINDOW_MINUTES ? parseInt(process.env.CYBERSPORT_SAFETY_WINDOW_MINUTES, 10) : 30;
    const windowMs = Number.isFinite(windowMin) && windowMin > 0 ? windowMin * 60 * 1000 : 30 * 60 * 1000;
    const resolveEligibleSince = new Date(now.getTime() - windowMs);
    const openTotal = await prisma.market.count({
      where: { oracleSource: 'pandascore', status: 'OPEN' },
    });
    const eligible = await prisma.market.count({
      where: {
        oracleSource: 'pandascore',
        status: 'OPEN',
        OR: [
          { endDate: { lte: now } },
          { endDate: null, startsAt: { lt: now } },
          { startsAt: { lte: resolveEligibleSince } },
        ],
      },
    });
    res.json({
      ok: true,
      openTotal,
      eligible,
      now: now.toISOString(),
      resolveEligibleSince: resolveEligibleSince.toISOString(),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: 'Failed', message });
  }
});

/** POST /api/oracle/cybersport/sync — one discovery cycle (upcoming → create markets) */
router.post('/cybersport/sync', requireCronSecret, async (_req, res) => {
  try {
    const result = await runDiscovery();
    res.json({
      ok: true,
      created: result.created,
      skipped: result.skipped,
      errors: result.errors.length ? result.errors : undefined,
      rateLimited: result.rateLimited,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[oracle] sync error:', message);
    res.status(500).json({ error: 'Sync failed', message });
  }
});

/** POST /api/oracle/cybersport/resolve — one resolution cycle (finished matches → resolve markets). Requires CRON_SECRET if set; when CRON_SECRET is unset you can trigger manually (e.g. curl -X POST /api/oracle/cybersport/resolve). */
router.post('/cybersport/resolve', (req, res, next) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-cron-secret'] !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}, async (_req, res) => {
  try {
    const result = await runResolution();
    res.json({
      ok: true,
      resolved: result.resolved,
      errors: result.errors.length ? result.errors : undefined,
      rateLimited: result.rateLimited,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[oracle] resolve error:', message);
    res.status(500).json({ error: 'Resolve failed', message });
  }
});

/** GET /api/oracle/crypto/status — oracleDay, createdTodayCount */
router.get('/crypto/status', async (_req, res) => {
  try {
    const status = await getCryptoOracleStatus();
    const limiter = getLimiterStats();
    res.json({ ok: true, ...status, limiter });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get crypto oracle status', message: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/oracle/crypto/sync — create up to 3 crypto markets for today (UTC). Idempotent. */
router.post('/crypto/sync', requireCronSecret, async (_req, res) => {
  try {
    const result = await runCryptoSync();
    res.json({
      ok: true,
      created: result.created,
      skipped: result.skipped,
      errors: result.errors.length ? result.errors : undefined,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[oracle] crypto sync error:', message);
    res.status(500).json({ error: 'Crypto sync failed', message });
  }
});

/** POST /api/oracle/crypto/resolve — resolve due crypto markets (endDate <= now). */
router.post('/crypto/resolve', requireCronSecret, async (_req, res) => {
  try {
    const result = await runCryptoResolution();
    res.json({
      ok: true,
      resolved: result.resolved,
      errors: result.errors.length ? result.errors : undefined,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[oracle] crypto resolve error:', message);
    res.status(500).json({ error: 'Crypto resolve failed', message });
  }
});

/** POST /api/oracle/odds/sync — create sports/NFL markets from Odds API (events). Every 5 min. */
router.post('/odds/sync', requireCronSecret, async (_req, res) => {
  try {
    const result = await runOddsSync();
    res.json({
      ok: true,
      created: result.created,
      skipped: result.skipped,
      errors: result.errors.length ? result.errors : undefined,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[oracle] odds sync error:', message);
    res.status(500).json({ error: 'Odds sync failed', message });
  }
});

/** POST /api/oracle/sports/sync — create markets from upcoming sports events. */
router.post('/sports/sync', requireCronSecret, async (_req, res) => {
  try {
    const result = await runSportsDiscovery();
    res.json({
      ok: true,
      created: result.created,
      skipped: result.skipped,
      errors: result.errors.length ? result.errors : undefined,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[oracle] sports sync error:', message);
    res.status(500).json({ error: 'Sports sync failed', message });
  }
});

/** POST /api/oracle/sports/resolve — resolve finished sports markets. */
router.post('/sports/resolve', requireCronSecret, async (_req, res) => {
  try {
    const result = await runSportsResolution();
    res.json({
      ok: true,
      resolved: result.resolved,
      errors: result.errors.length ? result.errors : undefined,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[oracle] sports resolve error:', message);
    res.status(500).json({ error: 'Sports resolve failed', message });
  }
});

/** POST /api/oracle/politics/sync */
router.post('/politics/sync', requireCronSecret, async (_req, res) => {
  try {
    const result = await runPoliticsDiscovery();
    res.json({
      ok: true,
      created: result.created,
      skipped: result.skipped,
      errors: result.errors.length ? result.errors : undefined,
      enabled: result.enabled,
      fetched: result.fetched,
      afterFilter: result.afterFilter,
      skipReasons: result.skipReasons,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[oracle] politics sync error:', message);
    res.status(500).json({ error: 'Politics sync failed', message });
  }
});

/** POST /api/oracle/politics/resolve */
router.post('/politics/resolve', requireCronSecret, async (_req, res) => {
  try {
    const result = await runPoliticsResolution();
    res.json({
      ok: true,
      resolved: result.resolved,
      errors: result.errors.length ? result.errors : undefined,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[oracle] politics resolve error:', message);
    res.status(500).json({ error: 'Politics resolve failed', message });
  }
});

/** POST /api/oracle/events/sync */
router.post('/events/sync', requireCronSecret, async (_req, res) => {
  try {
    const result = await runEventsDiscovery();
    res.json({
      ok: true,
      created: result.created,
      skipped: result.skipped,
      errors: result.errors.length ? result.errors : undefined,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[oracle] events sync error:', message);
    res.status(500).json({ error: 'Events sync failed', message });
  }
});

/** POST /api/oracle/events/resolve */
router.post('/events/resolve', requireCronSecret, async (_req, res) => {
  try {
    const result = await runEventsResolution();
    res.json({
      ok: true,
      resolved: result.resolved,
      errors: result.errors.length ? result.errors : undefined,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[oracle] events resolve error:', message);
    res.status(500).json({ error: 'Events resolve failed', message });
  }
});

/** POST /api/oracle/nfl/sync — one NFL discovery cycle (5–7 new markets/day max). */
router.post('/nfl/sync', requireCronSecret, async (_req, res) => {
  try {
    const result = await runNflDiscovery();
    res.json({
      ok: true,
      created: result.created,
      skipped: result.skipped,
      errors: result.errors.length ? result.errors : undefined,
      rateLimited: result.rateLimited,
      requestsUsedToday: result.requestsUsedToday,
      enabled: result.enabled,
      fetched: result.fetched,
      afterFilter: result.afterFilter,
      skipReasons: result.skipReasons,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[oracle] NFL sync error:', message);
    res.status(500).json({ error: 'NFL sync failed', message });
  }
});

/** POST /api/oracle/nfl/resolve — one NFL resolution cycle. */
router.post('/nfl/resolve', requireCronSecret, async (_req, res) => {
  try {
    const result = await runNflResolution();
    res.json({
      ok: true,
      resolved: result.resolved,
      cancelled: result.cancelled,
      errors: result.errors.length ? result.errors : undefined,
      rateLimited: result.rateLimited,
      requestsUsedToday: result.requestsUsedToday,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[oracle] NFL resolve error:', message);
    res.status(500).json({ error: 'NFL resolve failed', message });
  }
});

export default router;
