import express from 'express';
import { z } from 'zod';
import type { Bet } from '@prisma/client';
import prisma from '../utils/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';

const router = express.Router();

/** Platform fee taken from the pool on resolution (1.5%). Displayed odds account for this. */
const PLATFORM_FEE = 0.015;

/** In-memory active viewers per market: marketId -> Map<clientId, lastSeenMs>. */
const viewersByMarket = new Map<string, Map<string, number>>();
const VIEWER_TTL_MS = 45000;

function cleanupViewers() {
  const now = Date.now();
  for (const [marketId, clients] of viewersByMarket) {
    for (const [clientId, last] of clients) {
      if (now - last > VIEWER_TTL_MS) clients.delete(clientId);
    }
    if (clients.size === 0) viewersByMarket.delete(marketId);
  }
}
setInterval(cleanupViewers, 60000);

const createMarketSchema = z
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

// Get all markets (exclude PENDING so only live/approved markets are public). ?q=... search by keywords (title/description).
router.get('/', async (req, res) => {
  try {
    const { status, category, subCategory, q } = req.query;
    // Public list: show OPEN (live/upcoming/ended awaiting), RESOLVED, CLOSED. Hide only PENDING and CANCELLED.
    const baseWhere: Record<string, unknown> = {
      status: { notIn: ['PENDING', 'CANCELLED'] },
    };

    if (status && typeof status === 'string') {
      baseWhere.status = status;
    }
    if (category && typeof category === 'string') {
      baseWhere.category = category;
    }
    if (subCategory && typeof subCategory === 'string') {
      baseWhere.subCategory = subCategory;
    }

    const searchTrim = typeof q === 'string' ? q.trim() : '';
    const where =
      searchTrim.length > 0
        ? {
            AND: [
              baseWhere,
              {
                OR: [
                  { title: { contains: searchTrim, mode: 'insensitive' as const } },
                  { description: { not: null, contains: searchTrim, mode: 'insensitive' as const } },
                ],
              },
            ],
          }
        : baseWhere;

    const markets = await prisma.market.findMany({
      where,
      include: {
        creator: {
          select: {
            id: true,
            username: true,
          },
        },
        bets: {
          select: {
            outcome: true,
            amount: true,
          },
        },
        _count: {
          select: {
            bets: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Calculate odds for each market
    const marketsWithOdds = markets.map((market: { bets: { outcome: string; amount: number }[]; outcomes: string[] }) => {
      const totalBets = market.bets.reduce((sum: number, bet: { amount: number }) => sum + bet.amount, 0);
      const outcomeTotals: Record<string, number> = {};

      market.bets.forEach((bet: { outcome: string; amount: number }) => {
        outcomeTotals[bet.outcome] = (outcomeTotals[bet.outcome] || 0) + bet.amount;
      });

      // Odds reflect 1.5% platform fee so users see accurate potential wins
      const poolAfterFee = totalBets * (1 - PLATFORM_FEE);
      const odds: Record<string, number> = {};
      market.outcomes.forEach((outcome: string) => {
        const outcomeTotal = outcomeTotals[outcome] || 0;
        odds[outcome] = totalBets > 0 ? poolAfterFee / (outcomeTotal || 1) : 1;
      });

      return {
        ...market,
        totalVolume: totalBets,
        odds,
      };
    });

    res.json(marketsWithOdds);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch markets' });
  }
});

/** Get all markets for an event (same oracleMatchId or single market by id). GET /api/markets/event/:eventKey */
router.get('/event/:eventKey', async (req, res) => {
  try {
    const eventKey = req.params.eventKey;
    if (!eventKey) {
      return res.status(400).json({ error: 'eventKey required' });
    }
    const markets = await prisma.market.findMany({
      where: {
        status: { notIn: ['PENDING', 'CANCELLED'] },
        OR: [{ oracleMatchId: eventKey }, { id: eventKey }],
      },
      include: {
        creator: { select: { id: true, username: true } },
        bets: { select: { outcome: true, amount: true } },
      },
      orderBy: [{ oracleMatchId: 'asc' }, { marketType: 'asc' }, { createdAt: 'asc' }],
    });

    type M = { id: string; title: string; status: string; outcomes: string[]; startsAt: Date | null; winningOutcome: string | null; marketType: string | null; bets: { outcome: string; amount: number }[] };
    const withOdds = markets.map((m: M) => {
      const totalBets = m.bets.reduce((sum: number, b: { amount: number }) => sum + b.amount, 0);
      const outcomeTotals: Record<string, number> = {};
      m.bets.forEach((b: { outcome: string; amount: number }) => {
        outcomeTotals[b.outcome] = (outcomeTotals[b.outcome] || 0) + b.amount;
      });
      const poolAfterFee = totalBets * (1 - PLATFORM_FEE);
      const odds: Record<string, number> = {};
      m.outcomes.forEach((o: string) => {
        odds[o] = totalBets > 0 ? poolAfterFee / (outcomeTotals[o] || 1) : 1;
      });
      return {
        id: m.id,
        title: m.title,
        status: m.status,
        outcomes: m.outcomes,
        odds,
        totalVolume: totalBets,
        startsAt: m.startsAt,
        winningOutcome: m.winningOutcome,
        marketType: m.marketType,
      };
    });

    res.json({ eventKey, markets: withOdds });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch event markets' });
  }
});

/** GET /markets/:id/viewers — returns { viewers: number }. Query clientId= to register heartbeat (poll every 15s). */
router.get('/:id/viewers', async (req, res) => {
  try {
    const marketId = req.params.id;
    const clientId = typeof req.query.clientId === 'string' ? req.query.clientId : undefined;
    if (clientId && marketId) {
      if (!viewersByMarket.has(marketId)) viewersByMarket.set(marketId, new Map());
      viewersByMarket.get(marketId)!.set(clientId, Date.now());
    }
    const clients = viewersByMarket.get(marketId);
    const viewers = clients ? clients.size : 0;
    return res.json({ viewers });
  } catch {
    return res.status(500).json({ viewers: 0 });
  }
});

// Get single market (with eventKey and relatedMarkets for same event)
router.get('/:id', async (req, res) => {
  try {
    const market = await prisma.market.findUnique({
      where: { id: req.params.id },
      include: {
        creator: {
          select: {
            id: true,
            username: true,
          },
        },
        bets: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                isAnonymous: true,
              },
            },
          },
          orderBy: {
            createdAt: 'desc',
          },
        },
      },
    });

    if (!market) {
      return res.status(404).json({ error: 'Market not found' });
    }

    const eventKey = market.oracleMatchId ?? market.id;
    const betsForResponse = market.bets.map((b: { id: string; outcome: string; amount: number; createdAt: Date; user?: { isAnonymous: boolean | null; username: string | null } | null }) => ({
      id: b.id,
      outcome: b.outcome,
      amount: b.amount,
      createdAt: b.createdAt,
      user: {
        username: b.user?.isAnonymous ? 'Anonymous' : (b.user?.username ?? 'Unknown'),
      },
    }));

    const relatedRows = await prisma.market.findMany({
      where: {
        status: { not: 'PENDING' },
        OR: [{ oracleMatchId: eventKey }, { id: eventKey }],
      },
      include: {
        creator: { select: { id: true, username: true } },
        bets: { select: { outcome: true, amount: true } },
      },
    });

    type M2 = { id: string; title: string; status: string; outcomes: string[]; startsAt: Date | null; winningOutcome: string | null; marketType: string | null; bets: { outcome: string; amount: number }[] };
    const relatedMarkets = relatedRows.map((m: M2) => {
      const totalBets = m.bets.reduce((sum: number, b: { amount: number }) => sum + b.amount, 0);
      const outcomeTotals: Record<string, number> = {};
      m.bets.forEach((b: { outcome: string; amount: number }) => {
        outcomeTotals[b.outcome] = (outcomeTotals[b.outcome] || 0) + b.amount;
      });
      const poolAfterFee = totalBets * (1 - PLATFORM_FEE);
      const odds: Record<string, number> = {};
      m.outcomes.forEach((o: string) => {
        odds[o] = totalBets > 0 ? poolAfterFee / (outcomeTotals[o] || 1) : 1;
      });
      return {
        id: m.id,
        title: m.title,
        status: m.status,
        outcomes: m.outcomes,
        odds,
        totalVolume: totalBets,
        startsAt: m.startsAt,
        winningOutcome: m.winningOutcome,
        marketType: m.marketType,
      };
    });

    const totalBets = market.bets.reduce((sum: number, bet: Bet) => sum + bet.amount, 0);
    const outcomeTotals: Record<string, number> = {};
    market.bets.forEach((bet: Bet) => {
      outcomeTotals[bet.outcome] = (outcomeTotals[bet.outcome] || 0) + bet.amount;
    });
    const poolAfterFee = totalBets * (1 - PLATFORM_FEE);
    const odds: Record<string, number> = {};
    market.outcomes.forEach((outcome: string) => {
      const outcomeTotal = outcomeTotals[outcome] || 0;
      odds[outcome] = totalBets > 0 ? poolAfterFee / (outcomeTotal || 1) : 1;
    });

    const { endDate, bets: _bets, ...rest } = market;
    res.json({
      ...rest,
      eventKey,
      relatedMarkets,
      totalVolume: totalBets,
      odds,
      endsAt: endDate ?? undefined,
      bets: betsForResponse,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch market' });
  }
});

// Create market
router.post('/', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const data = createMarketSchema.parse(req.body);

    const market = await prisma.market.create({
      data: {
        title: data.title,
        description: data.description,
        category: data.category,
        outcomes: data.outcomes,
        creatorId: req.userId!,
        endDate: data.endDate ? new Date(data.endDate) : null,
        startsAt: data.startsAt ? new Date(data.startsAt) : null,
        status: 'PENDING',
      },
      include: {
        creator: {
          select: {
            id: true,
            username: true,
          },
        },
      },
    });

    res.status(201).json({
      ...market,
      totalVolume: 0,
      odds: Object.fromEntries(data.outcomes.map((o) => [o, 1])),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      const message = error.errors.map((e) => e.message).join('; ');
      return res.status(400).json({ error: message });
    }
    res.status(500).json({ error: 'Failed to create market' });
  }
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Resolve market (creator only). MVP: 1.5% platform commission, in-app payouts only, one transaction.
router.post('/:id/resolve', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const winningOutcome =
      typeof req.body?.winningOutcome === 'string' ? req.body.winningOutcome.trim() : undefined;

    if (!winningOutcome) {
      return res.status(400).json({ error: 'winningOutcome is required' });
    }

    const market = await prisma.market.findUnique({
      where: { id: req.params.id },
      include: { bets: true },
    });

    if (!market) {
      return res.status(404).json({ error: 'Market not found' });
    }
    if (market.creatorId !== req.userId) {
      return res.status(403).json({ error: 'Only the creator can resolve this market' });
    }
    if (market.status !== 'OPEN') {
      return res.status(409).json({ error: 'Market already resolved or closed', status: market.status });
    }
    if (!market.outcomes.includes(winningOutcome)) {
      return res.status(400).json({ error: 'Invalid winning outcome', validOutcomes: market.outcomes });
    }

    const totalPool = market.bets.reduce((sum: number, bet: Bet) => sum + bet.amount, 0);
    const commission = round2(totalPool * PLATFORM_FEE);
    const payoutPool = totalPool - commission;
    const winningBets = market.bets.filter((bet: Bet) => bet.outcome === winningOutcome);
    const totalWinningStake = winningBets.reduce((sum: number, bet: Bet) => sum + bet.amount, 0);

    await prisma.$transaction(async (tx: any) => {
      await tx.market.update({
        where: { id: market.id },
        data: {
          status: 'RESOLVED',
          winningOutcome,
          resolvedAt: new Date(),
        },
      });

      await tx.adminProfit.create({
        data: { marketId: market.id, amount: commission },
      });

      if (totalWinningStake > 0) {
        for (const bet of winningBets) {
          const payout = round2((payoutPool * bet.amount) / totalWinningStake);
          await tx.bet.update({
            where: { id: bet.id },
            data: { payout, isWinning: true },
          });
          await tx.user.update({
            where: { id: bet.userId },
            data: { balance: { increment: payout } },
          });
          await tx.transaction.create({
            data: {
              userId: bet.userId,
              type: 'BET_WON',
              amount: payout,
              description: JSON.stringify({ marketId: market.id, betId: bet.id, source: 'resolve' }),
              marketId: market.id,
              betId: bet.id,
            },
          });
        }
      }

      const losingBets = market.bets.filter((bet: Bet) => bet.outcome !== winningOutcome);
      if (losingBets.length > 0) {
        await tx.bet.updateMany({
          where: { id: { in: losingBets.map((b: Bet) => b.id) } },
          data: { isWinning: false, payout: 0 },
        });
      }
    });

    res.json({ message: 'Market resolved successfully' });
  } catch (error) {
    console.error('Resolve market error:', error);
    res.status(500).json({ error: 'Failed to resolve market' });
  }
});

export default router;
