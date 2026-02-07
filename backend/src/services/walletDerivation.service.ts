/**
 * Derive deposit addresses from MASTER_MNEMONIC (BIP39/BIP44).
 * No Tatum dependency for address generation; use Tatum only for balance/sweep.
 * Networks: TRON (USDT), MATIC/Polygon (USDT), SOL (native SOL / USDC).
 */

import crypto from 'crypto';
import * as bip39 from 'bip39';
import { HDKey } from '@scure/bip32';
import { HDNodeWallet } from 'ethers';
import { Keypair } from '@solana/web3.js';
// tronweb exports { TronWeb } (constructor); default is an object. Use named export.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TronWeb: TronWebConstructor } = require('tronweb');

const TRON_PATH_PREFIX = "m/44'/195'/0'/0/";
const POLYGON_PATH_PREFIX = "m/44'/60'/0'/0/";

export type Network = 'TRON' | 'MATIC' | 'SOL';

function getMnemonic(): string {
  const m = process.env.MASTER_MNEMONIC;
  if (!m || !m.trim()) throw new Error('Missing env: MASTER_MNEMONIC');
  return m.trim();
}

/** Derive private key (hex) and address for TRON at index (BIP44 path 195). */
function deriveTron(index: number): { address: string; privateKey: string } {
  const mnemonic = getMnemonic();
  const path = TRON_PATH_PREFIX + index;
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const hd = HDKey.fromMasterSeed(seed);
  const child = hd.derive(path);
  if (!child.privateKey) throw new Error('Tron derivation: no private key');
  const privateKeyHex = Buffer.from(child.privateKey).toString('hex');
  const tronWeb = new TronWebConstructor({ fullHost: 'https://api.trongrid.io' });
  const address = tronWeb.address.fromPrivateKey(privateKeyHex);
  return { address, privateKey: privateKeyHex };
}

/** Derive private key and address for Polygon (EVM) at index (BIP44 path 60). */
function derivePolygon(index: number): { address: string; privateKey: string } {
  const mnemonic = getMnemonic();
  const path = POLYGON_PATH_PREFIX + index;
  const node = HDNodeWallet.fromPhrase(mnemonic, path);
  return {
    address: node.address,
    privateKey: node.privateKey.startsWith('0x') ? node.privateKey.slice(2) : node.privateKey,
  };
}

/** Deterministic Solana keypair from mnemonic + index (SHA256 seed; no ed25519 HD dep). */
function deriveSolana(index: number): { address: string; privateKey: string } {
  const mnemonic = getMnemonic();
  const seed = crypto.createHash('sha256').update(`${mnemonic}|solana|${index}`, 'utf8').digest();
  const keypair = Keypair.fromSeed(seed);
  const privateKeyHex = Buffer.from(keypair.secretKey).toString('hex');
  return {
    address: keypair.publicKey.toBase58(),
    privateKey: privateKeyHex,
  };
}

/** Public: derive address only (for storage). Private key is re-derived when needed for sweep. */
export function deriveAddress(network: Network, derivationIndex: number): string {
  if (network === 'TRON') return deriveTron(derivationIndex).address;
  if (network === 'MATIC') return derivePolygon(derivationIndex).address;
  if (network === 'SOL') return deriveSolana(derivationIndex).address;
  throw new Error(`Unsupported network: ${network}`);
}

/** Derive private key for sweep (same index as stored derivationIndex). */
export function derivePrivateKey(network: Network, derivationIndex: number): string {
  if (network === 'TRON') return deriveTron(derivationIndex).privateKey;
  if (network === 'MATIC') return derivePolygon(derivationIndex).privateKey;
  if (network === 'SOL') return deriveSolana(derivationIndex).privateKey;
  throw new Error(`Unsupported network: ${network}`);
}
