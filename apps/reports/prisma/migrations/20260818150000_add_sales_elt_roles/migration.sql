-- AlterTable
-- Widen-then-narrow: MySQL enums require every existing row's value to remain
-- valid at every step, so ADMIN can't be dropped in the same statement that
-- adds ALL/SALES/ELT while ADMIN rows still exist.
--
-- NOT run automatically as part of this commit — this must be applied in the
-- SAME deploy as the code that reads the new Role values (proxy.ts, the page
-- guards, etc.), never before it. Applying it early would silently disable
-- `canManageDepartment`'s ADMIN escape hatch for whatever old code is still
-- running (it checks `=== "ADMIN"`, and this migration leaves zero rows with
-- that value).
ALTER TABLE `User` MODIFY `role` ENUM('MANAGER', 'ADMIN', 'ALL', 'SALES', 'ELT') NOT NULL DEFAULT 'ALL';

UPDATE `User` SET `role` = 'ELT' WHERE `role` = 'ADMIN';

ALTER TABLE `User` MODIFY `role` ENUM('ALL', 'MANAGER', 'SALES', 'ELT') NOT NULL DEFAULT 'ALL';
