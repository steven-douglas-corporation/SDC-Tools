# TotalETO SDC Database MCP server

A local [Model Context Protocol](https://modelcontextprotocol.io) server, packaged as
a Claude Desktop extension (`.dxt`), that gives Claude read-only access to the
**TotalETO SDC (production)** SQL Server database — active projects, costing,
purchase orders, invoicing, receiving.

This is unrelated to `SDC_Scheduler/mcp/sdc-db-server.mjs` (the Scheduler app's own
HTTP MCP bridge, which also happens to expose a Total ETO bridge as a secondary
feature). That one is coupled to Scheduler's own code and reused pool; this one is
fully standalone — it only needs a SQL Server login, nothing from any other app's
codebase. See [ARCHITECTURE.md](../../../ARCHITECTURE.md) if you're trying to place
this relative to everything else in the SDC estate.

## Tools exposed to Claude

| Tool | What it does |
| --- | --- |
| `query_sdc` | Run a single ad-hoc read-only SQL query. Rejected if it isn't `SELECT`/`WITH`, contains more than one statement, or references a sensitive column. |
| `get_unpaid_amounts` | Purchase orders not yet fully invoiced — money still owed to suppliers. |
| `list_active_projects` | Active (Sold) projects with customer, delivery, and team. |
| `get_project_costing` | Actuals vs estimates — hours, labour cost, materials, margin. |
| `get_project_specs` | Sections/machines on a job with engineer, dates, billing status. |
| `get_payment_schedule` | Invoicing and payment schedule — invoiced vs outstanding per job. |
| `get_open_purchase_orders` | Open POs — qty ordered vs received, date required, outstanding value. |
| `get_receiver_log` | Recent material receipts — what arrived, when, from which supplier. |
| `get_spec_costing` | Actual costs broken down by section — labour, materials, margin. |

`query_sdc` is the one tool that takes arbitrary input, so it's the one that needs
guarding — see "Read-only enforcement" below. The other 8 only ever run fixed,
application-authored SQL with typed inputs.

## Read-only enforcement

Every query — the ad-hoc one included — runs inside a transaction that is **always
rolled back**, win or lose. SQL Server has no exact equivalent of MySQL's
`START TRANSACTION READ ONLY`, so an explicit `BEGIN TRANSACTION` /
always-`ROLLBACK` is the real protection here, same idea as every other
database-access tool in the SDC estate (`SDC_Scheduler/lib/agent.js`,
`SDC_Scheduler/mcp/sdc-db-server.mjs`, the sibling MySQL dxt in that same repo).
`query_sdc` additionally requires a single `SELECT`/`WITH` statement and blocks
any query referencing a password/secret/token-shaped column, before it ever
reaches the database.

This is defense-in-depth on top of the SQL login's own database-level grants, not
a replacement for them — **the login itself must stay SELECT-only** in SQL Server.
If `TETO_ReadOnly` (or whatever login is configured) is ever granted write access,
this code's guards are the only thing standing between a bad query and a real
write, and they were only ever meant to be a backstop.

## Credentials — configured on install, not hardcoded

Unlike the version this replaced (which had a real password hardcoded directly in
`index.js`, found sitting in a Downloads folder — see the incident note in
[CLAUDE.md](../CLAUDE.md)), this version takes its SQL Server connection from
Claude Desktop's own install-time prompt (`manifest.json`'s `user_config`), which
Claude Desktop stores in the OS's secure credential storage, never a plaintext
file in this repo or anywhere else. `sql_password` is marked `"sensitive": true`
for exactly this reason — don't remove that flag.

**Current auth**: SQL Server login (`TETO_ReadOnly` by default) — a stopgap.
**Planned**: per-user Windows Authentication once that access is rolled out
company-wide. Switching later is a `manifest.json`/`index.js` config change, not
a rewrite — the connection object in `index.js` is the one place that changes.

### `encrypt: true` without a real certificate

The connection sets both `encrypt: true` and `trustServerCertificate: true`. SQL
Server generates its own self-signed certificate automatically with zero setup;
`trustServerCertificate: true` accepts it without validating who issued it. That
still encrypts the wire traffic (the password above and every query result) —
it just doesn't defend against an active man-in-the-middle presenting its own
certificate, which would require a real CA-issued certificate to close entirely.
For traffic staying inside the SDC network, that's the accepted tradeoff. Don't
flip `encrypt` back to `false` — that was the original, unencrypted state.

## Build & install

From this folder:

```powershell
npm install --omit=dev
npx @anthropic-ai/dxt pack . ../totaleto-sdc.dxt
```

Then in Claude Desktop: **Settings → Extensions → Install from file** →
select `totaleto-sdc.dxt`. It will prompt for the SQL Server host, port,
database, login, and password (defaults pre-filled for the standard SDC setup)
before completing install.

`node_modules/` and the built `.dxt` are not committed — same convention as
the sibling MySQL dxt.

## Manual test (outside Claude Desktop)

```powershell
$env:SQL_HOST="SERVER-APP1.stevendouglas.local"
$env:SQL_PORT="1433"
$env:SQL_DATABASE="SDC"
$env:SQL_USER="TETO_ReadOnly"
$env:SQL_PASSWORD="<the real password>"
node index.js
```

It should sit waiting on stdio with no output — that's correct for an MCP stdio
server. Ctrl+C to exit.
