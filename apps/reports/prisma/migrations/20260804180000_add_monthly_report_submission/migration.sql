-- One record per monthly-report submission attempt (successful or refused).
-- `submissionId` is the client-generated idempotency key; UNIQUE is what makes a
-- retried or double-clicked submission a no-op rather than a second freeze.
CREATE TABLE `MonthlyReportSubmission` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `submissionId` VARCHAR(64) NOT NULL,
  `month` VARCHAR(7) NOT NULL,
  `year` INTEGER NOT NULL,
  `monthNumber` INTEGER NOT NULL,
  `userId` INTEGER NULL,
  `userName` VARCHAR(191) NOT NULL,
  `status` VARCHAR(16) NOT NULL,
  `appVersion` VARCHAR(32) NOT NULL,
  `sections` TEXT NOT NULL,
  `validation` TEXT NOT NULL,
  `failureReason` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `MonthlyReportSubmission_submissionId_key`(`submissionId`),
  INDEX `MonthlyReportSubmission_month_idx`(`month`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
