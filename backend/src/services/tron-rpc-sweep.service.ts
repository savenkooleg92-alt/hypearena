/**
 * TRON sweep: 100% TronGrid + TronWeb. No Tatum.
 * Balance: contract balanceOf() via triggerconstantcontract. TRX: getaccount. Fund: createtransaction + broadcast. Transfer: triggersmartcontract + broadcast.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TronWeb: TronWebConstructor } = require('tronweb');

const TRONGRID_BASE = process.env.TRONGRID_BASE || 'https://api.trongrid.io';
const TRON_USDT_CONTRACT = process.env.TRON_USDT_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY || process.env.TRON_PRO_API_KEY || '';

function getHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (TRONGRID_API_KEY) h['TRON-PRO-API-KEY'] = TRONGRID_API_KEY.trim();
  return h;
}

let _tronWeb: InstanceType<typeof TronWebConstructor> | null = null;
function getTronWeb(): InstanceType<typeof TronWebConstructor> {
  if (!_tronWeb) _tronWeb = new TronWebConstructor({ fullHost: TRONGRID_BASE });
  return _tronWeb;
}

/** USDT balance in raw units (6 decimals) via Trongrid triggerconstantcontract — balanceOf(depositAddress). No Tatum. */
function getTronTrc20BalanceRaw(address: string): Promise<string> {
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
  return fetch(TRONGRID_BASE + '/wallet/triggerconstantcontract', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  })
    .then((res) => {
      if (!res.ok) throw new Error('Trongrid triggerconstantcontract: ' + res.status);
      return res.json();
    })
    .then((value: unknown) => {
      const data = value as { constant_result?: string[] };
      const hexResult = data.constant_result?.[0];
      if (!hexResult) return '0';
      return String(BigInt('0x' + hexResult));
    });
}

/** TRX balance in TRX (not sun). */
export async function getTronTrxBalance(address: string): Promise<number> {
  const res = await fetch(TRONGRID_BASE + '/wallet/getaccount', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ address: address, visible: true }),
  });
  if (!res.ok) throw new Error('Trongrid getaccount: ' + res.status);
  const data = (await res.json()) as { balance?: number };
  const sun = Number(data.balance ?? 0);
  return sun / 1e6;
}

/** Account resources: energy and bandwidth (for logging). */
export async function getTronResources(address: string): Promise<{ energy: number; bandwidth: number }> {
  const res = await fetch(TRONGRID_BASE + '/wallet/getaccountresource', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ address: address, visible: true }),
  });
  if (!res.ok) return { energy: 0, bandwidth: 0 };
  const data = (await res.json()) as { EnergyLimit?: number; freeNetLimit?: number };
  return {
    energy: Number(data.EnergyLimit ?? 0),
    bandwidth: Number(data.freeNetLimit ?? 0),
  };
}

