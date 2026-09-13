# SDC Power BI repo

This repo holds the **Job Hours Report - Management Level** Power BI project (the
`.tmdl` model definition under `Job Hours Report - Management Level/`) and a local
**MCP server** in `mcp-server/` that queries the live published model.

## Querying the live model

Use the `powerbi` MCP tools (`run_dax`, `list_tables`, `list_measures`) — they run DAX
against the published semantic model via the Power BI REST `executeQueries` endpoint,
authenticated as the signed-in user (RLS respected).

**Before writing DAX:** check [`mcp-server/QUERIES.md`](mcp-server/QUERIES.md) for a vetted,
ready-to-run pattern, and read [`mcp-server/MODEL-NOTES.md`](mcp-server/MODEL-NOTES.md) for
the schema, key measures, and non-obvious traps. When you validate a genuinely new query,
add it to `QUERIES.md` (the query and its intent — never cached results). The most important
traps:

- **`Function Hierarchy[Is Total]` doubles data** (412 leaf + 412 total rows). Filter
  `'Function Hierarchy'[Is Total] = FALSE` for any slice by function; never include both.
- **`Job Profitability %` clamps at 100% and isn't Profit ÷ Sales** — rank "most
  profitable" by `Job Profit/Loss` ($), not margin, unless filtering to completed jobs.
- **`Part Purchase` has ~2,340 PO lines with Job IDs not in the `Job` dimension** — they
  appear as a blank-Job bucket in job-level aggregations.
- **Measure DAX expressions are not queryable** — read the `.tmdl` files for definitions.

## MCP server

See [`mcp-server/README.md`](mcp-server/README.md) for build/login/share. The server is
registered in `.mcp.json` as `powerbi`. Ignore the old Microsoft remote "Power BI MCP"
connector (the `api.fabric.microsoft.com` one) — it has an unfixable OAuth bug and was
replaced by this local server.
