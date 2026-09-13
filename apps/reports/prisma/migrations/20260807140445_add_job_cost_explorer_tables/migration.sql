-- CreateTable
CREATE TABLE `JobCostDefaultRate` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `engRate` DECIMAL(8, 2) NOT NULL DEFAULT 200,
    `shopRate` DECIMAL(8, 2) NOT NULL DEFAULT 150,
    `pmPct` DECIMAL(5, 2) NOT NULL DEFAULT 10,
    `mfgPct` DECIMAL(5, 2) NOT NULL DEFAULT 10,
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedById` INTEGER NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `JobCostYearRate` (
    `year` VARCHAR(4) NOT NULL,
    `engRate` DECIMAL(8, 2) NULL,
    `shopRate` DECIMAL(8, 2) NULL,
    `pmPct` DECIMAL(5, 2) NULL,
    `mfgPct` DECIMAL(5, 2) NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedById` INTEGER NULL,

    PRIMARY KEY (`year`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `JobCostHourAllocation` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `jobId` VARCHAR(32) NOT NULL,
    `type` VARCHAR(8) NOT NULL,
    `year` VARCHAR(4) NOT NULL,
    `hours` DECIMAL(8, 2) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedById` INTEGER NULL,

    INDEX `JobCostHourAllocation_jobId_idx`(`jobId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
