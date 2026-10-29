-- ── Change quotes: per-change-quote hours + parts cost (additive) ───────────
--
-- Two new tables. Nothing existing is altered: EstimatedHours.quotedHours and
-- Job.costQuoted stay the totals every other part of the app reads, and "Original"
-- is derived from them (total minus applied change quotes). Safe to apply ahead of
-- the code — nothing reads these tables until the code that does is deployed.

-- CreateTable
CREATE TABLE `JobChangeQuote` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `jobId` INTEGER NOT NULL,
    `label` VARCHAR(64) NOT NULL,
    `amount` DECIMAL(12, 2) NULL,
    `partsCost` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `quoteDate` DATETIME(3) NULL,
    `note` VARCHAR(255) NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'Draft',
    `addedToTotals` BOOLEAN NOT NULL DEFAULT false,
    `appliedAt` DATETIME(3) NULL,
    `appliedByEmail` VARCHAR(191) NULL,
    `createdByEmail` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `JobChangeQuote_jobId_idx`(`jobId`),
    UNIQUE INDEX `JobChangeQuote_jobId_label_key`(`jobId`, `label`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `JobChangeQuoteHours` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `changeQuoteId` INTEGER NOT NULL,
    `section` VARCHAR(32) NOT NULL,
    `hours` INTEGER NOT NULL,

    UNIQUE INDEX `JobChangeQuoteHours_changeQuoteId_section_key`(`changeQuoteId`, `section`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `JobChangeQuote` ADD CONSTRAINT `JobChangeQuote_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `Job`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `JobChangeQuoteHours` ADD CONSTRAINT `JobChangeQuoteHours_changeQuoteId_fkey` FOREIGN KEY (`changeQuoteId`) REFERENCES `JobChangeQuote`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
