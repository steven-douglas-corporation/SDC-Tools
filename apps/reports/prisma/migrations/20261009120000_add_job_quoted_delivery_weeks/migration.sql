-- AlterTable
-- Quoted delivery in weeks from the job's start date. Nullable and additive: the Projects
-- grid derives the FAT Date from startDate + this, so nothing existing changes.
ALTER TABLE `Job` ADD COLUMN `quotedDeliveryWeeks` INTEGER NULL;
