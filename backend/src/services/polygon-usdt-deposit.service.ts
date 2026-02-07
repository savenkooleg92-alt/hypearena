/**
 * Polygon ERC-20 deposit flow (USDT or USDC): detect → confirm → credit → sweep.
 * Token contract is configurable via POLYGON_DEPOSIT_TOKEN_CONTRACT.
 * Detection uses eth_getLogs: Transfer events; sweep uses same contract for balanceOf/transfer.
 */

import prisma from '../utils/prisma';
import * as TatumService from './TatumService';
import { runSweepForNetwork } from './wallet-sweep.service';

const NETWORK_MATIC = 'MATIC';
const MIN_USD_POLYGON = 1;
const POLYGON_ERC20_DECIMALS = 6;

/** USDT Polygon (default). */
const USDT_POLYGON = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F';
/** Native USDC (Circle). Use POLYGON_DEPOSIT_TOKEN_CONTRACT=0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359 for USDC. */
const USDC_POLYGON_NATIVE = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
/** Configurable: USDT or USDC (or any ERC-20 with 6 decimals). */
const POLYGON_TOKEN_CONTRACT = (process.env.POLYGON_DEPOSIT_TOKEN_CONTRACT || USDT_POLYGON).trim().toLowerCase();
const POLYGON_TOKEN_CONTRACT_0X = POLYGON_TOKEN_CONTRACT.startsWith('0x') ? POLYGON_TOKEN_CONTRACT : '0x' + POLYGON_TOKEN_CONTRACT;

/** ERC20 Transfer(address from, address to, uint256 value). Same for all ERC-20. */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
/** Cursor-based scan: chunk size (blocks per eth_getLogs). On "too large"/429 we reduce and retry. */
const CHUNK_BLOCKS = Math.min(2000, Math.max(16, parseInt(process.env.POLYGON_DEPOSIT_CHUNK_BLOCKS || '200', 10)));
/** Chunk sizes to try on retry (largest first). */
const CHUNK_FALLBACKS = [CHUNK_BLOCKS, 100, 50, 25, 16].filter((s) => s >= 16 && s <= 5000);
/** First run: how many blocks back from latest to start (avoid scanning from block 0). */
const INITIAL_BLOCKS_BACK = Math.min(100_000, Math.max(1000, parseInt(process.env.POLYGON_DEPOSIT_INITIAL_BLOCKS || '50000', 10)));
const BACKOFF_MS = [1000, 2000, 5000];
const POLYGON_CURSOR_NETWORK = 'MATIC';

function maskRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname.includes('alchemy')) return u.origin.replace(/\/v2\/.*$/, '/v2/***');
    if (u.hostname.includes('drpc')) return u.origin + '/***';
    return u.origin;
  } catch {
    return '***';
  }
}

/** Normalize tx hash for storage (lowercase, no 0x prefix issues). */
/** Normalize tx hash: trim, strip non-hex (e.g. trailing semicolon), lowercase. Result 0x + hex only. */
function normalizeTxHash(txHash: string): string {
  const h = typeof txHash === 'string' ? txHash.trim() : '';
  const hex = h.replace(/^0x/i, '').replace(/[^0-9a-fA-F]/g, '');
  return '0x' + hex.toLowerCase();
}

/** Idempotency key for ledger. */
function depositLedgerExternalId(txHash: string, depositAddress: string): string {
  return `matic_usdt:${NETWORK_MATIC}:${normalizeTxHash(txHash)}:${depositAddress}`;
}

/** Pad EVM address to 32-byte topic (64 hex chars). */
function padAddressToTopic(addr: string): string {
  const a = addr.startsWith('0x') ? addr.slice(2).toLowerCase() : addr.toLowerCase();
  return '0x' + a.padStart(64, '0');
}

/** Parse amount from log (hex/decimal). Log data is raw units (6 decimals); normalize to human (e.g. 1020000 -> 1.02). */
function parseAmount(amount: string | number): number {
  if (typeof amount === 'number') return amount;
  const s = String(amount).trim();
  const n = s.startsWith('0x') ? parseInt(s, 16) : parseFloat(s);
  if (Number.isNaN(n)) return 0;
  if (n >= 1e6) return n / Math.pow(10, POLYGON_ERC20_DECIMALS);
  return n;
}

