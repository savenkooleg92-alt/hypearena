/**
 * Tatum integration: TRON (USDT), Solana (USDC), Polygon (USDT).
 * IMPORTANT:
 * - Inbound deposits: we ONLY read token balances on deposit addresses.
 * - Outbound payouts/sweeps: optional. In MVP you can keep them disabled.
 */

import 'dotenv/config';

const TATUM_BASE = 'https://api.tatum.io/v3';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function getApiKey(): string {
  return requireEnv('TATUM_API_KEY');
}


export const CHAINS = {
  TRON: 'TRON',
  SOLANA: 'SOL',
  POLYGON: 'MATIC',
} as const;

export type Chain = (typeof CHAINS)[keyof typeof CHAINS];

// Stablecoin contracts (mainnet)
export const TOKEN_CONTRACTS: Record<Chain, string> = {
  [CHAINS.TRON]: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', // USDT TRC20
  [CHAINS.SOLANA]: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC SPL
  [CHAINS.POLYGON]: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', // USDT Polygon (ERC20); PolygonScan may show as "USDT0"
};

export const TOKEN_DECIMALS: Record<Chain, number> = {
  [CHAINS.TRON]: 6,
  [CHAINS.SOLANA]: 6,
  [CHAINS.POLYGON]: 6,
};

/** Tatum: Polygon USDT uses currency "USDT" + chain "MATIC" (not USDT_MATIC). */

function toFixedAmount(amount: number, chain: Chain): string {
  const d = TOKEN_DECIMALS[chain] ?? 6;
  // we keep it simple: Tatum accepts string decimals
  return amount.toFixed(d);
}

async function tatumRequest<T>(
  endpoint: string,
  options: RequestInit & { jsonBody?: unknown } = {}
): Promise<T> {
  const { jsonBody, ...rest } = options;
  if (jsonBody != null && endpoint.includes('token/transaction')) {
    const safe = typeof jsonBody === 'object' && jsonBody !== null && 'fromPrivateKey' in jsonBody
      ? { ...jsonBody, fromPrivateKey: '[REDACTED]' }
      : jsonBody;
    console.log('[tatum] POST body (outgoing)', JSON.stringify(safe).slice(0, 500));
  }

  const res = await fetch(`${TATUM_BASE}${endpoint}`, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': getApiKey(),
      ...(rest.headers || {}),
    },
    ...(jsonBody !== undefined ? { body: JSON.stringify(jsonBody) } : {}),
  });

  if (!res.ok) {
    const rawBody = await res.text();
    const maybe: Record<string, unknown> = (() => {
      try {
        return JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        return {};
      }
    })();
    const msg =
      (maybe?.message as string) ?? (maybe?.error as string) ?? (maybe?.data as { message?: string })?.message ?? `Tatum API error: ${res.status} ${res.statusText}`;
    const detail = maybe?.data != null ? ` | data: ${JSON.stringify(maybe.data)}` : '';
    const err = new Error(String(msg) + detail);
    console.error('[tatum] error response', {
      status: res.status,
      endpoint,
      message: msg,
      data: maybe?.data,
      fullBody: rawBody?.slice(0, 1000),
    });
    throw err;
  }

  return (await res.json()) as T;
}

/**
 * Generate / return a deposit address.
 * We prefer deterministic derivation (derivationIndex) so later we can sweep reliably.
 *
 * TRON:
 *  - GET /tron/wallet -> { xpub }
 *  - GET /tron/address/{xpub}/{index} -> { address }
 *
 * POLYGON:
 *  - GET /polygon/wallet -> { xpub } or { address }
 *  - GET /polygon/address/{xpub}/{index} -> { address }
 *
 * SOL:
 *  - GET /solana/wallet -> often returns { address }
 * Note: For Solana, if you need derivation, we’ll add it later (depends on what Tatum returns on your plan).
 */
