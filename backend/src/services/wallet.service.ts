/**
 * Wallet withdrawal: pure service layer.
 * Lifecycle: PENDING → (Approve) APPROVED → (Send payout) SENT | FAILED.
 * Balance deducted on creation; refunded if FAILED. Anti double-payout: only send when status === APPROVED and !txId.
 */
import type { WithdrawalRequest } from '@prisma/client';
import prisma from '../utils/prisma';
import * as TatumService from './TatumService';

/** Fixed withdrawal fee per network (USD). From env or defaults. */
function getFeeConfig(): Record<string, number> {
  const tron = process.env.WITHDRAW_FEE_TRON_USD;
  const matic = process.env.WITHDRAW_FEE_MATIC_USD;
  const sol = process.env.WITHDRAW_FEE_SOL_USD;
  return {
    TRON: tron != null && tron !== '' ? Math.max(0, parseFloat(String(tron))) : 3,
    MATIC: matic != null && matic !== '' ? Math.max(0, parseFloat(String(matic))) : 0.5,
    SOL: sol != null && sol !== '' ? Math.max(0, parseFloat(String(sol))) : 0,
  };
}

/** Minimum withdrawal by network (USD). */
// TODO: restore TRON to 20 for production. Temporary $1 for testing.
const MIN_BY_NETWORK: Record<string, number> = {
  TRON: 1,
  MATIC: 1,
  SOL: 1,
};

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Fixed fee in USD for the given network. */
export function getWithdrawFeeByNetwork(network: string): number {
  const fees = getFeeConfig();
  return round2(fees[network] ?? 0);
}

/** @deprecated Use getWithdrawFeeByNetwork for fixed-fee model. */
export function calcWithdrawFee(amount: number): number {
  return round2(Math.max(1, amount * 0.01));
}

export function getMinWithdraw(): number {
  return Math.min(...Object.values(MIN_BY_NETWORK));
}

export function getMinWithdrawByNetwork(network: string): number {
  return MIN_BY_NETWORK[network] ?? 1;
}

export type WithdrawBreakdown = {
  amountRequested: number;
  feeUsd: number;
  amountToSend: number;
  currency: string;
  networkFeeInfo: string;
};

/** Compute fee breakdown for display and validation. amount = user-entered amount (you pay). */
export function getWithdrawBreakdown(amount: number, network: string): WithdrawBreakdown {
  const feeUsd = getWithdrawFeeByNetwork(network);
  const amountToSend = round2(Math.max(0, amount - feeUsd));
  const currency = network === 'SOL' ? 'USDC' : 'USDT';
  const networkFeeInfo =
    feeUsd === 0
      ? 'Fee paid by platform'
      : `Fees are required by the blockchain and may vary.`;
  return {
    amountRequested: round2(amount),
    feeUsd,
    amountToSend,
    currency,
    networkFeeInfo,
  };
}

export type CreateWithdrawalResult =
  | { kind: 'NO_USER' }
  | { kind: 'NO_FUNDS'; balance: number; required: number }
  | { kind: 'OK'; wr: WithdrawalRequest; updatedBalance: number };

export async function createWithdrawal(
  userId: string,
  data: { network: 'TRON' | 'MATIC' | 'SOL'; toAddress: string; amount: number }
): Promise<CreateWithdrawalResult> {
  const minAmount = getMinWithdrawByNetwork(data.network);
  if (data.amount < minAmount) {
    throw new Error(`Amount below minimum ($${minAmount} for ${data.network})`);
  }
  const fee = getWithdrawFeeByNetwork(data.network);
  const amountNet = round2(data.amount - fee);
  if (amountNet <= 0) {
    throw new Error('Amount too small after fee');
  }

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) return { kind: 'NO_USER' as const };

    if (user.balance < data.amount) {
      return {
        kind: 'NO_FUNDS' as const,
        balance: user.balance,
        required: data.amount,
      };
    }

    const updatedUser = await tx.user.update({
      where: { id: userId },
      data: { balance: { decrement: data.amount } },
      select: { id: true, balance: true },
    });

    const wr = await tx.withdrawalRequest.create({
      data: {
        userId,
        network: data.network,
        toAddress: data.toAddress,
        amountGross: data.amount,
        fee,
        amountNet,
        status: 'PENDING',
      },
    });

    await tx.transaction.create({
      data: {
        userId,
        type: 'WITHDRAWAL',
        amount: -data.amount,
        description: JSON.stringify({
          network: data.network,
          toAddress: data.toAddress,
          gross: data.amount,
          fee,
          net: amountNet,
          withdrawalRequestId: wr.id,
        }),
      },
    });

    return {
      kind: 'OK' as const,
      wr,
      updatedBalance: updatedUser.balance,
    };
  });

  return result;
}