/** Send TRX from fromPrivateKey (master) to toAddress (deposit). amountTrx in TRX. Returns txId. */
export async function sendTronTrx(
  fromPrivateKey: string,
  toAddress: string,
  amountTrx: number
): Promise<string> {
  const tw = getTronWeb();
  const pk = fromPrivateKey.startsWith('0x') ? fromPrivateKey.slice(2) : fromPrivateKey;
  const ownerAddress = tw.address.fromPrivateKey(pk);
  const sun = Math.floor(amountTrx * 1e6);
  const createBody = {
    to_address: toAddress,
    owner_address: ownerAddress,
    amount: sun,
    visible: true,
  };
  const createRes = await fetch(TRONGRID_BASE + '/wallet/createtransaction', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(createBody),
  });
  const createText = await createRes.text();
  if (!createRes.ok) {
    console.warn('[tron-sweep] createtransaction raw response:', createText.slice(0, 300));
    throw new Error('Trongrid createtransaction: ' + createRes.status);
  }
  let createJson: Record<string, unknown>;
  try {
    createJson = JSON.parse(createText) as Record<string, unknown>;
  } catch {
    throw new Error('Trongrid createtransaction: invalid JSON');
  }
  if (createJson.result !== undefined && (createJson as { result?: boolean }).result === false) {
    const msg = (createJson as { message?: string }).message ?? createText.slice(0, 200);
    throw new Error('Trongrid createtransaction failed: ' + msg);
  }
  console.log('[tron-sweep] createtransaction response keys:', Object.keys(createJson));
  const txToSign = (createJson.transaction ?? createJson) as Record<string, unknown>;
  if (!txToSign || (txToSign.raw_data === undefined && txToSign.raw_data_hex === undefined)) {
    console.warn('[tron-sweep] createtransaction raw response (truncated):', createText.slice(0, 500));
    throw new Error('No transaction in response (use raw_data/raw_data_hex)');
  }
  const signed = await tw.trx.sign(txToSign as Parameters<typeof tw.trx.sign>[0], pk);
  const broadcastRes = await fetch(TRONGRID_BASE + '/wallet/broadcasttransaction', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(signed),
  });
  const broadcastText = await broadcastRes.text();
  if (!broadcastRes.ok) {
    console.warn('[tron-sweep] broadcast raw response:', broadcastText.slice(0, 300));
    throw new Error('Trongrid broadcast: ' + broadcastRes.status);
  }
  let broadcastJson: Record<string, unknown>;
  try {
    broadcastJson = JSON.parse(broadcastText) as Record<string, unknown>;
  } catch {
    throw new Error('Trongrid broadcast: invalid JSON');
  }
  console.log('[tron-sweep] broadcast response keys:', Object.keys(broadcastJson));
  const txId = (broadcastJson.txid ?? broadcastJson.txID ?? createJson.txID ?? createJson.txid) as string | undefined;
  const result = broadcastJson.result as boolean | undefined;
  if (txId) return txId;
  if (result === false) {
    const msg = (broadcastJson.message as string) ?? broadcastText.slice(0, 200);
    throw new Error('Broadcast failed: ' + msg);
  }
  throw new Error('No txid in broadcast response');
}

/** Encode address for TRC20 parameter (32 bytes hex). */
function encodeAddressParam(hexAddr: string): string {
  if (hexAddr.length === 42 && hexAddr.startsWith('41')) return '0'.repeat(24) + hexAddr.slice(2);
  if (hexAddr.length === 40) return '0'.repeat(24) + hexAddr;
  return '0'.repeat(64);
}

/** Parse amount to integer string (smallest units). No float — strip decimals, use BigInt. */
function toIntegerRaw(amountRaw: string): string {
  const s = String(amountRaw).trim();
  const integerPart = s.includes('.') ? s.split('.')[0] ?? '0' : s;
  return BigInt(integerPart).toString();
}

/** Send TRC20 USDT from deposit (fromPrivateKey) to toAddress. amountRaw = integer string in smallest units (6 decimals). No floats. Returns txId. */
export async function sendTronTrc20(
  fromPrivateKey: string,
  toAddress: string,
  amountRaw: string
): Promise<string> {
  const amountIntegerStr = toIntegerRaw(amountRaw);
  const tw = getTronWeb();
  const fromAddr = tw.address.fromPrivateKey(fromPrivateKey.startsWith('0x') ? fromPrivateKey.slice(2) : fromPrivateKey);
  const toHex = tw.address.toHex(toAddress);
  const paramAddr = encodeAddressParam(toHex);
  const paramAmount = BigInt(amountIntegerStr).toString(16).padStart(64, '0');
  const body = {
    owner_address: fromAddr,
    contract_address: TRON_USDT_CONTRACT,
    function_selector: 'transfer(address,uint256)',
    parameter: paramAddr + paramAmount,
    visible: true,
  };
  const triggerRes = await fetch(TRONGRID_BASE + '/wallet/triggersmartcontract', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });
  if (!triggerRes.ok) {
    const text = await triggerRes.text();
    throw new Error('Trongrid triggersmartcontract: ' + triggerRes.status + ' ' + text.slice(0, 200));
  }
  const triggerData = (await triggerRes.json()) as { transaction?: unknown; txid?: string };
  if (!triggerData.transaction) throw new Error('No transaction in trigger response');
  const signed = await tw.trx.sign(triggerData.transaction as Parameters<typeof tw.trx.sign>[0], fromPrivateKey.startsWith('0x') ? fromPrivateKey.slice(2) : fromPrivateKey);
  const broadcastRes = await fetch(TRONGRID_BASE + '/wallet/broadcasttransaction', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(signed),
  });
  if (!broadcastRes.ok) throw new Error('Trongrid broadcast: ' + broadcastRes.status);
  const result = (await broadcastRes.json()) as { result?: boolean; txid?: string };
  if (!result.result && result.txid) return result.txid;
  if (!result.result) throw new Error('Broadcast failed');
  return result.txid ?? triggerData.txid ?? '';
}

