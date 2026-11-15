# Project Tracker module

Projects, tasks, statuses and a completion forecast. Built as a module of this app; see
[docs/MODULES.md](../../../docs/MODULES.md) for the conventions and
[the design notes](../../../../../docs/project-tracker/DESIGN.md) for what was decided and why.

Its screens are visible only to roles holding `tracker:view`, which ships off for everyone but
ELT. What exists:

```
forecast/engine.ts    the forecast itself: schedule(), simulate(), summarize(), verify(). No database.
service/              the only code that touches the tracker's tables
  database.ts           the small database interface the service is written against
  access.ts             project roles and global roles
  projects.ts           people records, projects, members, stack ranks
  tasks.ts              tasks, status changes, dependencies, comments, archiving
  people.ts             project members, capacity, time off, holidays
  forecast.ts           load inputs from the tables, run the engine, store the result
  queries.ts            what the project list and the board read
  task-detail.ts        what the task page reads, including history in words
db.ts                 the PostgreSQL connections (service login and engine login)
current-actor.ts      turns the signed-in user into a tracker person; ELT is all-access
actions.ts            "use server" entry points for the screens
api.ts                shared by the read-only API routes
components/           the screens' React components, and format.ts for dates and forecast reasons
```

Elsewhere in the app:

```
src/app/(app)/tracker/          the pages: project list, board, task, people and time
src/app/api/tracker/            read-only JSON routes for the same data
db/tracker/migrations/          0001_schema.sql, 0002_roles.sql, 0003_work_kinds.sql (PostgreSQL 15+, schema "tracker")
scripts/tracker/migrate.ts      applies the migrations (npm run db:tracker-migrate)
scripts/tracker/run-forecast.ts the forecast as its own process, for the nightly job
tests/tracker-*.test.ts         engine, schema, service and wording tests
```

## Tests

They run with the app's normal `npm test`. No database server is needed: the schema and service
tests use PGlite, which is Postgres compiled to WebAssembly and runs inside the test process.

## Settings

| Variable                      | Used by                           | Database role     |
| ----------------------------- | --------------------------------- | ----------------- |
| `TRACKER_DATABASE_URL`        | the app, for everything people do | `tracker_service` |
| `TRACKER_ENGINE_DATABASE_URL` | the forecast job only             | `tracker_engine`  |

Neither is set on the server yet. Until `TRACKER_DATABASE_URL` is set the module is off. For local development both are in `.env.dev.example`, along with `TRACKER_ADMIN_DATABASE_URL`, which only `npm run db:tracker-migrate` uses; see docs/DEV-ENVIRONMENT.md at the repo root.

## Rules worth knowing before changing anything

- All effort is in hours of project work. "1 Day" is 6 hours, the global project day.
- People type planned start, estimated completion and due dates. The forecast writes its own
  dates to `task_forecast` and never touches the typed ones.
- The first estimated completion date typed becomes the baseline and is never replaced.
- Tasks are archived, never deleted.
- A card's kind (Epic, Feature, Story, Task, Bug, Issue) is optional. A card sits only under a
  card of a higher kind; the service says why not in words and a database trigger enforces it.
  A card with cards under it carries no hours in the forecast: `rollUp()` in `service/queries.ts`
  adds up what is under it for both the board and the task page.
- The simulation is slow. It runs from `scripts/tracker/run-forecast.ts`, never inside the web
  process.
