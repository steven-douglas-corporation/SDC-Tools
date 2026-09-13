-- AlterTable
-- Readiness % was line-count-based (a line counted as "received" only when
-- 100% received, so a 99%-covered line scored the same as a 0%-covered one)
-- and, at the project level, double-counted a reused sub-assembly's parts
-- across every BOM position it legitimately appears at. Fixed by switching to
-- one quantity-weighted, whole-job-deduped formula (job-bom-rules.ts's
-- quantityReadiness). These two columns are its numerator/denominator,
-- persisted so the "notReleased" state and the "limited released scope" UI
-- indicator don't need to re-derive them from detailJson.
ALTER TABLE `BuildReadinessJobSnapshot`
  ADD COLUMN `requiredQtyTotal` INT NOT NULL DEFAULT 0,
  ADD COLUMN `coveredQtyTotal` INT NOT NULL DEFAULT 0;
