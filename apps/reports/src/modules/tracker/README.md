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
  checklist.ts          a card's checklist: small steps to tick off, with no hours and no effect on the forecast
  people.ts             project members, capacity, time off, holidays
  forecast.ts           load inputs from the tables, run the engine, store the result
  schema-status.ts      whether the database has every migration this code needs
  departments.ts        the company's departments, copied from the roster; which one a project is for
  queries.ts            what the project list and the board read
  timeline.ts           what the timelines read: one project's cards, or all projects as rows
  dependencies.ts       what a dependency means when cards sit under cards (no SQL)
  task-detail.ts        what the task page reads, including history in words
db.ts                 the PostgreSQL connections (service login and engine login)
current-actor.ts      turns the signed-in user into a tracker person; ELT is all-access; copies people and departments in
org-units.ts          the departments, worked out from the employee roster and the org chart's groups
actions.ts            "use server" entry points for the screens
api.ts                shared by the read-only API routes
components/           the screens' React components, and format.ts for dates and forecast reasons
```

Elsewhere in the app:

```
src/app/(app)/tracker/          the pages: project list, board, timeline, task, people and time
src/app/api/tracker/            read-only JSON routes for the same data
db/tracker/migrations/          0001 schema, 0002 roles, 0003 work kinds, 0004 done count, 0005 kind required, 0006 requested by, 0007 checklist, 0008 migration record readable, 0009 project priority dropped, 0010 project justification and value, 0011 project department, 0012 project done-by department, 0013 card start date, 0014 project start date (PostgreSQL 15+)
scripts/tracker/migrate.ts      applies the migrations (npm run db:tracker-migrate)
scripts/tracker/migrate-server.ps1  applies them to the company server, and creates the two logins
scripts/tracker/run-forecast.ts the forecast as its own process, for the nightly job
tests/tracker-*.test.ts         engine, schema, service and wording tests
```

## Tests

They run with the app's normal `npm test`. No database server is needed: the schema and service
tests use PGlite, which is Postgres compiled to WebAssembly and runs inside the test process.

## Settings

| Variable                      | Used by                                                          | Database role     |
| ----------------------------- | ---------------------------------------------------------------- | ----------------- |
| `TRACKER_DATABASE_URL`        | the app, for everything people do                                | `tracker_service` |
| `TRACKER_ENGINE_DATABASE_URL` | the app, to redo the forecast after each change; the nightly job | `tracker_engine`  |

The app needs both. With only the first, cards still save, but the dates on screen are not worked out again after a change and go stale without saying so.

Neither is set on the server yet. Until `TRACKER_DATABASE_URL` is set the module is off. On the server the schema and the two logins (`tracker_app`, `tracker_forecast`) come from `scripts/tracker/migrate-server.ps1`, which an administrator runs by hand; it creates the logins without passwords, so one has to be set for each before these two settings can be filled in. Run it again before deploying code that needs a new migration. If that is missed, the tracker's pages and API say the database needs an update and stay off until it has one (`service/schema-status.ts`); a new migration file must also be added to the list in that file. For local development both are in `.env.dev.example`, along with `TRACKER_ADMIN_DATABASE_URL`, which only `npm run db:tracker-migrate` uses; see docs/DEV-ENVIRONMENT.md at the repo root.

## Rules worth knowing before changing anything

- All effort is in hours of project work. "1 Day" is 6 hours, the global project day.
- People type planned start, estimated completion and due dates. The forecast writes its own
  dates to `task_forecast` and never touches the typed ones.
- The first estimated completion date typed becomes the baseline and is never replaced.
- Tasks are archived, never deleted. The screens call P80 the Safe date; the data and the code say P80.
- Every card has a kind (Epic, Feature, Story, Task, Bug, Issue, Milestone; Task by default). A card sits only under a
  card of a higher kind; the service says why not in words and a database trigger enforces it.
  A card with cards under it carries no hours in the forecast: `rollUp()` in `service/queries.ts`
  adds up what is under it for both the board and the task page.
- The simulation is slow. It runs from `scripts/tracker/run-forecast.ts`, never inside the web
  process.
