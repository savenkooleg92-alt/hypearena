import express from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import prisma from '../utils/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import * as WalletDerivation from '../services/walletDerivation.service';
import { processDeposits } from '../services/deposit.service';
import { runSolDepositCycle } from '../services/sol-deposit.service';
import { runSolUsdcDepositCycle } from '../services/sol-usdc-deposit.service';
import * as WalletService from '../services/wallet.service';
import { runSweepForNetwork } from '../services/wallet-sweep.service';

const router = express.Router();

const withdrawCreateSchema = z.object({
  network: z.enum(['TRON', 'MATIC', 'SOL']),
  toAddress: z.string().min(1),
  amount: z
    .number()
    .positive()
    .refine((v) => !Number.isNaN(v), 'Invalid amount')
    .transform((v) => WalletService.round2(v)),
});

const adminActionSchema = z.object({
  txId: z.string().optional(),
  error: z.string().optional(),
});

const devCreditSchema = z.object({
  amount: z.number().positive(),
  network: z.enum(['TRON', 'SOL', 'MATIC']),
  tokenSymbol: z.enum(['USDT', 'USDC']).optional(),
  userId: z.string().optional(),
});

/**
 * Deposit detection + crediting only. No sweep to master.
 * Call periodically (e.g. cron). Optional: set CRON_SECRET and send x-cron-secret header.
 */
router.post('/check-deposits', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-cron-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await processDeposits();
    return res.json({
      ok: true,
      credited: result.credited,
      errors: result.errors.length ? result.errors : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[wallet] check-deposits error:', message);
    return res.status(500).json({ error: 'Deposit check failed', message });
  }
});

/** SOL deposit cycle: detect -> confirm -> sweep -> credit. Cron: x-cron-secret. */
router.post('/check-sol-deposits', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-cron-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await runSolDepositCycle();
    return res.json({
      ok: true,
      detected: result.detected,
      confirmed: result.confirmed,
      failed: result.failed,
      swept: result.swept,
      credited: result.credited,
      errors: result.errors.length ? result.errors : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[wallet] check-sol-deposits error:', message);
    return res.status(500).json({ error: 'SOL deposit check failed', message });
  }
});

/** USDC SPL deposit cycle: detect -> confirm -> sweep -> credit. Cron: x-cron-secret. */
router.post('/check-sol-usdc-deposits', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-cron-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await runSolUsdcDepositCycle();
    return res.json({
      ok: true,
      detected: result.detected,
      confirmed: result.confirmed,
      failed: result.failed,
      swept: result.swept,
      credited: result.credited,
      errors: result.errors.length ? result.errors : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[wallet] check-sol-usdc-deposits error:', message);
    return res.status(500).json({ error: 'USDC deposit check failed', message });
  }
});

/**
 * DEV only: simulate deposit crediting (no on-chain). Disabled unless DEV_CREDIT_ENABLED=true.
 * Requires NODE_ENV === "development", CRON_SECRET (x-cron-secret), and DEV_CREDIT_ENABLED.
 */
router.post('/dev-credit', async (req, res) => {
  if (process.env.NODE_ENV !== 'development' || process.env.DEV_CREDIT_ENABLED !== 'true') {
    return res.status(404).json({ error: 'Not found' });
  }
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-cron-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const parseResult = devCreditSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Invalid body', details: parseResult.error.flatten() });
  }

  const { amount, network, tokenSymbol, userId: bodyUserId } = parseResult.data;

  let userId: string | undefined = bodyUserId;
  if (!userId) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string };
        userId = decoded.userId;
      } catch {
        return res.status(403).json({ error: 'Invalid or expired token' });
      }
    }
  }
  if (!userId) {
    return res.status(400).json({ error: 'Provide Authorization Bearer token or body.userId' });
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const metadata = { network, tokenSymbol: tokenSymbol ?? 'USDT', source: 'DEV' as const };
  const [updated] = await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { balance: { increment: amount } },
    }),
    prisma.transaction.create({
      data: {
        userId,
        type: 'DEPOSIT',
        amount,
        description: JSON.stringify(metadata),
      },
    }),
  ]);

  return res.json({ ok: true, newBalance: updated.balance });
});

const VALID_NETWORKS = ['TRON', 'SOL', 'MATIC'] as const;
const postAddressSchema = z.object({
  network: z.enum(VALID_NETWORKS),
});

/** GET /wallet/addresses – return all stored deposit addresses for the user */
router.get('/addresses', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const rows = await prisma.walletAddress.findMany({
      where: { userId },
      select: { network: true, address: true },
    });

    const addresses: Record<string, string> = {};
    rows.forEach((r) => {
      addresses[r.network] = r.address;
    });

    return res.json({ addresses });
  } catch (error) {
    console.error('[wallet] GET /addresses error:', error);
    return res.status(500).json({ error: 'Failed to fetch addresses' });
  }
});

