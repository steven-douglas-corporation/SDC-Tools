-- One row per application-wide refresh pass (§25.11), and the single-row lock that
-- makes sure only one runs at a time across every app server (§25.10).
CREATE TABLE `RefreshRun` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `refreshId` VARCHAR(64) NOT NULL,
  `trigger` VARCHAR(16) NOT NULL,
  `userId` INTEGER NULL,
  `userName` VARCHAR(191) NULL,
  `startedAt` DATETIME(3) NOT NULL,
  `completedAt` DATETIME(3) NULL,
  `durationMs` INTEGER NULL,
  `appVersion` VARCHAR(32) NOT NULL,
  `status` VARCHAR(16) NOT NULL,
  `sourcesOk` INTEGER NOT NULL DEFAULT 0,
  `sourcesFailed` INTEGER NOT NULL DEFAULT 0,
  `sourcesSkipped` INTEGER NOT NULL DEFAULT 0,
  `steps` TEXT NOT NULL,
  `failureDetail` TEXT NULL,

  UNIQUE INDEX `RefreshRun_refreshId_key`(`refreshId`),
  INDEX `RefreshRun_startedAt_idx`(`startedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `RefreshLock` (
  `id` INTEGER NOT NULL,
  `holder` VARCHAR(128) NULL,
  `startedAt` DATETIME(3) NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The single lock row has to exist for the conditional UPDATE to claim.
INSERT INTO `RefreshLock` (`id`, `holder`, `startedAt`) VALUES (1, NULL, NULL);