async function getPolygonLatestBlock(): Promise<number> {
  const res = await fetch(POLYGON_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
  });
  if (!res.ok) throw new Error(`Polygon RPC blockNumber ${res.status}`);
  const json = (await res.json()) as { result?: string; error?: { message: string } };
  if (json.error) throw new Error(`Polygon RPC: ${json.error.message}`);
  const latestHex = json.result ?? '0x0';
  return parseInt(latestHex, 16);
}

/** Ensure block is hex string 0x... for eth_getLogs. */
function toHexBlock(v: string | number): string {
  if (typeof v === 'number') return '0x' + Math.max(0, v).toString(16);
  const s = String(v).trim();
  if (s.startsWith('0x')) return s.toLowerCase();
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? '0x0' : '0x' + Math.max(0, n).toString(16);
}

/** Topic (32 bytes) to EVM address (0x + 40 hex). */
function topicToAddress(topic: string): string {
  const t = topic.startsWith('0x') ? topic.slice(2) : topic;
  const addr = t.length >= 40 ? t.slice(-40) : t.padStart(40, '0');
  return '0x' + addr.toLowerCase();
}

/** One eth_getLogs for configured ERC-20 contract + Transfer topic. Returns all Transfer logs; filter by deposit addresses in code. */
async function getPolygonErc20TransferLogsInRange(
  fromBlock: string,
  toBlock: string
): Promise<Array<{ txHash: string; toAddress: string; amountRaw: string }>> {
  const fromHex = toHexBlock(fromBlock);
  const toHex = toHexBlock(toBlock);
  const fromNum = parseInt(fromHex, 16);
  const toNum = parseInt(toHex, 16);
  if (fromNum > toNum) throw new Error(`eth_getLogs: fromBlock ${fromHex} > toBlock ${toHex}`);

  const addressStr = POLYGON_TOKEN_CONTRACT_0X;
  const filter = { address: addressStr, fromBlock: fromHex, toBlock: toHex, topics: [TRANSFER_TOPIC] as [string] };
  const res = await fetch(POLYGON_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [filter] }),
  });
  const text = await res.text();
  let json: { result?: unknown[]; error?: { message: string; code?: number } };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    json = {};
  }
  const bodyError = json?.error?.message;
  if (!res.ok) {
    const msg = bodyError ? `Polygon RPC ${res.status}: ${bodyError}` : `Polygon RPC ${res.status}: ${res.statusText}`;
    if (res.status === 400 || res.status === 429) console.error('[polygon-usdt] eth_getLogs response', res.status, text.slice(0, 400));
    throw new Error(msg);
  }
  if (json.error) throw new Error(`Polygon RPC: ${json.error.message}`);
  const logs = (json.result ?? []) as Array<{ transactionHash?: string; topics?: string[]; data?: string }>;
  const out: Array<{ txHash: string; toAddress: string; amountRaw: string }> = [];
  for (const l of logs) {
    if (!l.transactionHash || !l.data || !l.topics?.[2]) continue;
    const toAddress = topicToAddress(l.topics[2]);
    const amountRaw = l.data.startsWith('0x') ? String(parseInt(l.data, 16)) : l.data;
    out.push({ txHash: (l.transactionHash as string).toLowerCase(), toAddress, amountRaw });
  }
  return out;
}