/** Normalize Polygon tx hash for storage (lowercase, 0x prefix ok). */
function normalizePolygonTxHash(h: string): string {
  const s = typeof h === 'string' ? h.trim() : '';
  const stripped = s.replace(/^https:\/\/polygonscan\.com\/tx\//i, '').trim();
  const hex = stripped.startsWith('0x') ? stripped.slice(2) : stripped;
  if (!hex || !/^[a-fA-F0-9]{64}$/.test(hex)) return '';
  return '0x' + hex.toLowerCase();
}

/** POST /wallet/polygon-tx-submit – user submits "I paid" with Transaction Hash. One txHash globally = one submission (no double credit). */
router.post('/polygon-tx-submit', authenticateToken, async (req: AuthRequest, res) => {
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const raw = typeof req.body?.txHash === 'string' ? req.body.txHash : '';
  const txHash = normalizePolygonTxHash(raw);
  if (!txHash) {
    return res.status(400).json({ error: 'Invalid Transaction Hash. Paste the hash from Polygonscan (0x...).' });
  }
  try {
    const existing = await prisma.polygonTxSubmission.findUnique({ where: { txHash } });
    if (existing) {
      return res.status(400).json({
        error: 'This transaction hash was already submitted. Each hash can be credited only once.',
      });
    }
    const depositAlready = await prisma.deposit.findFirst({
      where: { network: 'MATIC', txHash, status: 'CREDITED' },
    });
    if (depositAlready) {
      return res.status(400).json({
        error: 'This transaction was already credited. Each hash is credited only once.',
      });
    }
    await prisma.polygonTxSubmission.create({
      data: { userId, txHash, status: 'PENDING' },
    });
    return res.json({
      ok: true,
      message: 'Submitted. Admin will verify and credit your account. One hash = one credit only.',
    });
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'P2002') {
      return res.status(400).json({ error: 'This transaction hash was already submitted.' });
    }
    console.error('[wallet] POST /polygon-tx-submit error:', e);
    return res.status(500).json({ error: 'Failed to submit' });
  }
});

/** GET /wallet/me/deposits – current user's deposit records (amount sent, status, txHash). */
router.get('/me/deposits', authenticateToken, async (req: AuthRequest, res) => {
  const userId = req.userId;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const rows = await prisma.deposit.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        network: true,
        txHash: true,
        depositAddress: true,
        rawAmount: true,
        amountUsd: true,
        status: true,
        isBelowMinimum: true,
        createdAt: true,
      },
    });
    return res.json({ deposits: rows });
  } catch (error) {
    console.error('[wallet] GET /me/deposits error:', error);
    return res.status(500).json({ error: 'Failed to fetch deposits' });
  }
});

/** POST /wallet/address – get or generate deposit address. One per user per network (TRON/SOL/MATIC). */
router.post('/address', authenticateToken, async (req: AuthRequest, res) => {
  const userId = req.userId;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const parseResult = postAddressSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: 'Invalid network',
      message: 'network must be one of: TRON, SOL, MATIC',
    });
  }

  const { network } = parseResult.data;

  try {
    const existing = await prisma.walletAddress.findUnique({
      where: { userId_network: { userId, network } },
    });
    if (existing) return res.json({ address: existing.address });
  } catch (dbErr) {
    console.error('[wallet] POST /address findUnique error:', dbErr);
    return res.status(500).json({ error: 'Failed to check existing address' });
  }

  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { address } = await prisma.$transaction(async (tx) => {
        const counter = await tx.networkCounter.upsert({
          where: { network },
          create: { network, nextIndex: 0 },
          update: {},
        });
        const allocatedIndex = counter.nextIndex;
        await tx.networkCounter.update({
          where: { network },
          data: { nextIndex: allocatedIndex + 1 },
        });

        const address = WalletDerivation.deriveAddress(network as WalletDerivation.Network, allocatedIndex);

        await tx.walletAddress.create({
          data: { userId, network, address, derivationIndex: allocatedIndex },
        });
        return { address };
      });

      return res.status(201).json({ address });
    } catch (err: unknown) {
      const isUniqueViolation =
        err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'P2002';
      if (isUniqueViolation) {
        try {
          const existingNow = await prisma.walletAddress.findUnique({
            where: { userId_network: { userId, network } },
          });
          if (existingNow) return res.json({ address: existingNow.address });
        } catch (_) {}
        if (attempt < maxRetries) continue;
      }

      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      console.error('[wallet] POST /address error:', { userId, network, attempt, message });
      if (stack) console.error(stack);

      const sanitized = message.includes('MASTER_MNEMONIC') ? 'Server wallet config missing' : message.includes('Tatum') || message.includes('network') ? message : 'Address generation failed';
      return res.status(500).json({ error: 'Wallet generation failed', message: process.env.NODE_ENV === 'development' ? message : sanitized });
    }
  }

  return res.status(500).json({ error: 'Failed to generate address after retries' });
});

/** Sweep TRON/MATIC USDT from deposit addresses to master. Protected by x-cron-secret. */
router.post('/sweep', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-cron-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const [tron, matic] = await Promise.all([
      runSweepForNetwork('TRON'),
      runSweepForNetwork('MATIC'),
    ]);
    const results = [...tron.results, ...matic.results];
    const sweptCount = tron.sweptCount + matic.sweptCount;
    return res.json({ ok: true, sweptCount, results });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[wallet] sweep error:', message);
    return res.status(500).json({ error: 'Sweep failed', message });
  }
});

