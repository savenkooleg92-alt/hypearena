import path from 'path';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth';
import marketRoutes from './routes/markets';
import betRoutes from './routes/bets';
import userRoutes from './routes/users';
import walletRoutes from './routes/wallet';
import oracleRoutes from './routes/oracle';
import adminRoutes from './routes/admin';
import rouletteRoutes from './routes/roulette';
import chatRoutes from './routes/chat';
import supportRoutes from './routes/support';
import { runDiscovery, runResolution } from './services/oracle.cybersport';
import { runCryptoSync, runCryptoResolution } from './services/oracle.crypto';
import { runDiscovery as runSportsDiscovery, runResolution as runSportsResolution } from './services/oracle.sports';
import { runDiscovery as runPoliticsDiscovery, runResolution as runPoliticsResolution } from './services/oracle.politics';
import { runDiscovery as runEventsDiscovery, runResolution as runEventsResolution } from './services/oracle.events';
import { runDiscovery as runNflDiscovery, runResolution as runNflResolution } from './services/oracle.apisports-nfl';
import { runOddsSync } from './services/odds.service';
import { resolveDueRounds } from './services/roulette.service';
import { moveEndedMarketsToAwaitingResult } from './services/market-status.service';
import { runSolDepositCycle } from './services/sol-deposit.service';
import { runSolUsdcDepositCycle, reconcileSolUsdcPending } from './services/sol-usdc-deposit.service';
import { runTronUsdtDepositCycle } from './services/tron-usdt-deposit.service';
import { runPolygonUsdtDepositCycle } from './services/polygon-usdt-deposit.service';
import prisma from './utils/prisma';
import { logSmtpConfigOnce } from './services/email.service';

