-- ── Parts Cost projection baseline, snapshotted at ETC submission ───────────
--
-- Reported 2026-09-03: the Parts Cost bar's total climbed as ETC converted into
-- invoiced actuals. The old projection was
--
--     actual + max(committedNotPosted, submittedEtc)
--
-- where `actual` is read live from the purchase lines while `submittedEtc` is a
-- persisted value that does not move between submissions. Invoicing $5,000 of
-- forecast therefore raised the total by $5,000 and shrank nothing, so by the time
-- an ETC was fully invoiced the projection had overstated the job by the whole ETC.
-- tests/parts-projection-stability.test.ts characterises that on the old formula.
--
-- The fix needs to know what the manager was looking at WHEN they submitted, and
-- that cannot be recomputed: every input to a recomputation is live and re-synced,
-- so a reconstructed baseline drifts for the same reason the projection did. Hence
-- a snapshot.
--
-- ── Safety ──────────────────────────────────────────────────────────────────
--
-- Purely additive: two NULLABLE columns, no existing column altered, no row
-- rewritten, no index or constraint touched. Nothing reads them until the code that
-- writes them ships, and the read path (lib/parts-etc-baseline.ts) falls back to a
-- derived baseline whenever they are NULL — so this migration is safe to apply
-- BEFORE, WITH, or AFTER the code, and needs no backfill to leave the app correct.
-- That is deliberate: it is the difference between a deploy that has to be
-- sequenced and one that does not.
--
-- Decimal(12,2) rather than the (10,2) used by this table's other money columns:
-- those hold one month's figure for one job, while a baseline for a multi-job
-- selection is summed by the caller — and (10,2) caps at 99,999,999.99, which a
-- whole-portfolio rollup can reach. The two new columns are per-row like the rest,
-- but sized so a future rollup snapshot cannot silently truncate.

ALTER TABLE `EtcEntry`
  ADD COLUMN `invoicedAtSubmit` DECIMAL(12, 2) NULL,
  ADD COLUMN `projectionBaseline` DECIMAL(12, 2) NULL;
