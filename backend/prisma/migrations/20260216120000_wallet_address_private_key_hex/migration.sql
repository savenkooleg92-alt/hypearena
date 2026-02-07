-- Optional private key for MATIC external wallets (on-chain sweep without derivationIndex)
ALTER TABLE "wallet_addresses" ADD COLUMN "privateKeyHex" TEXT;
