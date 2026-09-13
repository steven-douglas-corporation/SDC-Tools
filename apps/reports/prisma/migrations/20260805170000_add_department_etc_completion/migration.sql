-- Department ETC sign-off (§50): one row per department per report month.
--
-- The UNIQUE on (month, department) is what makes the write idempotent — the action
-- upserts against it, so a double-click or a duplicated realtime retry lands on the
-- same row instead of creating a second, contradictory status for the same month.
--
-- `year` / `monthNumber` are redundant with `month` and stored anyway, as
-- MonthlyReportSubmission does: §50 asks for the status to be stored separately by
-- report month AND report year, and grouping a report by year should not require
-- parsing a string.
--
-- No foreign key on `completedById`, on purpose: the name beside it is a snapshot, and
-- deleting a user must not either fail or cascade away a month's sign-off.
CREATE TABLE `DepartmentEtcCompletion` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `month` VARCHAR(7) NOT NULL,
  `year` INTEGER NOT NULL,
  `monthNumber` INTEGER NOT NULL,
  `department` VARCHAR(32) NOT NULL,
  `completed` BOOLEAN NOT NULL DEFAULT false,
  `completedById` INTEGER NULL,
  `completedByName` VARCHAR(191) NULL,
  `completedAt` DATETIME(3) NULL,
  `updatedAt` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `DepartmentEtcCompletion_month_department_key`(`month`, `department`),
  INDEX `DepartmentEtcCompletion_year_monthNumber_idx`(`year`, `monthNumber`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
