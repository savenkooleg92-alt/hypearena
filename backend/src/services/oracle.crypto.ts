/**
 * Crypto oracle v1: exactly 3 markets per UTC day (BTC, ETH, SOL), 24h duration,
 * realistic lines (±%), clean titles. Uses CoinGecko (no API key).
 */

import prisma from '../utils/prisma';
import { getSimplePrices, getPriceFromResult } from './coingecko.service';

const ORACLE_SOURCE = 'coingecko';
const CATEGORY = 'crypto';
const MARKET_TYPE_PREFIX = 'PRICE_OU_';
const OUTCOMES = ['ABOVE', 'BELOW'] as const;
const PLATFORM_FEE = 0.05; // 5% like other oracle resolution

const DELTA_PCT: Record<'btc' | 'eth' | 'sol', number> = {
  btc: 0.02,
  eth: 0.025,
  sol: 0.035,
};

const ROUND_TO: Record<'btc' | 'eth' | 'sol', number> = {
  btc: 100,
  eth: 10,
  sol: 1,
};

const SYMBOL_LABELS: Record<'btc' | 'eth' | 'sol', string> = {
  btc: 'Bitcoin',
  eth: 'Ethereum',
  sol: 'Solana',
};

const SYMBOLS: ('btc' | 'eth' | 'sol')[] = ['btc', 'eth', 'sol'];
const CRYPTO_MARKETS_PER_DAY = 3;

