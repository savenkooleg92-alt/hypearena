# Solana USDC SPL – Technical approach

## Confirmation (2)

- **`SOL_DEPOSITS_DISABLED=true`**  
  When set, `runSolDepositCycle()` returns immediately and does no native SOL detection. The Solana deposit interval is not started in `index.ts`, so no native SOL processing runs.

- **UI**  
  Solana is labeled "Solana (USDC)" and all wallet copy/breakdowns use USDC. With `SOL_DEPOSITS_DISABLED=true`, native SOL is fully disabled and the UI remains USDC-only until the USDC SPL flow is enabled.

---

## Full USDC SPL implementation – scope

1. **Deposit detection (USDC SPL only)**  
   - For each SOL `WalletAddress`, compute the **Associated Token Account (ATA)** for USDC mint.  
   - Use Solana RPC `getSignaturesForAddress(ata)` then `getTransaction(sig, jsonParsed)` to get parsed instructions.  
   - Parse SPL Token **Transfer** / **TransferChecked** where the destination is our ATA; sum amounts (6 decimals) → USDC amount.  
   - Create `Deposit` with `network: 'SOL'`, `rawAmount` = USDC amount, `amountUsd` = same (1:1), `priceUsed: 1`.

2. **Confirm**  
   - DETECTED → set `amountUsd = rawAmount`, `priceUsed = 1`. If `amountUsd < $1` → FAILED + `isBelowMinimum`. Else CONFIRMED.

3. **Sweep USDC to master**  
   - For each CONFIRMED deposit address with USDC balance ≥ minimum (e.g. 1 USDC):  
     - **Gas:** If deposit wallet’s native SOL balance is too low to pay fee, send a small amount of SOL from master to deposit wallet (e.g. 0.001 SOL) using existing `sendNative(SOL, ...)`.  
     - Build SPL **TransferChecked** from deposit ATA → master USDC ATA; sign with deposit wallet key; send via RPC `sendTransaction`.  
   - Mark deposit SWEPT, store `sweepTxId`.

4. **Credit**  
   - Same as today: for SWEPT, credit user balance (USD = USDC amount), create `Transaction` type DEPOSIT, set CREDITED.

5. **Withdrawals (SOL = USDC)**  
   - When user withdraws on Solana, send **USDC** from master’s USDC ATA to the user’s address.  
   - Resolve user’s USDC ATA (create if needed via `createAssociatedTokenAccountInstruction`), then **TransferChecked** from master ATA to user ATA.  
   - Master signs; fee paid in SOL from master.  
   - Requires master’s Solana private key (e.g. `MASTER_PRIVATE_KEY_SOLANA`).

6. **Quotes / breakdown**  
   - Already return `currency: 'USDC'` for SOL; amounts are in USD (1:1 with USDC). No change.

7. **Min deposit / withdrawal fee**  
   - Min deposit remains $1 (USDC). Withdrawal fee logic unchanged (fixed fee in USD; send `amountToSend` USDC).

8. **Runtime behavior**  
   - When **`SOL_USDC_ENABLED=true`**: run the new USDC deposit cycle (detect/confirm/sweep/credit) on the same interval.  
   - When **`SOL_DEPOSITS_DISABLED=true`** and **`SOL_USDC_ENABLED=true`**: only the USDC cycle runs (no native SOL).  
   - When **`SOL_DEPOSITS_DISABLED=true`** and **`SOL_USDC_ENABLED`** not set: no Solana deposit processing (UI still USDC-only).

Implementing accordingly.
