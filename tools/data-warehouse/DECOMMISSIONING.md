# Decommissioning: Power BI, Fabric, Power Automate, SharePoint copies

The warehouse replaces the old Paylocity → SharePoint → Power BI / Fabric chain. This is
the order to take that chain apart, and what still depends on each piece. Status as of
2026-10-04.

## Where things stand

| Piece | Status | Still depended on by |
|---|---|---|
| Power Automate flow: SFTP → SharePoint (`SDC-PowerBIIntegration`) | **Off** (2026-10-04, Jon) | Nothing known. The Power BI inputs it fed are now frozen |
| SharePoint copies (`Project Planner V2/Job Hours Report/…`) | **Frozen** at 2026-10-04 | Power BI dataset; manual reports-app scripts |
| Paylocity files on the SFTP server | **Deleted after each copy** (loader `delete_after_download = true`) | Only `Position_Families_Overrides.xlsx` stays: it's hand-edited there and the reports app still reads it |
| Power BI "Job Hours Report - Management Level" (dataset + report) | **Frozen** (inputs no longer update) | **Reports app** (below), and anyone still opening the report |
| Fabric warehouse `SDC-DataWarehouse-…` | **Live** | **Reports app** ETC history sync; Power BI dataset |

## What the reports app still reads from Power BI and Fabric

These must move before either is switched off, or the reports app breaks or goes stale:

| Reports module | Reads | From | Move to |
|---|---|---|---|
| `src/lib/sync-etc-history.ts` | ETC history (hours and costs), Standard Fees | Power BI (DAX) **and** Fabric (SQL) | Warehouse `"Fact"."EstimateToComplete"` + Standard Fees reference table (ROADMAP Phase 3) |
| `src/lib/etc-period.ts` | ETC periods (name, begin date) | Power BI | `"Dimension"."EtcPeriod"` |
| `src/lib/job-cost-source.ts` | Job sales price (`[Sales Total Amount]`) | Power BI | `"Fact"."JobSales"`; first find what feeds the Job Sales workbook |
| `src/lib/job-hours-source.ts` `buildColumnResolver()` | Function Hierarchy (what a section/function code means) | Power BI | `"Dimension"."Function"`. Falls back to the hand-written `SECTION_ALIASES` if Power BI is unreachable, so this one degrades rather than breaks |
| `src/lib/job-hours-source.ts` hours readers | Hours from Power BI | Power BI | Opt-in/backfill only (`HOURS_SOURCE=power_bi`); delete with Power BI |

Because the Power BI inputs are frozen, **the job sales price and anything else fed from the
SharePoint workbooks stop updating now**, even while Power BI is still up. Check whether the
Project Planner Data Control, Job Sales and Job Ledger (Sage) workbooks were fed by the
flow that's now off, or are edited directly in SharePoint.

## Order of shutdown

1. **Capture the baseline from Power BI (before anything is deleted).** Snapshot the key
   measures (hours, ETC, profitability) by month, job and department into a `"Baseline"`
   schema in the warehouse. The reports app's Power BI API connection (`powerbi-client.ts`)
   can run the queries. Once the dataset is gone, so is the reference every rebuilt measure
   has to match.
2. **Copy everything out of Fabric** into the warehouse raw layer: ETC periods, Standard Fees,
   and hours and costs ETC history. Then find what *writes* to Fabric (likely the ETC
   process or the ETC Planner) and point it at the warehouse instead.
3. **Move the reports app's four reads** (table above) to the warehouse, one PR each, with
   the same parity check used for hours: old source vs new, on the same data, identical.
4. **Retire Power BI:** tell anyone who opens the report, turn off its scheduled refresh,
   then delete the report and dataset. Revoke the service principal's access
   (`PBI_CLIENT_ID` / `PBI_CLIENT_SECRET` in the reports `.env`) and remove the variables.
   The model's definition is kept in `docs/reference/powerbi/` (PBIP).
5. **Shut down Fabric:** pause the capacity, wait a cycle to confirm nothing complains,
   then delete the workspace.
6. **Clean up SharePoint and Power Automate:** delete the disabled flow, and archive then
   delete the `SDC-PowerBIIntegration` copies. Revoke the Graph `Sites.Selected` permission
   used by `apps/reports/scripts/etl_job_hours.py` and `check-graph-auth.ts`, and delete
   those two scripts.
7. **Clean up settings that point at the old files:**
   - Reports `.env`: `JOB_HOURS_LOCAL_PATH`, `PAYLOCITY_EMPLOYEES_LOCAL_PATH`,
     `PAYLOCITY_POSITION_FAMILIES_LOCAL_PATH` are ignored while `DATAWAREHOUSE_URL` is set;
     remove them, and later the file-reading code paths, once the warehouse has run a few
     weeks without trouble.
   - ETC Planner (`D:\AI Projects\sdc-abhi\sdc-etc-planner\.env`): `JOB_HOURS_LOCAL_PATH`
     points at a OneDrive copy and isn't used by its code; remove it.
8. **SFTP server (SERVER-DC1):** once the overrides file has a new home (a warehouse
   reference table, edited through the reports app), nothing needs the share at all. Also
   raise with infrastructure that an SFTP server and an open file share run on what appears
   to be the domain controller.
