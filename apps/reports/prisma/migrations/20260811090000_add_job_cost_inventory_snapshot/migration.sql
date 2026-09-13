-- CreateTable
CREATE TABLE `JobCostInventorySnapshot` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `jobId` VARCHAR(32) NOT NULL,
    `asOfDate` DATETIME(3) NOT NULL,
    `salesPrice` DECIMAL(14, 2) NULL,
    `percentComplete` DECIMAL(6, 2) NULL,
    `sourceFile` VARCHAR(255) NOT NULL,
    `sourceSheet` VARCHAR(128) NOT NULL,
    `syncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `JobCostInventorySnapshot_asOfDate_idx`(`asOfDate`),
    UNIQUE INDEX `JobCostInventorySnapshot_jobId_asOfDate_key`(`jobId`, `asOfDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
