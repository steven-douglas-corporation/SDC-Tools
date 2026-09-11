# Development Log

Track every change made, decision taken, and issue found.
Most recent entry at the top.

---

## 2026-06-03 — Environment Setup

### What Was Done
- Cloned GitHub repo (https://github.com/abhikamuju36-ui/SDC-PowerBI.git) to `SDC-PowerBI-DEV/`
- Built MCP server exe from source (.NET 8, self-contained win-x64, 68.8 MB)
- Authenticated MCP server as akamuju@sdcautomation.com (token cached locally)
- Copied all Excel source files into `source-data/`
- Backed up original pbix files into `BACKUP/`
- Cleaned up old `SDC PowerBI/` folder (removed stale files, kept .claude settings)
- Fixed `.mcp.json` to use absolute path so it works from any working directory
- Verified live MCP connection — 412,509 actual hours, 240 jobs, 115 employees confirmed

### Key Findings
- `Job Hours Report.pbix` and `Job Hours Report - Fees.pbix` are thin shells (no embedded data)
  — they live-connect to the cloud semantic model and cannot be downloaded
- `Job Hours Report - Management Level.pbix` (9.9MB) has full embedded DataModel — this is
  the primary working file
- All 3 local pbix files had identical ReportId (65b97922) and DatasetId (5a47445c) — confirms
  they all point to same production cloud dataset
- Production data comes from `SDC-DataWarehouse` SQL database (owned by Jon Culp), NOT Excel files
- Reports use DirectQuery (no scheduled refresh — reads live from SQL warehouse)
- GitHub repo contains: MCP server (C#/.NET8), full semantic model as .tmdl text files,
  MODEL-NOTES.md, QUERIES.md — all very useful for development

### Environment State
- Working folder: `C:\Transfer\Projects\SDC-PowerBI-DEV\`
- MCP server: connected and tested ✓
- PowerBI Desktop: ready (open `_DEV.pbix` to start)
- DEV workspace: `SDC PowerBI DEV` on app.powerbi.com
- Production workspace: `SDC Reports` on app.powerbi.com

---

## Change Log Template (copy this for each change)

```
## YYYY-MM-DD — [Short Description]

### Report(s) Changed
- Job Hours Report - Management Level

### What Changed
- 

### Why
- 

### DAX Added/Modified
```dax
-- paste any new/changed DAX here
```

### Status
- [ ] Made in Desktop
- [ ] Published to DEV workspace
- [ ] Reviewed in browser
- [ ] Published to Production
```

---

## Known Issues / Bugs
| # | Issue | Found | Status |
|---|---|---|---|
| 1 | Fees and Standard reports are thin shells — cannot edit locally without Jon's Build permission | 2026-06-03 | Open |
| 2 | `Part Purchase` has ~2,340 PO lines with unmatched Job IDs (~$623K unattributed) | 2026-06-03 | Known data issue |

---

## Decisions Made
| Date | Decision | Reason |
|---|---|---|
| 2026-06-03 | Use `_DEV.pbix` as primary working file, not `.pbip` | `.pbip` has incomplete SemanticModel — no measure tmdl content yet |
| 2026-06-03 | Use absolute path in `.mcp.json` | Relative path broke when Claude Code opened from old folder |
| 2026-06-03 | Keep old `SDC PowerBI/` folder with just `.claude/` settings | Claude Code session settings stored there |
