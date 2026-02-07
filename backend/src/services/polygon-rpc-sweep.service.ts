/**
 * Polygon on-chain sweep: POL + ERC-20 (USDT or USDC) via RPC only.
 * Token contract = POLYGON_DEPOSIT_TOKEN_CONTRACT (same as detector).
 */

import { ethers } from 'ethers';

const USDT_POLYGON = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F';
const USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const POLYGON_TOKEN_CONTRACT = (process.env.POLYGON_DEPOSIT_TOKEN_CONTRACT || USDT_POLYGON).trim();
const POLYGON_TOKEN_0X = POLYGON_TOKEN_CONTRACT.startsWith('0x') ? POLYGON_TOKEN_CONTRACT : '0x' + POLYGON_TOKEN_CONTRACT;
const ERC20_DECIMALS = 6;
const ERC20_IFACE = new ethers.Interface([
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

async function rpc<T = string>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method}: ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result as T;
}

/** POL balance in POL units. */
export async function getPolygonNativeBalance(rpcUrl: string, address: string): Promise<number> {
  const hex = await rpc<string>(rpcUrl, 'eth_getBalance', [address, 'latest']);
  return Number(ethers.formatEther(BigInt(hex)));
}

/** ERC-20 (USDT/USDC) balance in human units. Uses POLYGON_DEPOSIT_TOKEN_CONTRACT. */
export async function getPolygonUsdtBalance(rpcUrl: string, address: string): Promise<number> {
  const data = ERC20_IFACE.encodeFunctionData('balanceOf', [address]);
  const hex = await rpc<string>(rpcUrl, 'eth_call', [
    { to: POLYGON_TOKEN_0X, data },
    'latest',
  ]);
  const raw = BigInt(hex);
  return Number(raw) / 10 ** ERC20_DECIMALS;
}

async function getGasPrice(rpcUrl: string): Promise<bigint> {
  const hex = await rpc<string>(rpcUrl, 'eth_gasPrice', []);
  const n = BigInt(hex);
  return n > 0n ? n : 50n * 10n ** 9n;
}

/** EIP-1559 fee params for Polygon. baseFee from block, maxFeePerGas >= baseFee*2 + priority. */
async function getEip1559Fees(rpcUrl: string): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const block = await rpc<{ baseFeePerGas?: string }>(rpcUrl, 'eth_getBlockByNumber', ['latest', false]);
  const baseFeeHex = block?.baseFeePerGas ?? '0x0';
  const baseFee = BigInt(baseFeeHex);
  const priority = 30n * 10n ** 9n; // 30 Gwei tip
  const maxFeePerGas = baseFee * 2n + priority;
  return { maxFeePerGas, maxPriorityFeePerGas: priority };
}

const GAS_BUFFER_MULTIPLIER = 1.2;

/** Estimate gas for ERC-20 transfer. Uses POLYGON_DEPOSIT_TOKEN_CONTRACT. */
export async function estimateUsdtTransferGas(
  rpcUrl: string,
  fromAddress: string,
  toAddress: string,
  amountHuman: number
): Promise<bigint> {
  const data = ERC20_IFACE.encodeFunctionData('transfer', [
    toAddress,
    BigInt(Math.round(amountHuman * 10 ** ERC20_DECIMALS)),
  ]);
  const hex = await rpc<string>(rpcUrl, 'eth_estimateGas', [
    { from: fromAddress, to: POLYGON_TOKEN_0X, data, value: '0x0' },
  ]);
  const gas = BigInt(hex);
  return gas > 0n ? gas : 80_000n;
}

