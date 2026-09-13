-- §42.11/§42.12: the punch-level rows behind the Undefined Hours KPI, so the card and
-- its drill-through are two views of one stored result rather than two computations.
-- CreateTable
CREATE TABLE `UndefinedHoursRow` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `month` VARCHAR(191) NOT NULL,
    `reason` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `workDate` DATE NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `section` VARCHAR(191) NOT NULL,
    `hours` DECIMAL(10, 2) NOT NULL,
    `sourceRow` INTEGER NOT NULL,
    `sourceFile` VARCHAR(191) NOT NULL,
    `importId` VARCHAR(191) NOT NULL,
    `countsTowardKpi` BOOLEAN NOT NULL DEFAULT true,
    `syncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `UndefinedHoursRow_month_idx`(`month`),
    INDEX `UndefinedHoursRow_month_countsTowardKpi_idx`(`month`, `countsTowardKpi`),
    INDEX `UndefinedHoursRow_importId_idx`(`importId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- §42.20: one row per Paylocity file import. `sha256` is the file VERSION identity —
-- Lisa replaces the workbook keeping the same name, so a filename and a timestamp do
-- not identify a version and only the content hash does.
-- CreateTable
CREATE TABLE `PaylocityImport` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `importId` VARCHAR(191) NOT NULL,
    `refreshId` VARCHAR(191) NULL,
    `fileName` VARCHAR(191) NOT NULL,
    `filePath` TEXT NOT NULL,
    `fileSize` INTEGER NOT NULL,
    `fileModifiedAt` DATETIME(3) NOT NULL,
    `sha256` VARCHAR(191) NOT NULL,
    `sheet` VARCHAR(191) NOT NULL,
    `reportFrom` DATE NULL,
    `reportTo` DATE NULL,
    `monthsCovered` TEXT NOT NULL,
    `rowsRead` INTEGER NOT NULL DEFAULT 0,
    `rowsInserted` INTEGER NOT NULL DEFAULT 0,
    `rowsUpdated` INTEGER NOT NULL DEFAULT 0,
    `rowsRemoved` INTEGER NOT NULL DEFAULT 0,
    `segmentsMerged` INTEGER NOT NULL DEFAULT 0,
    `rowsInvalid` INTEGER NOT NULL DEFAULT 0,
    `rowsUndefined` INTEGER NOT NULL DEFAULT 0,
    `undefinedHours` DECIMAL(10, 2) NOT NULL DEFAULT 0,
    `startedAt` DATETIME(3) NOT NULL,
    `completedAt` DATETIME(3) NULL,
    `durationMs` INTEGER NULL,
    `trigger` VARCHAR(191) NOT NULL,
    `userName` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL,
    `failureStage` VARCHAR(191) NULL,
    `failureDetail` TEXT NULL,
    `appVersion` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `PaylocityImport_importId_key`(`importId`),
    INDEX `PaylocityImport_sha256_idx`(`sha256`),
    INDEX `PaylocityImport_startedAt_idx`(`startedAt`),
    INDEX `PaylocityImport_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