export async function generateWallet(
  chain: Chain,
  derivationIndex = 0
): Promise<{ address: string; derivationIndex: number }> {
  if (chain === CHAINS.TRON) {
    const w = await tatumRequest<{ xpub?: string }>('/tron/wallet', { method: 'GET' });
    if (!w.xpub) throw new Error('Tatum TRON wallet: missing xpub');
    const a = await tatumRequest<{ address?: string }>(
      `/tron/address/${encodeURIComponent(w.xpub)}/${derivationIndex}`,
      { method: 'GET' }
    );
    if (!a.address) throw new Error('Tatum TRON address: missing address');
    return { address: a.address, derivationIndex };
  }

  if (chain === CHAINS.POLYGON) {
    const w = await tatumRequest<{ address?: string; xpub?: string }>('/polygon/wallet', {
      method: 'GET',
    });

    if (w.address) {
      return { address: w.address, derivationIndex };
    }

    if (!w.xpub) throw new Error('Tatum Polygon wallet: missing xpub');
    const a = await tatumRequest<{ address?: string }>(
      `/polygon/address/${encodeURIComponent(w.xpub)}/${derivationIndex}`,
      { method: 'GET' }
    );
    if (!a.address) throw new Error('Tatum Polygon address: missing address');
    return { address: a.address, derivationIndex };
  }

  if (chain === CHAINS.SOLANA) {
    const w = await tatumRequest<{ address?: string }>('/solana/wallet', { method: 'GET' });
    if (!w.address) throw new Error('Tatum Solana wallet: missing address');
    return { address: w.address, derivationIndex };
  }

  throw new Error(`Unsupported chain: ${chain}`);
}

/**
 * Read token balance at a deposit address (in token units, returned as string).
 * This is used for inbound deposit crediting (no movement of funds).
 */
export async function getDepositTokenBalance(chain: Chain, address: string): Promise<string> {
  const tokenAddress = TOKEN_CONTRACTS[chain];

  if (chain === CHAINS.TRON) {
    // TRON TRC20 balance endpoint
    const r = await tatumRequest<{ balance?: string }>(
      `/tron/trc20/account/balance/${encodeURIComponent(address)}/${encodeURIComponent(
        tokenAddress
      )}`,
      { method: 'GET' }
    ).catch(() => ({ balance: '0' }));
    return r.balance ?? '0';
  }

  // Polygon + Solana use generic token balance endpoint. For EVM (Polygon) use lowercase address.
  const addr = chain === CHAINS.POLYGON && address.startsWith('0x') ? address.toLowerCase() : address;
  const r = await tatumRequest<{ balance?: string }>(
    `/blockchain/token/balance/${encodeURIComponent(chain)}/${encodeURIComponent(
      tokenAddress
    )}/${encodeURIComponent(addr)}`,
    { method: 'GET' }
  ).catch(() => ({ balance: '0' }));

  return r.balance ?? '0';
}

/**
 * OUTBOUND (optional): Send payout from MASTER wallet to user wallet.
 * NOTE: In your current MVP you can keep destinationAddress undefined and we skip on-chain tx.
 * Master key: prefer env MASTER_PRIVATE_KEY_*; else derive from MASTER_MNEMONIC (no Tatum call).
 * Solana: MASTER_PRIVATE_KEY_SOLANA (or MASTER_PRIVATE_KEY_SOL) is used when set; mnemonic ONLY if not provided.
 */
const masterPrivKeyCache: Partial<Record<Chain, string>> = {};

export async function getMasterPrivateKey(chain: Chain): Promise<string> {
  const envKey =
    chain === CHAINS.TRON
      ? 'MASTER_PRIVATE_KEY_TRON'
      : chain === CHAINS.SOLANA
        ? 'MASTER_PRIVATE_KEY_SOLANA'
        : 'MASTER_PRIVATE_KEY_POLYGON';

  // Solana: check both MASTER_PRIVATE_KEY_SOLANA and MASTER_PRIVATE_KEY_SOL; normalize to base58 (Phantom exports JSON array; Tatum expects base58).
  if (chain === CHAINS.SOLANA) {
    const solPriv = process.env.MASTER_PRIVATE_KEY_SOLANA ?? process.env.MASTER_PRIVATE_KEY_SOL;
    if (solPriv) {
      const { getMasterPrivateKeySolana } = await import('./masterKeys.service');
      return getMasterPrivateKeySolana();
    }
  } else if (process.env[envKey]) {
    return process.env[envKey] as string;
  }

  if (masterPrivKeyCache[chain]) return masterPrivKeyCache[chain]!;

  if (!process.env.MASTER_MNEMONIC) throw new Error(`Missing env: MASTER_MNEMONIC (or set ${envKey})`);

  const { getMasterPrivateKeySolana, getMasterPrivateKeyPolygon, getMasterPrivateKeyTron } =
    await import('./masterKeys.service');
  const key =
    chain === CHAINS.SOLANA
      ? getMasterPrivateKeySolana()
      : chain === CHAINS.POLYGON
        ? getMasterPrivateKeyPolygon()
        : getMasterPrivateKeyTron();
  masterPrivKeyCache[chain] = key;
  return key;
}

