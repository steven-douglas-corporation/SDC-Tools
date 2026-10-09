-- AlterTable
-- Quoted Delivery is now a DATE the user enters; the grid derives the weeks from it and the
-- start date. Replaces the weeks column added by 20261009120000 (never populated by anyone but
-- the first test entries of this feature), so it is dropped rather than converted.
ALTER TABLE `Job` DROP COLUMN `quotedDeliveryWeeks`,
    ADD COLUMN `quotedDeliveryDate` DATETIME(3) NULL;
