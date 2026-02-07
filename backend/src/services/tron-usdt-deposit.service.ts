/**
 * TRON USDT (TRC-20) deposit flow: detect → confirm → credit. Fully automatic.
 * Sweep: POST /api/wallet/sweep or cron. Uses Trongrid contract events + cursor; address match in base58.
 */

import prisma from '../utils/prisma';
import * as TatumService from './TatumService';

const NETWORK_TRON = 'TRON';
const CURSOR_NETWORK = 'TRON';
// TODO: restore to 20 after testing. Temporary $1 for TRON USDT credit testing.
const MIN_USD_TRON_USDT = 1;
const TRON_USDT_DECIMALS = 6;
/** Backfill: last 24h (ms) when cursor is missing. */
const BACKFILL_MS = 24 * 60 * 60 * 1000;

/** Idempotency key for ledger (unique txHash + depositAddress). */
function depositLedgerExternalId(txHash: string, depositAddress: string): string {
  return `tron_usdt:${NETWORK_TRON}:${txHash}:${depositAddress}`;
}

/** Log config and deposit addresses at startup / each cycle. */
export async function logTronUsdtConfig(): Promise<void> {
  const contract = TatumService.TRON_USDT_CONTRACT;
  const endpoint = TatumService.TRONGRID_BASE;
  const addresses = await prisma.walletAddress.findMany({
    where: { network: NETWORK_TRON },
    select: { address: true },
    orderBy: { id: 'asc' },
  });
  const count = addresses.length;
  const first = count > 0 ? addresses[0]!.address : null;
  const last = count > 1 ? addresses[count - 1]!.address : null;
  const hasKey = !!TatumService.TRONGRID_API_KEY;
  console.log(
    '[tron-usdt] config: TRON_USDT_CONTRACT=' +
      contract +
      ' TronGrid=' +
      endpoint +
      (hasKey ? ' (API key set)' : ' (no API key, 1.2s delay between addresses)') +
      ' depositAddresses=' +
      count +
      (first ? ' first=' + first.slice(0, 12) + '…' : '') +
      (last && last !== first ? ' last=' + last.slice(0, 12) + '…' : '')
  );
}

