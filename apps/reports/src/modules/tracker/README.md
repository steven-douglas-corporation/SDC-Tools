# Project Tracker module

Projects, tasks, statuses and a completion forecast. Built as a module of this app; see
[docs/MODULES.md](../../../docs/MODULES.md) for the conventions and
[the design notes](../../../../../docs/project-tracker/DESIGN.md) for what was decided and why.

There are no screens or API routes yet. What exists:

```
forecast/engine.ts    the forecast itself: schedule(), simulate(), summarize(), verify(). No database.
service/              the only code that touches the tracker's tables
  database.ts           the small database interface the service is written against
  access.ts             project roles and global roles
  projects.ts           people, projects, members, stack ranks
  tasks.ts              tasks, status changes, dependencies, archiving
  forecast.ts           load inputs from the tables, run the engine, store the result
db.ts                 the PostgreSQL connections (service login and engine login)
```

Elsewhere in the app:

```
db/tracker/migrations/          0001_schema.sql, 0002_roles.sql (PostgreSQL 15+, schema "tracker")
scripts/tracker/run-forecast.ts the forecast as its own process, for the nightly job
tests/tracker-*.test.ts         engine, schema and service tests
```

## Tests

They run with the app's normal `npm test`. No database server is needed: the schema and service
tests use PGlite, which is Postgres compiled to WebAssembly and runs inside the test process.

## Settings

| Variable                      | Used by                           | Database role     |
| ----------------------------- | --------------------------------- | ----------------- |
| `TRACKER_DATABASE_URL`        | the app, for everything people do | `tracker_service` |
| `TRACKER_ENGINE_DATABASE_URL` | the forecast job only             | `tracker_engine`  |

Neither is set anywhere yet. Until `TRACKER_DATABASE_URL` is set the module is off.

## Rules worth knowing before changing anything

- All effort is in hours of project work. "1 Day" is 6 hours, the global project day.
- People type planned start, estimated completion and due dates. The forecast writes its own
  dates to `task_forecast` and never touches the typed ones.
- The first estimated completion date typed becomes the baseline and is never replaced.
- Tasks are archived, never deleted.
- The simulation is slow. It runs from `scripts/tracker/run-forecast.ts`, never inside the web
  process.
