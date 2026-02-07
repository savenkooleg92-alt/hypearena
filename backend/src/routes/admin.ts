import express, { Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { requireAdmin } from '../middleware/auth';
import * as WalletService from '../services/wallet.service';
import { runDiscovery, runResolution, resolveMatchByOracleMatchId, cancelStaleCybersportMarkets, reopenMatchByOracleMatchId } from '../services/oracle.cybersport';
import { getLimiterStats } from '../services/pandascore.service';
import * as RouletteService from '../services/roulette.service';
import { fetchPoliticsSuggestions } from '../services/politics-feed.service';
import { fetchEventsSuggestions } from '../services/events-feed.service';
import {
  runSolUsdcDepositCycle,
  backfillSolUsdcDeposit,
  creditSolUsdcDeposits,
  creditSolUsdcDepositByTxHash,
  reconcileSolUsdcPending,
  reconcileSolUsdcByTxHash,
  sweepSolUsdcDeposits,
} from '../services/sol-usdc-deposit.service';
import { runTronUsdtDepositCycle } from '../services/tron-usdt-deposit.service';
import { runPolygonUsdtDepositCycle, createAndCreditPolygonDeposit, creditPolygonDepositByTxHash, rescanPolygonDepositsForAddress } from '../services/polygon-usdt-deposit.service';
import { runSweepForNetwork } from '../services/wallet-sweep.service';
import { runResolution as runSportsResolution } from '../services/oracle.sports';
import { runResolution as runPoliticsResolution } from '../services/oracle.politics';
import { runResolution as runEventsResolution } from '../services/oracle.events';
import { fetchSportsScoresForDiagnostic, subCategoryToSportKey } from '../services/sports.data';
import { fetchUpcomingPoliticsEvents } from '../services/politics.data';
import { fetchUpcomingCulturalEvents } from '../services/events.data';
import { sendSupportReplyToUser, sendTestEmailToSupport, SUPPORT_EMAIL } from '../services/email.service';
import { getGamesByDate, getRequestsUsedToday as getApisportsRequestsUsedToday } from '../services/apisports-nfl.service';

const router = express.Router();
const withAuth = [authenticateToken, requireAdmin];

const updateMarketSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  description: z.string().optional().nullable(),
  category: z.string().optional().nullable(),
  subCategory: z.string().optional().nullable(),
  outcomes: z.array(z.string()).min(2).optional(),
  endDate: z.string().datetime().optional().nullable(),
  startsAt: z.string().datetime().optional().nullable(),
});

/** GET /api/admin/stats */
router.get('/stats', withAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const [platformBalance, depositsToday, depositsTotal, pendingWithdrawals, openMarkets, rouletteStats] =
      await Promise.all([
        prisma.adminProfit.aggregate({ _sum: { amount: true } }),
        prisma.transaction.aggregate({
          where: { type: 'DEPOSIT', createdAt: { gte: startOfToday() } },
          _sum: { amount: true },
        }),
        prisma.transaction.aggregate({
          where: { type: 'DEPOSIT' },
          _sum: { amount: true },
        }),
        prisma.withdrawalRequest.count({ where: { status: 'PENDING' } }),
        prisma.market.count({ where: { status: 'OPEN' } }),
        RouletteService.getRouletteStats(),
      ]);
    const oracle = getLimiterStats();
    const nflRequestsToday = getApisportsRequestsUsedToday();
    res.json({
      platformBalance: platformBalance._sum.amount ?? 0,
      depositsToday: depositsToday._sum.amount ?? 0,
      depositsTotal: depositsTotal._sum.amount ?? 0,
      pendingWithdrawals,
      openMarkets,
      oracle: {
        tokensRemaining: oracle.tokensRemaining,
        requestsInLastHour: oracle.requestsInLastHour,
        shouldStop: oracle.shouldStop,
        nfl: { requestsUsedToday: nflRequestsToday, dailyLimit: 100 },
      },
      roulette: {
        totalVolumeCents: rouletteStats.totalVolumeCents,
        totalFeesCents: rouletteStats.totalFeesCents,
        feesWaivedCount: rouletteStats.feesWaivedCount,
      },
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load stats', message: e instanceof Error ? e.message : String(e) });
  }
});

