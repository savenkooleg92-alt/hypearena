/**
 * Solana USDC SPL deposit flow: detect -> confirm -> sweep -> credit.
 * Detects USDC SPL token transfers to deposit addresses' ATAs (not native SOL).
 * Requires SOL_USDC_ENABLED=true. Run when SOL_DEPOSITS_DISABLED=true (no native SOL).
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  SystemProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createTransferCheckedInstruction,
  createAssociatedTokenAccountInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import prisma from '../utils/prisma';
import * as MasterKeys from './masterKeys.service';
import * as TatumService from './TatumService';
import * as WalletDerivation from './walletDerivation.service';

const NETWORK_SOL = 'SOL';
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
/** Mainnet USDC SPL mint (Circle). */
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_MINT_STR = USDC_MINT.toBase58();
const USDC_DECIMALS = 6;
const MIN_USDC_USD = 1;
/** SOL balance below this triggers auto-fund from master before sweep (in SOL). */
const SOL_SWEEP_MIN_BALANCE = Number(process.env.SOL_SWEEP_MIN_BALANCE) || 0.003;
/** Amount of SOL sent from master to deposit wallet when funding for sweep (in SOL). */
const SOL_SWEEP_FUND_AMOUNT = Number(process.env.SOL_SWEEP_FUND_AMOUNT) || 0.005;
/** Master wallet must have at least this much SOL to fund deposit wallets (fee + one SOL_SWEEP_FUND_AMOUNT). Below this we skip funding and log. */
const SOL_MASTER_MIN_BALANCE = Number(process.env.SOL_MASTER_MIN_BALANCE) || 0.01;
/** Do not fund same deposit address more than once in this window (ms). */
const SOL_FUND_RATE_LIMIT_MS = 10 * 60 * 1000; // 10 minutes
/** Fetch more signatures so older deposits are not missed (public RPC often drops recent txs). */
const USDC_SIGNATURE_LIMIT = Math.min(Number(process.env.USDC_SIGNATURE_LIMIT) || 200, 500);
/** Delay (ms) between RPC getSignatures calls per ATA to avoid 429 rate limits. */
const USDC_DETECT_DELAY_MS = Math.max(0, Number(process.env.USDC_DETECT_DELAY_MS) || 400);

function getConnection(): Connection {
  return new Connection(SOLANA_RPC_URL);
}

function getMasterSolanaAddress(): string {
  const addr = process.env.MASTER_ADDRESS_SOL ?? process.env.MASTER_ADDRESS_SOLANA;
  if (!addr) throw new Error('Missing MASTER_ADDRESS_SOL or MASTER_ADDRESS_SOLANA');
  return addr;
}

/** Send SOL from master to recipient via RPC (no Tatum). Uses master key from env/mnemonic. */
async function sendSolFromMasterRpc(
  conn: Connection,
  toAddress: string,
  amountSol: number
): Promise<string> {
  const masterKeypair = MasterKeys.getMasterKeypairSolana();
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: masterKeypair.publicKey,
      toPubkey: new PublicKey(toAddress),
      lamports: Math.ceil(amountSol * 1e9),
    })
  );
  const sig = await sendAndConfirmTransaction(conn, tx, [masterKeypair], {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
    maxRetries: 3,
  });
  return sig;
}

