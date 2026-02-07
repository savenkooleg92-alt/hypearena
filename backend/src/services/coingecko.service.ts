/**
 * CoinGecko public API (no API key). Used by crypto oracle for price-based markets.
 */

const BASE = 'https://api.coingecko.com/api/v3';

export type CoinId = 'bitcoin' | 'ethereum' | 'solana';

const COIN_IDS: CoinId[] = ['bitcoin', 'ethereum', 'solana'];

export interface SimplePriceResult {
  bitcoin?: { usd: number };
  ethereum?: { usd: number };
  solana?: { usd: number };
}

/** Fetch current USD price for bitcoin, ethereum, solana. */
export async function getSimplePrices(): Promise<SimplePriceResult> {
  const ids = COIN_IDS.join(',');
  const url = `${BASE}/simple/price?ids=${ids}&vs_currencies=usd`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko error: ${res.status}`);
  return res.json() as Promise<SimplePriceResult>;
}

/** Get price for a symbol (btc, eth, sol). Returns null if missing or invalid. */
export function getPriceFromResult(result: SimplePriceResult, symbol: 'btc' | 'eth' | 'sol'): number | null {
  const map: Record<'btc' | 'eth' | 'sol', keyof SimplePriceResult> = {
    btc: 'bitcoin',
    eth: 'ethereum',
    sol: 'solana',
  };
  const coin = result[map[symbol]];
  if (!coin || typeof (coin as { usd?: number }).usd !== 'number') return null;
  return (coin as { usd: number }).usd;
}
