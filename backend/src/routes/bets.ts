import express from 'express';
import { z } from 'zod';
import type { Bet } from '@prisma/client';
import prisma from '../utils/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';

const router = express.Router();

/** Platform fee taken from the pool on resolution (1.5%). Odds reflect this. */
const PLATFORM_FEE = 0.015;

const placeBetSchema = z.object({
  marketId: z.string().min(1, 'marketId is required'),
  outcome: z.string().min(1, 'outcome is required'),
  amount: z
    .number()
    .positive('amount must be positive')
    .refine((n) => !Number.isNaN(n), 'amount must be a number')
    .transform((n) => Math.round(n * 100) / 100),
});

// Place a bet — atomic debit + pool update (pool derived from Bet records)
router.post('/', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const parseResult = placeBetSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Invalid input', details: parseResult.error.flatten() });
    }

    const { marketId, outcome, amount } = parseResult.data;

    if (amount <= 0 || Number.isNaN(amount)) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    const userId = req.userId!;
    const [user, market] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId } }),
      prisma.market.findUnique({
        where: { id: marketId },
        select: {
          id: true,
          status: true,
          category: true,
          endDate: true,
          outcomes: true,
        },
      }),
    ]);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (!market) {
      return res.status(404).json({ error: 'Market not found' });
    }
    if (market.status !== 'OPEN') {
      return res.status(409).json({ error: 'Market is not open for betting', status: market.status });
    }
    // Politics: betting closes strictly at endDate (UTC). No bets after.
    if (market.category === 'politics' && market.endDate) {
      const now = Date.now();
      if (now >= market.endDate.getTime()) {
        return res.status(409).json({ error: 'Betting has closed for this market' });
      }
    }
    if (!market.outcomes.includes(outcome)) {
      return res.status(400).json({ error: 'Invalid outcome', validOutcomes: market.outcomes });
    }
    if (user.balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance', balance: user.balance, required: amount });
    }

    // Precompute odds (for Bet record) from current bets
    const existingBets = await prisma.bet.findMany({ where: { marketId } });
    const outcomeTotals: Record<string, number> = {};
    existingBets.forEach((bet: Bet) => {
      outcomeTotals[bet.outcome] = (outcomeTotals[bet.outcome] || 0) + bet.amount;
    });
    const totalBets = existingBets.reduce((sum: number, bet: Bet) => sum + bet.amount, 0);
    const newTotal = totalBets + amount;
    const newTotalAfterFee = newTotal * (1 - PLATFORM_FEE);
    const newOutcomeTotal = (outcomeTotals[outcome] || 0) + amount;
    const odds = newTotalAfterFee / newOutcomeTotal;

    // Atomic: debit user, create bet (pool = sum of bets per outcome), create transaction
    const [updatedUser, bet] = await prisma.$transaction(async (tx: any) => {
      const u = await tx.user.update({
        where: { id: userId },
        data: { balance: { decrement: amount } },
      });

      const newBet = await tx.bet.create({
        data: {
          userId,
          marketId,
          outcome,
          amount,
          odds,
        },
        include: {
          market: { select: { title: true, outcomes: true } },
        },
      });

      await tx.transaction.create({
        data: {
          userId,
          type: 'BET_PLACED',
          amount: -amount,
          description: JSON.stringify({ marketId, outcome }),
          marketId,
          betId: newBet.id,
        },
      });

      return [u, newBet];
    });

    // Pools = sum of bet amounts per outcome for this market (including new bet)
    const allBetsForMarket = await prisma.bet.findMany({
      where: { marketId },
      select: { outcome: true, amount: true },
    });
    const pools: Record<string, number> = {};
    allBetsForMarket.forEach((b: { outcome: string; amount: number }) => {
      pools[b.outcome] = (pools[b.outcome] ?? 0) + b.amount;
    });

    return res.status(201).json({
      bet: {
        id: bet.id,
        marketId: bet.marketId,
        outcome: bet.outcome,
        amount: bet.amount,
        odds: bet.odds,
        market: bet.market,
        createdAt: bet.createdAt,
      },
      updatedPools: pools,
      updatedBalance: updatedUser.balance,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.flatten() });
    }
    res.status(500).json({ error: 'Failed to place bet' });
  }
});

// Get user's bets
router.get('/my-bets', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const bets = await prisma.bet.findMany({
      where: { userId: req.userId! },
      include: {
        market: {
          select: {
            id: true,
            title: true,
            status: true,
            winningOutcome: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    res.json(bets);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch bets' });
  }
});

export default router;
