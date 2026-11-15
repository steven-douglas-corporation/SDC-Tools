# SDC Project Tracker

The database schema and the completion forecast for the in-house project tracker. There is no
service, API or UI yet, and nothing here is deployed or run by PM2.

Design decisions and open questions: [docs/project-tracker/DESIGN.md](../../docs/project-tracker/DESIGN.md).

```
db/migrations/   0001_schema.sql   tables, rules, views (PostgreSQL 15+, schema "tracker")
                 0002_roles.sql    the three roles that enforce the one write path
src/forecast/    engine.ts         the forecast: schedule(), simulate(), summarize(), verify()
tests/           schema.test.ts    loads the migrations into a real Postgres engine and checks each rule
                 engine.test.ts    the spec's worked example, plus each scheduling rule
```

## Run the tests

```bash
npm install
```

```bash
npm test
```

```bash
npm run typecheck
```

No database server is needed. The schema tests use PGlite, which is Postgres compiled to
WebAssembly and runs inside the test process.

## Using the engine

```ts
import { schedule, simulate, summarize } from "./src/forecast/engine.ts";

const inputs = {
  asOf: "2026-11-11",
  holidays: ["2026-11-26", "2026-11-27"],
  resources: [{ id: "Ana", hoursPerDay: 6 }],
  tasks: [{ id: "BIN-1", project: "BIN", projectRank: 1, remainingHours: 18, assignee: "Ana" }],
};

const { results } = schedule(inputs); // start, finish and why, or the reason it is unscheduled
const projects = summarize(inputs.tasks, results); // finish date and unscheduled work per project
const ranges = simulate(inputs); // P50 and P80 per task and per project
```

Dates are ISO strings. Effort and capacity are hours of project work; `hoursPerDay` is what a
person has for project work on a working day, already resolved from the global, team and person
capacity settings.
