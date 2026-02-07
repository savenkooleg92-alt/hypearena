/**
 * Manual resolve flow: move OPEN markets to AWAITING_RESULT when endDate has passed.
 * Only non-oracle markets (Politics etc.). Cybersport (pandascore) stays OPEN for the oracle to auto-resolve or move to AWAITING_RESULT on failure.
 */

import prisma from '../utils/prisma';

const CYBERSPORT_ORACLE_SOURCE = 'pandascore';

export async function moveEndedMarketsToAwaitingResult(): Promise<{ moved: number }> {
  const now = new Date();
  const result = await prisma.market.updateMany({
    where: {
      status: 'OPEN',
      endDate: { lte: now },
      OR: [{ oracleSource: null }, { oracleSource: { not: CYBERSPORT_ORACLE_SOURCE } }],
    },
    data: { status: 'AWAITING_RESULT' },
  });
  return { moved: result.count };
}
