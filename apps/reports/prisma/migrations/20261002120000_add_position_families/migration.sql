-- AlterTable
-- Paylocity's Position Code, mirrored by the hourly roster sync (see the
-- Employee.positionCode comment in schema.prisma). Nullable: people not in
-- Paylocity, and older exports without the column, have none.
ALTER TABLE `Employee` ADD COLUMN `positionCode` VARCHAR(191) NULL;

-- CreateTable
-- Position Code → family, from Paylocity's Position_Families report plus our
-- overrides file (see the PositionFamily comment in schema.prisma). Replaced
-- whole on every hourly pass.
CREATE TABLE `PositionFamily` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `positionCode` VARCHAR(191) NOT NULL,
    `familyCode` VARCHAR(191) NOT NULL,
    `familyName` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NULL,
    `headcount` INTEGER NULL,
    `source` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PositionFamily_positionCode_idx`(`positionCode`),
    UNIQUE INDEX `PositionFamily_positionCode_familyCode_source_key`(`positionCode`, `familyCode`, `source`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
