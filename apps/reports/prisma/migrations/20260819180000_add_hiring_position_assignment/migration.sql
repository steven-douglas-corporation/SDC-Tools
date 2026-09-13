-- CreateTable
CREATE TABLE `HiringPositionAssignment` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `positionSourceId` VARCHAR(64) NOT NULL,
  `workforceGroup` VARCHAR(32) NULL,
  `department` VARCHAR(64) NULL,
  `updatedByEmail` VARCHAR(191) NULL,
  `updatedAt` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `HiringPositionAssignment_positionSourceId_key`(`positionSourceId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4;
