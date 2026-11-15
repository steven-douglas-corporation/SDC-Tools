# Platform conversion backlog

Open tasks for growing SDC Reports into the one SDC app and decommissioning the separate apps, as
decided in [ADR 0006](adr/0006-platform-standard-for-new-and-converted-apps.md).

Started 2026-11-14. Judgements about Reports come from an architecture-level review of its code;
judgements about the other apps come from the architecture documents only. Confirm before
starting a task. Nothing is scheduled or assigned. Sizes are rough: S is days, M is weeks, L is a
month or more.

When the Project Tracker is live, these tasks move into it and this file is deleted.

## Foundation

| ID   | Task                                                                                                                         | Why                                                                                                                                            | Depends on | Size | Status |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---- | ------ |
| F-01 | Decide: one app with modules, or separate apps on a shared platform                                                          | Decided 2026-11-14: one app with a module per tool                                                                                             | RAID D-15  | S    | Done   |
| F-08 | Decide where the one app starts                                                                                              | Decided 2026-11-14: SDC Reports, changed in place                                                                                              | F-01       | S    | Done   |
| F-09 | Set the module conventions: folder layout, service functions, API routes, how a module is hidden until ready                 | Set 2026-11-14 in `apps/reports/docs/MODULES.md`                                                                                               | â€”        | S    | Done   |
| F-13 | Walk the Reports developers through the module conventions                                                                   | Tracker work lands in a codebase they change several times a day                                                                               | F-09       | S    | Open   |
| F-11 | Give the apps an HTTPS address: a certificate and a reverse proxy in front of the existing ports                             | Microsoft sign-in in a browser is impossible without it, and passwords cross the network unencrypted today                                     | RAID R-14  | M    | Open   |
| F-02 | Decide how sign-on is delivered                                                                                              | Decided 2026-11-14: the app signs in against Entra directly                                                                                    | RAID D-11  | S    | Done   |
| F-03 | Set up the PostgreSQL schemas, logins and a tested backup                                                                    | Layout decided 2026-11-14: one database, a schema per module (RAID D-10). Nothing typed in by people should live on a database with no backup. | â€”        | S    | Open   |
| F-12 | Add a way to run background jobs outside the web process                                                                     | The forecast simulation takes tens of seconds and would freeze the app for everyone                                                            | F-09       | S    | Open   |
| F-04 | Rename the warehouse to lowercase names (SQL scripts, the Python loader, the Reports app's warehouse queries)                | Cheap now; expensive after the warehouse's next phase adds most of the model                                                                   | RAID I-07  | S    | Open   |
| F-05 | Move the warehouse from re-runnable scripts to numbered migrations                                                           | Already planned in the warehouse roadmap; makes it match the standard                                                                          | F-04       | S    | Open   |
| F-06 | Pick the one source for holidays and for time off                                                                            | The Calendar, the warehouse and the tracker each have, or want, a copy                                                                         | F-03       | S    | Open   |
| F-07 | Audit every AI entry point (the Scheduler's assistant and tool server, the Total ETO tool server) against the AI access rule | The rule is agreed; nobody has checked the existing ones against it                                                                            | —          | S    | Open   |
| F-10 | Agree the order in which the other apps are folded in                                                                        | A suggested order is below; it has not been agreed                                                                                             | —          | S    | Open   |

## Reports itself

| ID   | Task                                                                                     | Notes                                                                                                                                                                   | Depends on | Size | Status    |
| ---- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---- | --------- |
| R-01 | Add "Sign in with Microsoft" for people who open Reports directly in a browser           | Written 2026-11-14 (pull request 270), switched off. Not yet tried against Microsoft itself: needs an app registration. Cannot be switched on in production until F-11. | F-11       | S    | In review |
| R-02 | Retire the password form and the password-hash copying between Reports and the Scheduler | Only after everyone has signed in with Microsoft at least once. Needs agreeing with the Scheduler's owner.                                                              | R-01       | S    | Open      |
| R-03 | Move Reports' own tables from MySQL to PostgreSQL                                        | 44 tables. About 18 MySQL-specific queries in 9 files need rewriting. Do it in a quiet period; it needs a short freeze on schema changes.                               | F-03       | L    | Open      |
| R-04 | Bring the architecture documents up to date                                              | They describe 23 tables and no role-based permissions; the setup guide for Microsoft sign-in describes steps that Entra would reject.                                   | —          | S    | Open      |
| R-05 | Add a permission check to the two read actions that only check for a signed-in user      | `loadEffectivePools` and `loadUnattributedDetail`. Low risk.                                                                                                            | —          | S    | Open      |
| R-06 | Rename the app once it holds more than reports                                           | Touches the launcher tile, the PM2 process name and the documents.                                                                                                      | M-01       | S    | Open      |
| R-07 | Decide whether Monthly ETC or the tracker owns estimate-to-complete                      | Needed before tracker projects link to live jobs.                                                                                                                       | RAID D-09  | S    | Open      |

## Modules, in suggested order

Each other app gets two tasks: rebuild it as a module, then switch the old app off. An old app is
switched off only when its module covers everything people use it for, its data has been moved,
and its PM2 process, port, updater entry, launcher tile and database have been removed.

| Order | ID   | Task                                                                              | Notes                                                                                                                                                         | Depends on  | Size | Status |
| ----- | ---- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ---- | ------ |
| 1     | M-00 | Move the tracker's schema and forecast engine into Reports                        | Done 2026-11-14: `apps/reports/src/modules/tracker` and `db/tracker/migrations`                                                                               | F-09        | S    | Done   |
| 1     | M-01 | Project Tracker module: service functions                                         | Done 2026-11-14, tested against an in-process Postgres only                                                                                                   | M-00        | L    | Done   |
| 1     | M-09 | Project Tracker module: permission keys and first screens                         | Done 2026-11-15: `tracker:view` and `tracker:edit` (off for every role but ELT), a project list and a board. Tried by hand in a local copy.                   | M-01        | L    | Done   |
| 1     | M-12 | Project Tracker module: API routes for AI tools and other systems                 | The service functions exist; nothing exposes them over HTTP yet                                                                                               | M-09        | M    | Open   |
| 1     | M-13 | Project Tracker module: remaining screens                                         | Dependencies, members, time off and capacity, a task's history and comments, sprints, role pools; dragging cards                                              | M-09        | L    | Open   |
| 1     | M-10 | Run the tracker service against a PostgreSQL server                               | Done 2026-11-15, by hand: migrations, service and forecast job passed against PostgreSQL 16 in the dev container, under the restricted logins. Not automated. | —           | S    | Done   |
| 1     | M-11 | Schedule the nightly forecast job                                                 | `scripts/tracker/run-forecast.ts`, as its own process                                                                                                         | M-10, F-12  | S    | Open   |
| 2     | M-03 | Build Readiness: confirm the screen Reports already has covers the standalone app | Reports already contains a Build Readiness screen and its own sync. This may be a check and a switch-off, not a rebuild.                                      | —           | S    | Open   |
| 2     | X-03 | Decommission the Build Readiness Report app                                       |                                                                                                                                                               | M-03        | S    | Open   |
| 3     | M-02 | Calendar module                                                                   | Small, and it holds the holidays and time off the forecast needs. Its four roles map onto Reports' permissions.                                               | F-09, F-06  | M    | Open   |
| 3     | X-02 | Decommission SDC Calendar                                                         | Includes its unused bridge to a Scheduler file that does not exist in production                                                                              | M-02        | S    | Open   |
| 4     | M-04 | Assemblies module                                                                 | Its data is a search index rebuilt from the file vault, so there is little to migrate                                                                         | F-09        | M    | Open   |
| 4     | X-04 | Decommission Assemblies Library                                                   |                                                                                                                                                               | M-04        | S    | Open   |
| —     | M-07 | State Logic Builder: decide whether the web version becomes a module              | It also ships as a standalone desktop app released from another repository, which would stay either way                                                       | F-10        | S    | Open   |
| —     | M-08 | SDC Scheduler: decide its relationship to the tracker and its future              | Owned by an outside collaborator (ADR 0002), and today it relays Microsoft sign-in to every app. Not ours to replace alone.                                   | RAID D-08   | S    | Open   |
| last  | X-09 | Retire or shrink the desktop launcher                                             | With one app there is little left to launch. It may remain as a desktop window onto the app.                                                                  | X-02 – X-04 | S    | Open   |
| last  | X-10 | Remove MySQL from the server                                                      | Only after R-03 and the last app using it is gone                                                                                                             | R-03, all X | S    | Open   |

## Not planned

| Task                                                               | Why not                                                |
| ------------------------------------------------------------------ | ------------------------------------------------------ |
| Retrofit the shared sign-on into the apps that are being folded in | They get it when they become modules.                  |
| Move the other apps' databases to PostgreSQL in place              | The data moves once, when the module replaces the app. |
| Rewrite existing JavaScript in TypeScript                          | Working code stays; new code is TypeScript.            |
| Regroup all of Reports' existing files into module folders         | Only when someone is already working in that area.     |

## Not part of this

- **Power BI tooling** (`tools/powerbi`): being retired separately; see the warehouse's decommissioning notes.
- **The data warehouse**: stays, as the shared data layer beside the app's own schemas. Only F-04 and F-05 touch it.
