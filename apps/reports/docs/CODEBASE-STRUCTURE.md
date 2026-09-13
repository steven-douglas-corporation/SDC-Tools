# Codebase Structure

This documents the actual, current folder layout — not a target/ideal one. For the system-level
picture (why things are shaped this way), see [ARCHITECTURE.md](ARCHITECTURE.md).

## Top-level layout

```
src/
  app/            Next.js App Router — routes only, minimal logic
  components/      All React components (flat, +2 subfolders — see below)
  lib/             All business logic, data access, server actions (flat, +1 subfolder)
prisma/            Schema, migrations, seed script
scripts/           Reusable maintenance/import CLI tools (run manually via `npx tsx`)
scripts/archive/   One-off diagnostic/repair scripts tied to specific past incidents
tests/             Unit tests (`tsx --test tests/*.test.ts`), flat, one file per lib module
docs/              This documentation set + standalone integration setup guides
public/            Static assets (brand logo, default Next.js icons)
reference/         Design-tool mockup exports used as a build reference (gitignored, not app code)
```

There is **no dedicated `hooks/` or `types/` folder**. Custom hooks live directly in
`src/components/` (`useAutosave.ts`, `useDrillFilters.ts`, `useMotion.ts`, etc.) alongside the
components that use them. Types are exported from whichever module owns the concept they
describe (`JobBom` from `lib/job-bom.ts`, `StandardJobBase` from the component that renders it) —
there's no central type-barrel file to keep in sync.

## `src/app/` — routes

Everything under `(app)/` shares one layout (`(app)/layout.tsx`) that calls `auth()`, which is
why every page below it is dynamically rendered. `login/` sits outside that group (no sidebar).

| Path | File | Renders |
|---|---|---|
| `/` | `(app)/page.tsx` | Dashboard — job/employee counts, data-quality panel, sync freshness |
| `/etc` | `(app)/etc/page.tsx` | Monthly ETC grid, KPI cards, Standard Sheet columns, department checklist |
| `/job-hours` | `(app)/job-hours/page.tsx` | Hours dashboard, Parts Cost card, Procurement (BOM/PO) |
| `/jobs` | `(app)/jobs/page.tsx` | Job list with status filters |
| `/jobs/[id]` | `(app)/jobs/[id]/page.tsx` | Single job: ETC suggestion, tasks, project release panel |
| `/jobs/new` | `(app)/jobs/new/page.tsx` | Redirects to `/quoted` (standalone form retired) |
| `/quoted` | `(app)/quoted/page.tsx` | Projects grid — quoted vs. actual, gated Standard Sheet columns |
| `/employees` | `(app)/employees/page.tsx` | Read-only roster grid |
| `/audit-log` | `(app)/audit-log/page.tsx` + `layout.tsx` | Password-gated audit trail (AG Grid) |
| `/login` | `login/page.tsx` + `LoginForm.tsx` + `actions.ts` | Sign-in / self-service sign-up |

`src/app/api/` holds route handlers only for what a Server Action can't do — see
[INTEGRATIONS.md](INTEGRATIONS.md) for the server-to-server ones and
[REALTIME-SYNC.md](REALTIME-SYNC.md) for the SSE ones.

**Add a new page** under `(app)/<route>/page.tsx` if it needs the sidebar/shell, or as a sibling
of `login/` if it shouldn't. Fetch data directly in the Server Component; don't invent an API
route to read your own database.

## `src/components/` — 80 files + 2 subfolders

Flat, feature-named files (`JobProcurement.tsx`, `EtcStandardColumns.tsx`,
`EmployeesGrid.tsx`, …) plus:

- **`ui/`** (9 files) — the shared design-system layer: `classnames.ts` (Tailwind class
  constants, incl. button/card geometry tokens), `format.ts` (money/hours formatters),
  `Typography.tsx`, `Drill.tsx` (the generic drill-down panel every KPI drill-through is built
  from), `StatusBadge.tsx`, `Toast.tsx`, `EmptyState.tsx`.
- **`charts/`** (5 files) — ECharts wrappers: `EChart.tsx`, `theme.ts` (shared series
  colors/options), `GaugeCard.tsx`, `IndicatorCard.tsx`, `ChartTooltip.tsx`.

**Add a new component** as a flat file in `src/components/` unless it's a generic,
feature-agnostic UI primitive (→ `ui/`) or a chart wrapper (→ `charts/`). There's no
per-feature component subfolder convention (no `components/etc/`, `components/projects/`) —
feature grouping happens by filename prefix, not by directory.

## `src/lib/` — 108 files + 1 subfolder

The bulk of the application's logic. Rough shape, by naming convention:

| Pattern | Count | What it means |
|---|---|---|
| `*-actions.ts` | 14 | Server Actions (`"use server"`), one file per feature area — the mutation entry points client components call |
| `etc-*.ts` | 17 | ETC domain logic (math, KPIs, department sign-off, live totals) |
| `sync-*.ts` | 4 | Upstream-to-database sync functions, called by the refresh pipeline |
| `*-gate.ts` | 3 | Password-gate helpers for destructive actions (see [ARCHITECTURE.md](ARCHITECTURE.md#authentication-and-authorization)) |
| `export/` (subfolder, 5 files) | — | CSV/XLSX builders shared by the export API and the export smoke test |
| everything else | ~65 | One concern per file: hours (`job-hours-*.ts`, `actual-hours.ts`), Paylocity import (`paylocity-*.ts`), Total ETO (`sync-totaleto.ts`, `job-bom.ts`), realtime (`realtime-hub.ts`, `change-version.ts`), auth/audit (`auth.ts`, `audit.ts`, `button-password.ts`), the Prisma singleton (`prisma.ts`), Scheduler integration (`scheduler-*.ts`) |

**Add new business logic** as a new file in `src/lib/`, named for what it does, not what page
uses it — `lib/etc.ts` is read by three different route pages plus the export builders and the
live-totals client store, and that's the norm, not an exception. If it's a mutation, put it in
a `*-actions.ts` file and mark it `"use server"`; if it's a module that must never be reachable
from client code (touches a raw DB connection, a secret, or process-global state), add
`import "server-only"` at the top — see `realtime-hub.ts` or `scheduler-db.ts` for the pattern.

## Server-only vs. client-only

- **Server-only**: anything under `src/app/**/page.tsx`/`layout.tsx` (Server Components by
  default), every `*-actions.ts` and `*-gate.ts` file, and any `lib/*.ts` module that opens a
  direct database/mssql/mysql2 connection.
- **Client-only**: any file starting with `"use client"` (~96 of them) — grids, autosave
  components, drill-throughs, the realtime provider, charts.
- There is no ambiguity in practice: a Server Component never has `"use client"`, and a client
  component never directly imports a `server-only`-guarded module — it calls a Server Action
  instead. If you're unsure which a new file should be, match whichever sibling file does the
  most similar job.

## Shared utilities and calculation modules

These are the modules other code is expected to reuse rather than reimplement:

- **`lib/etc.ts`** — the ETC math (`calcHoursLeft`, `suggestNewEtc`, `rollupNewEtc`,
  `newEtcDiff`, `effectiveNewEtc`) — see [ETC-BUSINESS-LOGIC.md](ETC-BUSINESS-LOGIC.md). Used by
  the grid, the KPI cards, the exports, and the live-totals client store, so a formula change
  made in only one of those would create a fifth, wrong, definition.
- **`lib/actual-hours.ts`** — the one place "actual hours to date" is stitched together across
  three historical eras (migrated Excel snapshot, frozen `EtcEntry`, live punches).
  `lib/job-hours-source.ts` and the Projects grid both read this rather than re-deriving it.
- **`lib/cell-rules.ts`** — rounding/decimal-place rules (`round2`, `roundTo`,
  `HOURS_DECIMALS`, `MONEY_DECIMALS`) shared by every grid cell and formula module.
- **`lib/undefined-hours-rules.ts`** — the one definition of which rejected punches count as
  "Undefined Hours" for the KPI, shared by the KPI aggregate and the drill-through so they
  reconcile by construction rather than by convention.
- **`lib/with-timeout.ts`** — the generic upstream-call timeout wrapper; use this rather than a
  new ad-hoc `Promise.race` if a new integration needs a render-time budget.
- **`components/ui/classnames.ts`** and **`components/ui/format.ts`** — the shared styling
  tokens and number formatters; a new component should reuse these rather than hardcoding a
  Tailwind class or a `toLocaleString` call.
