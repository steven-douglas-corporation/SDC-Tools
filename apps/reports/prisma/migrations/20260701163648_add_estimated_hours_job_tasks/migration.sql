/*
  Warnings:

  - You are about to drop the column `hours` on the `estimatedhours` table. All the data in the column will be lost.
  - Added the required column `updatedAt` to the `EstimatedHours` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `estimatedhours` DROP COLUMN `hours`,
    ADD COLUMN `actualHistoricalHours` DECIMAL(10, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `estimateToCompleteHours` DECIMAL(10, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `quotedHours` DECIMAL(10, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `updatedAt` DATETIME(3) NOT NULL;

-- AlterTable
ALTER TABLE `job` ADD COLUMN `completeDate` DATETIME(3) NULL,
    ADD COLUMN `costActualHistorical` DECIMAL(12, 2) NULL,
    ADD COLUMN `costQuoted` DECIMAL(12, 2) NULL,
    ADD COLUMN `includeInTypeCalc` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `startDate` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `JobTask` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `jobId` INTEGER NOT NULL,
    `slot` INTEGER NOT NULL,
    `taskName` VARCHAR(191) NOT NULL,
    `estimateToCompleteHours` DECIMAL(10, 2) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `JobTask_jobId_slot_key`(`jobId`, `slot`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `JobTask` ADD CONSTRAINT `JobTask_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `Job`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