/** 1) Detect: for each TRON deposit address fetch TRC20 transfers (per-address API), create DETECTED. Idempotent by unique(network, txHash, depositAddress). */
export async function detectTronUsdtDeposits(): Promise<{
  detected: number;
  scanned: number;
  matched: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let detected = 0;
  let scanned = 0;
  let matched = 0;

  const addresses = await prisma.walletAddress.findMany({
    where: { network: NETWORK_TRON },
    include: { user: { select: { id: true } } },
    orderBy: { id: 'asc' },
  });

  const hasApiKey = !!TatumService.TRONGRID_API_KEY;
  const delayMs = hasApiKey ? 0 : 1200;
  for (let i = 0; i < addresses.length; i++) {
    if (i > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    const wa = addresses[i]!;
    try {
      const transfers = await TatumService.getTronTrc20TransfersToAddress(wa.address, 200);
      scanned += transfers.length;
      if (transfers.length > 0) matched++;
      if (transfers.length > 0 && detected === 0) {
        const first = transfers[0]!;
        console.log('[tron-usdt] first transfer sample', {
          addr: wa.address.slice(0, 12) + '…',
          txId: first.txId.slice(0, 16) + '…',
          to: first.to.slice(0, 12) + '…',
          valueRaw: first.valueRaw,
        });
      }
      for (const t of transfers) {
        const rawAmount = parseInt(t.valueRaw, 10) / Math.pow(10, TRON_USDT_DECIMALS);
        if (rawAmount <= 0 || Number.isNaN(rawAmount)) continue;

        const now = new Date();
        try {
          await prisma.deposit.create({
            data: {
              userId: wa.userId,
              network: NETWORK_TRON,
              txHash: t.txId,
              walletAddressId: wa.id,
              depositAddress: wa.address,
              rawAmount,
              amountUsd: 0,
              status: 'DETECTED',
              detectedAt: now,
            },
          });
          detected++;
          console.log('[tron-usdt] detected', { tx: t.txId.slice(0, 20) + '…', user: wa.userId, amount: rawAmount });
        } catch (err: unknown) {
          if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'P2002') {
            // unique: already created (idempotent)
          } else {
            errors.push(`create Deposit ${t.txId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      if (transfers.length > 0) {
        console.log('[tron-usdt] addr ' + wa.address.slice(0, 12) + '… fetched ' + transfers.length + ' incoming, created ' + detected + ' new');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Trongrid ${wa.address.slice(0, 12)}…: ${msg}`);
      console.error('[tron-usdt] Trongrid error for ' + wa.address.slice(0, 12) + '…', msg);
    }
  }

  if (scanned > 0 || matched > 0 || detected > 0 || errors.length > 0) {
    console.log(
      '[tron-usdt] scanned ' + scanned + ' transfers, matched ' + matched + ' addresses, created ' + detected + ' deposits'
    );
  }

  return { detected, scanned, matched, errors };
}

/** 2) DETECTED → CONFIRMED (apply minimum). */
export async function confirmTronUsdtDeposits(): Promise<{ confirmed: number; failed: number; errors: string[] }> {
  const errors: string[] = [];
  let confirmed = 0;
  let failed = 0;
  const now = new Date();

  const list = await prisma.deposit.findMany({
    where: { network: NETWORK_TRON, status: 'DETECTED' },
  });

  for (const d of list) {
    const amountUsd = d.rawAmount;
    const isBelowMinimum = amountUsd < MIN_USD_TRON_USDT;
    if (isBelowMinimum) {
      await prisma.deposit.update({
        where: { id: d.id },
        data: { amountUsd, priceUsed: 1, status: 'FAILED', isBelowMinimum: true },
      });
      failed++;
      continue;
    }
    try {
      await prisma.deposit.update({
        where: { id: d.id },
        data: { amountUsd, priceUsed: 1, status: 'CONFIRMED', confirmedAt: now },
      });
      confirmed++;
    } catch (e) {
      errors.push(`confirm ${d.txHash}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { confirmed, failed, errors };
}

/** 3) Credit CONFIRMED deposits (idempotent by externalId). */
export async function creditTronUsdtDeposits(): Promise<{ credited: number; errors: string[] }> {
  const errors: string[] = [];
  let credited = 0;

  const list = await prisma.deposit.findMany({
    where: { network: NETWORK_TRON, status: 'CONFIRMED' },
    include: { user: { select: { id: true } } },
  });

  for (const d of list) {
    const externalId = depositLedgerExternalId(d.txHash, d.depositAddress);
    const now = new Date();
    try {
      await prisma.$transaction([
        prisma.transaction.create({
          data: {
            userId: d.userId,
            externalId,
            type: 'DEPOSIT',
            amount: d.amountUsd,
            description: JSON.stringify({
              source: 'tron_usdt',
              txHash: d.txHash,
              amountUsdt: d.rawAmount,
              amountUsd: d.amountUsd,
            }),
          },
        }),
        prisma.user.update({
          where: { id: d.userId },
          data: { balance: { increment: d.amountUsd } },
        }),
        prisma.deposit.update({
          where: { id: d.id },
          data: { status: 'CREDITED', creditedAt: now },
        }),
      ]);
      credited++;
      console.log('[tron-usdt] credited', { tx: d.txHash.slice(0, 20) + '…', userId: d.userId, amountUsd: d.amountUsd });
    } catch (e: unknown) {
      const isUniqueViolation = e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'P2002';
      if (isUniqueViolation) {
        await prisma.deposit.updateMany({
          where: { id: d.id, status: { not: 'CREDITED' } },
          data: { status: 'CREDITED', creditedAt: now },
        });
        credited++;
      } else {
        errors.push(`credit ${d.txHash}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return { credited, errors };
}

/** Run full cycle: detect → confirm → credit. Sweep is separate (cron /wallet/sweep). */
export async function runTronUsdtDepositCycle(): Promise<{
  detected: number;
  scanned: number;
  matched: number;
  confirmed: number;
  failed: number;
  credited: number;
  errors: string[];
}> {
  await logTronUsdtConfig();

  const errors: string[] = [];
  const d = await detectTronUsdtDeposits();
  errors.push(...d.errors);
  const c = await confirmTronUsdtDeposits();
  errors.push(...c.errors);
  const cr = await creditTronUsdtDeposits();
  errors.push(...cr.errors);

  if (d.detected > 0 || d.scanned > 0 || c.confirmed > 0 || cr.credited > 0 || errors.length > 0) {
    console.log('[tron-usdt] cycle', {
      scanned: d.scanned,
      matched: d.matched,
      detected: d.detected,
      confirmed: c.confirmed,
      failed: c.failed,
      credited: cr.credited,
      errors: errors.length,
    });
  }

  return {
    detected: d.detected,
    scanned: d.scanned,
    matched: d.matched,
    confirmed: c.confirmed,
    failed: c.failed,
    credited: cr.credited,
    errors,
  };
}