export async function getWithdrawalsByUser(userId: string): Promise<WithdrawalRequest[]> {
  return prisma.withdrawalRequest.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
}

export type WalletTransactionItem = {
  id: string;
  type: 'Deposit' | 'Withdraw';
  amountGross: number;
  fee: number;
  netAmount: number;
  currency: string;
  network: string;
  status: string;
  createdAt: string;
};

function currencyForNetwork(network: string): string {
  return network === 'SOL' ? 'USDC' : 'USDT';
}

function depositStatusDisplay(status: string): string {
  const map: Record<string, string> = {
    DETECTED: 'Pending',
    CONFIRMED: 'Confirmed',
    SWEPT: 'Processing',
    CREDITED: 'Credited',
    FAILED: 'Failed',
  };
  return map[status] ?? status;
}

function withdrawStatusDisplay(status: string): string {
  const map: Record<string, string> = {
    PENDING: 'Pending',
    APPROVED: 'Approved',
    SENT: 'Sent',
    FAILED: 'Failed',
    PROCESSING: 'Approved', // legacy
    COMPLETED: 'Sent', // legacy
  };
  return map[status] ?? status;
}

/** Unified list of deposits + withdrawals for the user, newest first. */
export async function getTransactionsForUser(
  userId: string,
  limit: number = 50
): Promise<WalletTransactionItem[]> {
  const [deposits, withdrawals] = await Promise.all([
    prisma.deposit.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        network: true,
        amountUsd: true,
        status: true,
        createdAt: true,
      },
    }),
    prisma.withdrawalRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        network: true,
        amountGross: true,
        fee: true,
        amountNet: true,
        status: true,
        createdAt: true,
      },
    }),
  ]);

  const depositItems: WalletTransactionItem[] = deposits.map((d) => ({
    id: d.id,
    type: 'Deposit',
    amountGross: d.amountUsd,
    fee: 0,
    netAmount: d.amountUsd,
    currency: currencyForNetwork(d.network),
    network: d.network,
    status: depositStatusDisplay(d.status),
    createdAt: d.createdAt.toISOString(),
  }));

  const withdrawItems: WalletTransactionItem[] = withdrawals.map((w) => ({
    id: w.id,
    type: 'Withdraw',
    amountGross: w.amountGross,
    fee: w.fee,
    netAmount: w.amountNet,
    currency: currencyForNetwork(w.network),
    network: w.network,
    status: withdrawStatusDisplay(w.status),
    createdAt: w.createdAt.toISOString(),
  }));

  const merged = [...depositItems, ...withdrawItems].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  return merged.slice(0, limit);
}

export type ApproveWithdrawalResult =
  | { kind: 'NO' }
  | { kind: 'BAD'; status: string }
  | { kind: 'OK'; wr: WithdrawalRequest };

export async function approveWithdrawal(id: string): Promise<ApproveWithdrawalResult> {
  const result = await prisma.$transaction(async (tx) => {
    const wr = await tx.withdrawalRequest.findUnique({ where: { id } });
    if (!wr) return { kind: 'NO' as const };
    if (wr.status !== 'PENDING') return { kind: 'BAD' as const, status: wr.status };

    const wr2 = await tx.withdrawalRequest.update({
      where: { id },
      data: { status: 'APPROVED', error: null },
    });
    console.log('[withdraw] approved', { id: wr.id, userId: wr.userId, network: wr.network, amountNet: wr.amountNet });
    return { kind: 'OK' as const, wr: wr2 };
  });
  return result;
}

function networkToChain(network: string): TatumService.Chain {
  if (network === 'TRON') return TatumService.CHAINS.TRON;
  if (network === 'MATIC') return TatumService.CHAINS.POLYGON;
  if (network === 'SOL') return TatumService.CHAINS.SOLANA;
  throw new Error(`Unsupported withdrawal network: ${network}`);
}

export type SendWithdrawalPayoutResult =
  | { kind: 'NO' }
  | { kind: 'BAD'; reason: string }
  | { kind: 'OK'; wr: WithdrawalRequest; txId: string };

/**
 * Send on-chain payout for an APPROVED withdrawal. Idempotent: if txId already set or status !== APPROVED, reject.
 * Runs in DB transaction after successful send: save txId, set status SENT.
 */
