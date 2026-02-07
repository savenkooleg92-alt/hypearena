/**
 * Solana deposit flow: detect -> confirm -> sweep -> credit.
 * Currently detects NATIVE SOL only. Production should use USDC SPL token only; set SOL_DEPOSITS_DISABLED=true
 * to disable this cycle until USDC SPL detection is implemented.
 * Idempotent by (network, txHash). Status: DETECTED -> CONFIRMED -> SWEPT -> CREDITED (or FAILED).
 */

import prisma from '../utils/prisma';
import * as TatumService from './TatumService';
import * as WalletDerivation from './walletDerivation.service';
import { getSimplePrices, getPriceFromResult } from './coingecko.service';

const NETWORK_SOL = 'SOL';
const SOL_LAMPORTS_PER_SOL = 1e9;
const SOL_MIN_DEPOSIT_SOL = 0.05; // minimum SOL to attempt sweep (fee reserve)
const MIN_USD_SOL = 1; // deposits below this are ignored (FAILED + isBelowMinimum)

function lamportsToSol(lamports: number): number {
  return lamports / SOL_LAMPORTS_PER_SOL;
}

/** Parse Tatum/Solana getTransaction response: return incoming lamports for the given address. */
function getIncomingLamportsFromTx(tx: {
  transaction?: { message?: { accountKeys?: string[] } };
  meta?: { preBalances?: number[]; postBalances?: number[] };
}, ourAddress: string): number {
  const accountKeys = tx.transaction?.message?.accountKeys ?? [];
  const pre = tx.meta?.preBalances ?? [];
  const post = tx.meta?.postBalances ?? [];
  const idx = accountKeys.indexOf(ourAddress);
  if (idx < 0 || idx >= pre.length || idx >= post.length) return 0;
  const delta = post[idx] - pre[idx];
  return delta > 0 ? delta : 0;
}

