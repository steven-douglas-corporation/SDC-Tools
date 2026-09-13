-- AlterTable
ALTER TABLE `job` ADD COLUMN `totEtoActEngHours` DECIMAL(10, 2) NULL,
    ADD COLUMN `totEtoActMfgHours` DECIMAL(10, 2) NULL,
    ADD COLUMN `totEtoEstEngHours` DECIMAL(10, 2) NULL,
    ADD COLUMN `totEtoEstMfgHours` DECIMAL(10, 2) NULL,
    ADD COLUMN `totEtoSyncedAt` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `JobMonthlyActualHours` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `jobId` INTEGER NOT NULL,
    `month` VARCHAR(191) NOT NULL,
    `actualHours` DECIMAL(10, 2) NOT NULL,
    `source` VARCHAR(191) NOT NULL DEFAULT 'power_bi',
    `syncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `JobMonthlyActualHours_jobId_month_key`(`jobId`, `month`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `JobMonthlyActualHours` ADD CONSTRAINT `JobMonthlyActualHours_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `Job`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