export async function sendWithdrawalPayout(withdrawalId: string): Promise<SendWithdrawalPayoutResult> {
  const wr = await prisma.withdrawalRequest.findUnique({
    where: { id: withdrawalId },
    include: { user: { select: { id: true } } },
  });
  if (!wr) return { kind: 'NO' };
  const allowed = ['APPROVED', 'PROCESSING'];
  if (!allowed.includes(wr.status)) return { kind: 'BAD', reason: `Expected APPROVED, got ${wr.status}` };
  if (wr.txId) return { kind: 'BAD', reason: 'Already sent (txId set). Double payout rejected.' };

  const chain = networkToChain(wr.network);
  const amount = wr.amountNet; // USD = token amount for USDT/USDC 1:1
  let txId: string;
  try {
    const result = await TatumService.sendPayout({
      userId: wr.userId,
      amount,
      destinationAddress: wr.toAddress,
      chain,
      reference: `withdrawal:${wr.id}`,
    });
    if (!result.success || !result.txId) {
      throw new Error(result.error ?? 'No txId returned');
    }
    txId = result.txId;
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error('[withdraw] payout failed', { id: wr.id, network: wr.network, error: errMsg });
    await prisma.$transaction(async (tx) => {
      await tx.withdrawalRequest.update({
        where: { id: withdrawalId },
        data: { status: 'FAILED', error: errMsg.slice(0, 500) },
      });
      await tx.user.update({
        where: { id: wr.userId },
        data: { balance: { increment: wr.amountGross } },
      });
      await tx.transaction.create({
        data: {
          userId: wr.userId,
          type: 'REFUND',
          amount: wr.amountGross,
          description: JSON.stringify({ reason: 'withdraw_payout_failed_refund', withdrawalRequestId: wr.id, error: errMsg }),
        },
      });
    });
    return { kind: 'BAD', reason: errMsg };
  }

  await prisma.$transaction(async (tx) => {
    await tx.withdrawalRequest.update({
      where: { id: withdrawalId },
      data: { status: 'SENT', txId, error: null },
    });
  });
  console.log('[withdraw] payout sent', { id: wr.id, txId, network: wr.network, amountNet: wr.amountNet });
  const updated = await prisma.withdrawalRequest.findUnique({ where: { id: withdrawalId } });
  return { kind: 'OK', wr: updated!, txId };
}

export type RetryWithdrawalResult =
  | { kind: 'NO' }
  | { kind: 'BAD'; reason: string }
  | { kind: 'OK'; wr: WithdrawalRequest };

/** Retry a FAILED withdrawal: deduct balance again and set status APPROVED so admin can Send payout. */
export async function retryWithdrawal(id: string): Promise<RetryWithdrawalResult> {
  const result = await prisma.$transaction(async (tx) => {
    const wr = await tx.withdrawalRequest.findUnique({ where: { id } });
    if (!wr) return { kind: 'NO' as const };
    if (wr.status !== 'FAILED') return { kind: 'BAD' as const, reason: `Expected FAILED, got ${wr.status}` };

    const user = await tx.user.findUnique({ where: { id: wr.userId }, select: { balance: true } });
    if (!user || user.balance < wr.amountGross)
      return { kind: 'BAD' as const, reason: `Insufficient balance (need $${wr.amountGross})` };

    await tx.user.update({
      where: { id: wr.userId },
      data: { balance: { decrement: wr.amountGross } },
    });
    const wr2 = await tx.withdrawalRequest.update({
      where: { id },
      data: { status: 'APPROVED', error: null },
    });
    await tx.transaction.create({
      data: {
        userId: wr.userId,
        type: 'WITHDRAWAL',
        amount: -wr.amountGross,
        description: JSON.stringify({
          reason: 'withdraw_retry',
          withdrawalRequestId: wr.id,
          network: wr.network,
          gross: wr.amountGross,
          fee: wr.fee,
          net: wr.amountNet,
        }),
      },
    });
    return { kind: 'OK' as const, wr: wr2 };
  });
  return result;
}

export type FailWithdrawalResult =
  | { kind: 'NO' }
  | { kind: 'BAD'; status: string }
  | { kind: 'OK'; wr: WithdrawalRequest; updatedBalance: number };

export async function failWithdrawal(
  id: string,
  body: { error?: string }
): Promise<FailWithdrawalResult> {
  const result = await prisma.$transaction(async (tx) => {
    const wr = await tx.withdrawalRequest.findUnique({ where: { id } });
    if (!wr) return { kind: 'NO' as const };
    if (wr.status !== 'PENDING') return { kind: 'BAD' as const, status: wr.status };

    const user = await tx.user.update({
      where: { id: wr.userId },
      data: { balance: { increment: wr.amountGross } },
      select: { id: true, balance: true },
    });

    const wr2 = await tx.withdrawalRequest.update({
      where: { id },
      data: {
        status: 'FAILED',
        error: body.error ?? 'Rejected by admin',
      },
    });
    console.log('[withdraw] payout failed (rejected)', { id: wr.id, userId: wr.userId, error: wr2.error });

    await tx.transaction.create({
      data: {
        userId: wr.userId,
        type: 'REFUND',
        amount: wr.amountGross,
        description: JSON.stringify({
          reason: 'withdraw_failed_refund',
          withdrawalRequestId: wr.id,
        }),
      },
    });

    return { kind: 'OK' as const, wr: wr2, updatedBalance: user.balance };
  });

  return result;
}
