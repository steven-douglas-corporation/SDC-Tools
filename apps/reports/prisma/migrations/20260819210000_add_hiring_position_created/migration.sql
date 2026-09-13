-- CreateTable
CREATE TABLE `HiringPositionCreated` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `title` VARCHAR(191) NOT NULL,
  `jobStatus` VARCHAR(32) NOT NULL,
  `workforceGroup` VARCHAR(32) NOT NULL,
  `department` VARCHAR(64) NOT NULL,
  `workLocDescription` VARCHAR(191) NULL,
  `remote` BOOLEAN NOT NULL DEFAULT false,
  `internal` BOOLEAN NOT NULL DEFAULT false,
  `createdByEmail` VARCHAR(191) NULL,
  `updatedByEmail` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4;
