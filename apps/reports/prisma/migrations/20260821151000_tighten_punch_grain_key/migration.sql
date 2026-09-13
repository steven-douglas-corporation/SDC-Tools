-- Tighten the unique key now that scripts/resync-raw-pair-storage.ts has rewritten
-- every row so `section` IS the raw pair. Drops the now-redundant rawSection/
-- rawFunction from the key (section already encodes them) and matches the schema's
-- final @@unique([jobId, section, workDate, employeeId]).
--
-- Safe only AFTER the resync: before it, two different raw pairs could share one
-- (section, workDate, employeeId) tuple whenever they folded onto the same
-- standardized section (that is what the earlier CONCAT-mismatch rows were).
DROP INDEX `JobHoursDetail_punch_grain_key` ON `JobHoursDetail`;
CREATE UNIQUE INDEX `JobHoursDetail_punch_grain_key`
  ON `JobHoursDetail` (`jobId`, `section`, `workDate`, `employeeId`);
