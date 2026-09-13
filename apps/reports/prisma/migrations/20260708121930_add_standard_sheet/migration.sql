-- CreateTable
CREATE TABLE `ExecutionRate` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `jobId` INTEGER NOT NULL,
    `engrRate` DECIMAL(10, 2) NOT NULL DEFAULT 170,
    `shopRate` DECIMAL(10, 2) NOT NULL DEFAULT 140,
    `partsMarkup` DECIMAL(10, 4) NOT NULL DEFAULT 1.2,
    `updatedById` INTEGER NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ExecutionRate_jobId_key`(`jobId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FeeAllotment` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `jobId` INTEGER NOT NULL,
    `category` ENUM('ENGINEERING_PM', 'ENGINEERING_WARRANTY', 'SHOP_MANUFACTURING', 'SHOP_WARRANTY') NOT NULL,
    `hours` DECIMAL(10, 2) NOT NULL,
    `month` VARCHAR(191) NOT NULL,
    `source` VARCHAR(191) NOT NULL DEFAULT 'manual',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `FeeAllotment_jobId_category_month_key`(`jobId`, `category`, `month`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CategoryPool` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `category` ENUM('ENGINEERING_PM', 'ENGINEERING_WARRANTY', 'SHOP_MANUFACTURING', 'SHOP_WARRANTY') NOT NULL,
    `month` VARCHAR(191) NOT NULL,
    `previousMonthPulledHours` DECIMAL(10, 2) NOT NULL,
    `newHoursAddedThisMonth` DECIMAL(10, 2) NOT NULL,
    `hoursAvailable` DECIMAL(10, 2) NOT NULL,
    `hoursWorkedThisMonth` DECIMAL(10, 2) NOT NULL,
    `hoursPulledThisMonth` DECIMAL(10, 2) NOT NULL,
    `newEtcHours` DECIMAL(10, 2) NOT NULL,
    `rate` DECIMAL(10, 2) NOT NULL,
    `standardFee` DECIMAL(12, 2) NOT NULL,
    `source` VARCHAR(191) NOT NULL DEFAULT 'manual',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `CategoryPool_category_month_key`(`category`, `month`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StandardFeeSnapshot` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `month` VARCHAR(191) NOT NULL,
    `submittedById` INTEGER NULL,
    `submittedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `totalEngr` DECIMAL(12, 2) NOT NULL,
    `totalShop` DECIMAL(12, 2) NOT NULL,
    `totalParts` DECIMAL(12, 2) NOT NULL,

    UNIQUE INDEX `StandardFeeSnapshot_month_key`(`month`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ExecutionRate` ADD CONSTRAINT `ExecutionRate_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `Job`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ExecutionRate` ADD CONSTRAINT `ExecutionRate_updatedById_fkey` FOREIGN KEY (`updatedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FeeAllotment` ADD CONSTRAINT `FeeAllotment_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `Job`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StandardFeeSnapshot` ADD CONSTRAINT `StandardFeeSnapshot_submittedById_fkey` FOREIGN KEY (`submittedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
