import express, { Response } from 'express';
import { z } from 'zod';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import * as RouletteService from '../services/roulette.service';
import prisma from '../utils/prisma';

const router = express.Router();

/** Simple in-memory rate limit: max 15 bets per minute per user */
const betRateLimit = new Map<string, number[]>();
const BET_RATE_WINDOW_MS = 60 * 1000;
const BET_RATE_MAX = 15;

function checkBetRateLimit(userId: string): boolean {
  const now = Date.now();
  let times = betRateLimit.get(userId) ?? [];
  times = times.filter((t) => now - t < BET_RATE_WINDOW_MS);
  if (times.length >= BET_RATE_MAX) return false;
  times.push(now);
  betRateLimit.set(userId, times);
  return true;
}

function requireCronSecret(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-cron-secret'] !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

/** GET /api/roulette/current — current round (status, endsAt, seedHash, pot, totalTickets, recent bets). Do not expose serverSeed until FINISHED. */
router.get('/current', async (_req, res: Response) => {
  try {
    let round = await RouletteService.getOrCreateCurrentRound();
    const now = new Date();
    if (round.status === 'OPEN' && round.endsAt && new Date(round.endsAt) <= now) {
      await RouletteService.resolveRound(round.id);
      const resolved = await RouletteService.getRoundById(round.id);
      if (resolved) round = resolved;
    }
    const payload: Record<string, unknown> = {
      id: round.id,
      roundNumber: round.roundNumber,
      status: round.status,
      startsAt: round.startsAt,
      endsAt: round.endsAt,
      seedHash: round.seedHash,
      clientSeed: round.clientSeed,
      nonce: round.nonce,
      totalTickets: round.totalTickets,
      potCents: round.potCents,
      feeCents: round.feeCents,
      winnerUserId: round.winnerUserId,
      winningTicket: round.winningTicket,
      createdAt: round.createdAt,
      bets: round.bets.map((b: { id: string; userId: string; amountCents: number; ticketsFrom: number; ticketsTo: number; createdAt: Date; user?: { username: string | null; isAnonymous: boolean | null } | null }) => ({
        id: b.id,
        userId: b.userId,
        username: b.user?.username,
        isAnonymous: b.user?.isAnonymous ?? false,
        amountCents: b.amountCents,
        ticketsFrom: b.ticketsFrom,
        ticketsTo: b.ticketsTo,
        createdAt: b.createdAt,
      })),
    };
    if (round.status === 'FINISHED') {
      payload.serverSeed = round.serverSeed;
    }
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: 'Failed to get current round', message: e instanceof Error ? e.message : String(e) });
  }
});

const betBodySchema = z.object({ amount: z.number().positive() });

/** POST /api/roulette/bet — place bet (auth required). Body: { amount: number } in dollars. */
router.post('/bet', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    if (!checkBetRateLimit(userId)) {
      res.status(429).json({ error: 'Too many bets. Try again in a minute.' });
      return;
    }
    const parsed = betBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
      return;
    }
    const result = await RouletteService.placeBet(userId, parsed.data.amount);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    const round = result.round;
    const payload: Record<string, unknown> = {
      ok: true,
      round: {
        id: round.id,
        roundNumber: round.roundNumber,
        status: round.status,
        startsAt: round.startsAt,
        endsAt: round.endsAt,
        seedHash: round.seedHash,
        totalTickets: round.totalTickets,
        potCents: round.potCents,
        bets: round.bets.map((b: { id: string; userId: string; amountCents: number; ticketsFrom: number; ticketsTo: number; createdAt: Date; user?: { username: string | null; isAnonymous: boolean | null } | null }) => ({
          id: b.id,
          userId: b.userId,
          username: b.user?.username,
          isAnonymous: b.user?.isAnonymous ?? false,
          amountCents: b.amountCents,
          ticketsFrom: b.ticketsFrom,
          ticketsTo: b.ticketsTo,
          createdAt: b.createdAt,
        })),
      },
    };
    if (round.status === 'FINISHED') {
      (payload.round as Record<string, unknown>).serverSeed = round.serverSeed;
    }
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: 'Bet failed', message: e instanceof Error ? e.message : String(e) });
  }
});