/** Wait for TRON tx confirmation (poll gettransactionbyid). Only SUCCESS counts — REVERT means funds did not move. */
async function waitForTronConfirmation(txId: string, maxWaitMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(TRONGRID_BASE + '/wallet/gettransactionbyid', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ value: txId }),
    });
    if (!res.ok) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    const data = (await res.json()) as { ret?: Array<{ contractRet?: string }> };
    const status = data.ret?.[0]?.contractRet;
    if (status === 'SUCCESS') return;
    if (status === 'REVERT') throw new Error('Funding tx reverted — TRX did not arrive. Check tx: https://tronscan.org/#/transaction/' + txId);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('Funding tx not confirmed in time. Check: https://tronscan.org/#/transaction/' + txId);
}

/** Min TRX to allow sweep (need enough to burn for TRC20 Energy). Auto-fund below this. */
const MIN_TRX_FOR_SWEEP = 15;
/** TRX to send when auto-funding. TRC20 USDT transfer burns ~13–27 TRX for Energy (empty recipient ≈130k energy). */
const FUND_TRX_AMOUNT = 30;

export type TronSweepResult = {
  address: string;
  amount: number;
  txId: string;
  success: boolean;
  error?: string;
};

/**
 * Sweep one TRON deposit address: get USDT balance (Trongrid), ensure TRX, send TRC20 to master.
 * No Tatum. Uses MasterKeys for master address/key.
 */
export async function sweepOneTronAddress(
  depositAddress: string,
  depositPrivateKey: string,
  masterAddress: string,
  masterPrivateKey: string
): Promise<TronSweepResult> {
  const balanceRaw = await getTronTrc20BalanceRaw(depositAddress);
  const amountRawInteger = toIntegerRaw(balanceRaw);
  console.log('[tron-sweep] balanceRaw=' + amountRawInteger + ' addr=' + depositAddress.slice(0, 12) + '…');
  if (amountRawInteger === '0') {
    return { address: depositAddress, amount: 0, txId: '', success: false, error: 'Balance 0' };
  }
  const amountHuman = Number(amountRawInteger) / 1e6;

  let trxBalance = await getTronTrxBalance(depositAddress);
  if (trxBalance < MIN_TRX_FOR_SWEEP) {
    const masterBalanceTrx = await getTronTrxBalance(masterAddress);
    console.log('[tron-sweep] masterBalanceTrx=' + masterBalanceTrx.toFixed(2) + ' before funding');
    console.log('[tron-sweep] funding from master ' + masterAddress + ' to deposit ' + depositAddress);
    const fundingTxId = await sendTronTrx(masterPrivateKey, depositAddress, FUND_TRX_AMOUNT);
    const explorerUrl = 'https://tronscan.org/#/transaction/' + fundingTxId;
    console.log('[tron-sweep] funding txid=' + fundingTxId + ' — check where TRX went: ' + explorerUrl);
    await waitForTronConfirmation(fundingTxId);
    trxBalance = await getTronTrxBalance(depositAddress);
  }
  if (trxBalance < 1) {
    return { address: depositAddress, amount: amountHuman, txId: '', success: false, error: 'Insufficient TRX after funding' };
  }

  const txId = await sendTronTrc20(depositPrivateKey, masterAddress, amountRawInteger);
  if (txId) console.log('[tron-sweep] sent tx=' + txId + ' amount=' + amountHuman.toFixed(2) + ' USDT');
  return { address: depositAddress, amount: amountHuman, txId, success: !!txId };
}
