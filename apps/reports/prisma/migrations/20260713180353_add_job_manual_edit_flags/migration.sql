-- AlterTable
ALTER TABLE `job` ADD COLUMN `costQuotedManuallyEdited` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `customerManuallyEdited` BOOLEAN NOT NULL DEFAULT false;
