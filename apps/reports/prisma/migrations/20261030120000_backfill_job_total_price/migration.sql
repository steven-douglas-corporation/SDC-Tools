-- ── Total = Sales Price + Change Quote, filled in for existing jobs ─────────
--
-- The Projects grid's Total column is now calculated (never typed), and Change Quote is filled
-- only by the Change Quotes panel. Total was empty for every job, so this sets it once for the
-- jobs that have a price; after this the app keeps it in step on every write. Data only — no
-- schema change, and re-running it is harmless (it recomputes the same value).
UPDATE `Job`
SET `totalPrice` = COALESCE(`salesPrice`, 0) + COALESCE(`changeQuote`, 0)
WHERE `salesPrice` IS NOT NULL OR `changeQuote` IS NOT NULL;
