-- CreateTable
CREATE TABLE `BuildReadinessJobSnapshot` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `jobId` VARCHAR(32) NOT NULL,
    `jobName` VARCHAR(255) NOT NULL,
    `customer` VARCHAR(255) NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'ok',
    `overallReadinessPct` INTEGER NOT NULL DEFAULT 0,
    `assembliesTotal` INTEGER NOT NULL DEFAULT 0,
    `assembliesReady` INTEGER NOT NULL DEFAULT 0,
    `assembliesPartial` INTEGER NOT NULL DEFAULT 0,
    `assembliesBlocked` INTEGER NOT NULL DEFAULT 0,
    `partsUncovered` INTEGER NOT NULL DEFAULT 0,
    `partsOnOrder` INTEGER NOT NULL DEFAULT 0,
    `partsPastDue` INTEGER NOT NULL DEFAULT 0,
    `partsDueSoon7d` INTEGER NOT NULL DEFAULT 0,
    `materialValueTotal` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `materialValueAtRisk` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `nextUnlockDate` DATETIME(3) NULL,
    `detailJson` TEXT NOT NULL,
    `computedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `BuildReadinessJobSnapshot_jobId_key`(`jobId`),
    INDEX `BuildReadinessJobSnapshot_overallReadinessPct_idx`(`overallReadinessPct`),
    INDEX `BuildReadinessJobSnapshot_customer_idx`(`customer`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BuildReadinessRefreshMeta` (
    `id` INTEGER NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'idle',
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `jobsTotal` INTEGER NOT NULL DEFAULT 0,
    `jobsDone` INTEGER NOT NULL DEFAULT 0,
    `jobsFailed` INTEGER NOT NULL DEFAULT 0,
    `triggeredByName` VARCHAR(191) NULL,
    `durationMs` INTEGER NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BuildReadinessSavedView` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `scope` VARCHAR(16) NOT NULL,
    `owner` VARCHAR(191) NULL,
    `config` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `BuildReadinessSavedView_scope_name_key`(`scope`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Seed the singleton refresh-meta row (id=1), matching the JobCostDefaultRate
-- singleton pattern: the app always upserts against id=1 rather than creating
-- it lazily, so an empty table would otherwise mean every very first read has
-- to special-case "no row yet" for no reason.
INSERT INTO `BuildReadinessRefreshMeta` (`id`, `status`, `updatedAt`) VALUES (1, 'idle', CURRENT_TIMESTAMP(3));