export interface PayoutParams {
  userId: string;
  amount: number;
  destinationAddress?: string; // if omitted -> no on-chain payout
  chain?: Chain;
  reference?: string;
}

export interface TatumTxResult {
  txId: string;
  chain: Chain;
  success: boolean;
  error?: string;
}

export async function sendPayout(params: PayoutParams): Promise<TatumTxResult> {
  const chain = params.chain ?? CHAINS.TRON;

  if (!params.destinationAddress) {
    // MVP: app-balance only
    return { txId: '', chain, success: true };
  }

  if (params.amount <= 0 || Number.isNaN(params.amount)) {
    return { txId: '', chain, success: false, error: 'Invalid amount' };
  }

  try {
    const fromPrivateKey = await getMasterPrivateKey(chain);
    const contractAddress = TOKEN_CONTRACTS[chain];

    if (chain === CHAINS.TRON) {
      const r = await tatumRequest<{ txId?: string }>('/tron/trc20/transaction', {
        method: 'POST',
        jsonBody: {
          fromPrivateKey,
          to: params.destinationAddress,
          tokenAddress: contractAddress,
          amount: toFixedAmount(params.amount, chain),
        },
      });
      return { txId: r.txId ?? '', chain, success: !!r.txId };
    }

    // Polygon + Solana: generic token tx endpoint. Solana requires "from" (sender address, base58).
    const fromAddress =
      chain === CHAINS.SOLANA
        ? (process.env.MASTER_ADDRESS_SOL ?? process.env.MASTER_ADDRESS_SOLANA ?? '')
        : undefined;
    if (chain === CHAINS.SOLANA && !fromAddress) {
      return { txId: '', chain, success: false, error: 'Missing MASTER_ADDRESS_SOLANA for Solana payout' };
    }
    const jsonBody: Record<string, unknown> = {
      chain,
      fromPrivateKey,
      to: params.destinationAddress,
      contractAddress,
      amount: toFixedAmount(params.amount, chain),
      digits: TOKEN_DECIMALS[chain],
    };
    if (fromAddress) jsonBody.from = fromAddress;

    const r = await tatumRequest<{ txId?: string }>('/blockchain/token/transaction', {
      method: 'POST',
      jsonBody,
    });

    return { txId: r.txId ?? '', chain, success: !!r.txId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { txId: '', chain, success: false, error: msg };
  }
}

// --- Deterministic derivation (MASTER_MNEMONIC + index). Do not log mnemonic or keys. ---

function getMnemonic(): string {
  const m = process.env.MASTER_MNEMONIC;
  if (!m) throw new Error('Missing env: MASTER_MNEMONIC');
  return m;
}

/**
 * Derive private key for a given derivation index from MASTER_MNEMONIC.
 * TRON: POST /tron/wallet/priv { mnemonic, index }
 * MATIC: POST /polygon/wallet/priv { mnemonic, index }
 * SOL: POST /solana/wallet/priv { mnemonic, index }
 */
export async function derivePrivateKeyFromMaster(
  chain: Chain,
  derivationIndex: number
): Promise<string> {
  if (chain !== CHAINS.TRON && chain !== CHAINS.POLYGON && chain !== CHAINS.SOLANA) {
    throw new Error(`derivePrivateKeyFromMaster only supports TRON, MATIC, SOL; got ${chain}`);
  }
  const mnemonic = getMnemonic();
  const path =
    chain === CHAINS.TRON ? '/tron/wallet/priv' : chain === CHAINS.SOLANA ? '/solana/wallet/priv' : '/polygon/wallet/priv';
  const r = await tatumRequest<{ key?: string; privateKey?: string }>(path, {
    method: 'POST',
    jsonBody: { mnemonic, index: derivationIndex },
  });
  const privKey = r.key ?? r.privateKey;
  if (!privKey) throw new Error(`Tatum: no key for ${chain} index ${derivationIndex}`);
  return privKey;
}

/**
 * Derive address from a private key.
 * TRON: POST /tron/address { privateKey }
 * MATIC: POST /polygon/address { privateKey }
 * SOL: POST /solana/address { privateKey }
 */
export async function deriveAddressFromPrivateKey(
  chain: Chain,
  privateKey: string
): Promise<string> {
  if (chain !== CHAINS.TRON && chain !== CHAINS.POLYGON && chain !== CHAINS.SOLANA) {
    throw new Error(`deriveAddressFromPrivateKey only supports TRON, MATIC, SOL; got ${chain}`);
  }
  const path =
    chain === CHAINS.TRON ? '/tron/address' : chain === CHAINS.SOLANA ? '/solana/address' : '/polygon/address';
  const r = await tatumRequest<{ address?: string }>(path, {
    method: 'POST',
    jsonBody: { privateKey },
  });
  if (!r.address) throw new Error(`Tatum: no address for ${chain}`);
  return r.address;
}

/**
 * Master wallet address (sweep destination). Prefer env MASTER_ADDRESS_*.
 * Solana: MUST use MASTER_ADDRESS_SOLANA (or MASTER_ADDRESS_SOL) from env only; no derivation.
 */
export async function getMasterAddress(chain: Chain): Promise<string> {
  if (chain === CHAINS.SOLANA) {
    const addr = process.env.MASTER_ADDRESS_SOL ?? process.env.MASTER_ADDRESS_SOLANA;
    if (!addr) throw new Error('Missing env: MASTER_ADDRESS_SOL or MASTER_ADDRESS_SOLANA');
    return addr;
  }
  const envKey =
    chain === CHAINS.TRON ? 'MASTER_ADDRESS_TRON' : 'MASTER_ADDRESS_POLYGON';
  if (process.env[envKey]) return process.env[envKey] as string;
  const priv = await getMasterPrivateKey(chain);
  return deriveAddressFromPrivateKey(chain, priv);
}

/**
 * Native balance: TRX (TRON) in TRX units, MATIC in MATIC units.
 */
export async function getNativeBalance(chain: Chain, address: string): Promise<number> {
  if (chain === CHAINS.TRON) {
    const r = await tatumRequest<{ balance?: number }>(
      `/tron/account/${encodeURIComponent(address)}`,
      { method: 'GET' }
    ).catch(() => ({ balance: 0 }));
    const sun = Number(r.balance ?? 0);
    return sun / 1e6; // sun -> TRX
  }
  if (chain === CHAINS.POLYGON) {
    const r = await tatumRequest<{ balance?: string }>(
      `/polygon/account/balance/${encodeURIComponent(address)}`,
      { method: 'GET' }
    ).catch(() => ({ balance: '0' }));
    return parseFloat(r.balance ?? '0') || 0;
  }
  if (chain === CHAINS.SOLANA) {
    const r = await tatumRequest<{ balance?: string }>(
      `/solana/account/balance/${encodeURIComponent(address)}`,
      { method: 'GET' }
    ).catch(() => ({ balance: '0' }));
    return parseFloat(r.balance ?? '0') || 0; // SOL
  }
  return 0;
}

/**
 * Send native currency from an address (fromPrivateKey) to another (toAddress).
 * TRON: TRX. MATIC: MATIC. Used for ensureGas (top up deposit address).
 * Solana: from MUST be MASTER_ADDRESS_SOLANA, privateKey MUST be MASTER_PRIVATE_KEY_SOLANA (Tatum expects { from, to, amount, privateKey }).
 */
export async function sendNative(
  chain: Chain,
  fromPrivateKey: string,
  toAddress: string,
  amount: number,
  fromAddress?: string
): Promise<string> {
  if (chain === CHAINS.TRON) {
    const sun = Math.floor(amount * 1e6).toString(); // 1 TRX = 1e6 sun
    const r = await tatumRequest<{ txId?: string }>('/tron/transaction', {
      method: 'POST',
      jsonBody: { fromPrivateKey, to: toAddress, amount: sun },
    });
    return r.txId ?? '';
  }
  if (chain === CHAINS.POLYGON) {
    const r = await tatumRequest<{ txId?: string }>('/polygon/transaction', {
      method: 'POST',
      jsonBody: {
        currency: 'MATIC',
        fromPrivateKey,
        to: toAddress,
        amount: amount.toString(),
      },
    });
    return r.txId ?? '';
  }
  if (chain === CHAINS.SOLANA) {
    if (!fromAddress) throw new Error('sendNative(SOLANA) requires fromAddress = MASTER_ADDRESS_SOLANA');
    const r = await tatumRequest<{ txId?: string }>('/solana/transaction', {
      method: 'POST',
      jsonBody: {
        from: fromAddress,
        to: toAddress,
        amount: amount.toString(),
        privateKey: fromPrivateKey,
      },
    });
    return r.txId ?? '';
  }
  throw new Error(`sendNative only supports TRON, MATIC, SOL; got ${chain}`);
}

/**
 * Send USDT from a deposit address (fromPrivateKey) to master (toAddress).
 * amountInTokenUnits: string (raw token units from balance API).
 */
export async function sendTokenFromDeposit(
  chain: Chain,
  fromPrivateKey: string,
  toAddress: string,
  amountInTokenUnits: string
): Promise<string> {
  const tokenAddress = TOKEN_CONTRACTS[chain];
  const decimals = TOKEN_DECIMALS[chain];
  if (chain === CHAINS.TRON) {
    const r = await tatumRequest<{ txId?: string }>('/tron/trc20/transaction', {
      method: 'POST',
      jsonBody: {
        fromPrivateKey,
        to: toAddress,
        tokenAddress,
        amount: amountInTokenUnits,
      },
    });
    return r.txId ?? '';
  }
  if (chain === CHAINS.POLYGON) {
    // Tatum validation allows currency: "USDT_MATIC" (from their error message). Amount human-readable, digits=6.
    const jsonBody = {
      currency: 'USDT_MATIC',
      fromPrivateKey,
      to: toAddress,
      amount: amountInTokenUnits,
      digits: 6,
    };
    console.log('[tatum] Polygon token tx request', {
      currency: jsonBody.currency,
      to: jsonBody.to,
      amount: jsonBody.amount,
      digits: jsonBody.digits,
    });
    const bodyStr = JSON.stringify(jsonBody);
    if (!bodyStr.includes('USDT_MATIC')) {
      console.error('[tatum] BUG: currency USDT_MATIC missing from serialized body', bodyStr.slice(0, 200));
    }
    const r = await tatumRequest<{ txId?: string }>('/blockchain/token/transaction', {
      method: 'POST',
      jsonBody,
    });
    return r.txId ?? '';
  }
  throw new Error(`sendTokenFromDeposit only supports TRON and MATIC, got ${chain}`);
}

/**
 * OUTBOUND (optional): Sweep placeholder.
 * We will implement properly once we store derivationIndex and have safe gas checks.
 */
export interface SweepSource {
  custodialAddress: string;
  chain: Chain;
  derivationIndex?: number;
  amount?: string; // token units string
}

export async function sweepToMaster(_params: { sources: SweepSource[] }): Promise<TatumTxResult[]> {
  // Replaced by POST /api/wallet/sweep which uses derivationIndex and ensureGas.
  return _params.sources.map((s) => ({
    txId: '',
    chain: s.chain,
    success: false,
    error: 'Use POST /api/wallet/sweep instead.',
  }));
}

// --- Solana: get signatures and transaction details (via public RPC or Tatum). ---

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

export interface SolanaSignatureInfo {
  signature: string;
  blockTime: number | null;
  err: unknown;
  confirmationStatus?: string;
}

const SOLANA_RPC_429_MAX_RETRIES = 4;
const SOLANA_RPC_429_BASE_MS = 2000;

/** Get transaction signatures for an address (Solana RPC getSignaturesForAddress). Use 'confirmed' to see txs sooner. Retries on 429 with backoff. */
export async function getSolanaSignaturesForAddress(
  address: string,
  limit = 50,
  commitment: 'confirmed' | 'finalized' = 'confirmed'
): Promise<SolanaSignatureInfo[]> {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'getSignaturesForAddress',
    params: [address, { limit, commitment }],
  };
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= SOLANA_RPC_429_MAX_RETRIES; attempt++) {
    const res = await fetch(SOLANA_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 429 && attempt < SOLANA_RPC_429_MAX_RETRIES) {
      const waitMs = SOLANA_RPC_429_BASE_MS * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (!res.ok) {
      lastErr = new Error(`Solana RPC error: ${res.status}`);
      throw lastErr;
    }
    const data = (await res.json()) as { result?: Array<{ signature: string; blockTime: number | null; err: unknown; confirmationStatus?: string }>; error?: { message: string } };
    if (data.error) {
      lastErr = new Error(`Solana RPC: ${data.error.message}`);
      throw lastErr;
    }
    return data.result ?? [];
  }
  throw lastErr ?? new Error('Solana RPC: too many 429 retries');
}