/** Wait for a Solana tx to be confirmed (or finalized). Returns true if confirmed, false on timeout. */
async function waitForSolanaConfirmation(
  conn: Connection,
  signature: string,
  opts: { timeoutMs?: number; commitment?: 'confirmed' | 'finalized' } = {}
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const commitment = opts.commitment ?? 'confirmed';
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await conn.getSignatureStatus(signature);
    if (status?.value?.confirmationStatus === commitment || status?.value?.confirmationStatus === 'finalized') {
      return true;
    }
    if (status?.value?.err) return false;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/** Sum USDC amount transferred to our ATA in parsed tx. Uses top-level and meta.innerInstructions; checks destination and optional mint. */
function parseUsdcTransfersToAta(
  parsed: NonNullable<Awaited<ReturnType<typeof TatumService.getSolanaParsedTransaction>>>,
  ourAtaAddress: string
): number {
  let total = 0;
  const instructions = parsed.transaction?.message?.instructions ?? [];
  const metaInner = parsed.meta?.innerInstructions ?? [];

  const collect = (instr: TatumService.SolanaParsedInstr) => {
    const p = instr.parsed;
    if (!p || (p.type !== 'transfer' && p.type !== 'transferChecked')) return;
    const dest = p.info?.destination;
    if (dest !== ourAtaAddress) return;
    if (p.info?.mint && p.info.mint !== USDC_MINT_STR) return;
    const tokenAmount = p.info?.tokenAmount;
    let amt = tokenAmount?.uiAmount ?? (tokenAmount?.uiAmountString ? parseFloat(tokenAmount.uiAmountString) : 0);
    if ((amt == null || Number.isNaN(amt) || amt <= 0) && tokenAmount?.amount) {
      const raw = parseInt(tokenAmount.amount, 10);
      if (!Number.isNaN(raw) && raw > 0) amt = raw / 1e6;
    }
    if (typeof amt === 'number' && !Number.isNaN(amt) && amt > 0) total += amt;
  };

  for (const instr of instructions) collect(instr);
  for (const inner of metaInner) {
    for (const instr of inner.instructions ?? []) collect(instr);
  }
  return total;
}

/** 1) Detect USDC SPL deposits: scan ATAs (Associated Token Accounts), create DETECTED. */
export async function detectSolUsdcDeposits(): Promise<{ detected: number; errors: string[] }> {
  const errors: string[] = [];
  let detected = 0;
  const isDefaultRpc = !process.env.SOLANA_RPC_URL || process.env.SOLANA_RPC_URL === 'https://api.mainnet-beta.solana.com';
  if (isDefaultRpc) {
    console.warn('[sol-usdc] detect: public RPC often returns null for getTransaction — set SOLANA_RPC_URL (e.g. Helius, QuickNode) for reliable detection');
  }

  const solAddresses = await prisma.walletAddress.findMany({
    where: { network: NETWORK_SOL },
    include: { user: { select: { id: true } } },
  });
  if (solAddresses.length === 0) {
    console.log('[sol-usdc] detect: no SOL wallet addresses in DB');
    return { detected: 0, errors };
  }
  console.log('[sol-usdc] detect: scanning', solAddresses.length, 'SOL address(es)');

  for (let i = 0; i < solAddresses.length; i++) {
    if (i > 0 && USDC_DETECT_DELAY_MS > 0) await new Promise((r) => setTimeout(r, USDC_DETECT_DELAY_MS));
    const wa = solAddresses[i];
    let ownerPubkey: PublicKey;
    try {
      ownerPubkey = new PublicKey(wa.address);
    } catch {
      errors.push(`invalid address ${wa.address}`);
      continue;
    }
    const ata = getAssociatedTokenAddressSync(USDC_MINT, ownerPubkey);
    const ataStr = ata.toBase58();
    console.log('[sol-usdc] scanning ATA', { depositAddress: wa.address, ata: ataStr.slice(0, 12) + '…' });

    let sigs: TatumService.SolanaSignatureInfo[];
    try {
      sigs = await TatumService.getSolanaSignaturesForAddress(ataStr, USDC_SIGNATURE_LIMIT, 'confirmed');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[sol-usdc] error: getSignatures', ataStr.slice(0, 20) + '…', msg);
      errors.push(`getSignatures ${ataStr}: ${msg}`);
      continue;
    }
    console.log('[sol-usdc] signatures fetched', { depositAddress: wa.address, count: sigs.length });

    for (const sig of sigs) {
      if (sig.err) continue;
      const txHash = sig.signature;

      const exists = await prisma.deposit.findUnique({
        where: { network_txHash_depositAddress: { network: NETWORK_SOL, txHash, depositAddress: wa.address } },
      });
      if (exists) continue;

      const parsed = await TatumService.getSolanaParsedTransaction(txHash);
      if (!parsed) {
        console.warn('[sol-usdc] deposit rejected: getTransaction returned null', {
          txHash: txHash.slice(0, 32) + '…',
          depositAddress: wa.address.slice(0, 12) + '…',
          ata: ataStr.slice(0, 12) + '…',
          hint: 'Set SOLANA_RPC_URL to Helius/QuickNode — public RPC often returns null',
        });
        continue;
      }
      if (parsed.meta?.err || !parsed.transaction?.message) {
        console.warn('[sol-usdc] deposit rejected: tx failed or no message', { txHash: txHash.slice(0, 24) + '…', depositAddress: wa.address });
        continue;
      }

      const usdcAmount = parseUsdcTransfersToAta(parsed, ataStr);
      if (usdcAmount <= 0) {
        console.warn('[sol-usdc] deposit rejected: no USDC transfer to our ATA', {
          reason: 'Parse meta.innerInstructions and mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          txHash: txHash.slice(0, 24) + '…',
          depositAddress: wa.address,
          ourAta: ataStr.slice(0, 12) + '…',
        });
        continue;
      }

      const now = new Date();
      console.log('[sol-usdc] detected', { tx: txHash.slice(0, 20) + '…', user: wa.userId, amount: usdcAmount, ata: ataStr.slice(0, 12) + '…' });
      try {
        await prisma.deposit.create({
          data: {
            userId: wa.userId,
            network: NETWORK_SOL,
            txHash,
            walletAddressId: wa.id,
            depositAddress: wa.address,
            ataAddress: ataStr,
            rawAmount: usdcAmount,
            amountUsd: 0,
            status: 'DETECTED',
            detectedAt: now,
          },
        });
        detected++;
      } catch (e: unknown) {
        if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'P2002') {
          // unique
        } else {
          errors.push(`create Deposit ${txHash}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  return { detected, errors };
}

const CONFIRM_MAX_RETRIES = 10;
function nextRetryAt(errorCount: number): Date {
  const minutes = Math.min(60, Math.pow(2, errorCount));
  const d = new Date();
  d.setMinutes(d.getMinutes() + minutes);
  return d;
}

/** 2) DETECTED -> CONFIRMED. Only process when nextRetryAt is null or <= now. On RPC failure set errorCount/nextRetryAt. */
export async function confirmSolUsdcDeposits(): Promise<{ confirmed: number; failed: number; errors: string[] }> {
  const errors: string[] = [];
  let confirmed = 0;
  let failed = 0;
  const now = new Date();

  const list = await prisma.deposit.findMany({
    where: {
      network: NETWORK_SOL,
      status: 'DETECTED',
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
    },
  });

  for (const d of list) {
    const amountUsd = d.rawAmount;
    const isBelowMinimum = amountUsd < MIN_USDC_USD;
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
        data: {
          amountUsd,
          priceUsed: 1,
          status: 'CONFIRMED',
          confirmedAt: now,
          lastError: null,
        },
      });
      confirmed++;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      const newCount = (d.errorCount ?? 0) + 1;
      await prisma.deposit.update({
        where: { id: d.id },
        data: {
          errorCount: Math.min(newCount, CONFIRM_MAX_RETRIES),
          lastError: errMsg.slice(0, 500),
          nextRetryAt: newCount < CONFIRM_MAX_RETRIES ? nextRetryAt(newCount) : null,
        },
      });
      errors.push(`confirm ${d.txHash}: ${errMsg}`);
    }
  }

  return { confirmed, failed, errors };
}

/** 3) Sweep USDC from deposit ATA to master ATA. Only for deposits that are already CREDITED (balance updated).
 * HARD RULE: never sweep CONFIRMED-only — ensures user balance is updated before any USDC leaves the deposit address.
 * Before sweep: if deposit wallet SOL < SOL_SWEEP_MIN_BALANCE, fund from master (idempotent, rate-limited 10 min), wait for confirm, then sweep. */
export async function sweepSolUsdcDeposits(): Promise<{ swept: number; sweptTxIds: string[]; errors: string[] }> {
  const callerStack = new Error().stack?.split('\n').slice(1, 4).join(' <- ') ?? 'unknown';
  console.log('[sol-usdc] sweepSolUsdcDeposits called', { caller: callerStack });

  const errors: string[] = [];
  const sweptTxIds: string[] = [];
  let swept = 0;
  const conn = getConnection();
  // Solana master: env only. MASTER_ADDRESS_SOLANA is authoritative; MASTER_PRIVATE_KEY_SOLANA first, then mnemonic.
  const masterAddress = getMasterSolanaAddress();
  // Tatum expects base58. Phantom exports JSON array [1..64] or base58 — normalize via masterKeys so we always send base58.
  let masterPriv = '';
  try {
    masterPriv = MasterKeys.getMasterPrivateKeySolana();
  } catch {
    masterPriv = '';
  }
  if (masterPriv) {
    const keyAddress = MasterKeys.getMasterAddressSolana();
    if (keyAddress !== masterAddress) {
      console.error(
        '[sol-master] MASTER_ADDRESS_SOLANA does not match the private key. Key address:',
        keyAddress,
        '| Env:',
        masterAddress,
        '— set MASTER_ADDRESS_SOLANA to',
        keyAddress
      );
      errors.push('MASTER_ADDRESS_SOLANA does not match MASTER_PRIVATE_KEY_SOLANA.');
      masterPriv = ''; // do not attempt funding; Tatum would reject
    }
  }
  console.log('[sol-master] using MASTER_ADDRESS_SOLANA:', masterAddress);
  const masterPubkey = new PublicKey(masterAddress);
  const masterAta = getAssociatedTokenAddressSync(USDC_MINT, masterPubkey);
  const minSolLamports = Math.ceil(SOL_SWEEP_MIN_BALANCE * 1e9);

  let masterSolBalance: number | null = null;
  try {
    masterSolBalance = await conn.getBalance(masterPubkey);
  } catch {
    // ignore; we'll skip funding if we can't check
  }
  const masterSolSol = masterSolBalance != null ? masterSolBalance / 1e9 : null;
  if (masterSolSol != null && masterSolSol < SOL_MASTER_MIN_BALANCE && masterPriv) {
    console.warn(
      '[sol-master] master SOL balance too low to fund deposit wallets:',
      masterSolSol.toFixed(4),
      'SOL (min',
      SOL_MASTER_MIN_BALANCE,
      '). Top up MASTER_ADDRESS_SOLANA.'
    );
  }

  // Only sweep addresses that have at least one CREDITED deposit (balance already updated). Never sweep CONFIRMED-only.
  const addressesToSweep = await prisma.deposit.findMany({
    where: { network: NETWORK_SOL, status: 'CREDITED' },
    select: { walletAddressId: true, depositAddress: true },
    distinct: ['depositAddress'],
  });

  if (addressesToSweep.length === 0) {
    console.log('[sol-usdc] sweep: no CREDITED deposits to sweep (sweep only after credit)');
  } else {
    console.log('[sol-usdc] sweep: checking', addressesToSweep.length, 'address(es) with CREDITED deposit(s)');
  }

  for (const { walletAddressId, depositAddress } of addressesToSweep) {
    if (!walletAddressId) {
      console.warn('[sol-usdc] sweep skip: no walletAddressId for', depositAddress.slice(0, 12) + '…');
      continue;
    }

    const wa = await prisma.walletAddress.findUnique({
      where: { id: walletAddressId },
      select: { derivationIndex: true },
    });
    if (wa?.derivationIndex == null) {
      console.warn('[sol-usdc] sweep skip: no derivationIndex for', depositAddress.slice(0, 12) + '…');
      continue;
    }

    const ownerPubkey = new PublicKey(depositAddress);
    const depositAta = getAssociatedTokenAddressSync(USDC_MINT, ownerPubkey);

    let balanceLamports: number;
    try {
      balanceLamports = await conn.getBalance(ownerPubkey);
    } catch (e) {
      errors.push(`balance ${depositAddress}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    let tokenBalance: bigint;
    try {
      const acc = await getAccount(conn, depositAta);
      tokenBalance = acc.amount;
    } catch {
      console.warn('[sol-usdc] sweep skip: no USDC ATA or zero balance for', depositAddress.slice(0, 12) + '…');
      continue;
    }

    // Only sweep the amount we've already credited for this address (only CREDITED rows).
    // rawAmount in DB is stored in human form (e.g. 1.0547); USDC has 6 decimals so multiply by 1e6 for token units.
    const creditedAgg = await prisma.deposit.aggregate({
      where: { network: NETWORK_SOL, depositAddress, status: 'CREDITED' },
      _sum: { rawAmount: true },
    });
    const creditedDeposits = await prisma.deposit.findMany({
      where: { network: NETWORK_SOL, depositAddress, status: 'CREDITED' },
      select: { id: true, txHash: true, rawAmount: true },
    });
    const creditedSumHuman = creditedAgg._sum.rawAmount ?? 0;
    const creditedSumTokenUnits = BigInt(Math.floor(creditedSumHuman * 1e6));
    const amountToSweep = creditedSumTokenUnits <= tokenBalance ? creditedSumTokenUnits : tokenBalance;
    if (amountToSweep < BigInt(Math.floor(MIN_USDC_USD * 1e6))) {
      if (creditedSumTokenUnits > 0n) {
        console.warn('[sol-usdc] sweep skip: credited sum below min for', depositAddress.slice(0, 12) + '…');
      }
      continue;
    }
    if (creditedDeposits.length === 0) {
      console.warn('[sol-usdc] sweep skip: no CREDITED deposits for', depositAddress.slice(0, 12) + '… (should not reach here)');
      continue;
    }
    console.log('[sol-usdc] sweep signing', {
      depositAddress: depositAddress.slice(0, 12) + '…',
      depositIds: creditedDeposits.map((d) => d.id),
      txHashes: creditedDeposits.map((d) => d.txHash.slice(0, 16) + '…'),
      amountUsd: creditedSumHuman,
      amountToSweepTokens: amountToSweep.toString(),
    });

    const usdcAmount = Number(tokenBalance);
    if (usdcAmount < MIN_USDC_USD * 1e6) {
      console.warn('[sol-usdc] sweep skip: USDC below min ($1) for', depositAddress.slice(0, 12) + '…', (usdcAmount / 1e6).toFixed(2), 'USDC');
      continue;
    }

    // 1) Ensure enough SOL for fees: fund from master if below threshold (idempotent, rate-limited)
    if (balanceLamports < minSolLamports) {
      const tenMinAgo = new Date(Date.now() - SOL_FUND_RATE_LIMIT_MS);
      const recentFunding = await prisma.deposit.findFirst({
        where: {
          network: NETWORK_SOL,
          depositAddress,
          fundedAt: { gte: tenMinAgo },
          fundingTxId: { not: null },
        },
        select: { fundingTxId: true, fundedAt: true },
      });

      if (recentFunding?.fundingTxId) {
        // Already funded recently: wait for confirmation if needed, then re-check balance
        const confirmed = await waitForSolanaConfirmation(conn, recentFunding.fundingTxId);
        if (confirmed) {
          try {
            balanceLamports = await conn.getBalance(ownerPubkey);
          } catch {
            // keep original balanceLamports
          }
        }
        if (balanceLamports < minSolLamports) {
          console.warn('[sol-usdc] sweep skip: funding not yet landed for', depositAddress.slice(0, 12) + '… (retry next cycle)');
          continue;
        }
      } else if (masterPriv) {
        if (masterSolBalance != null && masterSolBalance < SOL_MASTER_MIN_BALANCE * 1e9) {
          console.warn('[sol-master] sweep skip: master balance', (masterSolBalance / 1e9).toFixed(4), 'SOL <', SOL_MASTER_MIN_BALANCE, '— top up to fund', depositAddress.slice(0, 12) + '…');
          continue;
        }
        try {
          let fundTxId: string | undefined;
          try {
            fundTxId = await TatumService.sendNative(
              TatumService.CHAINS.SOLANA,
              masterPriv,
              depositAddress,
              SOL_SWEEP_FUND_AMOUNT,
              masterAddress
            );
          } catch (tatumErr) {
            const tatumMsg = tatumErr instanceof Error ? tatumErr.message : String(tatumErr);
            console.warn('[sol-usdc] Tatum fund failed, trying direct RPC:', tatumMsg.slice(0, 80));
            fundTxId = await sendSolFromMasterRpc(conn, depositAddress, SOL_SWEEP_FUND_AMOUNT);
          }
          if (fundTxId) {
            const fundedAt = new Date();
            await prisma.deposit.updateMany({
              where: {
                network: NETWORK_SOL,
                depositAddress,
                status: { in: ['CONFIRMED', 'CREDITED'] },
              },
              data: { fundingTxId: fundTxId, fundedAt },
            });
            console.log('[sol-usdc] funding deposit wallet', {
              wallet: depositAddress,
              amount: SOL_SWEEP_FUND_AMOUNT,
              tx: fundTxId,
            });
            const confirmed = await waitForSolanaConfirmation(conn, fundTxId);
            if (confirmed) {
              balanceLamports = await conn.getBalance(ownerPubkey);
            } else {
              errors.push(`fund confirm timeout ${depositAddress} tx=${fundTxId}`);
              continue;
            }
          }
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          console.warn('[sol-usdc] error: fund SOL', depositAddress.slice(0, 16) + '…', errMsg);
          errors.push(`fund SOL ${depositAddress}: ${errMsg}`);
          continue;
        }
      } else {
        console.warn('[sol-usdc] sweep skip: no master key to fund', depositAddress.slice(0, 12) + '… (set MASTER_PRIVATE_KEY_SOLANA or MASTER_MNEMONIC)');
        errors.push(
          `no SOL for fees ${depositAddress}; set MASTER_MNEMONIC or MASTER_PRIVATE_KEY_SOLANA`
        );
        continue;
      }
    }

    if (balanceLamports < minSolLamports) {
      console.warn('[sol-usdc] sweep skip: deposit wallet still has no SOL for fees after funding check:', depositAddress.slice(0, 12) + '…');
      continue;
    }

    let keypair: Keypair;
    try {
      const priv = WalletDerivation.derivePrivateKey('SOL', wa.derivationIndex);
      keypair = Keypair.fromSecretKey(Buffer.from(priv, 'hex'));
      if (keypair.publicKey.toBase58() !== depositAddress) {
        console.error('[sol-usdc] sweep fail: derived key does not match deposit address', {
          derived: keypair.publicKey.toBase58(),
          depositAddress,
          derivationIndex: wa.derivationIndex,
        });
        errors.push(`sweep ${depositAddress}: key mismatch (derivationIndex ${wa.derivationIndex})`);
        continue;
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error('[sol-usdc] sweep fail: cannot derive key for deposit wallet', { depositAddress, derivationIndex: wa.derivationIndex, error: errMsg });
      errors.push(`priv ${depositAddress}: ${errMsg}`);
      continue;
    }

    // Master must have a USDC ATA to receive; if Phantom never received USDC, it doesn't exist → InvalidAccountData.
    let masterAtaExists = false;
    try {
      await getAccount(conn, masterAta);
      masterAtaExists = true;
    } catch {
      // master ATA does not exist; we'll create it in the same tx (deposit wallet pays rent)
    }

    const tx = new Transaction();
    if (!masterAtaExists) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          keypair.publicKey, // payer (deposit wallet pays rent to create master's USDC ATA)
          masterAta,
          masterPubkey,
          USDC_MINT
        )
      );
      console.log('[sol-usdc] creating master USDC ATA', masterAta.toBase58().slice(0, 16) + '…');
    }
    tx.add(
      createTransferCheckedInstruction(
        depositAta,
        USDC_MINT,
        masterAta,
        ownerPubkey,
        amountToSweep,
        USDC_DECIMALS,
        [],
        TOKEN_PROGRAM_ID
      )
    );

    try {
      const sig = await sendAndConfirmTransaction(conn, tx, [keypair], {
        commitment: 'confirmed',
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      });

      const sweepNow = new Date();
      await prisma.deposit.updateMany({
        where: { network: NETWORK_SOL, depositAddress, status: 'CREDITED' },
        data: { status: 'SWEPT', sweepTxId: sig, sweptAt: sweepNow },
      });
      swept++;
      sweptTxIds.push(sig);
      console.log('[sol-usdc] sweep success', { deposit: depositAddress, tx: sig, depositIds: creditedDeposits.map((d) => d.id) });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      const errLog = e instanceof Error ? (e.stack || e.message) : String(e);
      errors.push(`sweep USDC ${depositAddress}: ${errMsg}`);
      console.error('[sol-usdc] sweep FAIL (USDC transfer)', {
        deposit: depositAddress,
        error: errMsg,
        detail: errLog.slice(0, 500),
      });
      console.log('[sol-usdc] sweep retry scheduled', { error: errMsg, deposit: depositAddress });
      // Leave status CONFIRMED/CREDITED so next cycle retries
    }
  }

  return { swept, sweptTxIds, errors };
}

/** Idempotency key for ledger: one Transaction row per deposit; prevents double credit. */
function depositLedgerExternalId(txHash: string, depositAddress: string): string {
  return `sol_usdc:${NETWORK_SOL}:${txHash}:${depositAddress}`;
}

/**
 * Credit user balance for CONFIRMED or SWEPT deposits. No dependency on sweep.
 * Pipeline: DETECT → CONFIRM → CREDIT (fast). Sweep is optional consolidation (runs later).
 * Uses Transaction.externalId = sol_usdc:SOL:txHash:depositAddress for idempotency (P2002 = already credited).
 * When SOL_USDC_SKIP_SWEEP=true (default): credit CONFIRMED immediately. When false: credit only SWEPT (legacy).
 */
export async function creditSolUsdcDeposits(): Promise<{ credited: number; errors: string[] }> {
  const errors: string[] = [];
  let credited = 0;
  const creditAfterConfirm = process.env.SOL_USDC_SKIP_SWEEP !== 'false'; // default true: credit right after confirm
  const statuses = creditAfterConfirm ? ['CONFIRMED', 'SWEPT'] : ['SWEPT'];

  const list = await prisma.deposit.findMany({
    where: { network: NETWORK_SOL, status: { in: statuses } },
    include: { user: { select: { id: true } } },
  });

  for (const d of list) {
    const externalId = depositLedgerExternalId(d.txHash, d.depositAddress);
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
              source: 'sol_usdc',
              txHash: d.txHash,
              amountUsdc: d.rawAmount,
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
      console.log('[sol-usdc] credited', { tx: d.txHash.slice(0, 20) + '…', userId: d.userId, amountUsd: d.amountUsd });
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
 * Credit a single SOL USDC deposit by txHash. Works for status SWEPT or CONFIRMED (force credit for recovery).
 * Idempotent: no double credit.
 */
export async function creditSolUsdcDepositByTxHash(
  txHash: string
): Promise<
  | { ok: true; alreadyCredited: true }
  | { ok: true; credited: true; userId: string; amountUsd: number; previousStatus: string }
  | { ok: false; error: string }
> {
  const deposit = await prisma.deposit.findFirst({
    where: { network: NETWORK_SOL, txHash },
    include: { user: { select: { id: true } } },
  });
  if (!deposit) return { ok: false, error: `No SOL deposit found for txHash: ${txHash.slice(0, 24)}…` };
  if (deposit.status === 'CREDITED') return { ok: true, alreadyCredited: true };

  if (deposit.status !== 'SWEPT' && deposit.status !== 'CONFIRMED') {
    return { ok: false, error: `Deposit status is ${deposit.status}; can only credit SWEPT or CONFIRMED` };
  }

  const previousStatus = deposit.status;
  const externalId = depositLedgerExternalId(deposit.txHash, deposit.depositAddress);
  const now = new Date();
  try {
    await prisma.$transaction([
      prisma.transaction.create({
        data: {
          userId: deposit.userId,
          externalId,
          type: 'DEPOSIT',
          amount: deposit.amountUsd,
          description: JSON.stringify({
            source: previousStatus === 'SWEPT' ? 'sol_usdc' : 'sol_usdc_manual_credit',
            txHash: deposit.txHash,
            amountUsdc: deposit.rawAmount,
            amountUsd: deposit.amountUsd,
          }),
        },
      }),
      prisma.user.update({
        where: { id: deposit.userId },
        data: { balance: { increment: deposit.amountUsd } },
      }),
      prisma.deposit.update({
        where: { id: deposit.id },
        data: { status: 'CREDITED', creditedAt: now },
      }),
    ]);
    console.log('[sol-usdc] credit-by-txHash', {
      txHash: deposit.txHash.slice(0, 24) + '…',
      userId: deposit.userId,
      amountUsd: deposit.amountUsd,
      previousStatus,
    });
    return { ok: true, credited: true, userId: deposit.userId, amountUsd: deposit.amountUsd, previousStatus };
  } catch (e: unknown) {
    const isUniqueViolation = e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'P2002';
    if (isUniqueViolation) {
      await prisma.deposit.updateMany({
        where: { id: deposit.id, status: { not: 'CREDITED' } },
        data: { status: 'CREDITED', creditedAt: now },
      });
      return { ok: true, credited: true, userId: deposit.userId, amountUsd: deposit.amountUsd, previousStatus };
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function runSolUsdcDepositCycle(): Promise<{
  detected: number;
  confirmed: number;
  failed: number;
  swept: number;
  credited: number;
  errors: string[];
}> {
  if (process.env.SOL_USDC_ENABLED !== 'true') {
    return { detected: 0, confirmed: 0, failed: 0, swept: 0, credited: 0, errors: [] };
  }

  console.log('[sol-usdc] cycle tick started');
  const errors: string[] = [];
  const d = await detectSolUsdcDeposits();
  errors.push(...d.errors);
  const c = await confirmSolUsdcDeposits();
  errors.push(...c.errors);
  const cr = await creditSolUsdcDeposits();
  errors.push(...cr.errors);
  const s = await sweepSolUsdcDeposits();
  errors.push(...s.errors);

  console.log('[sol-usdc] cycle tick done', {
    detected: d.detected,
    confirmed: c.confirmed,
    failed: c.failed,
    swept: s.swept,
    credited: cr.credited,
    errors: errors.length,
  });
  if (cr.credited > 0) {
    console.log('[sol-usdc] credit step done: credited', cr.credited);
  }
  if (errors.length > 0) {
    errors.slice(0, 5).forEach((e) => console.warn('[sol-usdc] error:', e));
    if (errors.length > 5) console.warn('[sol-usdc] ... and', errors.length - 5, 'more errors');
  }
  return {
    detected: d.detected,
    confirmed: c.confirmed,
    failed: c.failed,
    swept: s.swept,
    credited: cr.credited,
    errors,
  };
}

export type SweepResult = { swept: number; sweptTxIds: string[]; errors: string[] };

/**
 * Manual backfill: create a SWEPT deposit for a known tx and credit the user. Idempotent (no double credit).
 * Use when the watcher missed a deposit (e.g. DB was down or RPC returned null).
 */
export async function backfillSolUsdcDeposit(
  txHash: string,
  userEmail: string,
  amountUsdOverride?: number
): Promise<
  | { ok: true; alreadyCredited: true }
  | { ok: true; credited: true; userId: string; amountUsd: number }
  | { ok: false; error: string }
> {
  const user = await prisma.user.findUnique({ where: { email: userEmail } });
  if (!user) return { ok: false, error: `User not found: ${userEmail}` };

  const wa = await prisma.walletAddress.findUnique({
    where: { userId_network: { userId: user.id, network: NETWORK_SOL } },
  });
  if (!wa) return { ok: false, error: `No SOL deposit address for user ${userEmail}` };

  const depositAddress = wa.address;
  const existing = await prisma.deposit.findUnique({
    where: { network_txHash_depositAddress: { network: NETWORK_SOL, txHash, depositAddress } },
  });
  if (existing) {
    if (existing.status === 'CREDITED') return { ok: true, alreadyCredited: true };
    if (existing.status === 'SWEPT' || existing.status === 'CONFIRMED') {
      const result = await creditSolUsdcDepositByTxHash(existing.txHash);
      if (result.ok && 'credited' in result && result.credited)
        return { ok: true, credited: true, userId: user.id, amountUsd: existing.amountUsd };
      if (result.ok && 'alreadyCredited' in result) return { ok: true, alreadyCredited: true };
      return { ok: false, error: (result as { error: string }).error };
    }
    return { ok: false, error: `Deposit exists with status ${existing.status}; resolve manually or run USDC cycle` };
  }

  let amountUsd = amountUsdOverride;
  if (amountUsd == null || amountUsd <= 0) {
    const ownerPubkey = new PublicKey(depositAddress);
    const ata = getAssociatedTokenAddressSync(USDC_MINT, ownerPubkey);
    const ataStr = ata.toBase58();
    const parsed = await TatumService.getSolanaParsedTransaction(txHash);
    if (!parsed) return { ok: false, error: 'RPC returned null for tx; provide amountUsd in request body' };
    const usdcAmount = parseUsdcTransfersToAta(parsed, ataStr);
    if (usdcAmount <= 0) return { ok: false, error: 'No USDC transfer to this address in tx; provide amountUsd in request body' };
    amountUsd = usdcAmount;
  }

  const rawAmount = amountUsd;
  const deposit = await prisma.deposit.create({
    data: {
      userId: user.id,
      network: NETWORK_SOL,
      txHash,
      walletAddressId: wa.id,
      depositAddress,
      rawAmount,
      amountUsd,
      priceUsed: 1,
      status: 'SWEPT',
    },
  }).catch((e: unknown) => {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'P2002') {
      return null;
    }
    throw e;
  });
  if (!deposit) {
    const again = await prisma.deposit.findUnique({
      where: { network_txHash_depositAddress: { network: NETWORK_SOL, txHash, depositAddress } },
    });
    if (again?.status === 'CREDITED') return { ok: true, alreadyCredited: true };
    return { ok: false, error: 'Deposit already exists (race); check status and retry or run USDC cycle' };
  }

  const externalId = depositLedgerExternalId(txHash, depositAddress);
  const now = new Date();
  try {
    await prisma.$transaction([
      prisma.transaction.create({
        data: {
          userId: user.id,
          externalId,
          type: 'DEPOSIT',
          amount: amountUsd,
          description: JSON.stringify({ source: 'sol_usdc_backfill', txHash, amountUsd }),
        },
      }),
      prisma.user.update({ where: { id: user.id }, data: { balance: { increment: amountUsd } } }),
      prisma.deposit.update({ where: { id: deposit.id }, data: { status: 'CREDITED', creditedAt: now } }),
    ]);
  } catch (e: unknown) {
    const isUniqueViolation = e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'P2002';
    if (isUniqueViolation)
      await prisma.deposit.updateMany({
        where: { id: deposit.id, status: { not: 'CREDITED' } },
        data: { status: 'CREDITED', creditedAt: now },
      });
    else throw e;
  }
  console.log('[sol-usdc] backfill credited', { userId: user.id, amountUsd, txHash: txHash.slice(0, 24) + '…' });
  return { ok: true, credited: true, userId: user.id, amountUsd };
}

/**
 * Reconcile pending: detect → confirm → credit. Sweep is NOT run (use "Sweep to Master" separately).
 * Idempotent: no double credit (ledger externalId unique).
 */
export async function reconcileSolUsdcPending(): Promise<{
  detected: number;
  confirmed: number;
  failed: number;
  swept: number;
  credited: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const d = await detectSolUsdcDeposits();
  errors.push(...d.errors);
  const c = await confirmSolUsdcDeposits();
  errors.push(...c.errors);
  const cr = await creditSolUsdcDeposits();
  errors.push(...cr.errors);

  if (d.detected > 0 || c.confirmed > 0 || cr.credited > 0 || errors.length > 0) {
    console.log('[sol-usdc] reconcile', { detected: d.detected, confirmed: c.confirmed, failed: c.failed, credited: cr.credited, errors: errors.length });
  }
  return {
    detected: d.detected,
    confirmed: c.confirmed,
    failed: c.failed,
    swept: 0,
    credited: cr.credited,
    errors,
  };
}

/**
 * Reconcile one deposit by txHash: run confirm → credit (no sweep). Idempotent.
 */
export async function reconcileSolUsdcByTxHash(
  txHash: string
): Promise<
  | { ok: true; alreadyCredited: true }
  | { ok: true; credited: true; userId: string; amountUsd: number; previousStatus: string }
  | { ok: false; error: string }
> {
  const deposit = await prisma.deposit.findFirst({
    where: { network: NETWORK_SOL, txHash },
  });
  if (!deposit) return { ok: false, error: `No SOL deposit for txHash: ${txHash.slice(0, 24)}…` };
  if (deposit.status === 'CREDITED') return { ok: true, alreadyCredited: true };
  await confirmSolUsdcDeposits();
  return creditSolUsdcDepositByTxHash(txHash);
}
