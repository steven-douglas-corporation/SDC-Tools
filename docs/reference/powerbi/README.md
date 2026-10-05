# Power BI reference exports

Power BI is being retired in favor of the [reports app](../../../apps/reports). This folder
is where the old `.pbip` project exports live so the semantic models and DAX measures
stay available to reference while that logic gets rebuilt in the reports app.

## Adding an export

1. In Power BI Desktop, save the report as a `.pbip` (File → Save As → Power BI Project).
2. Drop the resulting `<Report Name>.Report/` and `<Report Name>.SemanticModel/` folders
   in here, one subfolder per report.
3. Commit as-is — these are reference only, not built or run as part of this repo.

## Where the logic lives

Each report's `.SemanticModel/definition/tables/*.tmdl` files are the part worth reading:
they hold the table/column definitions and DAX measures. The `.Report/` folder is the
visuals/layout and generally isn't needed once the equivalent view exists in the reports app.
