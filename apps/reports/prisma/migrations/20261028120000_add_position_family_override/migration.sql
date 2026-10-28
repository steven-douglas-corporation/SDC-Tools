-- ── Position family overrides move from a file into the app (2026-10-28) ────
--
-- Replaces Position_Families_Overrides.xlsx on the SFTP share. Empty on deploy:
-- the first hourly pass after it copies the file in once (lib/position-families-sync.ts),
-- so nobody's team moves on the switch.
CREATE TABLE `PositionFamilyOverride` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `positionCode` VARCHAR(191) NOT NULL,
    `familyCode` VARCHAR(191) NOT NULL,
    `familyName` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NULL,
    `updatedByEmail` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PositionFamilyOverride_positionCode_familyCode_key`(`positionCode`, `familyCode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
