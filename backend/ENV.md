# Environment variables

## Database (Neon PostgreSQL)

`DATABASE_URL` should point to your Neon Postgres instance. **Use the pooled (pooler) connection string** for the app to avoid connection limits.

- **Required format (pooled + params):**  
  `DATABASE_URL=postgresql://USER:PASS@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require&connection_limit=5&pool_timeout=30&connect_timeout=30`  
  Host must be the **pooler** (`-pooler`). The backend appends the three params if missing.

**If you see `P1001: Can't reach database server`:**

1. **Wake the database** – Neon free tier **suspends** projects after inactivity. Open [Neon Console](https://console.neon.tech), select your project, and run any query in the SQL editor (or use "Restore" if suspended).
2. **Use SSL only** – Use only `?sslmode=require`; remove `&channel_binding=require` if present.
3. **Use the pooler host** – In Neon Dashboard → Connection details, pick the **pooled** connection string (host often ends with `-pooler`).

**If you see `P1002: Connection timeout / advisory lock`:**

1. **Use the pooled connection string** – Not the direct endpoint. Pooler hostname usually contains `-pooler`. In `DATABASE_URL` you can add (or let the app add): `connect_timeout=30&pool_timeout=30&connection_limit=5`.
2. **Wake the DB** – In [Neon SQL Editor](https://console.neon.tech) run: `SELECT now();` to confirm the DB is awake.
3. **Kill stuck migration / advisory lock sessions** – Prisma migrate uses `pg_advisory_lock`; if a migrate run crashed or two ran at once, locks can stick. In Neon SQL Editor run:
   ```sql
   -- See who is holding advisory locks or running Prisma
   SELECT pid, usename, state, query
   FROM pg_stat_activity
   WHERE query ILIKE '%pg_advisory_lock%' OR query ILIKE '%prisma%';

   -- Terminate those sessions (replace with the pids from above if you want to be selective)
   SELECT pg_terminate_backend(pid)
   FROM pg_stat_activity
   WHERE (query ILIKE '%pg_advisory_lock%' OR query ILIKE '%prisma%')
     AND pid <> pg_backend_pid();
   ```
   Then restart the backend and use **only one** process for migrations (see below).
4. **Migrations: use deploy, not dev** – Run `prisma migrate deploy` to apply migrations (e.g. once per deploy). Do **not** run `prisma migrate dev` from multiple terminals or on every dev start; it takes an advisory lock and can leave the DB stuck. Run `migrate dev` only when you are creating new migrations, and only one instance at a time.
5. **Restart the backend** after the DB is awake and locks are cleared; then check `GET /api/health`. Once stable, run the USDC deposit cycle once (Admin → Solana deposits → “Run USDC deposit cycle”) to credit pending deposits.

## Required for wallet (deposit address generation + sweep)

| Variable | Description |
|----------|-------------|
| `MASTER_MNEMONIC` | BIP39 mnemonic (12+ words). Used to derive deposit addresses (TRON/Polygon/Solana) and **master private keys** when `MASTER_PRIVATE_KEY_*` are not set. One seed (e.g. Trust Wallet) can drive all chains: Solana keypair for sweeps/funding, EVM key for Polygon, TRON key. **Required** for address generation; also used to derive master keys if env overrides are omitted. |
| `TATUM_API_KEY` | Tatum API key. Used for balance checks and sending sweep transactions. **Required** for deposits/sweep. |
| `MASTER_ADDRESS_TRON` | TRON address where USDT is swept. |
| `MASTER_ADDRESS_POLYGON` | Polygon (EVM) address where USDT is swept. |
| `MASTER_ADDRESS_SOLANA` or `MASTER_ADDRESS_SOL` | Solana address where SOL/USDC is swept. |

### Master keys: MASTER_MNEMONIC vs overrides

- If **only** `MASTER_MNEMONIC` is set, the backend derives master private keys locally:
  - **Solana**: deterministic key from `hash(mnemonic|solana|master)` (not BIP44 501). The **same** derived address is used as the Solana master (sweep destination and funding). You do **not** need to set `MASTER_ADDRESS_SOLANA` when using only mnemonic — the backend uses the derived address. (Trust Wallet’s Solana address may differ because it uses BIP44; our derivation is custom.)
  - **Polygon**: BIP44 path `m/44'/60'/1'/0/0` (account 1; user addresses use account 0).
  - **TRON**: BIP44 path `m/44'/195'/1'/0/0` (account 1; user addresses use account 0).
- Setting **`MASTER_PRIVATE_KEY_SOLANA`** (or **`MASTER_PRIVATE_KEY_SOL`**), **`MASTER_PRIVATE_KEY_POLYGON`**, or **`MASTER_PRIVATE_KEY_TRON`** overrides derivation for that chain. Then **`MASTER_ADDRESS_*`** must match that key’s address (or we derive it from the key).

### MASTER_PRIVATE_KEY_SOLANA format (exact)

When you set the key explicitly (instead of deriving from mnemonic), our code accepts **one of**:

| Format | Example | Notes |
|--------|--------|--------|
| **Hex** | `0x` + 128 hex chars | 64-byte Solana secret key (same as `Keypair.secretKey`). Sent to Tatum as base58 internally. |
| **Base58** | Single string, no spaces | Standard Solana export (e.g. Phantom, Solana CLI). **Preferred** for Tatum (they expect base58). |
| **JSON array** | `[1,2,3,...,64]` | 64 numbers (0–255). Common export from Solana CLI / some wallets. Parsed and converted to keypair. |

So: **not** “JSON array vs base58” only — we support **hex**, **base58**, and **JSON array**. Tatum’s API expects **base58**; we accept all three and **normalize to base58** before sending. **Phantom:** Set **MASTER_ADDRESS_SOLANA** to your Phantom wallet's public address (the one that matches the key).

## Network keys (backend ↔ frontend)

- **Frontend/API/DB**: `TRON`, `SOL`, `MATIC` (one per user per network).
- **MATIC = Polygon** (EVM). Native token is **POL** (formerly MATIC), used for gas; withdrawals send **USDT** (ERC-20) to the user’s Polygon (0x) address. Your 0x address in Phantom (or any wallet) can receive USDT on Polygon.
- **Tatum internal**: TRON, SOL (Solana), POLYGON. Mapping is in code (SOL → Solana, MATIC → POLYGON).

## Optional

| Variable | Description |
|----------|-------------|
| `SOLANA_RPC_URL` | **Production:** use Helius or QuickNode RPC. Public RPC often returns `null` for `getTransaction` and drops recent txs; USDC watcher needs a reliable RPC. |
| `USDC_SIGNATURE_LIMIT` | Max signatures per ATA fetch (default 200). Increase if you need to catch very old deposits. |
| `SOL_SWEEP_MIN_BALANCE` | Min SOL (in SOL) on deposit wallet to attempt sweep (default 0.003). Below this we auto-fund from master. |
| `SOL_SWEEP_FUND_AMOUNT` | SOL amount sent from master to deposit wallet when funding for sweep (default 0.005). |
| `SOL_MASTER_MIN_BALANCE` | Minimum SOL the master wallet must have to fund deposit wallets (default 0.01). Below this we skip funding and log; top up MASTER_ADDRESS_SOLANA. |
| `DEV_CREDIT_ENABLED` | Set to `true` to enable POST /wallet/dev-credit in development. |
| `CRON_SECRET` | Required for cron endpoints (check-deposits, check-sol-deposits, sweep). |

## Support (ticket notifications by email)

All support ticket submissions (POST /api/support/ticket) trigger an email to the support inbox. **All support requests must be sent to hypearena@outlook.com.**

| Variable | Required | Description |
|----------|----------|-------------|
| `SMTP_HOST` | Yes (to send) | SMTP server host (e.g. smtp.office365.com for Outlook). |
| `SMTP_PORT` | Yes (to send) | SMTP port (e.g. 587 for TLS). |
| `SMTP_USER` | Yes (to send) | SMTP username (e.g. hypearena@outlook.com). |
| `SMTP_PASS` | Yes (to send) | SMTP password or app password. |
| `SUPPORT_EMAIL` | No | Inbox where new ticket notifications are sent. **Default: hypearena@outlook.com** |
| `SMTP_FROM` | No | From address (defaults to SMTP_USER). |
| `SMTP_SECURE` | No | Set to `true` for port 465. |

If SMTP is not configured, tickets are still created and stored; only the notification email is skipped (and logged to console).

## Deposit minimums (enforced in code)

- **TRON (USDT)**: $20
- **Polygon (USDT)**: $1
- **Solana (SOL)**: $1

Deposits below minimum are not credited and not swept.

## Withdrawal fees (fixed USD per network)

Optional env vars. Defaults used if unset.

| Variable | Default | Description |
|----------|---------|-------------|
| `WITHDRAW_FEE_TRON_USD` | 3 | Fixed fee in USD for TRON USDT (TRC-20) withdrawals. |
| `WITHDRAW_FEE_MATIC_USD` | 0.5 | Fixed fee in USD for Polygon USDT withdrawals. |
| `WITHDRAW_FEE_SOL_USD` | 0 | Fixed fee for Solana SOL (0 = fee paid by platform). |

User pays `amount`; they receive `amount - fee`. Submit is invalid if `amount - fee <= 0` or `amount` is below the network minimum.

## Solana (USDC-only in UI)

- **USDC watcher:** set `SOL_USDC_ENABLED=true` and `SOL_DEPOSITS_DISABLED=true`. Watcher scans each user’s USDC ATA (not wallet address), uses `meta.innerInstructions` and mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.
- Set **`SOL_DEPOSITS_DISABLED=true`** to disable native SOL detection when using USDC only.
- Withdrawal response currency for SOL is returned as **USDC**.

### Accounting: credit after confirm, sweep optional

- **Pipeline:** DETECT → CONFIRM → **CREDIT** (fast). **Sweep** is a separate consolidation step (hourly/daily/manual) to move funds from deposit ATA → master ATA. Withdrawals are paid from **MASTER**.
- **Credit step** accepts CONFIRMED or SWEPT. By default we credit as soon as a deposit is CONFIRMED (no dependency on sweep). Set `SOL_USDC_SKIP_SWEEP=false` to only credit after sweep (legacy).
- **Ledger idempotency:** Each credit creates a `Transaction` with `externalId = sol_usdc:SOL:txHash:depositAddress` (unique). Retries that hit P2002 do not double credit.
- **Deposits unique key:** `@@unique([network, txHash, depositAddress])`. Each tx per address handled once.

### Admin endpoints (admin auth)

| Endpoint | Description |
|----------|-------------|
| POST /api/admin/solana/usdc/reconcile | Reconcile pending: detect → confirm → credit (sweep not run). Returns counts. |
| POST /api/admin/solana/usdc/reconcile/:txHash | Reconcile one deposit by txHash. Idempotent. |
| POST /api/admin/solana/usdc/sweep-pending | Sweep to Master: move USDC from deposit ATAs to master. Run when desired (e.g. hourly/manual). |

### Manual backfill (missed USDC deposit)

If a deposit was confirmed on chain but not credited (e.g. DB down or RPC null):

1. **Reconcile by txHash:** POST /api/admin/solana/usdc/reconcile/:txHash (e.g. `5eRpFjTkHe8t8DovH39ecQQh9Wj4cqVGxorXToeq9jHGougHgaxNxuwQLjnEwnJs6rHm8QzEj8kUWxVv153JfhhY`) — runs confirm → credit. Idempotent.
2. Or **backfill** (when no deposit row exists): POST /api/admin/deposits/backfill-sol-usdc with body `{ "txHash", "userEmail", "amountUsd?" }`.

## TRON USDT (TRC-20) and Polygon USDT

- **Detection:** TRON uses Trongrid for TRC20 USDT. Polygon uses **Polygon RPC** `eth_getLogs` for ERC20 **Transfer** logs (contract `0xc2132D05D31c914a87C6611C10748AEb04B58e8F`, official USDT); credit when `transfer.to === depositAddress`. Optional env: `POLYGON_RPC_URL` (default `https://polygon-rpc.com`), `POLYGON_DEPOSIT_SCAN_BLOCKS` (default 100000).
- **Polygon sweep (auto gas funding):** One-click “Sweep all Polygon USDT to Master” funds POL from master when needed, waits for confirmation, then sweeps USDT. Idempotent (cooldown avoids double funding). Contract `0xc2132D05D31c914a87C6611C10748AEb04B58e8F` (PolygonScan may show as USDT0). Real sweep fee ~0.045 POL. Env: `POLYGON_SWEEP_MIN_GAS` (default 0.05 POL), `POLYGON_SWEEP_FUND_AMOUNT` (default 0.06 POL), `POLYGON_FUNDING_COOLDOWN_MINUTES` (default 10). Optional: `POLYGON_FUND_MAX_PER_HOUR` (e.g. 1 = max 1 POL funded per hour across all addresses).
- **Flow:** Detect → Confirm → Credit (same as Solana). Crediting is idempotent (`tron_usdt:TRON:txId:address` / `matic_usdt:MATIC:txHash:address`). **Sweep** is separate: Admin → TRON deposits / Polygon deposits → “Sweep all … to Master” (or cron POST /api/wallet/sweep). Sweep uses the same master key/address as withdrawals: `MASTER_ADDRESS_TRON`, `MASTER_ADDRESS_POLYGON`, and keys from env or `MASTER_MNEMONIC`.
- **Intervals:** TRON and Polygon deposit cycles run every 1 min (dev) / 2 min (prod). No env flag to disable; omit `MASTER_MNEMONIC` / keys if you do not use these networks.
- **Admin:** GET /api/admin/deposits/tron, GET /api/admin/deposits/polygon; POST /api/admin/tron/usdt/run-cycle, POST /api/admin/tron/usdt/sweep; POST /api/admin/polygon/usdt/run-cycle, POST /api/admin/polygon/usdt/sweep.
