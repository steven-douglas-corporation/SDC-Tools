-- ── The New ETC breakout, manager-entered ───────────────────────────────────
--
-- Requested 2026-09-03: the Monthly ETC grid's Parts Cost section gains two editable
-- columns, and New ETC becomes their sum:
--
--     New ETC = Left to Invoice + Left to Purchase
--
-- Why entered rather than computed. Both were first built as LIVE Total ETO figures
-- (see lib/parts-etc-breakout.ts), and that proved unreliable on the month-end page:
-- the batched 49-job parts-lines query aborts under real page load —
--
--     [parts-etc-breakout] batched parts lines failed: Error: aborted
--
-- and because the BOM half needs those lines to know which parts have been bought,
-- Left to Purchase then read $0 across every job. A figure that is silently zero is
-- worse than one a manager types, on a number that drives the forecast.
--
-- Left to Invoice keeps its Total ETO seed as a starting value and remains
-- overridable; Left to Purchase starts blank, by request.
--
-- ── Safety ──────────────────────────────────────────────────────────────────
--
-- Purely additive: two NULLABLE columns, no existing column altered, no row rewritten.
-- NULL means "not entered yet" and is deliberately distinct from 0 — the grid renders
-- it blank, the same way newEtcDraft does, because an unanswered cell is not a
-- forecast of nothing.
--
-- Decimal(12,2) matches invoicedAtSubmit/projectionBaseline rather than the (10,2)
-- this table's older money columns use: (10,2) caps at 99,999,999.99, and these are
-- per-job figures that a large job can push past that.

ALTER TABLE `EtcEntry`
  ADD COLUMN `leftToInvoice` DECIMAL(12, 2) NULL,
  ADD COLUMN `leftToPurchase` DECIMAL(12, 2) NULL;
