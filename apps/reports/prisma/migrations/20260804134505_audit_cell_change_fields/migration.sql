-- AlterTable
ALTER TABLE `auditlog` ADD COLUMN `appVersion` VARCHAR(191) NULL,
    ADD COLUMN `changeId` VARCHAR(191) NULL,
    ADD COLUMN `changeType` VARCHAR(191) NULL,
    ADD COLUMN `columnName` VARCHAR(191) NULL,
    ADD COLUMN `newValue` VARCHAR(191) NULL,
    ADD COLUMN `previousValue` VARCHAR(191) NULL,
    ADD COLUMN `rowRef` VARCHAR(191) NULL,
    ADD COLUMN `tab` VARCHAR(191) NULL,
    ADD COLUMN `userName` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `AuditLog_tab_rowRef_columnName_createdAt_idx` ON `AuditLog`(`tab`, `rowRef`, `columnName`, `createdAt`);

-- CreateIndex
CREATE INDEX `AuditLog_changeId_idx` ON `AuditLog`(`changeId`);
