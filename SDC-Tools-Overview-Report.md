# SDC Tools — Overview

**Prepared:** 2026-09-02

## What it is

SDC Tools is a set of five internally built applications delivered through one desktop launcher. Staff sign in once with their company account and move between all five tools from a single window.

The applications connect directly to the systems the company already runs — the ETO manufacturing database, the time-and-attendance system, Smartsheet, and the CAD vault. Most of those connections are read-only, so the tools display live source data rather than a copy. Where the tools own data of their own — schedules, calendar events, shop parts, vendor purchase orders, control-logic diagrams — that data is created and stored inside the suite. Users are viewers, editors, or administrators.

## The five applications

**Assemblies Library** — Answers whether a design already exists. It catalogues the CAD vault on a schedule and generates a preview image of each assembly, so engineers can search and judge results visually instead of guessing from filenames. The value is reuse: fewer hours redrawing what the company already owns.

**Build Readiness Report** — Answers whether a job can start. For any project it lays out the bill of materials item by item: what is released, purchased, received, printed, and signed off, with dates and approvals from Smartsheet folded in. Because it reads live from the manufacturing database, it reflects today's status, not last week's export.

**SDC Scheduler** — The operational hub. It holds the project schedule as tasks with owners, durations, dependencies, and phases; moving a date cascades the effect through dependent tasks on business days. Plans are baselined so progress can be measured against the original commitment. Around the schedule sit shop parts, vendor purchase orders and lead times, financial milestones, the team roster, and actual labour hours matched to jobs. It also carries comments, change history, e-mail digests, nightly backups, and PDF export.

**State Logic Builder** — A controls-engineering tool. An engineer draws a machine's state sequence — states, decisions, waits, transitions, devices — and the tool generates the PLC program in the format the Allen-Bradley controller imports directly. The diagram is the source of the code, not documentation of it, so the two cannot drift apart.

**SDC Calendar** — Company events, holidays, paydays, birthdays, and the employee directory, plus scheduled task dates pulled from the Scheduler. Derived entries are read-only, keeping a clear line between what someone entered and what the system generated. It exports to personal calendars and integrates with Teams.

A separate Power BI workstream provides management dashboards for job hours, profitability, parts cost, and utilisation.

## How the pieces connect

A job number means the same thing across the Scheduler, the Build Readiness Report, and the hours data. Scheduler tasks appear in the Calendar. Build readiness and Scheduler costing draw on the same manufacturing records. Two conventions are enforced suite-wide because earlier alternatives caused silent errors: labour hours come only from time-and-attendance punches and the reporting database, and customers are grouped by the manufacturing system's customer account ID.

## Standing and risks

The suite is in production and actively maintained. Updates are published centrally and reach users through the launcher.

Two risks stand out. Maintenance is concentrated in a very small group, and broadening that is the highest-value next step. And because the tools read live from external systems, an outage or schema change in any of them is felt immediately — an acceptable trade for current data, but a deliberate one.
