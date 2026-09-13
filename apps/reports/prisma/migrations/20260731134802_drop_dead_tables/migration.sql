/*
  Warnings:

  - You are about to drop the `actualhours` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `feeallotment` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `standardfeesnapshot` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE `actualhours` DROP FOREIGN KEY `ActualHours_employeeId_fkey`;

-- DropForeignKey
ALTER TABLE `actualhours` DROP FOREIGN KEY `ActualHours_jobId_fkey`;

-- DropForeignKey
ALTER TABLE `feeallotment` DROP FOREIGN KEY `FeeAllotment_jobId_fkey`;

-- DropForeignKey
ALTER TABLE `standardfeesnapshot` DROP FOREIGN KEY `StandardFeeSnapshot_submittedById_fkey`;

-- DropTable
DROP TABLE `actualhours`;

-- DropTable
DROP TABLE `feeallotment`;

-- DropTable
DROP TABLE `standardfeesnapshot`;

-- Orphaned freshness record. `dataset_refresh` was written only by
-- powerbi-refresh.ts (removed in ce9db58) and read by nothing -- the ETC header
-- only ever reads the "hours_actual" row. It sat frozen on
-- "Failed: ModelRefreshFailed_CredentialsNotSpecified" since 2026-07-19, which
-- read as a live problem but was only the last trace of that module.
DELETE FROM `PowerBiFreshness` WHERE `source` = 'dataset_refresh';
