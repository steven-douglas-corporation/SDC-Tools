-- Total (Sales Price + Change Quote) is only shown for jobs that have a change quote; without one
-- it would just repeat the Sales Price. Clear the values the previous backfill wrote for those jobs.
UPDATE `Job` SET `totalPrice` = NULL WHERE `changeQuote` IS NULL OR `changeQuote` = 0;
