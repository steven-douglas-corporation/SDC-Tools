-- Punch-level actual hours (employee x day x job x section) — the detail behind
-- JobMonthlyActualHours, feeding the in-app Hours Detail drillthrough.
CREATE TABLE `JobHoursDetail` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `jobId` INTEGER NOT NULL,
    `section` VARCHAR(191) NOT NULL,
    `month` VARCHAR(191) NOT NULL,
    `workDate` DATE NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `hours` DECIMAL(10, 2) NOT NULL,
    `source` VARCHAR(191) NOT NULL DEFAULT 'sharepoint',
    `syncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `JobHoursDetail_jobId_month_idx`(`jobId`, `month`),
    UNIQUE INDEX `JobHoursDetail_jobId_section_workDate_employeeId_key`(`jobId`, `section`, `workDate`, `employeeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `JobHoursDetail` ADD CONSTRAINT `JobHoursDetail_jobId_fkey`
    FOREIGN KEY (`jobId`) REFERENCES `Job`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
