-- SDC Project Tracker: the app may read which migrations have been applied.
--
-- The migration runners record each applied file in public.tracker_schema_migration. Until now
-- only the administrator who ran them could read that table, so the app had no way to notice
-- that it had been deployed ahead of its database. With this grant it can compare the record
-- with the migrations its own code expects (src/modules/tracker/service/schema-status.ts) and
-- say so plainly instead of failing on a missing column.
--
-- Read only. The record is still written only by the migration runners.
-- The table is made by the runners, not by a migration, so a database built some other way
-- (the automated tests) may not have it; then there is nothing to grant.

DO $$
BEGIN
    IF to_regclass('public.tracker_schema_migration') IS NOT NULL THEN
        GRANT SELECT ON public.tracker_schema_migration TO tracker_service, tracker_engine, tracker_readonly;
    END IF;
END $$;