function startOfToday(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** GET /api/admin/markets — all OPEN / RESOLVED (and CLOSED/CANCELLED). ?title=... filters by title (contains). ?awaiting=1 = markets needing resolution: AWAITING_RESULT or OPEN with endDate passed. */
router.get('/markets', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { status, title, awaiting } = req.query;
    const now = new Date();
    let where: Record<string, unknown> = {};
    if (awaiting === '1' || awaiting === 'true') {
      where = {
        OR: [
          { status: 'AWAITING_RESULT' },
          { status: 'OPEN', endDate: { lte: now } },
          { status: 'OPEN', endDate: null, startsAt: { lte: now } },
        ],
      };
    } else {
      if (status && typeof status === 'string') where.status = status;
      else where.status = { in: ['OPEN', 'AWAITING_RESULT', 'RESOLVED', 'CLOSED', 'CANCELLED'] };
    }
    if (title && typeof title === 'string' && title.trim()) where.title = { contains: title.trim(), mode: 'insensitive' };
    const markets = await prisma.market.findMany({
      where,
      include: {
        creator: { select: { id: true, username: true } },
        _count: { select: { bets: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(markets);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load markets' });
  }
});

const adminCreateMarketSchema = z
  .object({
    title: z.string().min(3).max(200),
    description: z.string().optional(),
    category: z.string().optional(),
    outcomes: z
      .array(z.string())
      .min(2)
      .transform((arr) => arr.filter((s) => s.trim().length > 0))
      .refine((arr) => arr.length >= 2, { message: 'At least 2 non-empty outcomes required' }),
    endDate: z.preprocess(
      (val) => (val === '' || val == null ? undefined : val),
      z.string().datetime().optional()
    ),
    startsAt: z.preprocess(
      (val) => (val === '' || val == null ? undefined : val),
      z.string().datetime().optional()
    ),
  })
  .refine(
    (data) => {
      if (!data.endDate || !data.startsAt) return true;
      const end = new Date(data.endDate).getTime();
      const start = new Date(data.startsAt).getTime();
      return end > start;
    },
    { message: 'End date must be after start date.', path: ['endDate'] }
  );

/** POST /api/admin/markets — create market as admin (status OPEN, visible immediately, no moderation) */
router.post('/markets', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const data = adminCreateMarketSchema.parse(req.body);
    const market = await prisma.market.create({
      data: {
        title: data.title,
        description: data.description ?? null,
        category: data.category ?? null,
        outcomes: data.outcomes,
        creatorId: req.userId!,
        endDate: data.endDate ? new Date(data.endDate) : null,
        startsAt: data.startsAt ? new Date(data.startsAt) : null,
        status: 'OPEN',
      },
      include: {
        creator: { select: { id: true, username: true } },
      },
    });
    res.status(201).json({
      ...market,
      totalVolume: 0,
      odds: Object.fromEntries(data.outcomes.map((o) => [o, 1])),
    });
  } catch (e) {
    if (e instanceof z.ZodError) {
      const message = e.errors.map((err) => err.message).join('; ');
      return res.status(400).json({ error: message });
    }
    res.status(500).json({ error: 'Failed to create market' });
  }
});

/** GET /api/admin/markets/pending — PENDING only */
router.get('/markets/pending', withAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const markets = await prisma.market.findMany({
      where: { status: 'PENDING' },
      include: {
        creator: { select: { id: true, username: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(markets);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load pending markets' });
  }
});

/** PATCH /api/admin/markets/:id — edit (e.g. before approve) */
router.patch('/markets/:id', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const market = await prisma.market.findUnique({ where: { id: req.params.id } });
    if (!market) return res.status(404).json({ error: 'Market not found' });
    if (market.status !== 'PENDING') return res.status(409).json({ error: 'Only PENDING markets can be edited' });
    const body = updateMarketSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: 'Invalid body', details: body.error.flatten() });
    const data: Record<string, unknown> = {};
    if (body.data.title != null) data.title = body.data.title;
    if (body.data.description !== undefined) data.description = body.data.description;
    if (body.data.category !== undefined) data.category = body.data.category;
    if (body.data.subCategory !== undefined) data.subCategory = body.data.subCategory;
    if (body.data.outcomes != null) data.outcomes = body.data.outcomes;
    if (body.data.endDate !== undefined) data.endDate = body.data.endDate ? new Date(body.data.endDate) : null;
    if (body.data.startsAt !== undefined) data.startsAt = body.data.startsAt ? new Date(body.data.startsAt) : null;
    const updated = await prisma.market.update({
      where: { id: req.params.id },
      data,
      include: { creator: { select: { id: true, username: true } } },
    });
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: 'Failed to update market' });
  }
});

/** POST /api/admin/markets/:id/approve */
router.post('/markets/:id/approve', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const market = await prisma.market.findUnique({ where: { id: req.params.id } });
    if (!market) return res.status(404).json({ error: 'Market not found' });
    if (market.status !== 'PENDING') return res.status(409).json({ error: 'Only PENDING markets can be approved' });
    await prisma.market.update({
      where: { id: req.params.id },
      data: { status: 'OPEN' },
    });
    res.json({ ok: true, message: 'Market approved' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to approve market' });
  }
});

/** POST /api/admin/markets/:id/reject */
router.post('/markets/:id/reject', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const market = await prisma.market.findUnique({ where: { id: req.params.id } });
    if (!market) return res.status(404).json({ error: 'Market not found' });
    if (market.status !== 'PENDING') return res.status(409).json({ error: 'Only PENDING markets can be rejected' });
    await prisma.market.update({
      where: { id: req.params.id },
      data: { status: 'CANCELLED' },
    });
    res.json({ ok: true, message: 'Market rejected' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to reject market' });
  }
});

