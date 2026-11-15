-- SDC Project Tracker: database roles that enforce the one write path.
--
-- These are group roles with no login. An administrator creates the actual logins and grants
-- one of these to each:
--   tracker_service   the API service: reads and writes everything except the forecast tables
--   tracker_engine    the forecast engine: reads everything, writes only the forecast tables
--   tracker_readonly  the AI chat's read API, the Brain and reporting: reads only
--
-- Run after 0001_schema.sql, as the owner of the tracker schema.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracker_service') THEN
        CREATE ROLE tracker_service NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracker_engine') THEN
        CREATE ROLE tracker_engine NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracker_readonly') THEN
        CREATE ROLE tracker_readonly NOLOGIN;
    END IF;
END $$;

GRANT USAGE ON SCHEMA tracker TO tracker_service, tracker_engine, tracker_readonly;

-- Everyone reads everything.
GRANT SELECT ON ALL TABLES IN SCHEMA tracker TO tracker_service, tracker_engine, tracker_readonly;

-- The service writes everything, then loses the forecast tables.
GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA tracker TO tracker_service;
REVOKE INSERT, UPDATE, DELETE ON
    tracker.schedule_run, tracker.task_forecast, tracker.project_forecast, tracker.project_forecast_history
    FROM tracker_service;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA tracker TO tracker_service, tracker_engine, tracker_readonly;

-- The engine writes only the forecast tables.
GRANT INSERT, UPDATE, DELETE ON
    tracker.schedule_run, tracker.task_forecast, tracker.project_forecast, tracker.project_forecast_history
    TO tracker_engine;
