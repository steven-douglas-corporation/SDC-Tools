-- Adds the standardization columns as real, indexed columns so every page's Group By
-- is a plain SQL GROUP BY. `section` still holds the OLD folded/split value at this
-- point in history — the next migration (20260821151000) tightens the unique key once
-- a full resync (scripts/resync-raw-pair-storage.ts) has rewritten `section` to be the
-- raw pair everywhere.
ALTER TABLE `JobHoursDetail`
  ADD COLUMN `standardDepartment` VARCHAR(191) NOT NULL DEFAULT '',
  ADD COLUMN `standardTaskDescription` VARCHAR(191) NOT NULL DEFAULT '',
  ADD COLUMN `mappingStatus` VARCHAR(191) NOT NULL DEFAULT '';

CREATE INDEX `JobHoursDetail_standardDepartment_idx` ON `JobHoursDetail` (`standardDepartment`);
CREATE INDEX `JobHoursDetail_mappingStatus_idx` ON `JobHoursDetail` (`mappingStatus`);
