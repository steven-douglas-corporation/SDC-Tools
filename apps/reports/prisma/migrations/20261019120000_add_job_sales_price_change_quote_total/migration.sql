-- AlterTable
-- Manually entered contract figures shown after Complete Date on the Projects grid.
-- Nullable with no default: blank means "not entered yet", which is different from 0.
ALTER TABLE `Job` ADD COLUMN `salesPrice` DECIMAL(12, 2) NULL,
    ADD COLUMN `changeQuote` DECIMAL(12, 2) NULL,
    ADD COLUMN `totalPrice` DECIMAL(12, 2) NULL;