/** Required POL for sweep = gasLimit * maxFeePerGas (EIP-1559). Used to fund deposit before ERC20. */
export async function getRequiredPolForSweep(
  rpcUrl: string,
  fromAddress: string,
  toAddress: string,
  amountHuman: number
): Promise<{ requiredPolWei: bigint; gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const [gasLimit, fees] = await Promise.all([
    estimateUsdtTransferGas(rpcUrl, fromAddress, toAddress, amountHuman),
    getEip1559Fees(rpcUrl),
  ]);
  const gasLimitWithBuffer = BigInt(Math.ceil(Number(gasLimit) * GAS_BUFFER_MULTIPLIER));
  const requiredPolWei = gasLimitWithBuffer * fees.maxFeePerGas;
  return {
    requiredPolWei,
    gasLimit: gasLimitWithBuffer,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  };
}

/** Get transaction count for address. Use "pending" to include in-mempool txs (avoids replacement underpriced). */
async function getNonce(rpcUrl: string, address: string, blockTag: 'latest' | 'pending' = 'pending'): Promise<number> {
  const hex = await rpc<string>(rpcUrl, 'eth_getTransactionCount', [address, blockTag]);
  return parseInt(hex, 16);
}

async function sendRawTransaction(rpcUrl: string, signedHex: string): Promise<string> {
  return rpc<string>(rpcUrl, 'eth_sendRawTransaction', [signedHex]);
}

function isRetryableSendError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();
  return (
    lower.includes('underpriced') ||
    lower.includes('replacement transaction') ||
    lower.includes('already known') ||
    lower.includes('nonce too low')
  );
}

const FEE_BUMP_PERCENT = 25;
const MAX_SEND_ATTEMPTS = 5;
const RETRY_DELAY_MS = 2000;

type ReceiptStatus = { blockNumber: string; status: string };
async function waitReceipt(rpcUrl: string, txHash: string, maxWaitMs = 120_000): Promise<ReceiptStatus> {
  const start = Date.now();
  const hexHash = txHash.startsWith('0x') ? txHash : '0x' + txHash;
  while (Date.now() - start < maxWaitMs) {
    const receipt = await rpc<{ blockNumber?: string; status?: string } | null>(rpcUrl, 'eth_getTransactionReceipt', [hexHash]);
    if (receipt?.blockNumber) return { blockNumber: receipt.blockNumber, status: receipt.status ?? '0x1' };
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('Tx not confirmed in time');
}

const GAS_LIMIT_NATIVE = 21000;

/** Send native POL. EIP-1559, nonce pending, retry +25% fee on underpriced/already known/nonce too low (up to 5x, 2s delay). */
export async function sendPolygonNative(
  rpcUrl: string,
  fromPrivateKey: string,
  toAddress: string,
  amountPol: number
): Promise<string> {
  const key = fromPrivateKey.startsWith('0x') ? fromPrivateKey : '0x' + fromPrivateKey;
  const wallet = new ethers.Wallet(key);
  const from = wallet.address;
  const balanceHex = await rpc<string>(rpcUrl, 'eth_getBalance', [from, 'latest']);
  const balanceWei = BigInt(balanceHex);
  let { maxFeePerGas, maxPriorityFeePerGas } = await getEip1559Fees(rpcUrl);
  const gasCost = BigInt(GAS_LIMIT_NATIVE) * maxFeePerGas;
  const requestedWei = ethers.parseEther(amountPol.toString());
  const valueWei = requestedWei <= balanceWei - gasCost ? requestedWei : balanceWei > gasCost ? balanceWei - gasCost : 0n;
  if (valueWei <= 0n) {
    throw new Error(
      `Master wallet insufficient: balance ${ethers.formatEther(balanceWei)} POL, need ${ethers.formatEther(requestedWei)} + gas ~${ethers.formatEther(gasCost)} POL`
    );
  }
  const nonce = await getNonce(rpcUrl, from, 'pending');
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    const tx: ethers.TransactionLike = {
      type: 2,
      to: toAddress,
      value: valueWei,
      gasLimit: GAS_LIMIT_NATIVE,
      maxFeePerGas,
      maxPriorityFeePerGas,
      nonce,
      chainId: 137,
    };
    const signed = await wallet.signTransaction(tx);
    try {
      const hash = await sendRawTransaction(rpcUrl, signed);
      const receipt = await waitReceipt(rpcUrl, hash);
      console.log('[polygon-funding] sent', { nonce, maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: maxPriorityFeePerGas.toString(), txHash: hash.slice(0, 18) + '…', block: receipt.blockNumber, status: receipt.status });
      return hash.startsWith('0x') ? hash : '0x' + hash;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (attempt < MAX_SEND_ATTEMPTS && isRetryableSendError(e)) {
        maxFeePerGas = (maxFeePerGas * BigInt(100 + FEE_BUMP_PERCENT)) / 100n;
        maxPriorityFeePerGas = (maxPriorityFeePerGas * BigInt(100 + FEE_BUMP_PERCENT)) / 100n;
        console.warn('[polygon-funding] retry', attempt + 1, 'nonce=', nonce, 'maxFeePerGas +' + FEE_BUMP_PERCENT + '%', 'delay', RETRY_DELAY_MS, 'ms');
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      } else {
        throw lastErr;
      }
    }
  }
  throw lastErr ?? new Error('sendPolygonNative failed');
}

