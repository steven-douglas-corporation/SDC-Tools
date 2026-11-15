# Modules

How a new tool is added to this app. Set 2026-11-14 as part of
[ADR 0006](../../../docs/adr/0006-platform-standard-for-new-and-converted-apps.md), which makes
this app the one SDC app. The Project Tracker is the first module built this way.

These rules apply to new modules. Existing code is not required to move; regroup it only when you
are already working in that area.

## Where things go

```
src/modules/<module>/
  service/        the module's logic, and the only code that touches its tables
  db.ts           the module's PostgreSQL connection (server-only)
  actions.ts      "use server" entry points for the module's own screens
  components/     the module's React components
  types.ts        types shared across the module

src/app/(app)/<module>/     pages: thin, they call service functions to read
src/app/api/<module>/       route handlers for AI tools and other systems

db/<module>/migrations/     numbered SQL files, applied once, in order
scripts/<module>/           background jobs, run outside the web process
tests/<module>-*.test.ts    flat, like every other test here
```

## Rules

**One write path.** Only files in `service/` import `db.ts`. Pages, actions, route handlers and
components never run SQL against the module's tables.

**Two doors, one room.** A server action and an API route are two ways into the same service
function. Each checks permission and calls the service; neither holds business rules.

**Permissions.**

- A module adds its own keys to `lib/permissions.ts`, named `<module>:view`, `<module>:edit`
  and so on, and its route to `ROUTE_PERMISSIONS`. Add the route late in that list; the first
  entry a role holds becomes its landing page after a refused request.
- Check with the existing helpers: `requirePagePermission`, `assertActionPermission`,
  `requireApiPermission`. Every action and every route handler checks, reads included.
- Access to one record, such as membership of a project, is checked inside the service function
  after the module permission.

**Hidden until ready.** A new module's permissions are seeded off for every role except its
pilot users. With no permission there is no sidebar entry and no route.

**Database.**

- Each module has its own PostgreSQL schema, named after the module, with lowercase
  underscore names.
- It connects with its own logins: one for the service, one for any background engine, one
  read-only. The connection string is `<MODULE>_DATABASE_URL`.
- Module tables are not Prisma models. Prisma manages this app's MySQL tables only.
- A change to several tables, and the history rows that record it, happen in one transaction
  inside one service function.
- This app's audit log is in MySQL, so it cannot be part of a PostgreSQL transaction. A module
  keeps the history it must not lose in its own schema, and may also write to the audit log
  afterwards.

**Pure logic stays pure.** Calculations such as the tracker's forecast import nothing from
Next.js, React or the database, so `tsx --test` can run them directly.

**Nothing slow in the web process.** This app runs as a single process by design. Work that
calculates for more than a moment runs as a script in `scripts/<module>/`, as its own PM2
process or scheduled task, and writes its result to the module's tables for the app to read.

**AI and other systems use the API.** They call `/api/<module>/...` under a user's permissions
or a service token. They never get a database login that can write.

**Modules keep to themselves.** A module may call another module's service functions. It never
reads or writes another module's tables.

**Reuse what exists.** Shared pieces such as `components/ui`, `lib/permissions.ts` and
`lib/audit.ts` are used, not copied.

**Small files.** One concern per file. A file heading past about 500 lines is a sign to split it.
