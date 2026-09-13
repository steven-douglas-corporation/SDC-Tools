-- CreateTable
CREATE TABLE `HoursImportIssue` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `month` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `rows` INTEGER NOT NULL,
    `hours` DECIMAL(10, 2) NOT NULL,
    `syncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `HoursImportIssue_month_idx`(`month`),
    UNIQUE INDEX `HoursImportIssue_month_label_key`(`month`, `label`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