/** POST /api/admin/markets/:id/resolve — set outcome and resolve (admin override; for Politics ENDED → RESOLVED) */
router.post('/markets/:id/resolve', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const winningOutcome =
      typeof req.body?.winningOutcome === 'string' ? req.body.winningOutcome.trim() : undefined;
    if (!winningOutcome) return res.status(400).json({ error: 'winningOutcome is required' });
    const market = await prisma.market.findUnique({
      where: { id: req.params.id },
      include: { bets: true },
    });
    if (!market) return res.status(404).json({ error: 'Market not found' });
    if (market.status !== 'OPEN' && market.status !== 'AWAITING_RESULT') {
      return res.status(409).json({ error: 'Market must be OPEN or AWAITING_RESULT to resolve', status: market.status });
    }
    if (!market.outcomes.includes(winningOutcome)) {
      return res.status(400).json({ error: 'Invalid winning outcome', validOutcomes: market.outcomes });
    }
    const totalPool = market.bets.reduce((sum, b) => sum + b.amount, 0);
    const commission = Math.round(totalPool * 0.015 * 100) / 100;
    const payoutPool = totalPool - commission;
    const winningBets = market.bets.filter((b) => b.outcome === winningOutcome);
    const totalWinningStake = winningBets.reduce((sum, b) => sum + b.amount, 0);
    await prisma.$transaction(async (tx) => {
      await tx.market.update({
        where: { id: market.id },
        data: { status: 'RESOLVED', winningOutcome, resolvedAt: new Date() },
      });
      if (totalPool > 0) await tx.adminProfit.create({ data: { marketId: market.id, amount: commission } });
      if (totalWinningStake > 0) {
        for (const bet of winningBets) {
          const payout = Math.round((payoutPool * bet.amount / totalWinningStake) * 100) / 100;
        await tx.bet.update({ where: { id: bet.id }, data: { payout, isWinning: true } });
        await tx.user.update({ where: { id: bet.userId }, data: { balance: { increment: payout } } });
        await tx.transaction.create({
          data: {
            userId: bet.userId,
            type: 'BET_WON',
            amount: payout,
            description: JSON.stringify({ marketId: market.id, betId: bet.id, source: 'admin_resolve' }),
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
    res.json({ ok: true, message: 'Market resolved', winningOutcome });
  } catch (e) {
    res.status(500).json({ error: 'Failed to resolve market' });
  }
});

/** POST /api/admin/markets/:id/remove — cancel market (any status). Body: { refund?: boolean }. If refund=true, return stakes to all bettors; if false/omit, just hide from site. */
router.post('/markets/:id/remove', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const refund = req.body && typeof (req.body as { refund?: boolean }).refund === 'boolean' ? (req.body as { refund: boolean }).refund : false;
    const market = await prisma.market.findUnique({
      where: { id: req.params.id },
      include: { bets: true },
    });
    if (!market) return res.status(404).json({ error: 'Market not found' });
    const allowed = ['PENDING', 'OPEN', 'AWAITING_RESULT', 'RESOLVED', 'CLOSED'];
    if (!allowed.includes(market.status)) {
      return res.status(409).json({ error: 'Market cannot be removed', status: market.status });
    }
    const isResolved = market.status === 'RESOLVED' || market.status === 'CLOSED';
    await prisma.$transaction(async (tx) => {
      await tx.market.update({
        where: { id: market.id },
        data: { status: 'CANCELLED', resolvedAt: new Date(), winningOutcome: null },
      });
      if (refund) {
        if (isResolved) {
          for (const bet of market.bets) {
            const stake = bet.amount;
            const payout = bet.payout ?? 0;
            const isWinning = bet.isWinning === true;
            if (isWinning && payout > 0) {
              const profit = payout - stake;
              await tx.user.update({
                where: { id: bet.userId },
                data: { balance: { decrement: profit } },
              });
            } else {
              await tx.user.update({
                where: { id: bet.userId },
                data: { balance: { increment: stake } },
              });
            }
            await tx.bet.update({
              where: { id: bet.id },
              data: { payout: 0, isWinning: false },
            });
            await tx.transaction.create({
              data: {
                userId: bet.userId,
                type: 'BET_WON',
                amount: isWinning && payout > 0 ? - (payout - stake) : stake,
                description: JSON.stringify({ marketId: market.id, betId: bet.id, source: 'admin_remove_refund', reason: 'market_removed_stakes_returned' }),
                marketId: market.id,
                betId: bet.id,
              },
            });
          }
        } else {
          for (const bet of market.bets) {
            await tx.user.update({
              where: { id: bet.userId },
              data: { balance: { increment: bet.amount } },
            });
            await tx.bet.update({
              where: { id: bet.id },
              data: { payout: 0, isWinning: false },
            });
            await tx.transaction.create({
              data: {
                userId: bet.userId,
                type: 'BET_WON',
                amount: bet.amount,
                description: JSON.stringify({ marketId: market.id, betId: bet.id, source: 'admin_remove', reason: 'market_removed' }),
                marketId: market.id,
                betId: bet.id,
              },
            });
          }
        }
      }
    });
    res.json({
      ok: true,
      message: refund ? 'Market removed and stakes returned to bettors' : 'Market removed from site',
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[admin] remove market failed:', message, e);
    res.status(500).json({ error: 'Failed to remove market', details: message });
  }
});

/** GET /api/admin/bets */
router.get('/bets', withAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const bets = await prisma.bet.findMany({
      include: {
        user: { select: { id: true, username: true } },
        market: { select: { id: true, title: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    res.json(bets);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load bets' });
  }
});

/** GET /api/admin/deposits — transactions type DEPOSIT */
router.get('/deposits', withAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const rows = await prisma.transaction.findMany({
      where: { type: 'DEPOSIT' },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load deposits' });
  }
});

/** GET /api/admin/deposits/sol — SOL deposit records. Optional ?address= or ?tx= to filter by deposit address or tx hash. */
router.get('/deposits/sol', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const address = typeof req.query.address === 'string' ? req.query.address.trim() : undefined;
    const tx = typeof req.query.tx === 'string' ? req.query.tx.trim() : undefined;
    const where: { network: 'SOL'; depositAddress?: string; txHash?: string } = { network: 'SOL' };
    if (address) where.depositAddress = address;
    if (tx) where.txHash = tx;
    const rows = await prisma.deposit.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 500,
      include: { user: { select: { id: true, username: true } } },
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load SOL deposits' });
  }
});

/** GET /api/admin/deposits/sol/pending — CONFIRMED and SWEPT SOL deposits (not yet credited). */
router.get('/deposits/sol/pending', withAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const rows = await prisma.deposit.findMany({
      where: { network: 'SOL', status: { in: ['CONFIRMED', 'SWEPT'] } },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, username: true, email: true } } },
    });
    res.json({ pending: rows, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load pending SOL deposits' });
  }
});

/** GET /api/admin/deposits/tron — TRON USDT deposit records. */
router.get('/deposits/tron', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const address = typeof req.query.address === 'string' ? req.query.address.trim() : undefined;
    const tx = typeof req.query.tx === 'string' ? req.query.tx.trim() : undefined;
    const where: { network: 'TRON'; depositAddress?: string; txHash?: string } = { network: 'TRON' };
    if (address) where.depositAddress = address;
    if (tx) where.txHash = tx;
    const rows = await prisma.deposit.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 500,
      include: { user: { select: { id: true, username: true } } },
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load TRON deposits' });
  }
});

/** GET /api/admin/deposits/polygon — Polygon USDT deposit records. */
router.get('/deposits/polygon', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const address = typeof req.query.address === 'string' ? req.query.address.trim() : undefined;
    const tx = typeof req.query.tx === 'string' ? req.query.tx.trim() : undefined;
    const where: { network: 'MATIC'; depositAddress?: string; txHash?: string } = { network: 'MATIC' };
    if (address) where.depositAddress = address;
    if (tx) where.txHash = tx;
    const rows = await prisma.deposit.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 500,
      include: { user: { select: { id: true, username: true } } },
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load Polygon deposits' });
  }
});