/** Get full transaction by signature (Tatum or RPC). Uses Tatum for consistency. */
export async function getSolanaTransaction(signature: string): Promise<{
  slot?: number;
  blockTime?: number | null;
  meta?: { err: unknown };
  transaction?: { message?: { accountKeys?: string[]; instructions?: unknown[] } };
}> {
  const r = await tatumRequest<{ slot?: number; blockTime?: number | null; meta?: { err: unknown }; transaction?: { message?: { accountKeys?: string[]; instructions?: unknown[] } } }>(
    `/solana/transaction/${encodeURIComponent(signature)}`,
    { method: 'GET' }
  ).catch(() => null);
  if (r) return r;
  // Fallback: Solana RPC getTransaction
  const body = { jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }] };
  const res = await fetch(SOLANA_RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Solana RPC getTransaction error: ${res.status}`);
  const data = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (data.error) throw new Error(`Solana RPC: ${data.error.message}`);
  return (data.result as object) ?? {};
}

/** Parsed instruction shape for SPL token transfer (destination, tokenAmount, optional mint). */
export type SolanaParsedInstr = {
  parsed?: {
    type?: string;
    info?: {
      destination?: string;
      tokenAmount?: { amount?: string; uiAmount?: number; uiAmountString?: string };
      mint?: string;
    };
  };
};

/** Get parsed transaction (for SPL token transfer parsing). Uses RPC getTransaction with jsonParsed. */
export async function getSolanaParsedTransaction(signature: string): Promise<{
  meta?: {
    err?: unknown;
    /** Solana RPC: inner instructions (SPL token transfers often appear here). */
    innerInstructions?: Array<{ index: number; instructions: Array<SolanaParsedInstr> }>;
  };
  transaction?: {
    message?: {
      accountKeys?: Array<{ pubkey: string }>;
      instructions?: Array<SolanaParsedInstr>;
    };
  };
} | null> {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'getTransaction',
    params: [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
  };
  const res = await fetch(SOLANA_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (data.error || data.result == null) return null;
  return data.result as NonNullable<ReturnType<typeof getSolanaParsedTransaction>>;
}

// --- TRON TRC20: config, address normalizer, and events (Trongrid, no Tatum key for read) ---

export const TRONGRID_BASE = process.env.TRONGRID_BASE || 'https://api.trongrid.io';
/** Optional. Set TRONGRID_API_KEY for higher rate limit (avoids 429). Header: TRON-PRO-API-KEY. */
export const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY || process.env.TRON_PRO_API_KEY || '';
/** Official TRC20 USDT mainnet: TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t. Override with TRON_USDT_CONTRACT. */
export const TRON_USDT_CONTRACT = process.env.TRON_USDT_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

export function getTrongridHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (TRONGRID_API_KEY) h['TRON-PRO-API-KEY'] = TRONGRID_API_KEY.trim();
  return h;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TronWeb: TronWebConstructor } = require('tronweb');

let _tronWeb: InstanceType<typeof TronWebConstructor> | null = null;
function getTronWeb(): InstanceType<typeof TronWebConstructor> {
  if (!_tronWeb) _tronWeb = new TronWebConstructor({ fullHost: TRONGRID_BASE });
  return _tronWeb;
}

/** Get TRC20 USDT balance in raw units (6 decimals) via Trongrid triggerconstantcontract. Use when Tatum balance returns 404. */
export async function getTronTrc20BalanceRaw(address: string): Promise<string> {
  const tw = getTronWeb();
  const hexAddr = tw.address.toHex(address);
  const param = hexAddr.length === 42 ? '0'.repeat(24) + hexAddr.slice(2) : '';
  const body = {
    owner_address: address,
    contract_address: TRON_USDT_CONTRACT,
    function_selector: 'balanceOf(address)',
    parameter: param,
    visible: true,
  };
  const res = await fetch(TRONGRID_BASE + '/wallet/triggerconstantcontract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getTrongridHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Trongrid triggerconstantcontract: ' + res.status);
  const data = (await res.json()) as { constant_result?: string[] };
  const hexResult = data.constant_result?.[0];
  if (!hexResult) return '0';
  return String(BigInt('0x' + hexResult));
}

/** Normalize TRON address to base58. Input can be hex (0x... or 41...) or base58. */
export function tronAddressToBase58(hexOrBase58: string): string {
  const s = String(hexOrBase58).trim();
  if (!s) return s;
  if (s.startsWith('T') && s.length >= 33 && s.length <= 35) return s;
  try {
    const tw = getTronWeb();
    const hex = s.startsWith('0x') ? s.slice(2) : s;
    if (hex.length === 40 && /^[0-9a-fA-F]+$/.test(hex)) return tw.address.fromHex('41' + hex);
    if (hex.length === 42 && /^41[0-9a-fA-F]{40}$/.test(hex)) return tw.address.fromHex(hex);
  } catch {
    // fallback: return as-is for unknown format
  }
  return s;
}

export interface TronTrc20Transfer {
  txId: string;
  to: string;   // base58 after normalize
  from: string;
  valueRaw: string;
  blockTimestamp: number;
}

/** Get incoming TRC20 USDT transfers to an address (Trongrid v1). Only confirmed. Address comparison uses base58. */
export async function getTronTrc20TransfersToAddress(
  address: string,
  limit = 200
): Promise<TronTrc20Transfer[]> {
  const url = `${TRONGRID_BASE}/v1/accounts/${encodeURIComponent(address)}/transactions/trc20?contract_address=${TRON_USDT_CONTRACT}&limit=${limit}&only_confirmed=true&order_by=block_timestamp,desc`;
  const res = await fetch(url, { method: 'GET', headers: getTrongridHeaders() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trongrid TRC20 error: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    data?: Array<{
      transaction_id?: string;
      txID?: string;
      to?: string;
      from?: string;
      value?: string;
      block_timestamp?: number;
      [k: string]: unknown;
    }>;
  };
  const list = data.data ?? [];
  const addressBase58 = tronAddressToBase58(address);
  const mapped = list.map((t) => {
    const rawTo = (t as Record<string, unknown>).to ?? (t as Record<string, unknown>).to_address ?? t.to ?? '';
    const rawFrom = (t as Record<string, unknown>).from ?? (t as Record<string, unknown>).from_address ?? t.from ?? '';
    let valueRaw = t.value ?? (t as Record<string, unknown>).value_raw ?? '0';
    if (typeof valueRaw === 'number') valueRaw = String(valueRaw);
    return {
      txId: t.transaction_id ?? t.txID ?? '',
      to: tronAddressToBase58(String(rawTo)),
      from: tronAddressToBase58(String(rawFrom)),
      valueRaw: String(valueRaw).trim(),
      blockTimestamp: t.block_timestamp ?? 0,
    };
  });
  const out = mapped.filter((t) => t.txId && t.to === addressBase58).slice(0, limit);
  if (list.length > 0 && out.length === 0 && mapped.length > 0) {
    const firstM = mapped[0]!;
    const firstL = list[0] as Record<string, unknown> | undefined;
    const rawTo = firstL ? String(firstL.to ?? firstL.to_address ?? '').slice(0, 24) : '';
    console.warn('[tron-usdt] address mismatch: expected to=' + addressBase58.slice(0, 14) + '… got to=' + firstM.to.slice(0, 14) + '… rawTo=' + rawTo + '…');
  }
  return out;
}

/** Transfer event from USDT contract (for event-based scanner). */
export interface TronTrc20TransferEvent {
  txId: string;
  blockTimestamp: number;
  toBase58: string;
  fromBase58: string;
  valueRaw: string;
}

/** Fetch Transfer events from TRC20 contract (Trongrid v1). Events ordered by block_timestamp asc for cursor. */
export async function getTronTrc20TransferEvents(
  minBlockTimestampMs: number,
  limit = 200
): Promise<TronTrc20TransferEvent[]> {
  const url = `${TRONGRID_BASE}/v1/contracts/${encodeURIComponent(TRON_USDT_CONTRACT)}/events?event_name=Transfer&only_confirmed=true&min_block_timestamp=${minBlockTimestampMs}&order_by=block_timestamp,asc&limit=${limit}`;
  const res = await fetch(url, { method: 'GET', headers: getTrongridHeaders() });
  if (!res.ok) throw new Error(`Trongrid events error: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    data?: Array<{
      transaction_id?: string;
      block_timestamp?: number;
      result?: Record<string, unknown> & { to?: string; from?: string; value?: string };
    }>;
  };
  const list = data.data ?? [];
  return list.map((e) => {
    const result = (e.result ?? {}) as Record<string, unknown>;
    const toHex = (result.to ?? result['1'] ?? '') as string;
    const fromHex = (result.from ?? result['0'] ?? '') as string;
    let valueRaw = (result.value ?? result['2'] ?? '0') as string;
    if (typeof valueRaw === 'string' && valueRaw.startsWith('0x')) valueRaw = String(BigInt(valueRaw));
    return {
      txId: e.transaction_id ?? '',
      blockTimestamp: e.block_timestamp ?? 0,
      toBase58: tronAddressToBase58(toHex),
      fromBase58: tronAddressToBase58(fromHex),
      valueRaw: String(valueRaw),
    };
  }).filter((e) => e.txId);
}