/** 400/429/range/limit → retry with smaller window + backoff. */
function isGetLogsRetryableError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();
  return (
    lower.includes('400') ||
    lower.includes('429') ||
    lower.includes('range') ||
    lower.includes('limit') ||
    lower.includes('exceeded') ||
    lower.includes('too many') ||
    lower.includes('too large') ||
    lower.includes('bad request') ||
    lower.includes('10000') ||
    lower.includes('block range') ||
    lower.includes('rate limit')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Load or init cursor for MATIC. Returns block number to use as fromBlock (inclusive); next scan uses fromBlock+1. */
async function getOrInitPolygonCursor(latestBlock: number): Promise<number> {
  const row = await prisma.blockCursor.findUnique({ where: { network: POLYGON_CURSOR_NETWORK } });
  const last = row?.lastProcessedBlock ?? null;
  if (last != null && last >= 0) return last;
  const start = Math.max(0, latestBlock - INITIAL_BLOCKS_BACK);
  await prisma.blockCursor.upsert({
    where: { network: POLYGON_CURSOR_NETWORK },
    create: { network: POLYGON_CURSOR_NETWORK, lastBlockTimestamp: 0, lastProcessedBlock: start },
    update: { lastProcessedBlock: start },
  });
  console.log('[polygon-usdt] cursor init', { fromBlock: start, latest: latestBlock });
  return start;
}

/** Persist cursor after successfully processing [fromBlock..toBlock]. */
async function savePolygonCursor(toBlock: number): Promise<void> {
  await prisma.blockCursor.upsert({
    where: { network: POLYGON_CURSOR_NETWORK },
    create: { network: POLYGON_CURSOR_NETWORK, lastBlockTimestamp: 0, lastProcessedBlock: toBlock },
    update: { lastProcessedBlock: toBlock },
  });
}

/** 1) Detect: cursor-based scan. fromBlock = lastProcessedBlock+1, chunk by chunk; on "too large"/429 reduce chunk + backoff, then retry. */
export async function detectPolygonUsdtDeposits(): Promise<{ detected: number; errors: string[] }> {
  const errors: string[] = [];
  let detected = 0;

  const addresses = await prisma.walletAddress.findMany({
    where: { network: NETWORK_MATIC },
    include: { user: { select: { id: true } } },
  });
  const depositAddressSet = new Set(addresses.map((a) => a.address.toLowerCase()));
  const addressByLower = new Map<string, (typeof addresses)[0]>();
  for (const wa of addresses) {
    addressByLower.set(wa.address.toLowerCase(), wa);
  }

  let latestBlock: number;
  try {
    latestBlock = await getPolygonLatestBlock();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`Polygon RPC blockNumber: ${msg}`);
    return { detected, errors };
  }

  const cursorStart = await getOrInitPolygonCursor(latestBlock);
  let fromBlock = cursorStart + 1;
  let chunkSize = CHUNK_FALLBACKS[0];
  let chunkIndex = 0;

  console.log('[polygon-usdt] detect start', {
    rpc: maskRpcUrl(POLYGON_RPC_URL),
    tokenContract: POLYGON_TOKEN_CONTRACT_0X.slice(0, 10) + '…',
    fromBlock,
    latestBlock,
    chunkBlocks: chunkSize,
    depositAddresses: addresses.length,
  });

  while (fromBlock <= latestBlock) {
    const toBlock = Math.min(fromBlock + chunkSize - 1, latestBlock);
    const fromHex = '0x' + fromBlock.toString(16);
    const toHex = '0x' + toBlock.toString(16);

    let logs: Array<{ txHash: string; toAddress: string; amountRaw: string }>;
    try {
      logs = await getPolygonErc20TransferLogsInRange(fromHex, toHex);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isGetLogsRetryableError(e) && chunkIndex < CHUNK_FALLBACKS.length - 1) {
        chunkIndex++;
        chunkSize = CHUNK_FALLBACKS[chunkIndex];
        const backoff = BACKOFF_MS[Math.min(chunkIndex - 1, BACKOFF_MS.length - 1)];
        console.warn('[polygon-usdt] eth_getLogs retry', { nextChunk: chunkSize, backoffMs: backoff, error: msg.slice(0, 80) });
        await sleep(backoff);
        continue;
      }
      errors.push(`Polygon RPC eth_getLogs [${fromBlock}..${toBlock}]: ${msg}`);
      return { detected, errors };
    }

    const matched = logs.filter((l) => depositAddressSet.has(l.toAddress.toLowerCase()));
    for (const l of matched) {
      const wa = addressByLower.get(l.toAddress.toLowerCase());
      if (!wa) continue;
      const txHashNorm = normalizeTxHash(l.txHash);
      const exists = await prisma.deposit.findUnique({
        where: {
          network_txHash_depositAddress: { network: NETWORK_MATIC, txHash: txHashNorm, depositAddress: wa.address },
        },
      });
      if (exists) continue;

      const rawAmount = parseAmount(l.amountRaw);
      if (rawAmount <= 0) continue;

      const now = new Date();
      try {
        await prisma.deposit.create({
          data: {
            userId: wa.userId,
            network: NETWORK_MATIC,
            txHash: txHashNorm,
            walletAddressId: wa.id,
            depositAddress: wa.address,
            rawAmount,
            amountUsd: 0,
            status: 'DETECTED',
            detectedAt: now,
          },
        });
        detected++;
        console.log('[polygon-usdt] detected', { tx: l.txHash.slice(0, 20) + '…', user: wa.userId, amount: rawAmount });
      } catch (e: unknown) {
        if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'P2002') {
          // unique race
        } else {
          errors.push(`create Deposit ${l.txHash}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    await savePolygonCursor(toBlock);
    fromBlock = toBlock + 1;
    if (chunkIndex > 0) {
      chunkIndex = 0;
      chunkSize = CHUNK_FALLBACKS[0];
    }
  }

  console.log('[polygon-usdt] detect cycle', {
    cursorTo: fromBlock - 1,
    latestBlock,
    created: detected,
    errors: errors.length,
  });
  return { detected, errors };
}

/** 2) DETECTED → CONFIRMED. */
export async function confirmPolygonUsdtDeposits(): Promise<{ confirmed: number; failed: number; errors: string[] }> {
  const errors: string[] = [];
  let confirmed = 0;
  let failed = 0;
  const now = new Date();

  const list = await prisma.deposit.findMany({
    where: { network: NETWORK_MATIC, status: 'DETECTED' },
  });

  for (const d of list) {
    const amountUsd = d.rawAmount;
    const isBelowMinimum = amountUsd < MIN_USD_POLYGON;
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
export async function creditPolygonUsdtDeposits(): Promise<{ credited: number; errors: string[] }> {
  const errors: string[] = [];
  let credited = 0;

  const list = await prisma.deposit.findMany({
    where: { network: NETWORK_MATIC, status: 'CONFIRMED' },
    include: { user: { select: { id: true } } },
  });

  for (const d of list) {
    const externalId = depositLedgerExternalId(normalizeTxHash(d.txHash), d.depositAddress);
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
              source: 'polygon_usdt',
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
      console.log('[polygon-usdt] credited', { tx: d.txHash.slice(0, 20) + '…', userId: d.userId, amountUsd: d.amountUsd });
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

/**
 * Manually add a Polygon USDT deposit and credit it (admin).
 * depositAddress must exist in WalletAddress (MATIC). txHash and amountUsd from block explorer.
 */
export async function createAndCreditPolygonDeposit(
  txHash: string,
  depositAddress: string,
  amountUsd: number
): Promise<{ ok: boolean; credited?: boolean; error?: string }> {
  const txHashNorm = normalizeTxHash(txHash);
  const rawAmount = amountUsd;

  const wa = await prisma.walletAddress.findFirst({
    where: { network: NETWORK_MATIC, address: { equals: depositAddress, mode: 'insensitive' } },
    include: { user: { select: { id: true } } },
  });

  if (!wa) {
    return { ok: false, error: 'Deposit address not found in wallet_addresses. User must have requested a Polygon deposit address from the app first.' };
  }

  const existing = await prisma.deposit.findUnique({
    where: {
      network_txHash_depositAddress: { network: NETWORK_MATIC, txHash: txHashNorm, depositAddress: wa.address },
    },
  });

  if (existing) {
    if (existing.status === 'CREDITED') {
      return { ok: true, credited: false };
    }
    await prisma.deposit.update({
      where: { id: existing.id },
      data: { amountUsd, priceUsed: 1, status: 'CONFIRMED', confirmedAt: new Date() },
    });
  } else {
    await prisma.deposit.create({
      data: {
        userId: wa.userId,
        network: NETWORK_MATIC,
        txHash: txHashNorm,
        walletAddressId: wa.id,
        depositAddress: wa.address,
        rawAmount,
        amountUsd,
        priceUsed: 1,
        status: 'CONFIRMED',
        confirmedAt: new Date(),
      },
    });
  }

  const cr = await creditPolygonUsdtDeposits();
  return { ok: true, credited: cr.credited > 0 };
}

/**
 * Credit one Polygon USDT deposit by tx hash only: fetch receipt, parse Transfer log, find our deposit address, credit.
 * Use when auto-detect missed the tx (e.g. block range, RPC). Idempotent.
 */
export async function creditPolygonDepositByTxHash(
  txHash: string
): Promise<
  | { ok: true; credited: true; depositAddress: string; amountUsd: number }
  | { ok: true; alreadyCredited: true; depositAddress: string; amountUsd: number }
  | { ok: false; error: string }
> {
  const txHashNorm = normalizeTxHash(txHash);
  const res = await fetch(POLYGON_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getTransactionReceipt',
      params: [txHashNorm],
    }),
  });
  if (!res.ok) return { ok: false, error: `Polygon RPC error: ${res.status}` };
  const json = (await res.json()) as { result?: { logs?: Array<{ address?: string; topics?: string[]; data?: string }> }; error?: { message: string } };
  if (json.error) return { ok: false, error: `Polygon RPC: ${json.error.message}` };
  const receipt = json.result;
  if (!receipt?.logs?.length) return { ok: false, error: 'No receipt or logs for this tx' };

  const maticAddresses = await prisma.walletAddress.findMany({
    where: { network: NETWORK_MATIC },
    select: { address: true },
  });
  const ourAddressesLower = new Set(maticAddresses.map((a) => a.address.toLowerCase()));

  for (const log of receipt.logs) {
    if (log.address?.toLowerCase() !== POLYGON_TOKEN_CONTRACT_0X.toLowerCase()) continue;
    if (log.topics?.[0] !== TRANSFER_TOPIC || !log.topics[2] || !log.data) continue;
    const toAddress = topicToAddress(log.topics[2]);
    if (!ourAddressesLower.has(toAddress.toLowerCase())) continue;
    const amountRaw = parseInt(log.data, 16);
    if (Number.isNaN(amountRaw) || amountRaw < 1e6) continue;
    const amountUsd = amountRaw / Math.pow(10, POLYGON_ERC20_DECIMALS);

    const wa = await prisma.walletAddress.findFirst({
      where: { network: NETWORK_MATIC, address: { equals: toAddress, mode: 'insensitive' } },
    });
    if (!wa) continue;

    const existing = await prisma.deposit.findUnique({
      where: {
        network_txHash_depositAddress: { network: NETWORK_MATIC, txHash: txHashNorm, depositAddress: wa.address },
      },
    });
    if (existing?.status === 'CREDITED') {
      return { ok: true, alreadyCredited: true, depositAddress: wa.address, amountUsd };
    }

    const creditResult = await createAndCreditPolygonDeposit(txHashNorm, wa.address, amountUsd);
    if (!creditResult.ok) return { ok: false, error: creditResult.error ?? 'Credit failed' };
    return { ok: true, credited: (creditResult as { credited?: boolean }).credited ?? true, depositAddress: wa.address, amountUsd };
  }

  return { ok: false, error: 'No USDT Transfer to any of our MATIC deposit addresses in this tx' };
}

/**
 * Rescan block range for one deposit address: fetch Transfer logs to that address, create DETECTED → confirm → credit.
 * Use when auto-detect missed (e.g. before cursor fix). Idempotent. Chunks to avoid RPC "block range too large".
 */
export async function rescanPolygonDepositsForAddress(
  depositAddress: string,
  fromBlock: number,
  toBlock?: number
): Promise<{ ok: boolean; created: number; credited: number; errors: string[] }> {
  const errors: string[] = [];
  let created = 0;

  const wa = await prisma.walletAddress.findFirst({
    where: { network: NETWORK_MATIC, address: { equals: depositAddress, mode: 'insensitive' } },
    include: { user: { select: { id: true } } },
  });
  if (!wa) {
    return { ok: false, created: 0, credited: 0, errors: ['Deposit address not found in wallet_addresses (MATIC).'] };
  }
  const addrLower = wa.address.toLowerCase();

  let endBlock = toBlock;
  if (endBlock == null) {
    try {
      endBlock = await getPolygonLatestBlock();
    } catch (e) {
      return {
        ok: false,
        created: 0,
        credited: 0,
        errors: [`Polygon RPC blockNumber: ${e instanceof Error ? e.message : String(e)}`],
      };
    }
  }

  const from = Math.max(0, fromBlock);
  const to = Math.min(endBlock, from + 500_000);
  let cursor = from;
  let chunkSize = 100;

  while (cursor <= to) {
    const toChunk = Math.min(cursor + chunkSize - 1, to);
    const fromHex = '0x' + cursor.toString(16);
    const toHex = '0x' + toChunk.toString(16);
    try {
      const logs = await getPolygonErc20TransferLogsInRange(fromHex, toHex);
      const forUs = logs.filter((l) => l.toAddress.toLowerCase() === addrLower);
      for (const l of forUs) {
        const txHashNorm = normalizeTxHash(l.txHash);
        const rawAmount = parseAmount(l.amountRaw);
        if (rawAmount <= 0) continue;
        const exists = await prisma.deposit.findUnique({
          where: {
            network_txHash_depositAddress: { network: NETWORK_MATIC, txHash: txHashNorm, depositAddress: wa.address },
          },
        });
        if (exists) continue;
        try {
          await prisma.deposit.create({
            data: {
              userId: wa.userId,
              network: NETWORK_MATIC,
              txHash: txHashNorm,
              walletAddressId: wa.id,
              depositAddress: wa.address,
              rawAmount,
              amountUsd: 0,
              status: 'DETECTED',
              detectedAt: new Date(),
            },
          });
          created++;
        } catch (e: unknown) {
          if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'P2002') {
            // race
          } else {
            errors.push(`create ${l.txHash}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      cursor = toChunk + 1;
      if (chunkSize < 100) chunkSize = Math.min(100, chunkSize + 25);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isGetLogsRetryableError(e) && chunkSize > 16) {
        chunkSize = Math.max(16, Math.floor(chunkSize / 2));
        await sleep(1500);
        continue;
      }
      errors.push(`eth_getLogs [${cursor}..${toChunk}]: ${msg}`);
      break;
    }
  }

  const confirmRes = await confirmPolygonUsdtDeposits();
  errors.push(...confirmRes.errors);
  const creditRes = await creditPolygonUsdtDeposits();
  errors.push(...creditRes.errors);

  return {
    ok: true,
    created,
    credited: creditRes.credited,
    errors,
  };
}

