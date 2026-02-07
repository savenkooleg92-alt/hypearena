/**
 * Deposit detection + crediting only (TRON/MATIC USDT).
 * - Minimum: TRON (USDT) $20; Polygon (USDT) $1. Below minimum we ignore (do not credit).
 * - SOL native deposits are handled by sol-deposit.service (min $1).
 */

import prisma from '../utils/prisma';
import * as TatumService from './TatumService';

const NETWORK_TO_CHAIN: Record<string, TatumService.Chain> = {
  TRON: TatumService.CHAINS.TRON,
  SOL: TatumService.CHAINS.SOLANA,
  MATIC: TatumService.CHAINS.POLYGON,
};

const MIN_USD_TRON_USDT = 20;
const MIN_USD_POLYGON_USDT = 1;

function networkToChain(network: string): TatumService.Chain | null {
  return NETWORK_TO_CHAIN[network] ?? null;
}

export async function processDeposits(): Promise<{ credited: number; errors: string[] }> {
  const errors: string[] = [];
  let credited = 0;

  const addresses = await prisma.walletAddress.findMany({
    include: { user: { select: { id: true } } },
  });

  for (const wa of addresses) {
    if (wa.network === 'SOL') continue; // SOL native handled by sol-deposit.service
    if (wa.network === 'TRON' || wa.network === 'MATIC') continue; // TRON/MATIC handled by tron-usdt and polygon-usdt deposit services (tx-based)

    const chain = networkToChain(wa.network);
    if (!chain) {
      errors.push(`Unknown network: ${wa.network} for address ${wa.id}`);
      continue;
    }

    let currentBalanceStr: string;
    try {
      currentBalanceStr = await TatumService.getDepositTokenBalance(chain, wa.address);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Balance fetch failed ${wa.network}/${wa.address}: ${msg}`);
      continue;
    }

    const currentBalanceRaw = parseFloat(currentBalanceStr) || 0;
    const lastCredited = wa.lastCreditedBalance ?? 0;
    const deltaRaw = Math.max(0, currentBalanceRaw - lastCredited);
    if (deltaRaw <= 0) continue;

    const decimals = TatumService.TOKEN_DECIMALS[chain];
    const amountToCredit = deltaRaw / Math.pow(10, decimals);
    if (amountToCredit <= 0) continue;

    const minUsd = wa.network === 'TRON' ? MIN_USD_TRON_USDT : MIN_USD_POLYGON_USDT;
    if (amountToCredit < minUsd) {
      await prisma.walletAddress.update({
        where: { id: wa.id },
        data: { lastCreditedBalance: currentBalanceRaw },
      }).catch(() => {});
      continue;
    }

    try {
      await prisma.$transaction([
        prisma.user.update({
          where: { id: wa.userId },
          data: { balance: { increment: amountToCredit } },
        }),
        prisma.transaction.create({
          data: {
            userId: wa.userId,
            type: 'DEPOSIT',
            amount: amountToCredit,
            description: `Deposit ${wa.network} (${wa.address.slice(0, 8)}...)`,
          },
        }),
        prisma.walletAddress.update({
          where: { id: wa.id },
          data: { lastCreditedBalance: currentBalanceRaw },
        }),
      ]);
      credited += 1;
      if (process.env.NODE_ENV === 'development') {
        console.log(`[DepositService] Credited ${amountToCredit} for user ${wa.userId} (${wa.network})`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Credit failed ${wa.userId}/${wa.network}: ${msg}`);
    }
  }

  return { credited, errors };
}
