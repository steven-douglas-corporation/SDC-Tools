# TotalETO SDC Database tool

A local **MCP server** in `mcp-server/`, packaged as a Claude Desktop extension
(`.dxt`), that gives Claude read-only access to the TotalETO SDC (production) SQL
Server database — active projects, costing, purchase orders, invoicing, receiving.

## Querying the database

Use the `TotalETO SDC Database` connector's tools — `list_active_projects`,
`get_project_costing`, `get_open_purchase_orders`, etc. cover the common cases;
`query_sdc` is the ad-hoc escape hatch for anything else, restricted to a single
read-only statement. See [`mcp-server/README.md`](mcp-server/README.md) for the
full tool list and how the read-only guarantee is actually enforced.

## Incident note (2026-09-20/22)

The version that predated this one had a **real SQL login password hardcoded
directly in `index.js`**, discovered sitting as a built `.dxt` in a personal
Downloads folder — not tracked anywhere, not backed up, and the credential
inside it never rotated. It also had zero guardrails on its ad-hoc query tool:
no read-only enforcement, no row cap, nothing stopping a write from executing
beyond whatever grants the SQL login happened to have.

This version fixes both: credentials come from Claude Desktop's own encrypted
`user_config` prompt (never a file in this repo), and every query — ad-hoc or
fixed — runs inside a transaction that's always rolled back, with `query_sdc`
additionally restricted to a single `SELECT`/`WITH` statement with no
sensitive-column references. If you find another copy of the old hardcoded
version floating around (another Downloads folder, another machine), replace
it with this one and let whoever owns the `TETO_ReadOnly` SQL login know the
old password should be rotated.

**Auth is a deliberate stopgap**: SQL Server login today, per-user Windows
Authentication once that's rolled out company-wide. See
[`mcp-server/README.md`](mcp-server/README.md#credentials--configured-on-install-not-hardcoded)
for what changes when that happens.

## Not to be confused with

`SDC_Scheduler/mcp/sdc-db-server.mjs` (a different repo) also exposes a Total ETO
bridge, but as a secondary feature of Scheduler's own HTTP MCP server — it's
coupled to Scheduler's code and connection pool. This tool is fully standalone
and has no dependency on Scheduler at all.
