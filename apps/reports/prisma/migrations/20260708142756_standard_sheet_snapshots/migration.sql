-- CreateTable
CREATE TABLE `StandardSheetSnapshot` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `jobId` INTEGER NOT NULL,
    `month` VARCHAR(191) NOT NULL,
    `engrRate` DECIMAL(10, 2) NOT NULL,
    `shopRate` DECIMAL(10, 2) NOT NULL,
    `partsMarkup` DECIMAL(10, 4) NOT NULL,
    `etcEngineering` DECIMAL(12, 2) NOT NULL,
    `etcShop` DECIMAL(12, 2) NOT NULL,
    `etcParts` DECIMAL(12, 2) NOT NULL,
    `totalEtcDollars` DECIMAL(14, 2) NOT NULL,
    `percentOfTotal` DECIMAL(9, 6) NOT NULL,
    `standardFeeEngineering` DECIMAL(14, 2) NOT NULL,
    `standardFeeShop` DECIMAL(14, 2) NOT NULL,
    `contingencyAmount` DECIMAL(12, 2) NOT NULL,
    `contingencyRate` DECIMAL(6, 2) NOT NULL,
    `totalStandardFees` DECIMAL(14, 2) NOT NULL,
    `notes` VARCHAR(191) NULL,
    `submittedById` INTEGER NULL,
    `submittedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `StandardSheetSnapshot_month_idx`(`month`),
    UNIQUE INDEX `StandardSheetSnapshot_jobId_month_key`(`jobId`, `month`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `StandardSheetSnapshot` ADD CONSTRAINT `StandardSheetSnapshot_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `Job`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StandardSheetSnapshot` ADD CONSTRAINT `StandardSheetSnapshot_submittedById_fkey` FOREIGN KEY (`submittedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
