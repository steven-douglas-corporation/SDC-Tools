-- DataWarehouse (PostgreSQL): people, signing in with their Windows account.
--
-- Run as a superuser (postgres or jculp). Safe to re-run: roles are only
-- created when missing, and memberships are re-applied. To add someone, add a
-- line to the people list below and re-run.
--
-- How sign-in works (server config, not in this file; see README "Access"):
--   pg_hba.conf   members of windows_users connecting from 10.0.0.0/24 use SSPI
--                 (Windows login), so they have no Postgres password.
--   pg_ident.conf maps STEVENDOUGLAS\jdoe (reported as jdoe@STEVENDOUGLAS) to
--                 role jdoe. So each role name must be the person's Windows
--                 account name, the part after STEVENDOUGLAS\ — which is not
--                 always their email name (Dan's is dbelliveau).
--
-- Groups:
--   windows_users  signs in with Windows (the pg_hba rule keys on it)
--   dw_admin       owner rights on DataWarehouse: create, change and drop
--                  objects, read and write all data. Kept for future people
--                  who need database rights without being superusers.
--
-- Superuser (2026-10-04, Jon's decision): the developers below are full Postgres
-- admins. Set per person in the list; re-running applies it.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'windows_users') THEN
        CREATE ROLE windows_users NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dw_admin') THEN
        CREATE ROLE dw_admin NOLOGIN;
    END IF;
END
$$;

-- dw_loader owns the database and every object in it, so its members act as owners.
GRANT dw_loader TO dw_admin;

-- People: Windows account name, and their groups.
DO $$
DECLARE
    person record;
BEGIN
    FOR person IN
        SELECT * FROM (VALUES
            ('jculp',      'Jon Culp',           true),
            ('mvest',      'Moses Vest',         true),
            ('sbemberkar', 'Shashank Bemberkar', true),
            ('dbelliveau', 'Dan Belliveau',      true)
        ) AS p (account, full_name, superuser)
    LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = person.account) THEN
            EXECUTE format('CREATE ROLE %I LOGIN', person.account);
        END IF;
        EXECUTE format('COMMENT ON ROLE %I IS %L', person.account, person.full_name);
        EXECUTE format('GRANT windows_users TO %I', person.account);
        IF person.superuser THEN
            EXECUTE format('ALTER ROLE %I SUPERUSER', person.account);
        ELSE
            EXECUTE format('ALTER ROLE %I NOSUPERUSER', person.account);
            EXECUTE format('GRANT dw_admin TO %I', person.account);
        END IF;
    END LOOP;
END
$$;
