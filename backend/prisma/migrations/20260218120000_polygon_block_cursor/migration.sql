-- AlterTable: Polygon cursor-based scan (last processed block number)
ALTER TABLE "block_cursors" ADD COLUMN "lastProcessedBlock" INTEGER;
