# ADR 0007 — MySQL for app databases, PostgreSQL for the data warehouse

**Status:** Accepted, 2026-11-24

## Context

Two database engines run on the app server today. Every app with a database of its own
uses MySQL (Assemblies, Scheduler, State Logic, Calendar, Reports). The data warehouse
(`tools/data-warehouse`) uses PostgreSQL, and so does the Project Tracker module inside
Reports.

Three questions kept coming up as the warehouse grew and Reports started reading from it:

- Should everything move to one engine?
- Should the warehouse share a database server with the apps?
- How does data that people enter in an app get into the warehouse?

Three layouts were compared: MySQL for apps with Postgres for the warehouse (what exists),
Postgres for both on two instances, and Postgres for both on one instance.

## Decision

- **App databases use MySQL. The data warehouse uses PostgreSQL.** No app is migrated to
  make this true; it is the rule for new apps.
- **The warehouse gets its own VM.** Apps and their databases stay together on the app
  server.
- **App data reaches the warehouse by a scheduled copy job** into the warehouse's raw
  layer, built like the Paylocity load: a batch row per run, the same alerts and health
  checks. The same pattern is used for Total ETO.

## Why

- **One engine was not worth a migration.** Postgres for everything would leave one
  engine to operate, not two. It would also mean rewriting and migrating live apps, and
  users would see no difference.
- **The copy into the warehouse costs about the same either way.** A scheduled copy job
  reads MySQL, SQL Server or Postgres alike. Only built-in change streaming needs both
  ends to be Postgres, and nothing here needs changes within seconds: app-entered data
  changes a few times a day.
- **One shared instance was the only layout that lets the warehouse slow the apps down.**
  A heavy load or reporting query competes for the same memory and disk as someone
  saving an entry.
- **The two need different backups.** App data is entered by hand and cannot be
  recreated, so it needs frequent backups and restore to a point in time. The warehouse
  can mostly be rebuilt from its sources and its file archive.

## Consequences

- Two engines stay in operation: two sets of backups, upgrades and know-how.
- A copy across engines has to translate a few data types, once per table: date-times and
  time zones, true/false and unsigned numbers, and text comparison (MySQL usually ignores
  case, Postgres does not). Rows land in the raw layer unchanged and are converted inside
  the warehouse, so the translation is in one visible place.
- The copy job needs one read-only login on each app database it reads, an encrypted
  connection, and the database port open between the two VMs only.
- Once the warehouse is on its own VM, nothing may assume it shares a machine with the
  apps. The Reports app's Refresh Data button starts the warehouse's load through a local
  scheduled task (`apps/reports/src/lib/warehouse-ingest.ts`), and that has to be replaced
  before the move.

## Not decided here

- **The Project Tracker.** It is an app on Postgres and uses Postgres features (its own
  schema, database functions and roles). Whether it stays as the one exception has not
  been confirmed, and whether it shares the warehouse's Postgres instance has not been
  checked.
- **When the warehouse moves, and to which operating system.** The roadmap argues for
  Linux (`tools/data-warehouse/ROADMAP.md`, Phase 2).
- **Which app tables are copied first, and how often.**