// Load .env from backend/ so it works regardless of cwd (e.g. when run from monorepo root)
dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function pingDb(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

// Fail fast if wallet address generation will fail (optional; comment out if using env elsewhere)
if (!process.env.TATUM_API_KEY) {
  console.warn('[startup] TATUM_API_KEY is not set; wallet address generation will fail.');
}
if (!process.env.MASTER_MNEMONIC) {
  console.warn('[startup] MASTER_MNEMONIC is not set; wallet address generation will fail.');
}
logSmtpConfigOnce();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/markets', marketRoutes);
app.use('/api/bets', betRoutes);
app.use('/api/users', userRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/oracle', oracleRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/roulette', rouletteRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/support', supportRoutes);

// Health check (includes DB ping so you can verify Neon is reachable)
app.get('/api/health', async (req, res) => {
  const dbOk = await pingDb();
  if (dbOk) {
    res.json({ status: 'ok', db: 'ok', message: 'HYPE ARENA API is running' });
  } else {
    res.status(503).json({ status: 'degraded', db: 'error', message: 'Database unreachable (check Neon wake and DATABASE_URL)' });
  }
});

app.listen(PORT, async () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);

  // Oracle startup env (to debug why Politics/NFL may not start)
  console.log('[startup] POLITICS_ORACLE_ENABLED=', process.env.POLITICS_ORACLE_ENABLED);
  console.log('[startup] ORACLE_CREATOR_USER_ID=', process.env.ORACLE_CREATOR_USER_ID);
  console.log('[startup] APISPORTS_API_KEY set=', !!process.env.APISPORTS_API_KEY);

  // DB health: ping once with one retry so Neon has time to wake
  const dbPing = async (attempt: number) => {
    if (await pingDb()) {
      console.log('[db] connected (Neon/Postgres OK)');
      return;
    }
    if (attempt < 2) {
      console.warn('[db] first ping failed, retrying in 2s...');
      await new Promise((r) => setTimeout(r, 2000));
      return dbPing(attempt + 1);
    }
    console.error('[db] FAILED: Prisma cannot reach the database. Check DATABASE_URL and Neon console (wake DB, use pooled URL).');
  };
  dbPing(1).catch(() => {});

  // Cybersport oracle: run resolution on startup and on interval so esports battles resolve automatically
  const pandaKey = process.env.PANDASCORE_API_KEY?.trim();
  const oracleCreatorId = process.env.ORACLE_CREATOR_USER_ID?.trim();
  const hasPandaKey = Boolean(pandaKey);
  const hasOracleCreator = Boolean(oracleCreatorId);
  if (!hasPandaKey || !hasOracleCreator) {
    console.warn(
      '[oracle/cybersport] DISABLED: set PANDASCORE_API_KEY and ORACLE_CREATOR_USER_ID in .env to enable esports auto-resolution. Matches will stay Pending until then.'
    );
    if (!hasPandaKey) console.warn('[oracle/cybersport] PANDASCORE_API_KEY is missing or empty');
    if (!hasOracleCreator) console.warn('[oracle/cybersport] ORACLE_CREATOR_USER_ID is missing or empty');
  } else {
    console.log('[oracle/cybersport] ENABLED: auto-resolution will run on startup (5s) and every 60s');
    const { getUpcomingMatches, GAMES } = await import('./services/pandascore.service');
    getUpcomingMatches(GAMES.CS2, 1, 1)
      .then((list) => {
        console.log('[oracle/cybersport] PandaScore API OK: key valid, csgo upcoming count=' + (list?.length ?? 0));
      })
      .catch((e: Error) => {
        const msg = e?.message ?? String(e);
        if (msg.includes('401') || msg.includes('403') || msg.includes('Unauthorized')) {
          console.error('[oracle/cybersport] PandaScore API key invalid or expired (401/403). Get a new token at https://app.pandascore.co/');
        } else {
          console.warn('[oracle/cybersport] PandaScore check failed:', msg.slice(0, 120));
        }
      });
    const runStartupResolution = () => {
      console.log('[oracle/cybersport] running startup resolution...');
      runResolution()
        .then((r) => {
          console.log('[oracle/cybersport] startup resolve done: resolved=' + r.resolved + ', errors=' + r.errors.length);
          if (r.errors.length > 0) {
            r.errors.forEach((e) => console.warn('[oracle/cybersport]', e));
          }
        })
        .catch((e: Error) => console.error('[oracle/cybersport] startup resolve:', e.message));
    };
    setTimeout(runStartupResolution, 5000);

    const resolutionIntervalMs = process.env.CYBERSPORT_RESOLVE_INTERVAL_MS
      ? parseInt(process.env.CYBERSPORT_RESOLVE_INTERVAL_MS, 10)
      : 60 * 1000;
    const intervalMs = Number.isFinite(resolutionIntervalMs) && resolutionIntervalMs > 0 ? resolutionIntervalMs : 60 * 1000;
    setInterval(() => runResolution().catch((e: Error) => console.error('[oracle] resolve', e.message)), intervalMs);
    console.log('[oracle/cybersport] watcher: every ' + intervalMs / 1000 + 's (Agent → Oracle → Auto-Resolve)');

    const discoveryIntervalMs = process.env.NODE_ENV === 'development' ? 5 * 60 * 1000 : 30 * 60 * 1000;
    runDiscovery().catch((e: Error) => console.error('[oracle/cybersport] startup discovery:', e.message));
    setInterval(() => runDiscovery().catch((e: Error) => console.error('[oracle] discovery', e.message)), discoveryIntervalMs);
    console.log('[oracle/cybersport] discovery started: every ' + discoveryIntervalMs / 60000 + ' min (upcoming matches → new markets)');
  }
  // Roulette: run resolve once on startup (catches rounds that expired while backend was down)
  resolveDueRounds()
    .then((r) => {
      if (r.resolved > 0 || r.errors.length > 0) {
        console.log(`[roulette] startup: resolved ${r.resolved}, errors: ${r.errors.length}`);
      }
    })
    .catch((e: Error) => console.error('[roulette] startup resolve:', e.message));

  // Roulette: periodic resolve (dev and prod); idempotent so safe with single process
  const rouletteIntervalMs = 5 * 1000; // 5s so round flips to FINISHED within 5–10s after endsAt
  setInterval(
    () => resolveDueRounds().catch((e: Error) => console.error('[roulette] interval resolve:', e.message)),
    rouletteIntervalMs
  );

  // Manual resolve: OPEN → AWAITING_RESULT when endDate passed (no oracles, no auto-payouts)
  moveEndedMarketsToAwaitingResult()
    .then((r) => {
      if (r.moved > 0) console.log('[markets] moved to AWAITING_RESULT:', r.moved);
    })
    .catch((e: Error) => console.error('[markets] moveToAwaitingResult:', e.message));
  setInterval(
    () =>
      moveEndedMarketsToAwaitingResult().catch((e: Error) => console.error('[markets] moveToAwaitingResult:', e.message)),
    60 * 1000
  );
  console.log('[roulette] resolve interval (' + (rouletteIntervalMs / 1000) + 's) started');

  // Solana deposits: native SOL and/or USDC SPL
  if (process.env.SOL_DEPOSITS_DISABLED !== 'true') {
    const solDepositIntervalMs = process.env.NODE_ENV === 'development' ? 30 * 1000 : 90 * 1000;
    setInterval(
      () => runSolDepositCycle().catch((e: Error) => console.error('[sol-deposits]', e.message)),
      solDepositIntervalMs
    );
    console.log('[sol-deposits] interval (' + (solDepositIntervalMs / 1000) + 's) started');
  } else {
    console.log('[sol-deposits] native SOL disabled (SOL_DEPOSITS_DISABLED=true). For USDC set SOL_USDC_ENABLED=true');
  }
  // USDC SPL deposits: fully automatic. detect → confirm → sweep → credit on interval. No admin action required.
  // Runs even when SOL_DEPOSITS_DISABLED=true (USDC-only). Set SOL_USDC_ENABLED=true.
  if (process.env.SOL_USDC_ENABLED === 'true') {
    const usdcIntervalMs = process.env.NODE_ENV === 'development' ? 30 * 1000 : 90 * 1000;
    const reconcileIntervalMs = 2 * 60 * 1000; // 2 min catch-up after outages
    runSolUsdcDepositCycle().catch((e: Error) => console.error('[sol-usdc] startup:', e.message));
    setInterval(
      () => runSolUsdcDepositCycle().catch((e: Error) => console.error('[sol-usdc]', e.message)),
      usdcIntervalMs
    );
    setInterval(
      () => reconcileSolUsdcPending().catch((e: Error) => console.error('[sol-usdc] reconcile:', e.message)),
      reconcileIntervalMs
    );
    console.log('[sol-usdc] auto cycle started: every ' + usdcIntervalMs / 1000 + 's (detect → confirm → credit → sweep), reconcile every ' + reconcileIntervalMs / 1000 + 's');
  }

  // TRON USDT: detect → confirm → credit automatically. Sweep via cron POST /api/wallet/sweep.
  const tronUsdtIntervalMs = process.env.NODE_ENV === 'development' ? 60 * 1000 : 2 * 60 * 1000; // 1 min dev, 2 min prod
  runTronUsdtDepositCycle().catch((e: Error) => console.error('[tron-usdt] startup:', e.message));
  setInterval(
    () => runTronUsdtDepositCycle().catch((e: Error) => console.error('[tron-usdt]', e.message)),
    tronUsdtIntervalMs
  );
  console.log('[tron-usdt] auto cycle: every ' + tronUsdtIntervalMs / 1000 + 's (detect → confirm → credit)');

  // Polygon USDT: detect → confirm → credit → sweep (same as Solana USDC). Set ENABLE_POLYGON_DEPOSITS=false to disable.
  if (process.env.ENABLE_POLYGON_DEPOSITS !== 'false') {
    const polygonUsdtIntervalMs = process.env.NODE_ENV === 'development' ? 60 * 1000 : 90 * 1000;
    runPolygonUsdtDepositCycle().catch((e: Error) => console.error('[polygon-usdt] startup:', e.message));
    setInterval(
      () => runPolygonUsdtDepositCycle().catch((e: Error) => console.error('[polygon-usdt]', e.message)),
      polygonUsdtIntervalMs
    );
    const polygonRpc = process.env.POLYGON_RPC_URL || '';
    const rpcMasked = polygonRpc ? (polygonRpc.includes('drpc') ? polygonRpc.replace(/\/[^/]+$/, '/***') : polygonRpc.includes('alchemy') ? polygonRpc.replace(/\/v2\/.*$/, '/v2/***') : polygonRpc.slice(0, 40) + '…') : 'default';
    console.log('[polygon-usdt] auto cycle: every ' + polygonUsdtIntervalMs / 1000 + 's (detect → confirm → credit → sweep), RPC=' + rpcMasked);
  } else {
    console.log('[polygon-usdt] disabled (ENABLE_POLYGON_DEPOSITS=false)');
  }

  // Crypto oracle: sync and resolve on fixed intervals in all environments (not triggered by frontend)
  if (process.env.ORACLE_CREATOR_USER_ID) {
    const cryptoSyncIntervalMs =
      process.env.NODE_ENV === 'development' ? 2 * 60 * 1000 : 30 * 60 * 1000; // 2 min dev, 30 min prod
    const cryptoResolveIntervalMs = 60 * 1000; // 1 min everywhere

    runCryptoSync().catch((e: Error) => console.error('[oracle/crypto] startup sync:', e.message));

    setInterval(() => {
      runCryptoSync().catch((e: Error) => console.error('[oracle/crypto] sync:', e.message));
    }, cryptoSyncIntervalMs);
    setInterval(() => {
      runCryptoResolution().catch((e: Error) => console.error('[oracle/crypto] resolve:', e.message));
    }, cryptoResolveIntervalMs);

    console.log(
      '[oracle/crypto] sync interval: every ' + cryptoSyncIntervalMs / 60000 + ' min (all envs)'
    );
    console.log(
      '[oracle/crypto] resolve interval: every ' + cryptoResolveIntervalMs / 1000 + ' s (all envs)'
    );
  }

  // Sports oracle: sync (create markets) and resolve every 60s when Odds API key is set
  const oddsApiKey = process.env.ODDS_API_KEY ?? process.env.THE_ODDS_API_KEY;
  if (process.env.ORACLE_CREATOR_USER_ID) {
    const sportsSyncIntervalMs = 5 * 60 * 1000; // 5 min
    const sportsResolveIntervalMs = 60 * 1000; // 60 s
    if (oddsApiKey) {
      runOddsSync().catch((e: Error) => console.error('[oracle/odds] startup sync:', e.message));
      setInterval(() => runOddsSync().catch((e: Error) => console.error('[oracle/odds] sync:', e.message)), sportsSyncIntervalMs);
      console.log('[oracle/odds] sync interval: every ' + sportsSyncIntervalMs / 60000 + ' min');
    }
    setInterval(() => runSportsResolution().catch((e: Error) => console.error('[oracle/sports] resolve:', e.message)), sportsResolveIntervalMs);
    console.log('[oracle/sports] resolve interval: every ' + sportsResolveIntervalMs / 1000 + ' s');
  }

  // Politics oracle: DISABLED by default. Set POLITICS_ORACLE_ENABLED=true to auto-fetch from GDELT + RSS (BBC, Google News, Reuters).
  if (process.env.ORACLE_CREATOR_USER_ID) {
    const politicsResolveIntervalMs = 10 * 60 * 1000; // 10 min
    const politicsEnabled = String(process.env.POLITICS_ORACLE_ENABLED || '').toLowerCase() === 'true';
    if (politicsEnabled) {
      console.log('[oracle/politics] ENABLED: startup sync in 8s, discovery every 10 min, resolution every 10 min');
      setTimeout(() => {
        runPoliticsDiscovery()
          .then((r) => console.log('[oracle/politics] startup sync: created=', r.created, 'fetched=', r.fetched, 'afterFilter=', r.afterFilter))
          .catch((e: Error) => console.error('[oracle/politics] startup sync:', e.message));
      }, 8000);
      setInterval(() => runPoliticsDiscovery().catch((e: Error) => console.error('[oracle/politics] sync:', e.message)), 10 * 60 * 1000);
      setInterval(() => runPoliticsResolution().catch((e: Error) => console.error('[oracle/politics] resolve:', e.message)), politicsResolveIntervalMs);
    } else {
      console.log('[oracle/politics] DISABLED (set POLITICS_ORACLE_ENABLED=true to enable auto GDELT + RSS). You can create Politics markets manually in Admin.');
    }
  } else {
    console.log('[oracle/politics] NOT started: ORACLE_CREATOR_USER_ID is not set');
  }

  // Events oracle: sync + resolve every 60s (no-op until EVENTS_ORACLE_ENABLED + data integration)
  if (process.env.ORACLE_CREATOR_USER_ID) {
    const eventsResolveIntervalMs = 60 * 1000;
    setInterval(() => runEventsDiscovery().catch((e: Error) => console.error('[oracle/events] sync:', e.message)), 10 * 60 * 1000);
    setInterval(() => runEventsResolution().catch((e: Error) => console.error('[oracle/events] resolve:', e.message)), eventsResolveIntervalMs);
  }

  // NFL oracle (API-Sports): discovery 5–7 new/day, resolution every 10 min. 100 API requests/day limit.
  if (process.env.APISPORTS_API_KEY && process.env.ORACLE_CREATOR_USER_ID) {
    const nflResolveIntervalMs = 10 * 60 * 1000; // 10 min
    const nflDiscoveryIntervalMs = 6 * 60 * 60 * 1000; // 6 h — cap 5–7 new markets/day inside runDiscovery
    console.log('[oracle/nfl] startup discovery scheduled in 10s');
    setTimeout(() => {
      runNflDiscovery()
        .then((r) => console.log('[oracle/nfl] startup discovery: created=', r.created, 'fetched=', r.fetched, 'afterFilter=', r.afterFilter))
        .catch((e: Error) => console.error('[oracle/nfl] startup discovery:', e.message));
    }, 10000);
    setInterval(() => runNflResolution().catch((e: Error) => console.error('[oracle/nfl] resolve:', e.message)), nflResolveIntervalMs);
    setInterval(() => runNflDiscovery().catch((e: Error) => console.error('[oracle/nfl] discovery:', e.message)), nflDiscoveryIntervalMs);
    console.log('[oracle/nfl] started: resolution every ' + nflResolveIntervalMs / 60000 + ' min, discovery every ' + nflDiscoveryIntervalMs / 3600000 + ' h');
  } else {
    if (!process.env.APISPORTS_API_KEY) console.log('[oracle/nfl] NOT started: APISPORTS_API_KEY is not set');
    if (!process.env.ORACLE_CREATOR_USER_ID) console.log('[oracle/nfl] NOT started: ORACLE_CREATOR_USER_ID is not set');
  }
});
