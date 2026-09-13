-- Preserve the RAW Paylocity punch identity on every hours row.
--
-- `section` is the STANDARDIZED app column: the 10-311 30/70 split, the 414->413
-- merge and the 12/13/14-211 fold all rewrite it. That made the raw punch
-- unrecoverable, which in turn made two required things impossible — reproducing
-- the raw Paylocity PivotTable from app data, and validating a punch against the
-- approved Section+Function rule book (Section 40 + Function 311 is approved,
-- Section 10 + Function 311 is not, and `section` cannot tell them apart once
-- folded).
--
-- Both columns are NOT NULL DEFAULT '' rather than nullable: a punch whose
-- Section or Function cell was blank is a real punch with real hours that must
-- still reconcile, and it classifies as Undefined on exactly that basis.
ALTER TABLE `JobHoursDetail`
  ADD COLUMN `rawSection`  VARCHAR(191) NOT NULL DEFAULT '',
  ADD COLUMN `rawFunction` VARCHAR(191) NOT NULL DEFAULT '';

-- The old key summed two different raw punches into one row whenever
-- standardization folded them onto the same column (a 12-211 and a 14-211 punch
-- by one person on one day became a single 10-211 row), destroying the raw
-- distinction. The new key is the true punch grain.
--
-- `section` stays IN the key alongside the raw pair, and both are load-bearing:
-- the raw pair alone collides on the 10-311 split, whose two halves share one raw
-- pair and differ only by `section`.
--
-- Safe on existing data: the old key was already unique, and the two new columns
-- are constant ('') across every existing row, so the widened key cannot collide.
DROP INDEX `JobHoursDetail_jobId_section_workDate_employeeId_key` ON `JobHoursDetail`;

-- Short, explicit index names. NOT cosmetic: Prisma's default name for a
-- six-column unique key on this table is 75 characters and MySQL rejects any
-- identifier over 64 (error 1059), so the migration fails outright without them.
-- Both names are pinned via `map:` in schema.prisma so a later `prisma migrate
-- dev` cannot regenerate the over-long default.
CREATE UNIQUE INDEX `JobHoursDetail_punch_grain_key`
  ON `JobHoursDetail` (`jobId`, `section`, `workDate`, `employeeId`, `rawSection`, `rawFunction`);

-- Group-by-raw for the Undefined Hours drill-through and the reconciliation view.
CREATE INDEX `JobHoursDetail_raw_pair_idx`
  ON `JobHoursDetail` (`rawSection`, `rawFunction`);

-- NOTE: existing rows keep rawSection = rawFunction = '' deliberately. They are
-- NOT back-filled by guessing an inverse of the standardization, because for a
-- merged column that inverse does not exist — a stored `10-211` row could have
-- come from 10-211, 12-211, 13-211 or 14-211, and writing any one of those would
-- be fabricating provenance. Instead the next full hours sync rewrites every
-- month from the source file with the raw pair intact (sync is replace-by-job-
-- month, so this is self-healing). Run:
--
--   npx tsx scripts/verify-raw-punch-identity.ts
--
-- to confirm the backfill completed and that grouping by the raw pair reproduces
-- the raw Paylocity totals.
