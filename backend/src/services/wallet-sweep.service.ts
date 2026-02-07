/**
 * Sweep TRON/Polygon USDT from deposit addresses to master.
 * TRON: Trongrid + TronWeb only (no Tatum). Balance via triggerconstantcontract, TRX/energy check, auto-fund, TRC20 transfer.
 * Polygon: on-chain only (Polygon RPC). No Tatum. Deposit key: derivationIndex or privateKeyHex (MATIC). Idempotent.
 */

import { ethers } from 'ethers';
import prisma from '../utils/prisma';
import * as WalletDerivation from './walletDerivation.service';
import * as PolygonRpc from './polygon-rpc-sweep.service';
import * as MasterKeys from './masterKeys.service';
import * as TronRpcSweep from './tron-rpc-sweep.service';

const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
const POLYGON_MIN_USDT_SWEEP = 1; // only sweep if credited sum >= this (same as MIN_USD_POLYGON_USDT)
// Required POL is computed per sweep via estimateGas * gasPrice * 1.2 (no fixed fund amount).
const POLYGON_FUNDING_COOLDOWN_MS = (parseInt(process.env.POLYGON_FUNDING_COOLDOWN_MINUTES || '10', 10) || 10) * 60 * 1000;
const POLYGON_FUND_MAX_PER_HOUR = process.env.POLYGON_FUND_MAX_PER_HOUR ? parseFloat(process.env.POLYGON_FUND_MAX_PER_HOUR) : null;

/** Single-flight lock for Polygon sweep (funding + sweep). Prevents parallel eth_sendRawTransaction from master. */
let polygonSweepLock: Promise<void> = Promise.resolve();

export type SweepResultItem = {
  network: string;
  address: string;
  amount: number;
  txId: string;
  success: boolean;
  error?: string;
};

