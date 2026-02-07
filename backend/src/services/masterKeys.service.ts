/**
 * Master wallet keys: prefer env MASTER_PRIVATE_KEY_*; otherwise derive from MASTER_MNEMONIC.
 * (1) Solana: keypair for sweeps / SOL funding — derived or env (hex / base58 / JSON array).
 * (2) EVM (Polygon): private key for withdrawals — derived at path m/44'/60'/0'/0/0 or env.
 * (3) TRON: private key — derived at path m/44'/195'/0'/0/0 or env.
 * All env keys remain overrides when set.
 */

import crypto from 'crypto';
import * as bip39 from 'bip39';
import { HDKey } from '@scure/bip32';
import { HDNodeWallet } from 'ethers';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TronWeb: TronWebConstructor } = require('tronweb');

/** Account 1 so master does not collide with user addresses at account 0 (index 0,1,2...). */
const TRON_MASTER_PATH = "m/44'/195'/1'/0/0";
const POLYGON_MASTER_PATH = "m/44'/60'/1'/0/0";
/** Seed for Solana master key (does not collide with user indices 0,1,2,...). */
const SOLANA_MASTER_SEED = 'master';

function getMnemonic(): string {
  const m = process.env.MASTER_MNEMONIC;
  if (!m || !m.trim()) throw new Error('Missing env: MASTER_MNEMONIC');
  return m.trim();
}

// --- Solana ---
// Priority: MASTER_PRIVATE_KEY_SOLANA (or MASTER_PRIVATE_KEY_SOL) when set; mnemonic ONLY when not provided.
// Master address for Solana must always come from env (MASTER_ADDRESS_SOLANA); do not derive.

/** Solana secret key is 64 bytes (32 seed + 32 public). Return as Uint8Array from env or derived. */
function getSolanaSecretKeyBytes(): Uint8Array {
  const raw = process.env.MASTER_PRIVATE_KEY_SOLANA ?? process.env.MASTER_PRIVATE_KEY_SOL;
  if (raw) return parseSolanaPrivateKeyToBytes(raw);

  const mnemonic = getMnemonic();
  const seed = crypto
    .createHash('sha256')
    .update(`${mnemonic}|solana|${SOLANA_MASTER_SEED}`, 'utf8')
    .digest();
  const keypair = Keypair.fromSeed(seed);
  return keypair.secretKey;
}

/**
 * Parse MASTER_PRIVATE_KEY_SOLANA from any supported format to 64-byte secret key.
 * Accepted formats:
 * - Hex: "0x" + 128 hex chars (64 bytes).
 * - Base58: Solana standard (e.g. Phantom export).
 * - JSON array: [1,2,...,64] (e.g. Solana CLI / Trust Wallet export).
 */
export function parseSolanaPrivateKeyToBytes(input: string): Uint8Array {
  const s = input.trim();
  if (s.startsWith('0x')) {
    const hex = s.slice(2);
    if (hex.length !== 128 || !/^[0-9a-fA-F]+$/.test(hex))
      throw new Error('MASTER_PRIVATE_KEY_SOLANA: hex must be 0x + 128 hex chars');
    return new Uint8Array(Buffer.from(hex, 'hex'));
  }
  if (s.startsWith('[')) {
    const arr = JSON.parse(s) as number[];
    if (!Array.isArray(arr) || arr.length !== 64)
      throw new Error('MASTER_PRIVATE_KEY_SOLANA: JSON array must have 64 numbers');
    return new Uint8Array(arr);
  }
  // Base58 (Solana standard)
  const decoded = bs58.decode(s);
  if (decoded.length !== 64)
    throw new Error('MASTER_PRIVATE_KEY_SOLANA: base58 must decode to 64 bytes');
  return new Uint8Array(decoded);
}

/**
 * Get Solana master private key in the format expected when calling Tatum sendNative(SOLANA, ...).
 * Tatum expects base58. Returns base58 string (or hex with 0x for backward compat; caller may normalize).
 */
export function getMasterPrivateKeySolana(): string {
  const bytes = getSolanaSecretKeyBytes();
  return bs58.encode(bytes);
}

/** Get Solana master secret as hex (0x + 128 chars). Useful for local Keypair. */
export function getMasterPrivateKeySolanaHex(): string {
  const raw = process.env.MASTER_PRIVATE_KEY_SOLANA ?? process.env.MASTER_PRIVATE_KEY_SOL;
  if (raw) {
    const bytes = parseSolanaPrivateKeyToBytes(raw);
    return '0x' + Buffer.from(bytes).toString('hex');
  }
  const mnemonic = getMnemonic();
  const seed = crypto
    .createHash('sha256')
    .update(`${mnemonic}|solana|${SOLANA_MASTER_SEED}`, 'utf8')
    .digest();
  const keypair = Keypair.fromSeed(seed);
  return '0x' + Buffer.from(keypair.secretKey).toString('hex');
}

/** Get Solana master public address (for setting MASTER_ADDRESS_SOLANA when using mnemonic-only). */
export function getMasterAddressSolana(): string {
  const bytes = getSolanaSecretKeyBytes();
  const keypair = Keypair.fromSecretKey(bytes);
  return keypair.publicKey.toBase58();
}

/** Get Solana master Keypair (for signing txs via RPC, e.g. funding without Tatum). */
export function getMasterKeypairSolana(): Keypair {
  return Keypair.fromSecretKey(getSolanaSecretKeyBytes());
}

// --- Polygon (EVM) ---

/** Get Polygon master private key (hex, no 0x prefix for Tatum compatibility). */
export function getMasterPrivateKeyPolygon(): string {
  const raw = process.env.MASTER_PRIVATE_KEY_POLYGON;
  if (raw) {
    const s = raw.trim();
    return s.startsWith('0x') ? s.slice(2) : s;
  }
  const mnemonic = getMnemonic();
  const node = HDNodeWallet.fromPhrase(mnemonic, POLYGON_MASTER_PATH);
  const pk = node.privateKey;
  return pk.startsWith('0x') ? pk.slice(2) : pk;
}

// --- TRON ---

/** Get TRON master private key (hex). */
export function getMasterPrivateKeyTron(): string {
  const raw = process.env.MASTER_PRIVATE_KEY_TRON;
  if (raw) {
    const s = raw.trim();
    return s.startsWith('0x') ? s.slice(2) : s;
  }
  const mnemonic = getMnemonic();
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const hd = HDKey.fromMasterSeed(seed);
  const child = hd.derive(TRON_MASTER_PATH);
  if (!child.privateKey) throw new Error('TRON master derivation: no private key');
  return Buffer.from(child.privateKey).toString('hex');
}

/** Get TRON master address (for validation / display). */
export function getMasterAddressTron(): string {
  const tronWeb = new TronWebConstructor({ fullHost: 'https://api.trongrid.io' });
  return tronWeb.address.fromPrivateKey(getMasterPrivateKeyTron());
}