/** GET /api/roulette/my-bets — current user's roulette bets with round info and win/loss. For history page. */
router.get('/my-bets', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const limit = Math.min(parseInt(String(req.query.limit || '100'), 10) || 100, 200);
    const bets = await prisma.rouletteBet.findMany({
      where: { userId },
      include: {
        round: {
          select: {
            id: true,
            roundNumber: true,
            status: true,
            potCents: true,
            feeCents: true,
            totalTickets: true,
            winnerUserId: true,
            winningTicket: true,
            paidAt: true,
            createdAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    const list = bets.map((b: { id: string; amountCents: number; ticketsFrom: number; ticketsTo: number; createdAt: Date; round: { id: string; status: string; winningTicket: number | null; winnerUserId: string | null; potCents: number | null; feeCents: number | null; roundNumber: number } }) => {
      const r = b.round;
      const won =
        r.status === 'FINISHED' &&
        r.winningTicket != null &&
        r.winnerUserId === userId &&
        r.winningTicket >= b.ticketsFrom &&
        r.winningTicket <= b.ticketsTo;
      const payoutCents = won && r.potCents != null && r.feeCents != null ? r.potCents - r.feeCents : null;
      return {
        id: b.id,
        roundId: r.id,
        roundNumber: r.roundNumber,
        amountCents: b.amountCents,
        ticketsFrom: b.ticketsFrom,
        ticketsTo: b.ticketsTo,
        won,
        payoutCents,
        createdAt: b.createdAt,
        roundStatus: r.status,
      };
    });
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: 'Failed to get my roulette bets', message: e instanceof Error ? e.message : String(e) });
  }
});

/** GET /api/roulette/history?limit=20 — finished rounds with winner, pot, fee, winningTicket, serverSeed */
router.get('/history', async (req, res: Response) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit || '20'), 10) || 20, 100);
    const rounds = await RouletteService.getHistory(limit);
    type RoundItem = { id: string; roundNumber: number; status: string; startsAt: Date | null; endsAt: Date | null; seedHash: string | null; serverSeed: string | null; clientSeed: string | null; nonce: number; totalTickets: number; potCents: number; feeCents: number; winnerUserId: string | null; winningTicket: number | null; createdAt: Date; updatedAt: Date; bets: Array<{ id: string; userId: string; amountCents: number; ticketsFrom: number; ticketsTo: number; user?: { username: string | null; isAnonymous: boolean | null } | null }> };
    res.json(
      rounds.map((r: RoundItem) => ({
        id: r.id,
        roundNumber: r.roundNumber,
        status: r.status,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        seedHash: r.seedHash,
        serverSeed: r.serverSeed,
        clientSeed: r.clientSeed,
        nonce: r.nonce,
        totalTickets: r.totalTickets,
        potCents: r.potCents,
        feeCents: r.feeCents,
        winnerUserId: r.winnerUserId,
        winningTicket: r.winningTicket,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        bets: r.bets.map((b: { id: string; userId: string; amountCents: number; ticketsFrom: number; ticketsTo: number; user?: { username: string | null; isAnonymous: boolean | null } | null }) => ({
          id: b.id,
          userId: b.userId,
          username: b.user?.username,
          isAnonymous: b.user?.isAnonymous ?? false,
          amountCents: b.amountCents,
          ticketsFrom: b.ticketsFrom,
          ticketsTo: b.ticketsTo,
        })),
      }))
    );
  } catch (e) {
    res.status(500).json({ error: 'Failed to get history', message: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/roulette/resolve — cron: resolve all due rounds (x-cron-secret) */
router.post('/resolve', requireCronSecret, async (_req, res: Response) => {
  try {
    const result = await RouletteService.resolveDueRounds();
    res.json({ ok: true, resolved: result.resolved, errors: result.errors });
  } catch (e) {
    res.status(500).json({ error: 'Resolve failed', message: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
