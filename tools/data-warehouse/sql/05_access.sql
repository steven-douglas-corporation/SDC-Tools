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
