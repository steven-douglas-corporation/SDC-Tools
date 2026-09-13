-- AlterTable
-- TEXT's 64KB limit was silently dropping the snapshot for any active job
-- whose assemblies+blockers+vendors+upcoming JSON grew past it (found live —
-- 20 of 50 active jobs failed with MySQL error 1406 before this fix).
ALTER TABLE `BuildReadinessJobSnapshot` MODIFY `detailJson` LONGTEXT NOT NULL;
