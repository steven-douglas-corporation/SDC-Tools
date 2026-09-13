-- AlterTable
ALTER TABLE `HiringPositionAssignment` ADD COLUMN `isVisible` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `HiringPositionCreated` ADD COLUMN `isVisible` BOOLEAN NOT NULL DEFAULT true;
