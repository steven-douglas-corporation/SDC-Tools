-- CreateTable
CREATE TABLE `ProjectRelease` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `jobId` INTEGER NOT NULL,
    `fileName` VARCHAR(191) NOT NULL,
    `uploadedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `uploadedBy` VARCHAR(191) NULL,
    `receiptOfPo` DATETIME(3) NULL,
    `deliveryWeeks` INTEGER NULL,
    `deliveryDate` VARCHAR(191) NULL,
    `penalty` BOOLEAN NOT NULL DEFAULT false,
    `penaltyWeeks` INTEGER NULL,
    `milestones` JSON NULL,
    `budgetImage` LONGTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ProjectRelease_jobId_key`(`jobId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ProjectRelease` ADD CONSTRAINT `ProjectRelease_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `Job`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
