-- AlterTable
ALTER TABLE `etcentry` ADD COLUMN `priorEtcConfirmedAt` DATETIME(3) NULL,
    ADD COLUMN `priorEtcPending` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `priorEtcSourceMonth` VARCHAR(7) NULL;