/** ERC20 USDT transfer. EIP-1559, retry on underpriced. opts from getRequiredPolForSweep. */
export async function sendPolygonUsdt(
  rpcUrl: string,
  fromPrivateKey: string,
  toAddress: string,
  amountHuman: number,
  opts?: { gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
): Promise<string> {
  const key = fromPrivateKey.startsWith('0x') ? fromPrivateKey : '0x' + fromPrivateKey;
  const wallet = new ethers.Wallet(key);
  const from = wallet.address;
  const data = ERC20_IFACE.encodeFunctionData('transfer', [
    toAddress,
    BigInt(Math.round(amountHuman * 10 ** ERC20_DECIMALS)),
  ]);
  const gasLimit = opts?.gasLimit ?? 100_000n;
  let maxFeePerGas = opts?.maxFeePerGas ?? 0n;
  let maxPriorityFeePerGas = opts?.maxPriorityFeePerGas ?? 0n;
  if (maxFeePerGas === 0n) {
    const fees = await getEip1559Fees(rpcUrl);
    maxFeePerGas = fees.maxFeePerGas;
    maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
  }
  const nonce = await getNonce(rpcUrl, from, 'pending');
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    const tx: ethers.TransactionLike = {
      type: 2,
      to: POLYGON_TOKEN_0X,
      value: 0n,
      data,
      gasLimit: Number(gasLimit),
      maxFeePerGas,
      maxPriorityFeePerGas,
      nonce,
      chainId: 137,
    };
    const signed = await wallet.signTransaction(tx);
    try {
      const hash = await sendRawTransaction(rpcUrl, signed);
      const receipt = await waitReceipt(rpcUrl, hash);
      if (receipt.status === '0x0' || receipt.status === '0x') {
        console.error('[polygon-sweep] usdt tx reverted', { txHash: hash, blockNumber: receipt.blockNumber, status: receipt.status });
        throw new Error(`Sweep tx reverted (status ${receipt.status}). Check Polygonscan for revert reason.`);
      }
      console.log('[polygon-sweep] usdt sent', { nonce, maxFeePerGas: maxFeePerGas.toString(), txHash: hash.slice(0, 18) + '…', block: receipt.blockNumber, status: receipt.status });
      return hash.startsWith('0x') ? hash : '0x' + hash;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (attempt < MAX_SEND_ATTEMPTS && isRetryableSendError(e)) {
        maxFeePerGas = (maxFeePerGas * BigInt(100 + FEE_BUMP_PERCENT)) / 100n;
        maxPriorityFeePerGas = (maxPriorityFeePerGas * BigInt(100 + FEE_BUMP_PERCENT)) / 100n;
        console.warn('[polygon-sweep] usdt retry', attempt + 1, 'nonce=', nonce, 'maxFeePerGas +' + FEE_BUMP_PERCENT + '%');
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      } else {
        throw lastErr;
      }
    }
  }
  throw lastErr ?? new Error('sendPolygonUsdt failed');
}
