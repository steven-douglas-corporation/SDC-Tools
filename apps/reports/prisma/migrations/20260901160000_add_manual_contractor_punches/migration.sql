-- ── Manual contractor punches — TEMPORARY (2026-09-01) ──────────────────────
--
-- Paylocity's Job Hours report is not carrying temp/contractor punches for
-- July-August 2026. Until it is fixed, the supplied timecards live here, one row
-- per punch SEGMENT, and are merged into the hours feed so every page that
-- consumes normalized hours sees them.
--
-- Nothing else is touched: this migration only creates a table. No existing
-- hours, ETC entry, quote or submission is modified.
--
-- Rollback once Paylocity is fixed is `DROP TABLE ManualContractorPunch;` plus
-- removing the merge in lib/hours-feed.ts. Nobody has to remember to do it
-- promptly, though — the merge suppresses any (employee, work date) the official
-- feed already carries, so a fixed Paylocity report wins on its own.
CREATE TABLE `ManualContractorPunch` (
  `id`             INTEGER      NOT NULL AUTO_INCREMENT,
  `employeeName`   VARCHAR(191) NOT NULL,
  `employeeRef`    VARCHAR(32)  NOT NULL,
  -- A STRING, deliberately: these contractors have no integer Paylocity id yet,
  -- and the pipeline already types employeeId as a string throughout.
  `paylocityId`    VARCHAR(32)  NOT NULL,
  `workDate`       DATE         NOT NULL,
  -- The transfer value verbatim ("211/1158/10/Concord") next to its parsed parts,
  -- so the parse is auditable against the screenshot rather than trusted.
  `transferRaw`    VARCHAR(64)  NOT NULL,
  `jobNumber`      VARCHAR(32)  NOT NULL,
  `machineSec`     VARCHAR(16)  NOT NULL,
  `functionId`     VARCHAR(16)  NOT NULL,
  `location`       VARCHAR(64)  NOT NULL DEFAULT '',
  `startTime`      VARCHAR(5)   NOT NULL,
  `endTime`        VARCHAR(5)   NOT NULL,
  -- DERIVED from startTime/endTime at seed time. Never estimated, never a daily
  -- total: a multi-job day is several rows, one per segment.
  `hours`          DECIMAL(6,4) NOT NULL,
  `source`         VARCHAR(64)  NOT NULL DEFAULT 'manual_contractor_timecard',
  -- The screenshot's pay period, for the audit trail only. Every report groups by
  -- workDate, so July 1-3 on a June-starting period still count as July.
  `payPeriod`      VARCHAR(32)  NOT NULL,
  `note`           VARCHAR(255) NULL,
  `active`         BOOLEAN      NOT NULL DEFAULT true,
  `supersededAt`   DATETIME(3)  NULL,
  `createdAt`      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdByEmail` VARCHAR(191) NULL,

  -- One row per punch segment; re-running the seed updates in place.
  UNIQUE INDEX `manual_punch_segment`(`paylocityId`, `workDate`, `startTime`, `endTime`, `jobNumber`, `machineSec`, `functionId`),
  INDEX `ManualContractorPunch_workDate_idx`(`workDate`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