// --- Polygon ERC20: token transactions (Tatum) ---

export interface PolygonTokenTx {
  txId: string;
  amount: string; // human-readable or raw; we use amount from response
  to: string;
  from?: string;
  timestamp?: number;
}

/** Get fungible token transactions for an address (Tatum). Returns both in/out; filter by to===address for incoming. */
export async function getPolygonTokenTransactions(
  address: string,
  tokenAddress: string
): Promise<PolygonTokenTx[]> {
  const chain = CHAINS.POLYGON;
  const pageSize = 50;
  const url = `/blockchain/token/transaction/${encodeURIComponent(chain)}/${encodeURIComponent(address)}/${encodeURIComponent(tokenAddress)}?pageSize=${pageSize}`;
  const r = await tatumRequest<{ transactions?: Array<{ txId?: string; amount?: string; to?: string; from?: string; timestamp?: number }> }>(
    url,
    { method: 'GET' }
  ).catch((e) => {
    console.warn('[tatum] getPolygonTokenTransactions failed:', e instanceof Error ? e.message : String(e));
    return { transactions: [] };
  });
  const list = r.transactions ?? [];
  return list
    .filter((t) => t.to && String(t.to).toLowerCase() === address.toLowerCase())
    .map((t) => ({
      txId: t.txId ?? '',
      amount: t.amount ?? '0',
      to: t.to ?? '',
      from: t.from,
      timestamp: t.timestamp,
    }))
    .filter((t) => t.txId);
}
