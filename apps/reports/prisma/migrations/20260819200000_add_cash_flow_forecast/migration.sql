-- CreateTable
CREATE TABLE `CashFlowSnapshot` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `snapshotTimestamp` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `snapshotDate` DATE NOT NULL,
  `sourceRefreshTimestamp` DATETIME(3) NOT NULL,
  `createdBy` VARCHAR(191) NULL,
  `contentHash` VARCHAR(64) NOT NULL,
  `lineCount` INTEGER NOT NULL,

  INDEX `CashFlowSnapshot_snapshotDate_idx`(`snapshotDate`),
  INDEX `CashFlowSnapshot_snapshotTimestamp_idx`(`snapshotTimestamp`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4;

-- CreateTable
CREATE TABLE `CashFlowSnapshotLine` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `snapshotId` INTEGER NOT NULL,
  `projectId` VARCHAR(20) NOT NULL,
  `customer` VARCHAR(191) NULL,
  `forecastMonth` VARCHAR(7) NOT NULL,
  `flowType` VARCHAR(8) NOT NULL,
  `category` VARCHAR(8) NOT NULL,
  `amount` DECIMAL(14, 2) NOT NULL,

  INDEX `CashFlowSnapshotLine_snapshotId_projectId_idx`(`snapshotId`, `projectId`),
  INDEX `CashFlowSnapshotLine_snapshotId_forecastMonth_idx`(`snapshotId`, `forecastMonth`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4;

-- CreateTable
CREATE TABLE `CashFlowEtcAllocation` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `projectId` VARCHAR(20) NOT NULL,
  `forecastMonth` VARCHAR(7) NOT NULL,
  `amount` DECIMAL(14, 2) NOT NULL,
  `note` VARCHAR(500) NULL,
  `updatedByEmail` VARCHAR(191) NULL,
  `updatedAt` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `CashFlowEtcAllocation_projectId_forecastMonth_key`(`projectId`, `forecastMonth`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4;

-- CreateTable
CREATE TABLE `CashFlowForecastOverride` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `projectId` VARCHAR(20) NOT NULL,
  `category` VARCHAR(8) NOT NULL,
  `forecastMonth` VARCHAR(7) NOT NULL,
  `amount` DECIMAL(14, 2) NOT NULL,
  `note` VARCHAR(500) NULL,
  `updatedByEmail` VARCHAR(191) NULL,
  `updatedAt` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `CashFlowForecastOverride_projectId_category_forecastMonth_key`(`projectId`, `category`, `forecastMonth`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4;

-- AddForeignKey
ALTER TABLE `CashFlowSnapshotLine` ADD CONSTRAINT `CashFlowSnapshotLine_snapshotId_fkey` FOREIGN KEY (`snapshotId`) REFERENCES `CashFlowSnapshot`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
