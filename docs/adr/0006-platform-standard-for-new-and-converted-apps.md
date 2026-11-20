# ADR 0006 — One app, grown from SDC Reports, on one platform standard

**Status:** Accepted in part, 2026-11-14. The items under "Decided" are agreed. The items under
"Proposed" are recommendations awaiting a decision; each names its row in the SDC IT RAID Log
where it has one.

## Context

Six apps grew separately. Each has its own database (five on MySQL), its own way of knowing who
the user is, and its own copy of shared facts such as people and holidays. The data warehouse and
the planned AI assistant are on PostgreSQL.

The separation is history, not design: the tools were built one at a time, some by different
people in different repositories, and the launcher was added afterwards. It costs several
sign-ins, five databases, duplicate data and a fresh set of basic decisions for every new tool.
Its usual benefit, letting separate teams release independently, does not apply when a few people
maintain all of it.

SDC Reports (`apps/reports`) is by far the largest and most active of the six: about 120,000
lines of strict TypeScript, 44 tables, 267 test files, and two-thirds of all commits in this
repository over the 30 days before this decision. It already has what any shared app needs:
users, per-role permissions with an admin screen, an audit log, navigation and a deployment.

The Project Tracker, designed on 2026-11-14, is the first new tool since these questions were
asked, and its design review settled them.

## Decided

| Topic                  | Standard                                                                                                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One app                | One app with a module per tool, sharing one sign-in, one navigation and one set of users (RAID D-15).                                                                                                                                                                                                   |
| Where it starts        | SDC Reports, changed in place. It is not copied to a new app and no new app is started.                                                                                                                                                                                                                 |
| First new module       | The Project Tracker.                                                                                                                                                                                                                                                                                    |
| The other apps         | Each is rebuilt as a module of the one app and then decommissioned, where that pays. The order and the exceptions are in [PLATFORM-CONVERSION.md](../PLATFORM-CONVERSION.md).                                                                                                                           |
| Database engine        | PostgreSQL for every new module. Reports' existing MySQL tables move later, as their own task.                                                                                                                                                                                                          |
| Database layout        | One PostgreSQL database with a schema per module and the warehouse beside them, so anything can be joined. Separate logins per role. Restore by schema, never the whole database (RAID D-10).                                                                                                           |
| Naming in the database | Lowercase with underscores (`tracker.task`). No quoted mixed-case names. The warehouse is renamed to match.                                                                                                                                                                                             |
| Sign-in                | Single sign-on. Nobody signs in twice, and nothing keeps its own passwords. The app signs in against Entra directly, matching the Microsoft account to the existing user by email (RAID D-11). This needs the app to be served over HTTPS first; Entra refuses plain-HTTP return addresses (RAID R-14). |
| AI access              | AI assistants reach the app through its API endpoints or read-only tools, under the asking user's permissions. They never get direct write access to tables.                                                                                                                                            |
| One write path         | Everything that changes a module's data goes through that module's service layer. The database enforces it with separate logins: the service, any background engine, read-only users.                                                                                                                   |
| Language               | TypeScript.                                                                                                                                                                                                                                                                                             |

## Proposed

| Topic           | Recommendation                                                                                                                                                                                                                  | RAID |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Module layout   | Set out in [apps/reports/docs/MODULES.md](../../apps/reports/docs/MODULES.md): each new module gets its own folders, its logic lives in service functions, and its screens, API routes and background jobs all go through them. |      |
| Background work | Long-running work such as the forecast simulation runs as its own process, never inside the web process, which is single-instance by design.                                                                                    |      |
| Schema changes  | Numbered SQL migrations for PostgreSQL modules, as the warehouse roadmap plans. Reports' MySQL tables stay on their current migration tool until they move.                                                                     |      |
| Shared facts    | One source each for people (the warehouse roster), holidays and time off. Modules read the shared copy.                                                                                                                         |      |
| Permissions     | Reports' per-role permissions cover who can reach a module. A module adds per-project or per-record access where it needs it.                                                                                                   |      |
| Tests           | Schema rules are tested against a real Postgres engine in CI with no server (as `apps/tracker` does), and business rules have a fixed worked example.                                                                           |      |

## Consequences

- The tracker's schema and forecast engine, built in `apps/tracker`, move into `apps/reports` as
  its first module. The engine has no framework dependencies and uses the same test runner.
- Work lands in a codebase that two developers change several times a day. Module conventions
  are set in `apps/reports/docs/MODULES.md`, and tracker work arrives as small pull requests on the same
  branch-and-review flow they use.
- A new module can stay hidden behind a permission that is off for everyone but its pilot users.
- "Reports" becomes a misleading name. Renaming the app is its own task, later.
- Reports runs on MySQL for now, so the one app talks to two databases until its own tables
  move. It already connects to PostgreSQL for the warehouse.
- The other apps keep running, unchanged, until their module replaces them. Converting them in
  place (moving a database, retrofitting sign-on) is the exception.
- The Scheduler is owned by an outside collaborator (ADR 0002), is today the relay for Microsoft
  sign-in, and the State Logic Builder also ships as a standalone desktop app. Whether and how
  each is replaced is open (RAID D-08 for the Scheduler).

## Rejected

- **Start a new app.** It would have to rebuild users, permissions, audit and navigation, then
  re-create 120,000 lines that change 200 times a month. Reports would be the last thing
  replaced and the new app would never catch up.
- **Copy Reports to a new app and build there.** Two copies diverge from the first day, every
  fix has to be carried across by hand, the copy inherits the same MySQL database and password
  sign-in, and users and data end up split across two systems.
- **Keep the apps separate on a shared platform.** It would fix sign-on and data duplication but
  keep six codebases, six deployments and six sets of screens to maintain.
- **Convert every existing app in place.** That is effort spent on code that is going away.
- **Keep MySQL as the standard.** The tracker's rules need features MySQL lacks (partial and
  deferrable constraints, row-level security), and the warehouse and AI roadmap are PostgreSQL.
- **A separate database per module in PostgreSQL.** Unlike SQL Server, PostgreSQL cannot query
  across databases, and separate databases share the same log and memory anyway, so the split
  costs joins and gains no isolation that schemas and logins do not already give.
