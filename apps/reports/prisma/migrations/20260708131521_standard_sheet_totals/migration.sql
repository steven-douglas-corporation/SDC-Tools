-- AlterTable
ALTER TABLE `executionrate` ADD COLUMN `contingencyAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `notes` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `StandardSheetSetting` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `contingencyRate` DECIMAL(6, 2) NOT NULL DEFAULT 1.2,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
