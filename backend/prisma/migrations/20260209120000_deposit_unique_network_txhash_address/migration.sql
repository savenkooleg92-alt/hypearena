-- Drop unique constraint (network, txHash) so one transaction can credit multiple deposit addresses (e.g. USDC SPL to multiple ATAs).
DROP INDEX IF EXISTS "deposits_network_txHash_key";

-- Create unique constraint (network, txHash, depositAddress).
CREATE UNIQUE INDEX "deposits_network_txHash_depositAddress_key" ON "deposits"("network", "txHash", "depositAddress");