function getOracleDay(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Even UTC date (day of month) → ABOVE (+delta). Odd → BELOW (-delta). */
function isAboveDay(date: Date): boolean {
  return date.getUTCDate() % 2 === 0;
}

function roundLine(value: number, symbol: 'btc' | 'eth' | 'sol'): number {
  const step = ROUND_TO[symbol];
  return Math.round(value / step) * step;
}

/** Build line from current price: ABOVE → price * (1+delta), BELOW → price * (1-delta). */
function computeLine(price: number, symbol: 'btc' | 'eth' | 'sol', above: boolean): number {
  const delta = DELTA_PCT[symbol];
  const line = above ? price * (1 + delta) : price * (1 - delta);
  return roundLine(line, symbol);
}

function formatLineDollars(line: number): string {
  if (line >= 1000) return `$${Math.round(line).toLocaleString()}`;
  if (line >= 1) return `$${line.toFixed(2)}`;
  return `$${line.toFixed(2)}`;
}

/** Title e.g. "Bitcoin price at 7 Feb 2025, 18:00 UTC — Above or Below $76,500" */
function formatResolveAtUTC(date: Date): string {
  const d = date.getUTCDate();
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const m = months[date.getUTCMonth()];
  const y = date.getUTCFullYear();
  const h = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  return `${d} ${m} ${y}, ${h}:${min} UTC`;
}

function buildTitle(symbol: 'btc' | 'eth' | 'sol', resolveAt: Date, line: number): string {
  const label = SYMBOL_LABELS[symbol];
  const timeStr = formatResolveAtUTC(resolveAt);
  const lineStr = formatLineDollars(line);
  return `${label} price at ${timeStr} — Above or Below ${lineStr}`;
}

function getOracleCreatorId(): string {
  const id = process.env.ORACLE_CREATOR_USER_ID;
  if (!id) throw new Error('ORACLE_CREATOR_USER_ID is not set');
  return id;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Count crypto oracle markets for a given UTC day. */
export async function countCryptoMarketsForDay(oracleDay: string): Promise<number> {
  return prisma.market.count({
    where: {
      oracleSource: ORACLE_SOURCE,
      oracleMatchId: oracleDay,
    },
  });
}

/** Idempotent: create one crypto market if not exists. Uses unique (oracleSource, oracleMatchId, marketType). */
async function createCryptoMarketIfNotExists(data: {
  creatorId: string;
  oracleDay: string;
  symbol: 'btc' | 'eth' | 'sol';
  title: string;
  line: number;
  resolveAt: Date;
}): Promise<'created' | 'skipped'> {
  const marketType = `${MARKET_TYPE_PREFIX}${data.symbol}`;
  const existing = await prisma.market.findUnique({
    where: {
      oracleSource_oracleMatchId_marketType: {
        oracleSource: ORACLE_SOURCE,
        oracleMatchId: data.oracleDay,
        marketType,
      },
    },
  });
  if (existing) return 'skipped';

  await prisma.market.create({
    data: {
      creatorId: data.creatorId,
      title: data.title,
      description: `Crypto price prediction. Resolves at ${data.resolveAt.toISOString()} UTC.`,
      category: CATEGORY,
      subCategory: data.symbol,
      outcomes: [...OUTCOMES],
      status: 'OPEN',
      oracleSource: ORACLE_SOURCE,
      oracleMatchId: data.oracleDay,
      marketType,
      line: data.line,
      endDate: data.resolveAt,
    },
  });
  return 'created';
}

/** Sync: create exactly 3 crypto markets per UTC day (one per symbol). Idempotent. */
export async function runCryptoSync(): Promise<{
  created: number;
  skipped: number;
  errors: string[];
}> {
  console.log('[oracle/crypto] sync tick started');
  const errors: string[] = [];
  let created = 0;
  let skipped = 0;

  try {
    const creatorId = getOracleCreatorId();
    const now = new Date();
    const oracleDay = getOracleDay(now);

    const createdTodayCount = await countCryptoMarketsForDay(oracleDay);
    console.log('[oracle/crypto] sync: createdTodayCount=' + createdTodayCount);
    if (createdTodayCount >= CRYPTO_MARKETS_PER_DAY) {
      console.log('[oracle/crypto] sync tick done: created 0 (already have ' + CRYPTO_MARKETS_PER_DAY + ' for today)');
      return { created: 0, skipped: 3, errors: [] };
    }

    const prices = await getSimplePrices();
    const above = isAboveDay(now);
    const resolveAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    for (const symbol of SYMBOLS) {
      const price = getPriceFromResult(prices, symbol);
      if (price == null || price <= 0) {
        errors.push(`${symbol}: invalid price`);
        continue;
      }
      const line = computeLine(price, symbol, above);
      const title = buildTitle(symbol, resolveAt, line);

      try {
        const result = await createCryptoMarketIfNotExists({
          creatorId,
          oracleDay,
          symbol,
          title,
          line,
          resolveAt,
        });
        if (result === 'created') created++;
        else skipped++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${symbol}: ${msg}`);
      }
    }

    console.log('[oracle/crypto] sync tick done: created ' + created + ', skipped ' + skipped);
    return { created, skipped, errors };
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
    console.log('[oracle/crypto] sync tick error: ' + (e instanceof Error ? e.message : String(e)));
    return { created: 0, skipped: 0, errors };
  }
}

/** Resolve one crypto market (payout/commission in transaction). Idempotent. */
async function resolveCryptoMarketById(marketId: string, winningOutcome: string): Promise<void> {
  const market = await prisma.market.findUnique({
    where: { id: marketId },
    include: { bets: true },
  });
  if (!market || market.status !== 'OPEN') return;
  if (!market.outcomes.includes(winningOutcome)) return;

  const totalPool = market.bets.reduce((sum, b) => sum + b.amount, 0);
  const commission = round2(totalPool * PLATFORM_FEE);
  const payoutPool = totalPool - commission;
  const winningBets = market.bets.filter((b) => b.outcome === winningOutcome);
  const totalWinningStake = winningBets.reduce((sum, b) => sum + b.amount, 0);

  await prisma.$transaction(async (tx) => {
    await tx.market.update({
      where: { id: market.id },
      data: { status: 'RESOLVED', winningOutcome, resolvedAt: new Date() },
    });
    if (totalPool > 0) {
      await tx.adminProfit.create({ data: { marketId: market.id, amount: commission } });
    }
    if (totalWinningStake > 0) {
      for (const bet of winningBets) {
        const payout = round2((payoutPool * bet.amount) / totalWinningStake);
        await tx.bet.update({ where: { id: bet.id }, data: { payout, isWinning: true } });
        await tx.user.update({ where: { id: bet.userId }, data: { balance: { increment: payout } } });
        await tx.transaction.create({
          data: {
            userId: bet.userId,
            type: 'BET_WON',
            amount: payout,
            description: JSON.stringify({ marketId: market.id, betId: bet.id, source: 'oracle_crypto' }),
            marketId: market.id,
            betId: bet.id,
          },
        });
      }
    }
    const losingBets = market.bets.filter((b) => b.outcome !== winningOutcome);
    if (losingBets.length > 0) {
      await tx.bet.updateMany({
        where: { id: { in: losingBets.map((b) => b.id) } },
        data: { isWinning: false, payout: 0 },
      });
    }
  });
}

/** Resolve: find OPEN crypto markets where endDate (resolveAt) <= now, fetch price, resolve ABOVE/BELOW. */
export async function runCryptoResolution(): Promise<{ resolved: number; errors: string[] }> {
  console.log('[oracle/crypto] resolve tick started');
  const errors: string[] = [];
  let resolved = 0;
  const now = new Date();

  const markets = await prisma.market.findMany({
    where: {
      oracleSource: ORACLE_SOURCE,
      status: 'OPEN',
      endDate: { lte: now },
      marketType: { startsWith: MARKET_TYPE_PREFIX },
    },
  });

  if (markets.length === 0) {
    console.log('[oracle/crypto] resolve tick done: resolved 0');
    return { resolved: 0, errors: [] };
  }

  let prices: Awaited<ReturnType<typeof getSimplePrices>> | null = null;
  try {
    prices = await getSimplePrices();
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
    return { resolved: 0, errors };
  }

  for (const market of markets) {
    if (market.line == null) {
      errors.push(`${market.id}: missing line`);
      continue;
    }
    const symbol = market.marketType?.replace(MARKET_TYPE_PREFIX, '') as 'btc' | 'eth' | 'sol';
    if (!SYMBOLS.includes(symbol)) {
      errors.push(`${market.id}: unknown symbol`);
      continue;
    }
    const price = getPriceFromResult(prices!, symbol);
    if (price == null) {
      errors.push(`${market.id}: no price for ${symbol}`);
      continue;
    }
    const winningOutcome = price >= market.line ? 'ABOVE' : 'BELOW';
    try {
      await resolveCryptoMarketById(market.id, winningOutcome);
      resolved++;
    } catch (e) {
      errors.push(`${market.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log('[oracle/crypto] resolve tick done: resolved ' + resolved);
  return { resolved, errors };
}

/** Status: oracleDay, createdTodayCount, optional limiter info. */
export async function getCryptoOracleStatus(): Promise<{
  oracleDay: string;
  createdTodayCount: number;
}> {
  const oracleDay = getOracleDay();
  const createdTodayCount = await countCryptoMarketsForDay(oracleDay);
  return { oracleDay, createdTodayCount };
}
