-- §26.15 — the full confirmation-and-submission flow, timed.
--
-- `createdAt` alone answered "when was the row written", which for a FAILED attempt
-- is the only moment there is. A successful submission has three that matter and are
-- not recoverable afterwards:
--
--   confirmedAt  when the user pressed "Yes, Submit Report" in the dialog (browser
--                clock — the only one that knows how long the dialog sat open)
--   startedAt    when the server began validating and writing
--   completedAt  when the transaction committed
--
-- All NULL-able: rows written before this migration have none of them, and a caller
-- that does not time itself is still allowed to record an attempt.
ALTER TABLE `MonthlyReportSubmission`
  ADD COLUMN `confirmedAt` DATETIME(3) NULL,
  ADD COLUMN `startedAt`   DATETIME(3) NULL,
  ADD COLUMN `completedAt` DATETIME(3) NULL;
