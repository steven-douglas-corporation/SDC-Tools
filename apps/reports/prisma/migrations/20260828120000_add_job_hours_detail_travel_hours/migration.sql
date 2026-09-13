-- The travel PORTION of a punch row's hours, from the Paylocity export's own
-- "Travel" column. Hours rather than a label because Travel sits inside the Job
-- Hours Report's group-by grain but not this table's -- see sync-actuals.ts.
--
-- NULL-able on purpose and with no default: every existing row must read "not
-- known" until the next hours sync rewrites it from the workbook. A DEFAULT 0
-- would have made 29k historical rows claim a measured zero travel, which is a
-- wrong number rather than a missing one.
ALTER TABLE `JobHoursDetail` ADD COLUMN `travelHours` DECIMAL(10, 2) NULL;
