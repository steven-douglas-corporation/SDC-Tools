-- DataWarehouse (PostgreSQL): logins for the apps that read the warehouse.
--
-- Run after 04_facts.sql as an admin (postgres or jculp). Safe to re-run: the
-- role is only created when missing, and grants are re-applied. Passwords are
-- not set here (no secrets in the repo): set one with
--   ALTER ROLE reports_app PASSWORD '...';
-- and give it to the app through its .env.

-- reports_app: the reports app (apps/reports). Read-only.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reports_app') THEN
        CREATE ROLE reports_app LOGIN;
    END IF;
END
$$;

GRANT CONNECT ON DATABASE "DataWarehouse" TO reports_app;

GRANT USAGE ON SCHEMA "Integration", "RawPaylocity", "Paylocity", "Dimension", "Fact" TO reports_app;
GRANT SELECT ON ALL TABLES IN SCHEMA "Integration", "RawPaylocity", "Paylocity", "Dimension", "Fact" TO reports_app;

-- Tables and views dw_loader creates later are readable too, without re-running this.
ALTER DEFAULT PRIVILEGES FOR ROLE dw_loader IN SCHEMA "Integration", "RawPaylocity", "Paylocity", "Dimension", "Fact"
    GRANT SELECT ON TABLES TO reports_app;

-- reports_dev: a developer laptop running the reports app against the warehouse. Read-only.
-- It is a member of reports_app, so it can read exactly what the live app can and nothing more,
-- and its password can be changed or the login dropped without touching the live app.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reports_dev') THEN
        CREATE ROLE reports_dev LOGIN;
    END IF;
END
$$;

GRANT reports_app TO reports_dev;
COMMENT ON ROLE reports_dev IS 'Read-only, for a developer laptop running Reports. Same rights as reports_app.';