/** Get withdrawal fee breakdown (quote). GET /api/wallet/withdraw/quote?network=TRON&amount=50 */
router.get('/withdraw/quote', authenticateToken, async (req: AuthRequest, res) => {
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const network = req.query.network as string | undefined;
  const amountParam = req.query.amount as string | undefined;
  const networks: Array<'TRON' | 'MATIC' | 'SOL'> = ['TRON', 'MATIC', 'SOL'];
  if (!network || !networks.includes(network as 'TRON' | 'MATIC' | 'SOL')) {
    return res.status(400).json({ error: 'Invalid or missing network' });
  }
  const amount = amountParam != null ? parseFloat(amountParam) : NaN;
  if (Number.isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid or missing amount' });
  }

  const breakdown = WalletService.getWithdrawBreakdown(WalletService.round2(amount), network);
  return res.json({
    ok: true,
    ...breakdown,
    minAmountRequested: WalletService.getMinWithdrawByNetwork(network),
  });
});

/** Create withdrawal request. POST /api/wallet/withdraw */
router.post('/withdraw', authenticateToken, async (req: AuthRequest, res) => {
  const parsed = withdrawCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
  }

  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { network, toAddress, amount } = parsed.data;

  const minAmount = WalletService.getMinWithdrawByNetwork(network);
  if (amount < minAmount) {
    return res.status(400).json({ error: 'Amount too small', message: `Minimum for ${network} is $${minAmount}`, min: minAmount });
  }

  const breakdown = WalletService.getWithdrawBreakdown(amount, network);
  if (breakdown.amountToSend <= 0) {
    return res.status(400).json({ error: 'Amount too small after fee', fee: breakdown.feeUsd });
  }

  try {
    const result = await WalletService.createWithdrawal(userId, { network, toAddress, amount });

    if (result.kind === 'NO_USER') return res.status(404).json({ error: 'User not found' });
    if (result.kind === 'NO_FUNDS') {
      return res
        .status(400)
        .json({ error: 'Insufficient balance', balance: result.balance, required: result.required });
    }

    const b = WalletService.getWithdrawBreakdown(amount, network);
    return res.status(201).json({
      ok: true,
      request: result.wr,
      updatedBalance: result.updatedBalance,
      breakdown: {
        amountRequested: result.wr.amountGross,
        feeUsd: result.wr.fee,
        amountToSend: result.wr.amountNet,
        currency: b.currency,
        networkFeeInfo: b.networkFeeInfo,
      },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[wallet] withdraw create error:', message);
    return res.status(500).json({ error: 'Server error' });
  }
});

/** List my withdrawals. GET /api/wallet/withdraw */
router.get('/withdraw', authenticateToken, async (req: AuthRequest, res) => {
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const items = await WalletService.getWithdrawalsByUser(userId);
    return res.json({ ok: true, items });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[wallet] withdraw list error:', message);
    return res.status(500).json({ error: 'Server error' });
  }
});

/** Unified transactions (deposits + withdrawals). GET /api/wallet/transactions?limit=50 */
router.get('/transactions', authenticateToken, async (req: AuthRequest, res) => {
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const limitParam = req.query.limit as string | undefined;
  const limit = limitParam != null ? Math.min(100, Math.max(1, parseInt(limitParam, 10))) : 50;
  if (Number.isNaN(limit)) {
    return res.status(400).json({ error: 'Invalid limit' });
  }

  try {
    const items = await WalletService.getTransactionsForUser(userId, limit);
    return res.json({ ok: true, items });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[wallet] transactions error:', message);
    return res.status(500).json({ error: 'Server error' });
  }
});

/** Admin approve. POST /api/wallet/withdraw/:id/approve (x-cron-secret) */
router.post('/withdraw/:id/approve', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-cron-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const id = req.params.id;
  const parsed = adminActionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
  }

  try {
    const updated = await WalletService.approveWithdrawal(id);

    if (updated.kind === 'NO') return res.status(404).json({ error: 'Not found' });
    if (updated.kind === 'BAD') {
      return res.status(409).json({ error: 'Invalid status', status: updated.status });
    }

    return res.json({ ok: true, request: updated.wr });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[wallet] withdraw approve error:', message);
    return res.status(500).json({ error: 'Server error' });
  }
});

/** Admin fail (refund). POST /api/wallet/withdraw/:id/fail (x-cron-secret) */
router.post('/withdraw/:id/fail', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-cron-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const id = req.params.id;
  const parsed = adminActionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
  }

  try {
    const result = await WalletService.failWithdrawal(id, { error: parsed.data.error });

    if (result.kind === 'NO') return res.status(404).json({ error: 'Not found' });
    if (result.kind === 'BAD') {
      return res.status(409).json({ error: 'Invalid status', status: result.status });
    }

    return res.json({ ok: true, request: result.wr, updatedBalance: result.updatedBalance });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[wallet] withdraw fail error:', message);
    return res.status(500).json({ error: 'Server error' });
  }
});

export default router;