export async function runSweepForNetwork(
  network: 'TRON' | 'MATIC'
): Promise<{ sweptCount: number; results: SweepResultItem[]; message?: string }> {
  const results: SweepResultItem[] = [];
  let sweptCount = 0;

  if (network === 'MATIC') {
    return runPolygonSweep(results, sweptCount);
  }

  const rows = await prisma.walletAddress.findMany({
    where: { network },
    select: { id: true, network: true, address: true, derivationIndex: true },
  });

  const masterAddress = MasterKeys.getMasterAddressTron();
  const masterPriv = MasterKeys.getMasterPrivateKeyTron();
  console.log('[tron-sweep] checking ' + rows.length + ' TRON address(es) (Trongrid only, no Tatum)');

  for (const row of rows) {
    if (row.derivationIndex == null) {
      console.log('[tron-sweep] skip ' + row.address.slice(0, 12) + '…: No derivationIndex');
      results.push({
        network: row.network,
        address: row.address,
        amount: 0,
        txId: '',
        success: false,
        error: 'No derivationIndex (address not sweepable)',
      });
      continue;
    }

    const depositPriv = WalletDerivation.derivePrivateKey(row.network as WalletDerivation.Network, row.derivationIndex);
    try {
      const one = await TronRpcSweep.sweepOneTronAddress(row.address, depositPriv, masterAddress, masterPriv);
      results.push({
        network: row.network,
        address: one.address,
        amount: one.amount,
        txId: one.txId,
        success: one.success,
        error: one.error,
      });
      if (one.success) {
        sweptCount++;
        console.log('[tron-sweep] success ' + one.address.slice(0, 12) + '… amount=' + one.amount + ' tx=' + (one.txId?.slice(0, 16) ?? '') + '…');
      } else if (one.error && one.error !== 'Balance 0') {
        console.warn('[tron-sweep] failed ' + one.address.slice(0, 12) + '…', one.error);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[tron-sweep] error ' + row.address.slice(0, 12) + '…', msg);
      results.push({
        network: row.network,
        address: row.address,
        amount: 0,
        txId: '',
        success: false,
        error: msg,
      });
    }
  }

  console.log('[tron-sweep] done: swept ' + sweptCount + ', results ' + results.length);
  return { sweptCount, results };
}

/**
 * Polygon USDT sweep: only for addresses that have CREDITED deposits; only sweep the sum of credited amounts (not full balance).
 * Same principle as Solana USDC: never sweep before credit — user balance must be updated first.
 */
async function runPolygonSweep(
  results: SweepResultItem[],
  sweptCount: number
): Promise<{ sweptCount: number; results: SweepResultItem[]; message?: string }> {
  const prevLock = polygonSweepLock;
  let releaseLock!: () => void;
  polygonSweepLock = new Promise<void>((r) => {
    releaseLock = r;
  });
  await prevLock;
  try {
    return await runPolygonSweepInner(results, sweptCount);
  } finally {
    releaseLock();
  }
}

async function runPolygonSweepInner(
  results: SweepResultItem[],
  sweptCount: number
): Promise<{ sweptCount: number; results: SweepResultItem[]; message?: string }> {
  const callerStack = new Error().stack?.split('\n').slice(1, 4).join(' <- ') ?? 'unknown';
  console.log('[polygon-sweep] runPolygonSweep called', { caller: callerStack });

  const addressesToSweep = await prisma.deposit.findMany({
    where: { network: 'MATIC', status: 'CREDITED' },
    select: { depositAddress: true, walletAddressId: true },
    distinct: ['depositAddress'],
  });

  if (addressesToSweep.length === 0) {
    console.log('[polygon-sweep] no CREDITED deposits to sweep (sweep only after credit)');
    results.push({
      network: 'MATIC',
      address: '-',
      amount: 0,
      txId: '',
      success: false,
      error: 'Нет закредитованных депозитов. Сначала «Зачислить по tx» или «Зачислить и забрать на мастер» (вставь tx hash с Polygonscan), либо «Run cycle».',
    });
    return {
      sweptCount,
      results,
      message: 'Нет закредитованных депозитов Polygon. Сначала запустите «Run Polygon USDT cycle» или «Зачислить по tx» / «Зачислить и забрать на мастер».',
    };
  }
  console.log('[polygon-sweep] checking', addressesToSweep.length, 'address(es) with CREDITED deposit(s)');

  const masterPrivHex = MasterKeys.getMasterPrivateKeyPolygon();
  const masterPriv = masterPrivHex.startsWith('0x') ? masterPrivHex : '0x' + masterPrivHex;
  const masterAddress = new ethers.Wallet(masterPriv).address;

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const fundedCountLastHour =
    POLYGON_FUND_MAX_PER_HOUR != null
      ? await prisma.walletAddress.count({
          where: { network: 'MATIC', gasFundedAt: { gte: oneHourAgo } },
        })
      : 0;
  const estimatedPolPerFund = 0.1;
  const totalFundedPolLastHour = fundedCountLastHour * estimatedPolPerFund;
  const fundLimitReached =
    POLYGON_FUND_MAX_PER_HOUR != null && totalFundedPolLastHour >= POLYGON_FUND_MAX_PER_HOUR;

  for (const { depositAddress } of addressesToSweep) {
    const row = await prisma.walletAddress.findFirst({
      where: { network: 'MATIC', address: { equals: depositAddress, mode: 'insensitive' } },
      select: {
        id: true,
        network: true,
        address: true,
        derivationIndex: true,
        privateKeyHex: true,
        gasFundingTxId: true,
        gasFundedAt: true,
      },
    });
    if (!row) {
      results.push({
        network: 'MATIC',
        address: depositAddress,
        amount: 0,
        txId: '',
        success: false,
        error: 'WalletAddress not found for deposit address',
      });
      continue;
    }

    const depositPrivRaw =
      row.privateKeyHex != null && row.privateKeyHex.trim() !== ''
        ? row.privateKeyHex.trim()
        : row.derivationIndex != null
          ? WalletDerivation.derivePrivateKey('MATIC', row.derivationIndex)
          : null;
    if (depositPrivRaw == null) {
      results.push({
        network: row.network,
        address: row.address,
        amount: 0,
        txId: '',
        success: false,
        error: 'No private key (set derivationIndex or privateKeyHex for MATIC)',
      });
      continue;
    }

    const creditedAgg = await prisma.deposit.aggregate({
      where: { network: 'MATIC', depositAddress: row.address, status: 'CREDITED' },
      _sum: { rawAmount: true },
    });
    const creditedDeposits = await prisma.deposit.findMany({
      where: { network: 'MATIC', depositAddress: row.address, status: 'CREDITED' },
      select: { id: true, txHash: true, rawAmount: true },
    });
    const creditedSumHuman = creditedAgg._sum.rawAmount ?? 0;
    if (creditedDeposits.length === 0 || creditedSumHuman < POLYGON_MIN_USDT_SWEEP) {
      if (creditedSumHuman > 0 && creditedSumHuman < POLYGON_MIN_USDT_SWEEP) {
        console.warn('[polygon-sweep] skip: credited sum below min for', row.address.slice(0, 12) + '…');
      }
      results.push({
        network: row.network,
        address: row.address,
        amount: 0,
        txId: '',
        success: false,
        error: creditedSumHuman < POLYGON_MIN_USDT_SWEEP ? `Сумма закредитованных депозитов < ${POLYGON_MIN_USDT_SWEEP} USDT` : 'Нет CREDITED депозитов по этому адресу',
      });
      continue;
    }

    let onChainBalance: number;
    try {
      onChainBalance = await PolygonRpc.getPolygonUsdtBalance(POLYGON_RPC_URL, row.address);
    } catch (e) {
      results.push({
        network: row.network,
        address: row.address,
        amount: 0,
        txId: '',
        success: false,
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    // Sweep full on-chain balance so nothing remains (no dust). We only sweep addresses that have at least one CREDITED deposit.
    const amountToSweep = onChainBalance;
    if (amountToSweep < POLYGON_MIN_USDT_SWEEP) {
      results.push({
        network: row.network,
        address: row.address,
        amount: 0,
        txId: '',
        success: false,
        error: onChainBalance < POLYGON_MIN_USDT_SWEEP
          ? `На адресе 0 токенов (balance=${onChainBalance.toFixed(2)}). Проверь контракт: ${process.env.POLYGON_DEPOSIT_TOKEN_CONTRACT || 'USDT'}.`
          : `Сумма к свипу < ${POLYGON_MIN_USDT_SWEEP} USDT`,
      });
      continue;
    }

    console.log('[polygon-sweep] sweep signing', {
      depositAddress: row.address.slice(0, 12) + '…',
      depositIds: creditedDeposits.map((d: { id: string }) => d.id),
      txHashes: creditedDeposits.map((d: { txHash: string }) => d.txHash.slice(0, 16) + '…'),
      amountUsd: creditedSumHuman,
      amountToSweep,
    });

    let requiredPolWei: bigint;
    let gasLimit: bigint;
    let maxFeePerGas: bigint;
    let maxPriorityFeePerGas: bigint;
    try {
      const required = await PolygonRpc.getRequiredPolForSweep(
        POLYGON_RPC_URL,
        row.address,
        masterAddress,
        amountToSweep
      );
      requiredPolWei = required.requiredPolWei;
      gasLimit = required.gasLimit;
      maxFeePerGas = required.maxFeePerGas;
      maxPriorityFeePerGas = required.maxPriorityFeePerGas;
    } catch (e) {
      results.push({
        network: row.network,
        address: row.address,
        amount: 0,
        txId: '',
        success: false,
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    const requiredPolPol = Number(ethers.formatEther(requiredPolWei));
    let nativeBalance: number;
    try {
      nativeBalance = await PolygonRpc.getPolygonNativeBalance(POLYGON_RPC_URL, row.address);
    } catch (e) {
      results.push({
        network: row.network,
        address: row.address,
        amount: 0,
        txId: '',
        success: false,
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    const now = new Date();
    const cooldownEnd = row.gasFundedAt ? new Date(row.gasFundedAt.getTime() + POLYGON_FUNDING_COOLDOWN_MS) : null;
    const withinCooldown = cooldownEnd != null && now < cooldownEnd;

    if (nativeBalance < requiredPolPol) {
      if (withinCooldown && row.gasFundingTxId) {
        // Re-check balance: previous funding tx may have just confirmed
        try {
          const recheckBalance = await PolygonRpc.getPolygonNativeBalance(POLYGON_RPC_URL, row.address);
          if (recheckBalance >= requiredPolPol) {
            nativeBalance = recheckBalance;
            console.log('[polygon-sweep] funding landed on recheck addr=' + row.address.slice(0, 12) + '… balance=' + recheckBalance.toFixed(4));
          } else {
            const cooldownMin = Math.ceil((cooldownEnd!.getTime() - now.getTime()) / 60000);
            console.log('[polygon-sweep] funding skipped (cooldown) addr=' + row.address.slice(0, 12) + '… balance=' + recheckBalance.toFixed(4) + ' need=' + requiredPolPol.toFixed(4) + ' cooldown ' + cooldownMin + ' min');
            results.push({
              network: row.network,
              address: row.address,
              amount: 0,
              txId: '',
              success: false,
              error: `Insufficient POL; funding in cooldown (${cooldownMin} min left). Set POLYGON_FUNDING_COOLDOWN_MINUTES=2 to retry sooner.`,
            });
            continue;
          }
        } catch {
          results.push({
            network: row.network,
            address: row.address,
            amount: 0,
            txId: '',
            success: false,
            error: 'Insufficient POL; funding in cooldown',
          });
          continue;
        }
      }
      if (nativeBalance < requiredPolPol) {
        if (fundLimitReached) {
          results.push({
            network: row.network,
            address: row.address,
            amount: 0,
            txId: '',
            success: false,
            error: 'POL fund limit per hour reached',
          });
          continue;
        }
        const fundAmountPol = requiredPolPol - nativeBalance;
        try {
          const fundingTxId = await PolygonRpc.sendPolygonNative(
          POLYGON_RPC_URL,
          masterPriv,
          row.address,
          fundAmountPol
        );
        await prisma.walletAddress.update({
          where: { id: row.id },
          data: { gasFundingTxId: fundingTxId, gasFundedAt: now },
        });
        console.log('[polygon-sweep] funded ' + fundAmountPol.toFixed(4) + ' POL (required ' + requiredPolPol.toFixed(4) + ') addr=' + row.address.slice(0, 12) + '… tx=' + fundingTxId.slice(0, 18) + '…');
        nativeBalance = await PolygonRpc.getPolygonNativeBalance(POLYGON_RPC_URL, row.address);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[polygon-sweep] funding failed addr=' + row.address.slice(0, 12) + '…', msg);
        results.push({
          network: row.network,
          address: row.address,
          amount: 0,
          txId: '',
          success: false,
          error: 'Funding failed: ' + msg,
        });
        continue;
      }
      }
    }

    if (nativeBalance < requiredPolPol) {
      results.push({
        network: row.network,
        address: row.address,
        amount: 0,
        txId: '',
        success: false,
        error: 'Insufficient POL after funding',
      });
      continue;
    }

    try {
      const sweepTxId = await PolygonRpc.sendPolygonUsdt(
        POLYGON_RPC_URL,
        depositPrivRaw,
        masterAddress,
        amountToSweep,
        { gasLimit, maxFeePerGas, maxPriorityFeePerGas }
      );
      const sweptAt = new Date();
      await prisma.deposit.updateMany({
        where: {
          network: 'MATIC',
          depositAddress: row.address,
          status: 'CREDITED',
        },
        data: { status: 'SWEPT', sweepTxId: sweepTxId, sweptAt },
      });
      sweptCount++;
      console.log('[polygon-sweep] sweep success', {
        addr: row.address.slice(0, 12) + '…',
        usdt: amountToSweep.toFixed(2),
        tx: sweepTxId.slice(0, 18) + '…',
        depositIds: creditedDeposits.map((d: { id: string }) => d.id),
      });
      results.push({ network: row.network, address: row.address, amount: amountToSweep, txId: sweepTxId, success: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[polygon-sweep] sweep failed addr=' + row.address.slice(0, 12) + '…', msg, 'USDT balance=', onChainBalance, 'POL balance=', nativeBalance);
      results.push({
        network: row.network,
        address: row.address,
        amount: amountToSweep,
        txId: '',
        success: false,
        error: msg,
      });
    }
  }

  return { sweptCount, results };
}