/** Run full cycle: detect → confirm → credit → sweep (auto, like Solana USDC). No-op when ENABLE_POLYGON_DEPOSITS=false. */
export async function runPolygonUsdtDepositCycle(): Promise<{
  detected: number;
  confirmed: number;
  failed: number;
  credited: number;
  swept: number;
  errors: string[];
}> {
  if (process.env.ENABLE_POLYGON_DEPOSITS === 'false') {
    return { detected: 0, confirmed: 0, failed: 0, credited: 0, swept: 0, errors: [] };
  }
  const errors: string[] = [];
  const d = await detectPolygonUsdtDeposits();
  errors.push(...d.errors);
  const c = await confirmPolygonUsdtDeposits();
  errors.push(...c.errors);
  const cr = await creditPolygonUsdtDeposits();
  errors.push(...cr.errors);

  let swept = 0;
  try {
    const sweepResult = await runSweepForNetwork('MATIC');
    swept = sweepResult.sweptCount;
    if (sweepResult.results?.some((r) => r.error)) {
      sweepResult.results.filter((r) => r.error).forEach((r) => errors.push(`${r.address}: ${r.error}`));
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`sweep: ${msg}`);
  }

  if (d.detected > 0 || c.confirmed > 0 || cr.credited > 0 || swept > 0 || errors.length > 0) {
    console.log('[polygon-usdt] cycle', { detected: d.detected, confirmed: c.confirmed, failed: c.failed, credited: cr.credited, swept, errors: errors.length });
    if (errors.length > 0) {
      errors.slice(0, 5).forEach((err, i) => console.warn('[polygon-usdt] error', i + 1, err));
      if (errors.length > 5) console.warn('[polygon-usdt] ... and', errors.length - 5, 'more errors');
    }
  }
  return {
    detected: d.detected,
    confirmed: c.confirmed,
    failed: c.failed,
    credited: cr.credited,
    swept,
    errors,
  };
}
