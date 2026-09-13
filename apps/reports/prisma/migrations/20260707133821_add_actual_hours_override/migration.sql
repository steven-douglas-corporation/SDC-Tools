-- AlterTable
ALTER TABLE `jobmonthlyactualhours` ADD COLUMN `overridden` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `overriddenAt` DATETIME(3) NULL,
    ADD COLUMN `overriddenNote` VARCHAR(191) NULL;
