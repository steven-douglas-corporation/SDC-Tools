-- AlterTable
-- Net Terms (payment terms, in days) shown after Total on the Projects grid.
-- Existing jobs start at 30; it is editable per job afterwards.
ALTER TABLE `Job` ADD COLUMN `netTerms` INTEGER NOT NULL DEFAULT 30;