/** 1) Scan SOL deposit addresses; insert DETECTED deposits (unique by network+txHash). */
export async function detectSolDeposits(): Promise<{ detected: number; errors: string[] }> {
  const errors: string[] = [];
  let detected = 0;

  const solAddresses = await prisma.walletAddress.findMany({
    where: { network: NETWORK_SOL },
    include: { user: { select: { id: true } } },
  });

  for (const wa of solAddresses) {
    let signatures: TatumService.SolanaSignatureInfo[];
    try {
      signatures = await TatumService.getSolanaSignaturesForAddress(wa.address, 50);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`getSignatures ${wa.address}: ${msg}`);
      continue;
    }

    for (const sig of signatures) {
      if (sig.err) continue; // failed tx
      const txHash = sig.signature;

      const exists = await prisma.deposit.findUnique({
        where: { network_txHash_depositAddress: { network: NETWORK_SOL, txHash, depositAddress: wa.address } },
      });
      if (exists) continue;

      let txData: { transaction?: { message?: { accountKeys?: string[] } }; meta?: { preBalances?: number[]; postBalances?: number[] } };
      try {
        const raw = await TatumService.getSolanaTransaction(txHash) as Record<string, unknown>;
        txData = {
          transaction: raw.transaction as typeof txData.transaction,
          meta: raw.meta as typeof txData.meta,
        };
      } catch (e) {
        errors.push(`getTx ${txHash}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }

      const incomingLamports = getIncomingLamportsFromTx(txData, wa.address);
      if (incomingLamports <= 0) continue;

      const rawAmount = lamportsToSol(incomingLamports);

      try {
        await prisma.deposit.create({
          data: {
            userId: wa.userId,
            network: NETWORK_SOL,
            txHash,
            walletAddressId: wa.id,
            depositAddress: wa.address,
            rawAmount,
            amountUsd: 0,
            status: 'DETECTED',
          },
        });
        detected++;
      } catch (e: unknown) {
        if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'P2002') {
          // unique violation - already exists, skip
        } else {
          errors.push(`create Deposit ${txHash}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  return { detected, errors };
}

/** 2) DETECTED -> CONFIRMED (set amountUsd, priceUsed). If amountUsd < MIN_USD_SOL -> FAILED + isBelowMinimum. */
export async function confirmSolDeposits(): Promise<{ confirmed: number; failed: number; errors: string[] }> {
  const errors: string[] = [];
  let confirmed = 0;
  let failed = 0;

  const list = await prisma.deposit.findMany({
    where: { network: NETWORK_SOL, status: 'DETECTED' },
  });

  let solPrice: number | null = null;
  try {
    const prices = await getSimplePrices();
    solPrice = getPriceFromResult(prices, 'sol');
  } catch (e) {
    errors.push('CoinGecko SOL price failed');
  }

  if (solPrice == null || solPrice <= 0) {
    return { confirmed: 0, failed: 0, errors };
  }

  for (const d of list) {
    const amountUsd = d.rawAmount * solPrice;
    const isBelowMinimum = amountUsd < MIN_USD_SOL;

    try {
      await prisma.deposit.update({
        where: { id: d.id },
        data: {
          amountUsd,
          priceUsed: solPrice,
          status: isBelowMinimum ? 'FAILED' : 'CONFIRMED',
          isBelowMinimum,
        },
      });
      if (isBelowMinimum) failed++;
      else confirmed++;
    } catch (e) {
      errors.push(`confirm ${d.txHash}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { confirmed, failed, errors };
}

/** 3) Sweep CONFIRMED: for each SOL address with CONFIRMED deposits, sweep balance to master (if >= SOL_MIN_DEPOSIT_SOL). */
export async function sweepSolDeposits(): Promise<{ swept: number; errors: string[] }> {
  const errors: string[] = [];
  let swept = 0;

  const addressesWithConfirmed = await prisma.deposit.findMany({
    where: { network: NETWORK_SOL, status: 'CONFIRMED' },
    select: { walletAddressId: true, depositAddress: true },
    distinct: ['depositAddress'],
  });

  const masterAddress = await TatumService.getMasterAddress(TatumService.CHAINS.SOLANA);

  for (const { walletAddressId, depositAddress } of addressesWithConfirmed) {
    if (!walletAddressId) continue;

    const wa = await prisma.walletAddress.findUnique({
      where: { id: walletAddressId },
      select: { derivationIndex: true },
    });
    if (wa?.derivationIndex == null) continue;

    let balanceSol: number;
    try {
      balanceSol = await TatumService.getNativeBalance(TatumService.CHAINS.SOLANA, depositAddress);
    } catch (e) {
      errors.push(`balance ${depositAddress}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    if (balanceSol < SOL_MIN_DEPOSIT_SOL) {
      errors.push(`skip sweep ${depositAddress}: balance ${balanceSol} < ${SOL_MIN_DEPOSIT_SOL} SOL`);
      continue;
    }

    // Leave ~0.000005 SOL for fee (~5000 lamports)
    const sweepAmount = Math.max(0, balanceSol - 0.00001);
    if (sweepAmount < SOL_MIN_DEPOSIT_SOL) continue;

    let priv: string;
    try {
      priv = WalletDerivation.derivePrivateKey('SOL', wa.derivationIndex);
    } catch (e) {
      errors.push(`priv ${depositAddress}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    // Tatum Solana may expect base58 secret key; we have hex (64 bytes). Try hex first.
    const privForTatum = priv.length === 128 ? Buffer.from(priv, 'hex').toString('base64') : priv;

    let txId: string;
    try {
      txId = await TatumService.sendNative(TatumService.CHAINS.SOLANA, privForTatum, masterAddress, sweepAmount);
    } catch (e) {
      errors.push(`sweep ${depositAddress}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    if (!txId) {
      errors.push(`sweep ${depositAddress}: no txId`);
      continue;
    }

    await prisma.deposit.updateMany({
      where: { network: NETWORK_SOL, status: 'CONFIRMED', depositAddress },
      data: { status: 'SWEPT', sweepTxId: txId },
    });
    swept++;
  }

  return { swept, errors };
}

/** 4) SWEPT -> credit user balance, create Transaction DEPOSIT, status CREDITED. */
export async function creditSolDeposits(): Promise<{ credited: number; errors: string[] }> {
  const errors: string[] = [];
  let credited = 0;

  const list = await prisma.deposit.findMany({
    where: { network: NETWORK_SOL, status: 'SWEPT' },
    include: { user: { select: { id: true } } },
  });

  for (const d of list) {
    try {
      await prisma.$transaction([
        prisma.user.update({
          where: { id: d.userId },
          data: { balance: { increment: d.amountUsd } },
        }),
        prisma.transaction.create({
          data: {
            userId: d.userId,
            type: 'DEPOSIT',
            amount: d.amountUsd,
            description: JSON.stringify({
              source: 'sol',
              txHash: d.txHash,
              amountSol: d.rawAmount,
              amountUsd: d.amountUsd,
              priceUsed: d.priceUsed,
            }),
          },
        }),
        prisma.deposit.update({
          where: { id: d.id },
          data: { status: 'CREDITED' },
        }),
      ]);
      credited++;
    } catch (e) {
      errors.push(`credit ${d.txHash}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { credited, errors };
}

/** Run full cycle: detect -> confirm -> sweep -> credit. No-op if SOL_DEPOSITS_DISABLED=true (use when only USDC is supported). */
export async function runSolDepositCycle(): Promise<{
  detected: number;
  confirmed: number;
  failed: number;
  swept: number;
  credited: number;
  errors: string[];
}> {
  if (process.env.SOL_DEPOSITS_DISABLED === 'true') {
    return { detected: 0, confirmed: 0, failed: 0, swept: 0, credited: 0, errors: [] };
  }
  // Native SOL only; for USDC SPL set SOL_DEPOSITS_DISABLED=true and SOL_USDC_ENABLED=true
  const errors: string[] = [];
  const d = await detectSolDeposits();
  errors.push(...d.errors);

  const c = await confirmSolDeposits();
  errors.push(...c.errors);

  const s = await sweepSolDeposits();
  errors.push(...s.errors);

  const cr = await creditSolDeposits();
  errors.push(...cr.errors);

  return {
    detected: d.detected,
    confirmed: c.confirmed,
    failed: c.failed,
    swept: s.swept,
    credited: cr.credited,
    errors,
  };
}
