-- AlterTable
-- Position title, sourced from Employee_Department_Map.xlsx (see
-- scripts/import-employee-departments.ts) — no upstream system carries a
-- title today, so this is populated from that sheet alone.
ALTER TABLE `Employee` ADD COLUMN `positionTitle` VARCHAR(191) NULL;
