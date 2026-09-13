-- A content digest per (job, month) bucket of punch rows, so a refresh can rewrite
-- only the buckets whose contents actually changed.
--
-- Measured before this existed (2026-08-25): syncJobHoursDetail ran 1,146 sequential
-- delete-then-insert transactions per refresh, rewriting all 28,972 JobHoursDetail
-- rows every pass — 10.5s of a 17.4s refresh, the largest single cost in the app.
-- Twelve of the twenty months it rewrote are closed 2025 history whose source
-- workbook (Job_Hours_2025.xlsx) has not been saved since 2026-06-03, so the great
-- majority of that work reproduced byte-identical rows.
--
-- Starts EMPTY on purpose. An absent digest means "unknown", which is treated as
-- changed, so the first refresh after this migration rewrites every bucket exactly as
-- before and fills the table in. There is no backfill to get wrong: the digest is only
-- ever a cache of what the rows already say.
CREATE TABLE `JobHoursBucket` (
  `jobId`    INTEGER  NOT NULL,
  `month`    VARCHAR(191) NOT NULL,
  `digest`   CHAR(64) NOT NULL,
  `rows`     INTEGER  NOT NULL,
  `syncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`jobId`, `month`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Cascade with the job: a digest outliving its job would let a later row reusing that
-- primary key skip a write it needs, which would present as silently missing punches.
ALTER TABLE `JobHoursBucket`
  ADD CONSTRAINT `JobHoursBucket_jobId_fkey`
  FOREIGN KEY (`jobId`) REFERENCES `Job`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
