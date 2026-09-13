# SDC Projects Reports (ETC Planner)

An internal web app that replaces the `Project Planner Data Control.xlsx`, `End Of Month ETC
Sheet.xlsx`, and `Standard Fees.xlsx` workbooks: monthly Estimate-to-Complete (ETC) tracking,
the Projects (quoted hours) grid, Standard Fees, and a Job Hour Details / Procurement view that
recreates the equivalent Power BI reports natively. Hours come from a Paylocity export
workbook; parts cost and BOM data come live from Total ETO.

## Tech stack

Next.js 16 (App Router, Turbopack) · React 19 · Prisma / MySQL · NextAuth v5 · ECharts

## Setup

```bash
npm install
cp .env.example .env   # fill in real values — see docs/DEVELOPMENT.md
npx prisma migrate deploy
npm run dev          # http://localhost:4006
```

Use `localhost:4006`, not a hostname, in dev (see `next.config.ts`'s `allowedDevOrigins` note).

## Main commands

```bash
npm run dev          # dev server, port 4006
npm run build        # production build
npm start            # run the production build
npm run deploy       # build + free port 4006 + pm2 restart (production deploy)
npm test             # run the test suite (99 files, tsx --test)
npm run lint         # eslint
```

## Documentation

Everything beyond this quick start lives in [`docs/`](docs/):

| Doc | Covers |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System components, client/server boundaries, auth, main modules |
| [CODEBASE-STRUCTURE.md](docs/CODEBASE-STRUCTURE.md) | Folder-by-folder layout, where new code goes |
| [DATA-FLOW.md](docs/DATA-FLOW.md) | Source → database → calculation → UI, for hours/parts/ETC/exports |
| [ETC-BUSINESS-LOGIC.md](docs/ETC-BUSINESS-LOGIC.md) | The exact ETC formulas (Prior ETC, New ETC, Diff, Parts Cost, carry-forward, submission) |
| [INTEGRATIONS.md](docs/INTEGRATIONS.md) | Paylocity, Total ETO, Power BI, auth, the sibling Scheduler app |
| [REALTIME-SYNC.md](docs/REALTIME-SYNC.md) | Live cell edits, presence, conflict handling |
| [REFRESH-PIPELINE.md](docs/REFRESH-PIPELINE.md) | The scheduled + manual data-refresh pipeline |
| [SEMANTIC-MODEL-MAP.md](docs/SEMANTIC-MODEL-MAP.md) | How app concepts map onto the Power BI semantic model |
| [UNMAPPED-HOURS.md](docs/UNMAPPED-HOURS.md) | Auto-generated — punch codes with no section mapping (`scripts/report-unmapped-hours.ts`) |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | Local setup, env vars, Prisma workflow |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Build/deploy process, the PM2-on-Windows gotcha, rollback |
| [TESTING.md](docs/TESTING.md) | Test structure and what must pass before deploying |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common failure modes and where to look |

`docs/` also holds standalone setup guides for specific integrations (Entra, Graph, Paylocity
ingestion, Power BI continuity) that predate this documentation set.

`DEVLOG.md` at the repo root is the detailed, dated running history of every change — the
`docs/` files above describe current behavior; `DEVLOG.md` explains how it got that way.