/** POST /api/admin/deposits/run-usdc-credit-step — run only credit step (SWEPT → CREDITED). Use after DB recovery. */
router.post('/deposits/run-usdc-credit-step', withAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await creditSolUsdcDeposits();
    res.json({ ok: true, credited: result.credited, errors: result.errors.length ? result.errors : undefined });
  } catch (e) {
    res.status(500).json({ error: 'Credit step failed', message: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/admin/deposits/credit-one-sol-usdc — credit one deposit by txHash (CONFIRMED or SWEPT → CREDITED). Idempotent. */
router.post('/deposits/credit-one-sol-usdc', withAuth, async (req: AuthRequest, res: Response) => {
  const txHash = typeof req.body?.txHash === 'string' ? req.body.txHash.trim() : '';
  if (!txHash) return res.status(400).json({ error: 'txHash required' });
  try {
    const result = await creditSolUsdcDepositByTxHash(txHash);
    if (result.ok && 'alreadyCredited' in result && result.alreadyCredited) {
      return res.json({ ok: true, alreadyCredited: true, message: 'Deposit already credited' });
    }
    if (result.ok && 'credited' in result && result.credited) {
      return res.json({
        ok: true,
        credited: true,
        userId: result.userId,
        amountUsd: result.amountUsd,
        previousStatus: result.previousStatus,
      });
    }
    return res.status(400).json({ ok: false, error: (result as { error: string }).error });
  } catch (e) {
    res.status(500).json({ error: 'Credit one failed', message: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/admin/solana/usdc/reconcile — reconcile pending SOL USDC (last 48h): detect → confirm → sweep → credit. */
router.post('/solana/usdc/reconcile', withAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await reconcileSolUsdcPending();
    res.json({
      ok: true,
      detected: result.detected,
      confirmed: result.confirmed,
      failed: result.failed,
      swept: result.swept,
      credited: result.credited,
      errors: result.errors.length ? result.errors : undefined,
    });
  } catch (e) {
    res.status(500).json({ error: 'Reconcile failed', message: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/admin/solana/usdc/reconcile/:txHash — reconcile one deposit by txHash; run credit path. Idempotent. */
router.post('/solana/usdc/reconcile/:txHash', withAuth, async (req: AuthRequest, res: Response) => {
  const txHash = req.params.txHash?.trim();
  if (!txHash) return res.status(400).json({ error: 'txHash required' });
  try {
    const result = await reconcileSolUsdcByTxHash(txHash);
    if (result.ok && 'alreadyCredited' in result && result.alreadyCredited) {
      return res.json({ ok: true, alreadyCredited: true, message: 'Deposit already credited' });
    }
    if (result.ok && 'credited' in result && result.credited) {
      return res.json({
        ok: true,
        credited: true,
        userId: result.userId,
        amountUsd: result.amountUsd,
        previousStatus: result.previousStatus,
      });
    }
    return res.status(400).json({ ok: false, error: (result as { error: string }).error });
  } catch (e) {
    res.status(500).json({ error: 'Reconcile by txHash failed', message: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/admin/solana/usdc/sweep-pending — sweep all CONFIRMED USDC to master; return count and tx hashes. */
router.post('/solana/usdc/sweep-pending', withAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await sweepSolUsdcDeposits();
    res.json({
      ok: true,
      swept: result.swept,
      sweptTxIds: result.sweptTxIds,
      errors: result.errors.length ? result.errors : undefined,
    });
  } catch (e) {
    res.status(500).json({ error: 'Sweep failed', message: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/admin/deposits/run-usdc-cycle — run USDC deposit detection and credit (detect → confirm → sweep → credit). */
router.post('/deposits/run-usdc-cycle', withAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await runSolUsdcDepositCycle();
    res.json({
      ok: true,
      detected: result.detected,
      confirmed: result.confirmed,
      failed: result.failed,
      swept: result.swept,
      credited: result.credited,
      errors: result.errors.length ? result.errors : undefined,
    });
  } catch (e) {
    res.status(500).json({ error: 'USDC cycle failed', message: e instanceof Error ? e.message : String(e) });
  }
});

const backfillSolUsdcSchema = z.object({
  txHash: z.string().min(1),
  userEmail: z.string().email(),
  amountUsd: z.number().positive().optional(),
});

/** POST /api/admin/deposits/backfill-sol-usdc — manually credit one USDC tx for a user (idempotent, no double credit). */
router.post('/deposits/backfill-sol-usdc', withAuth, async (req: AuthRequest, res: Response) => {
  const parsed = backfillSolUsdcSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues });
  }
  const { txHash, userEmail, amountUsd } = parsed.data;
  try {
    const result = await backfillSolUsdcDeposit(txHash, userEmail, amountUsd);
    if (result.ok && 'alreadyCredited' in result && result.alreadyCredited) {
      return res.json({ ok: true, alreadyCredited: true, message: 'Deposit already credited' });
    }
    if (result.ok && 'credited' in result && result.credited) {
      return res.json({ ok: true, credited: true, userId: result.userId, amountUsd: result.amountUsd });
    }
    return res.status(400).json({ ok: false, error: (result as { error: string }).error });
  } catch (e) {
    res.status(500).json({ error: 'Backfill failed', message: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/admin/tron/usdt/run-cycle — TRON USDT: detect → confirm → credit. */
router.post('/tron/usdt/run-cycle', withAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await runTronUsdtDepositCycle();
    res.json({
      ok: true,
      scanned: result.scanned,
      matched: result.matched,
      detected: result.detected,
      confirmed: result.confirmed,
      failed: result.failed,
      credited: result.credited,
      errors: result.errors.length ? result.errors : undefined,
    });
  } catch (e) {
    res.status(500).json({ error: 'TRON USDT cycle failed', message: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/admin/tron/usdt/sweep — Sweep all TRON USDT from deposit addresses to master. */
router.post('/tron/usdt/sweep', withAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const { sweptCount, results } = await runSweepForNetwork('TRON');
    res.json({ ok: true, sweptCount, results });
  } catch (e) {
    res.status(500).json({ error: 'TRON sweep failed', message: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/admin/polygon/credit-deposit — Manually credit one Polygon USDT deposit by tx hash and address. Body: { txHash, depositAddress, amountUsd }. */
router.post('/polygon/credit-deposit', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const txHash = typeof req.body?.txHash === 'string' ? req.body.txHash.trim() : '';
    const depositAddress = typeof req.body?.depositAddress === 'string' ? req.body.depositAddress.trim() : '';
    const amountUsd = typeof req.body?.amountUsd === 'number' ? req.body.amountUsd : parseFloat(String(req.body?.amountUsd || ''));
    if (!txHash || !depositAddress || Number.isNaN(amountUsd) || amountUsd <= 0) {
      return res.status(400).json({ error: 'Body must include txHash, depositAddress, and amountUsd (number)' });
    }
    const result = await createAndCreditPolygonDeposit(txHash, depositAddress, amountUsd);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }
    return res.json({ ok: true, credited: result.credited });
  } catch (e) {
    res.status(500).json({ error: 'Polygon credit-deposit failed', message: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/admin/polygon/credit-by-tx — Credit one Polygon USDT deposit by tx hash only (receipt parsed for address and amount). Body: { txHash }. */
router.post('/polygon/credit-by-tx', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const txHash = typeof req.body?.txHash === 'string' ? req.body.txHash.trim() : '';
    if (!txHash) return res.status(400).json({ error: 'Body must include txHash' });
    const result = await creditPolygonDepositByTxHash(txHash);
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'Polygon credit-by-tx failed', message: e instanceof Error ? e.message : String(e) });
  }
});

/** GET /api/admin/polygon/user-submissions — List user-submitted Polygon tx hashes (I paid). */
router.get('/polygon/user-submissions', withAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const rows = await prisma.polygonTxSubmission.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { user: { select: { id: true, username: true, email: true } } },
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load user submissions' });
  }
});

/** POST /api/admin/polygon/user-submissions/credit — Verify and credit one submission by id. One txHash = one credit ever. */
router.post('/polygon/user-submissions/credit', withAuth, async (req: AuthRequest, res: Response) => {
  const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
  if (!id) return res.status(400).json({ error: 'Body must include id (submission id).' });
  try {
    const sub = await prisma.polygonTxSubmission.findUnique({ where: { id } });
    if (!sub) return res.status(404).json({ error: 'Submission not found' });
    if (sub.status === 'CREDITED') {
      return res.json({
        ok: true,
        alreadyCredited: true,
        amountUsd: sub.amountUsd,
        depositAddress: sub.depositAddress,
        message: 'This hash was already credited. One hash = one credit only.',
      });
    }
    const creditResult = await creditPolygonDepositByTxHash(sub.txHash);
    if (!creditResult.ok) {
      return res.status(400).json({ error: creditResult.error });
    }
    const amountUsd = 'amountUsd' in creditResult ? creditResult.amountUsd : undefined;
    const depositAddress = 'depositAddress' in creditResult ? creditResult.depositAddress : undefined;
    await prisma.polygonTxSubmission.update({
      where: { id },
      data: { status: 'CREDITED', creditedAt: new Date(), amountUsd: amountUsd ?? null, depositAddress: depositAddress ?? null },
    });
    const { sweptCount, results, message } = await runSweepForNetwork('MATIC');
    return res.json({
      ok: true,
      credited: true,
      amountUsd,
      depositAddress,
      sweptCount,
      results,
      message,
    });
  } catch (e) {
    res.status(500).json({ error: 'Credit failed', message: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/admin/polygon/rescan-address — Rescan block range for one address; create DETECTED → confirm → credit. Body: { depositAddress, fromBlock, toBlock? }. */
router.post('/polygon/rescan-address', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const depositAddress = typeof req.body?.depositAddress === 'string' ? req.body.depositAddress.trim() : '';
    const fromBlock = typeof req.body?.fromBlock === 'number' ? req.body.fromBlock : parseInt(String(req.body?.fromBlock ?? ''), 10);
    const toBlock = req.body?.toBlock != null ? (typeof req.body.toBlock === 'number' ? req.body.toBlock : parseInt(String(req.body.toBlock), 10)) : undefined;
    if (!depositAddress) return res.status(400).json({ error: 'Body must include depositAddress (0x...)' });
    if (Number.isNaN(fromBlock) || fromBlock < 0) return res.status(400).json({ error: 'Body must include fromBlock (number)' });
    const result = await rescanPolygonDepositsForAddress(depositAddress, fromBlock, toBlock);
    if (!result.ok) return res.status(400).json({ error: result.errors[0] ?? 'Rescan failed' });
    return res.json({
      ok: true,
      created: result.created,
      credited: result.credited,
      errors: result.errors.length ? result.errors : undefined,
    });
  } catch (e) {
    res.status(500).json({ error: 'Polygon rescan failed', message: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/admin/polygon/credit-and-sweep — Credit one deposit by tx hash, then fund (POL) and sweep to master. Body: { txHash }. */
router.post('/polygon/credit-and-sweep', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const txHash = typeof req.body?.txHash === 'string' ? req.body.txHash.trim() : '';
    if (!txHash) return res.status(400).json({ error: 'Body must include txHash (найди на Polygonscan: адрес → ERC-20 Transfers → входящий)' });
    const creditResult = await creditPolygonDepositByTxHash(txHash);
    if (!creditResult.ok) return res.status(400).json({ error: creditResult.error });
    const { sweptCount, results, message } = await runSweepForNetwork('MATIC');
    const forAddress = 'ok' in creditResult && 'depositAddress' in creditResult ? (creditResult as { depositAddress?: string }).depositAddress : null;
    return res.json({
      ok: true,
      credited: true,
      depositAddress: forAddress ?? undefined,
      sweptCount,
      results,
      message,
    });
  } catch (e) {
    res.status(500).json({ error: 'Polygon credit-and-sweep failed', message: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/admin/polygon/usdt/run-cycle — Polygon USDT: detect → confirm → credit → sweep (same as SOL). */
router.post('/polygon/usdt/run-cycle', withAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await runPolygonUsdtDepositCycle();
    res.json({
      ok: true,
      detected: result.detected,
      confirmed: result.confirmed,
      failed: result.failed,
      credited: result.credited,
      swept: result.swept,
      errors: result.errors.length ? result.errors : undefined,
    });
  } catch (e) {
    res.status(500).json({ error: 'Polygon USDT cycle failed', message: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/admin/polygon/usdt/sweep — Sweep all Polygon USDT from deposit addresses to master. */
router.post('/polygon/usdt/sweep', withAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const { sweptCount, results, message } = await runSweepForNetwork('MATIC');
    res.json({ ok: true, sweptCount, results, message });
  } catch (e) {
    res.status(500).json({ error: 'Polygon sweep failed', message: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/admin/oracle/test-apisports — trigger one NFL request to verify provider + env; confirm dashboard counter increments. */
router.post('/oracle/test-apisports', withAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const requestsBefore = getApisportsRequestsUsedToday();
    const today = new Date().toISOString().slice(0, 10);
    const season = new Date().getFullYear();
    console.log('[admin] oracle/test-apisports: triggering one NFL request, date=', today, 'season=', season);
    const games = await getGamesByDate(today, season);
    const requestsAfter = getApisportsRequestsUsedToday();
    res.json({
      ok: true,
      sport: 'nfl',
      requestsUsedBefore: requestsBefore,
      requestsUsedAfter: requestsAfter,
      gamesCount: games.length,
      message:
        requestsAfter > requestsBefore
          ? 'One request sent. Dashboard counter should show ' + requestsAfter + ' requests used today.'
          : 'Request may have been skipped (daily limit reached) or no request was made. Check server logs.',
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[admin] oracle/test-apisports error:', message);
    res.status(500).json({
      ok: false,
      error: message,
      requestsUsedToday: getApisportsRequestsUsedToday(),
    });
  }
});

/** POST /api/admin/oracle/diagnostic — один диагностический прогон resolver: fetch params, fetchedCount, pending OPEN markets, matchedCount, resolvedCount, интерпретация. */
router.post('/oracle/diagnostic', withAuth, async (_req: AuthRequest, res: Response) => {
  const now = new Date();
  const out: {
    sports: {
      fetchParams: Array<{ sportKey: string; daysFrom: number; endpoint: string }>;
      fetchedCount: number;
      completedCount: number;
      pendingCount: number;
      pendingMarkets: Array<{ provider: string; externalEventId: string; marketId: string }>;
      matchedCount: number;
      resolvedCount: number;
      interpretation: string;
    };
    politics: {
      fetchParams: { POLITICS_ORACLE_ENABLED: string };
      fetchedCount: number;
      pendingCount: number;
      pendingMarkets: Array<{ provider: string; externalEventId: string; marketId: string }>;
      matchedCount: number;
      resolvedCount: number;
      interpretation: string;
    };
    events: {
      fetchParams: { EVENTS_ORACLE_ENABLED: string };
      fetchedCount: number;
      pendingCount: number;
      pendingMarkets: Array<{ provider: string; externalEventId: string; marketId: string }>;
      matchedCount: number;
      resolvedCount: number;
      interpretation: string;
    };
  } = {
    sports: { fetchParams: [], fetchedCount: 0, completedCount: 0, pendingCount: 0, pendingMarkets: [], matchedCount: 0, resolvedCount: 0, interpretation: '' },
    politics: { fetchParams: { POLITICS_ORACLE_ENABLED: process.env.POLITICS_ORACLE_ENABLED ?? 'not set' }, fetchedCount: 0, pendingCount: 0, pendingMarkets: [], matchedCount: 0, resolvedCount: 0, interpretation: '' },
    events: { fetchParams: { EVENTS_ORACLE_ENABLED: process.env.EVENTS_ORACLE_ENABLED ?? 'not set' }, fetchedCount: 0, pendingCount: 0, pendingMarkets: [], matchedCount: 0, resolvedCount: 0, interpretation: '' },
  };

  try {
    // --- Pending OPEN markets ---
    const [sportsMarkets, politicsMarkets, eventsMarkets] = await Promise.all([
      prisma.market.findMany({
        where: { oracleSource: 'sports', status: 'OPEN', startsAt: { lt: now } },
        select: { id: true, oracleMatchId: true, subCategory: true },
        orderBy: { startsAt: 'asc' },
        take: 100,
      }),
      prisma.market.findMany({
        where: { oracleSource: 'politics', status: 'OPEN', endDate: { lte: now } },
        select: { id: true, oracleMatchId: true },
        orderBy: { endDate: 'asc' },
        take: 100,
      }),
      prisma.market.findMany({
        where: { oracleSource: 'events', status: 'OPEN', endDate: { lte: now } },
        select: { id: true, oracleMatchId: true },
        orderBy: { endDate: 'asc' },
        take: 100,
      }),
    ]);

    out.sports.pendingCount = sportsMarkets.length;
    out.sports.pendingMarkets = sportsMarkets
      .filter((m) => m.oracleMatchId)
      .map((m) => ({ provider: 'sports', externalEventId: m.oracleMatchId!, marketId: m.id }));
    out.politics.pendingCount = politicsMarkets.length;
    out.politics.pendingMarkets = politicsMarkets
      .filter((m) => m.oracleMatchId)
      .map((m) => ({ provider: 'politics', externalEventId: m.oracleMatchId!, marketId: m.id }));
    out.events.pendingCount = eventsMarkets.length;
    out.events.pendingMarkets = eventsMarkets
      .filter((m) => m.oracleMatchId)
      .map((m) => ({ provider: 'events', externalEventId: m.oracleMatchId!, marketId: m.id }));

    // --- Sports: fetch params + fetchedCount (per sport_key from pending) ---
    const sportKeys = [...new Set(sportsMarkets.map((m) => subCategoryToSportKey(m.subCategory ?? 'nfl')))];
    for (const sportKey of sportKeys.length ? sportKeys : ['americanfootball_nfl']) {
      const diag = await fetchSportsScoresForDiagnostic(sportKey, 3);
      out.sports.fetchParams.push(diag.fetchParams);
      out.sports.fetchedCount += diag.eventCount;
      out.sports.completedCount += diag.completedCount;
    }

    // --- Politics: fetchParams + fetchedCount (upcoming list length) ---
    const politicsList = await fetchUpcomingPoliticsEvents();
    out.politics.fetchedCount = politicsList.length;

    // --- Events: fetchParams + fetchedCount ---
    const eventsList = await fetchUpcomingCulturalEvents();
    out.events.fetchedCount = eventsList.length;

    // --- Run resolvers (one tick each) ---
    const [sportsResult, politicsResult, eventsResult] = await Promise.all([
      runSportsResolution(),
      runPoliticsResolution(),
      runEventsResolution(),
    ]);

    out.sports.matchedCount = sportsResult.matchedCount;
    out.sports.resolvedCount = sportsResult.resolved;
    out.politics.matchedCount = politicsResult.matchedCount;
    out.politics.resolvedCount = politicsResult.resolved;
    out.events.matchedCount = eventsResult.matchedCount;
    out.events.resolvedCount = eventsResult.resolved;

    // --- Interpretations ---
    const interp = (
      fetchedCount: number,
      matchedCount: number,
      resolvedCount: number,
      provider: string
    ): string => {
      if (fetchedCount === 0) return `${provider}: fetchedCount=0 — проблема в окне запроса / эндпоинте / ключе (THE_ODDS_API_KEY или POLITICS/EVENTS_ORACLE_ENABLED).`;
      if (matchedCount === 0) return `${provider}: fetchedCount>0 но matchedCount=0 — проблема в маппинге externalEventId (id провайдера не совпадает с oracleMatchId в БД).`;
      if (resolvedCount === 0) return `${provider}: matchedCount>0 но resolvedCount=0 — проблема в определении 'finished' или в парсинге результата (outcome не в списке outcomes маркета).`;
      return `${provider}: OK — resolvedCount=${resolvedCount}, matchedCount=${matchedCount}.`;
    };

    out.sports.interpretation = interp(out.sports.fetchedCount, out.sports.matchedCount, out.sports.resolvedCount, 'sports');
    out.politics.interpretation = interp(out.politics.fetchedCount, out.politics.matchedCount, out.politics.resolvedCount, 'politics');
    out.events.interpretation = interp(out.events.fetchedCount, out.events.matchedCount, out.events.resolvedCount, 'events');

    return res.json({
      ok: true,
      diagnostic: out,
      errors: [
        ...(sportsResult.errors.length ? sportsResult.errors.map((e) => `sports: ${e}`) : []),
        ...(politicsResult.errors.length ? politicsResult.errors.map((e) => `politics: ${e}`) : []),
        ...(eventsResult.errors.length ? eventsResult.errors.map((e) => `events: ${e}`) : []),
      ],
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[admin] oracle diagnostic error:', message);
    return res.status(500).json({ error: 'Oracle diagnostic failed', message });
  }
});

/** GET /api/admin/withdrawals — list with user email/username */
router.get('/withdrawals', withAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const rows = await prisma.withdrawalRequest.findMany({
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, email: true, username: true } } },
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load withdrawals' });
  }
});

/** GET /api/admin/withdrawals/stats */
router.get('/withdrawals/stats', withAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const [totalToday, totalVolume, pendingCount, failedCount, approvedCount] = await Promise.all([
      prisma.withdrawalRequest.count({ where: { status: { in: ['SENT', 'COMPLETED'] }, createdAt: { gte: startOfToday } } }),
      prisma.withdrawalRequest.aggregate({
        where: { status: { in: ['SENT', 'COMPLETED'] } },
        _sum: { amountNet: true },
      }),
      prisma.withdrawalRequest.count({ where: { status: 'PENDING' } }),
      prisma.withdrawalRequest.count({ where: { status: 'FAILED' } }),
      prisma.withdrawalRequest.count({ where: { status: { in: ['APPROVED', 'PROCESSING'] } } }),
    ]);
    res.json({
      totalWithdrawalsToday: totalToday,
      totalWithdrawalsVolume: totalVolume._sum.amountNet ?? 0,
      pendingCount,
      failedCount,
      approvedCount,
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load withdrawal stats' });
  }
});

/** POST /api/admin/withdrawals/send-all-approved — must be before /:id routes */
router.post('/withdrawals/send-all-approved', withAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const list = await prisma.withdrawalRequest.findMany({
      where: { status: { in: ['APPROVED', 'PROCESSING'] }, txId: null },
      orderBy: { createdAt: 'asc' },
    });
    const results: Array<{ id: string; txId?: string; error?: string }> = [];
    for (const wr of list) {
      const r = await WalletService.sendWithdrawalPayout(wr.id);
      if (r.kind === 'OK') results.push({ id: wr.id, txId: r.txId });
      else results.push({ id: wr.id, error: r.kind === 'BAD' ? r.reason : 'Not found' });
    }
    res.json({ ok: true, sent: results.filter((x) => x.txId).length, failed: results.filter((x) => x.error).length, results });
  } catch (e) {
    res.status(500).json({ error: 'Send all failed', message: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/admin/withdrawals/:id/approve — PENDING → APPROVED */
router.post('/withdrawals/:id/approve', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await WalletService.approveWithdrawal(req.params.id);
    if (result.kind === 'NO') return res.status(404).json({ error: 'Not found' });
    if (result.kind === 'BAD') return res.status(409).json({ error: 'Invalid status', status: result.status });
    res.json({ ok: true, request: result.wr });
  } catch (e) {
    res.status(500).json({ error: 'Failed to approve withdrawal' });
  }
});

/** POST /api/admin/withdrawals/:id/reject — PENDING → FAILED, refund balance */
router.post('/withdrawals/:id/reject', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const parsed = z.object({ error: z.string().optional() }).safeParse(req.body ?? {});
    const result = await WalletService.failWithdrawal(req.params.id, { error: parsed.success ? parsed.data.error : undefined });
    if (result.kind === 'NO') return res.status(404).json({ error: 'Not found' });
    if (result.kind === 'BAD') return res.status(409).json({ error: 'Invalid status', status: result.status });
    res.json({ ok: true, request: result.wr, updatedBalance: result.updatedBalance });
  } catch (e) {
    res.status(500).json({ error: 'Failed to reject withdrawal' });
  }
});

/** POST /api/admin/withdrawals/:id/send-payout — APPROVED → send on-chain, set SENT + txId */
router.post('/withdrawals/:id/send-payout', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await WalletService.sendWithdrawalPayout(req.params.id);
    if (result.kind === 'NO') return res.status(404).json({ error: 'Not found' });
    if (result.kind === 'BAD') return res.status(409).json({ error: result.reason });
    res.json({ ok: true, request: result.wr, txId: result.txId });
  } catch (e) {
    res.status(500).json({ error: 'Send payout failed', message: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/admin/withdrawals/:id/retry — FAILED → deduct balance again, set APPROVED */
router.post('/withdrawals/:id/retry', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await WalletService.retryWithdrawal(req.params.id);
    if (result.kind === 'NO') return res.status(404).json({ error: 'Not found' });
    if (result.kind === 'BAD') return res.status(409).json({ error: result.reason });
    res.json({ ok: true, request: result.wr });
  } catch (e) {
    res.status(500).json({ error: 'Retry failed', message: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/admin/withdrawals/:id/fail — alias for reject (PENDING → FAILED) */
router.post('/withdrawals/:id/fail', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const parsed = z.object({ error: z.string().optional() }).safeParse(req.body ?? {});
    const result = await WalletService.failWithdrawal(req.params.id, { error: parsed.success ? parsed.data.error : undefined });
    if (result.kind === 'NO') return res.status(404).json({ error: 'Not found' });
    if (result.kind === 'BAD') return res.status(409).json({ error: 'Invalid status', status: result.status });
    res.json({ ok: true, request: result.wr, updatedBalance: result.updatedBalance });
  } catch (e) {
    res.status(500).json({ error: 'Failed to reject withdrawal' });
  }
});

/** GET /api/admin/feed/politics — political BATTLES only (binary outcomes). Sources: GDELT, BBC/Reuters/Google News RSS. */
router.get('/feed/politics', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const suggestions = await fetchPoliticsSuggestions(limit);
    res.json({ suggestions });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch politics feed', message: e instanceof Error ? e.message : String(e) });
  }
});

/** GET /api/admin/feed/events — event suggestions (concerts, etc.) for admin to create markets */
router.get('/feed/events', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 200);
    const suggestions = await fetchEventsSuggestions(limit);
    res.json({ suggestions });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch events feed', message: e instanceof Error ? e.message : String(e) });
  }
});

/** GET /api/admin/support/tickets — list all support tickets, filter by status, sort newest first */
router.get('/support/tickets', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const where = status && ['OPEN', 'REPLIED', 'CLOSED'].includes(status) ? { status } : {};
    const tickets = await prisma.supportTicket.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, username: true, email: true } } },
    });
    res.json(tickets);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load tickets' });
  }
});

/** POST /api/admin/support/test-email — send test email to SUPPORT_EMAIL (admin-only). */
router.post('/support/test-email', withAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await sendTestEmailToSupport();
    res.json({
      ok: true,
      to: SUPPORT_EMAIL,
      messageId: result.messageId,
      accepted: result.accepted,
      rejected: result.rejected,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[admin] support/test-email error:', msg);
    res.status(500).json({ error: msg });
  }
});

/** POST /api/admin/support/:id/reply — set admin reply, status REPLIED, send email to user */
router.post('/support/:id/reply', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id;
    const body = typeof req.body?.reply === 'string' ? req.body.reply.trim() : '';
    if (!body) return res.status(400).json({ error: 'Reply text is required' });
    const ticket = await prisma.supportTicket.findUnique({ where: { id } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    await prisma.supportTicket.update({
      where: { id },
      data: { adminReply: body, status: 'REPLIED', repliedAt: new Date() },
    });
    await sendSupportReplyToUser({
      userEmail: ticket.userEmail,
      ticketId: ticket.id,
      subject: ticket.subject,
      adminReply: body,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

/** POST /api/admin/support/:id/close — set status CLOSED */
router.post('/support/:id/close', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id;
    const ticket = await prisma.supportTicket.findUnique({ where: { id } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    await prisma.supportTicket.update({
      where: { id },
      data: { status: 'CLOSED' },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to close ticket' });
  }
});

/** POST /api/admin/oracle/sync */
router.post('/oracle/sync', withAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await runDiscovery();
    res.json({
      ok: true,
      created: result.created,
      skipped: result.skipped,
      errors: result.errors,
      rateLimited: result.rateLimited,
      matchesFound: result.matchesFound,
    });
  } catch (e) {
    res.status(500).json({ error: 'Sync failed', message: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/admin/oracle/resolve */
router.post('/oracle/resolve', withAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await runResolution();
    res.json({ ok: true, resolved: result.resolved, errors: result.errors, rateLimited: result.rateLimited });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[admin] oracle/resolve error:', message);
    res.json({
      ok: true,
      resolved: 0,
      errors: [message],
      rateLimited: false,
    });
  }
});

const resolveMatchBodySchema = z.object({ oracleMatchId: z.string().min(1) });

/** POST /api/admin/oracle/reopen-match — restore CANCELLED markets to OPEN (reverse refund). Then use resolve-match to resolve. */
router.post('/oracle/reopen-match', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const parsed = resolveMatchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Body must include oracleMatchId (string)' });
    }
    const result = await reopenMatchByOracleMatchId(parsed.data.oracleMatchId);
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error, ...result });
    }
    res.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[admin] oracle/reopen-match error:', message);
    res.status(500).json({ ok: false, error: message });
  }
});

/** POST /api/admin/oracle/resolve-match — resolve one match by oracleMatchId (all OPEN match_winner markets for that match). */
router.post('/oracle/resolve-match', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const parsed = resolveMatchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Body must include oracleMatchId (string)' });
    }
    const result = await resolveMatchByOracleMatchId(parsed.data.oracleMatchId);
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error, ...result });
    }
    res.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[admin] oracle/resolve-match error:', message);
    res.status(500).json({ ok: false, error: message });
  }
});

/** POST /api/admin/oracle/cancel-stale — cancel OPEN pandascore markets older than 7 days or with null oracleMatchId. */
router.post('/oracle/cancel-stale', withAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await cancelStaleCybersportMarkets();
    res.json({ ok: true, cancelled: result.cancelled, errors: result.errors });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

/** GET /api/admin/roulette/current — current round for admin */
router.get('/roulette/current', withAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const round = await RouletteService.getOrCreateCurrentRound();
    res.json({
      id: round.id,
      roundNumber: round.roundNumber,
      status: round.status,
      startsAt: round.startsAt,
      endsAt: round.endsAt,
      seedHash: round.seedHash,
      serverSeed: round.serverSeed,
      totalTickets: round.totalTickets,
      potCents: round.potCents,
      feeCents: round.feeCents,
      winnerUserId: round.winnerUserId,
      winningTicket: round.winningTicket,
      bets: round.bets.map((b) => ({
        id: b.id,
        userId: b.userId,
        username: b.user?.username,
        amountCents: b.amountCents,
        ticketsFrom: b.ticketsFrom,
        ticketsTo: b.ticketsTo,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get roulette round', message: e instanceof Error ? e.message : String(e) });
  }
});

/** GET /api/admin/roulette/history — last 20 finished rounds */
router.get('/roulette/history', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit || '20'), 10) || 20, 100);
    const rounds = await RouletteService.getHistory(limit);
    res.json(
      rounds.map((r) => ({
        id: r.id,
        roundNumber: r.roundNumber,
        status: r.status,
        endsAt: r.endsAt,
        potCents: r.potCents,
        feeCents: r.feeCents,
        feeWaived: r.feeCents === 0,
        winnerUserId: r.winnerUserId,
        winningTicket: r.winningTicket,
        serverSeed: r.serverSeed,
        updatedAt: r.updatedAt,
      }))
    );
  } catch (e) {
    res.status(500).json({ error: 'Failed to get roulette history', message: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/admin/roulette/resolve — run resolve now (all due rounds) */
router.post('/roulette/resolve', withAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await RouletteService.resolveDueRounds();
    res.json({ ok: true, resolved: result.resolved, errors: result.errors });
  } catch (e) {
    res.status(500).json({ error: 'Roulette resolve failed', message: e instanceof Error ? e.message : String(e) });
  }
});

const resolveRoundBodySchema = z.object({ roundId: z.string().min(1) });

/** POST /api/admin/roulette/resolve-round — resolve one round by id (logs start + finished) */
router.post('/roulette/resolve-round', withAuth, async (req: AuthRequest, res: Response) => {
  try {
    const parsed = resolveRoundBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }
    const { roundId } = parsed.data;
    const result = await RouletteService.resolveRound(roundId);
    if (result.ok) {
      return res.json({
        ok: true,
        roundId,
        winningTicket: result.winningTicket,
        totalTickets: result.totalTickets,
      });
    }
    return res.status(400).json({ error: result.error ?? 'Round not resolved' });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[admin] roulette/resolve-round error:', message);
    return res.status(500).json({ error: 'Roulette resolve-round failed', message });
  }
});

export default router;
