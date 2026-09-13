# SDC PowerBI Dashboard Redesign Prompt
# Use this prompt when starting any redesign work with Claude

---

## MASTER REDESIGN PROMPT

You are redesigning the SDC PowerBI dashboard suite for Steven Douglas Corp. (SDC),
a custom automation engineering company. The goal is a sharp, brand-aligned dashboard
that delivers the right answer at a glance — not a data dump.

---

### BRAND IDENTITY (from SDC Brand Guide 2026)

**Color Palette — use these exact hex codes:**
| Role | Color | Hex |
|---|---|---|
| Primary (CTAs, headlines, key data) | Primary Blue | `#1574C4` |
| Dark backgrounds, headers | Dark Navy | `#061D39` |
| Supporting tints, card backgrounds | Light Blue | `#AACEE8` |
| Alerts, callouts, overrun warnings | Yellow | `#FFDE51` |
| Success, on-track indicators | Green | `#74C415` |
| Dividers, subtle backgrounds | Gray | `#D9D9D9` |
| Body text | Black | `#231F20` |
| Vibrant accent (use sparingly) | Lime Green | `#BEFA4F` |

**Typography:**
- Headlines / KPI labels: **Montserrat Bold** (web/digital standard)
- Body text, table data: **Aptos 11pt** (Office standard)
- All-caps for section headers and category labels

**Logo:**
- Dark background pages → white SDC logo
- Light background pages → blue SDC logo (`#1574C4`)

**Design Voice (apply to dashboard design too):**
- "Quietly capable" — let the data speak, no decoration for decoration's sake
- Sharp, direct, no clutter
- Industrial aesthetic — clean, high contrast, purposeful

---

### LAYOUT PRINCIPLES

**One screen = one answer.**
Every page must answer exactly ONE question. The user should not have to hunt.
Examples:
- "Are we over or under on hours?" → one page
- "Which jobs are at risk?" → one page
- "How is this specific job doing?" → drill-through page

**Visual hierarchy — strict 3-level rule:**
1. **Hero number** (top, large) — the single most important KPI on this page
2. **Supporting context** (middle) — 2-4 supporting metrics that explain the hero
3. **Detail table/chart** (bottom) — drill-down for those who need it

**Page structure:**
- Dark Navy (`#061D39`) header bar — page title in white Montserrat Bold, All-caps
- White or very light gray (`#F5F5F5`) content area
- SDC blue (`#1574C4`) for all primary data bars, line charts, highlights
- Yellow (`#FFDE51`) ONLY for warnings, overruns, things needing attention
- Green (`#74C415`) for on-track, positive variance, completed

---

### CHART & VISUAL RULES

**Use these chart types:**
| Data Type | Chart |
|---|---|
| Single KPI | Large card with trend arrow |
| Comparison (actual vs quoted) | Horizontal bar, side by side |
| Trend over time | Clean line chart, no fill |
| Distribution / breakdown | Stacked bar OR donut (max 5 segments) |
| Ranked list (top jobs, employees) | Horizontal bar chart, sorted descending |
| Status (on track / at risk / over) | Colored icon/badge — NO pie charts |

**Rules:**
- NO pie charts — ever
- NO 3D charts
- NO decorative images or stock photos
- Grid lines: light gray only, minimal
- Every axis label in Aptos, small, not rotated
- Every chart has a clear title in Montserrat Bold
- Data labels on bars when space allows — never overlapping

---

### COLOR USAGE FOR DATA

| Situation | Color |
|---|---|
| Actual hours / current state | `#1574C4` (Primary Blue) |
| Quoted / target / budget | `#061D39` (Dark Navy) |
| ETC / forecast | `#AACEE8` (Light Blue) |
| Overrun / at risk / warning | `#FFDE51` (Yellow) |
| On track / under budget | `#74C415` (Green) |
| Completed / closed | `#D9D9D9` (Gray) |
| Neutral secondary | `#AACEE8` (Light Blue) |

---

### NAVIGATION & UX

- Left-side or top navigation bar — Dark Navy background, white text
- Active page indicator — Yellow `#FFDE51` left border or underline
- All slicers/filters in one consistent location (top or left panel)
- Drill-through enabled on every job name and employee name
- Back button always visible on drill-through pages
- Mobile layout defined for key summary pages

---

### PAGE STRUCTURE (suggested, adapt as needed)

**Page 1 — Executive Summary**
_One-screen answer: "How is SDC performing right now?"_
- Hero: Total Actual vs Quoted Hours (big number + % variance)
- 3 KPI cards: Active Jobs | Employees On Payroll | Overrun Jobs count
- Trend line: Hours by month (actual vs quoted, rolling 12 months)
- Status table: Job count by status (Active / At Risk / Overrun / Complete)

**Page 2 — Job Hours Detail**
_One-screen answer: "Which jobs are consuming the most hours?"_
- Top 10 jobs by actual hours — horizontal bar (blue = actual, navy = quoted)
- Yellow highlight on any job where actual > quoted
- Filter by Job Status, Date Range, Customer

**Page 3 — Employee Utilization**
_One-screen answer: "Are our people utilized well?"_
- Hero: Utilization % (large card, green if >80%, yellow if 60-80%, red if <60%)
- Bar chart: Utilization by employee (sorted descending)
- KPIs: Billable vs Non-Billable hours split

**Page 4 — Profitability**
_One-screen answer: "Are our jobs making money?"_
- Hero: Total Profit/Loss ($) — NOT %
- Ranked list: Top 10 jobs by profit (dollars)
- Completed jobs only for margin view
- Warning: flag jobs where Profit/Loss < 0

**Page 5 — Parts & Costs**
_One-screen answer: "Where is the parts spend going?"_
- Hero: Total Invoiced Parts Cost
- Top jobs by parts spend
- Note on unmatched POs (~$623K blank-job bucket)

**Page 6 — Job Drill-Through** (not in nav, accessed via click)
_One-screen answer: "Everything about this one job"_
- Job name, customer, status, type as header
- Actual vs Quoted vs ETC hours — 3 cards
- Hours trend by month for this job
- Parts cost summary
- Employee hours breakdown for this job

---

### WHAT TO AVOID

- No walls of numbers — if a table has >10 rows visible without scroll, it's too much
- No color gradients or shadows on charts
- No tooltips as primary info — key numbers always visible
- No more than 6 visuals per page
- No redundant slicers — one filter panel, consistent across all pages
- Never use `Job Profitability %` as primary metric (clamps at 100%, misleading)
- Always filter `Function Hierarchy[Is Total] = FALSE` when slicing by function

---

### TONE CHECK (before publishing)

Ask yourself:
> "Can a manager open this and answer their question in under 10 seconds?"

If no → simplify.
If yes → ship it.

---
_Based on SDC Brand Guide 2026 | Built for SDC PowerBI DEV environment_
_Last updated: 2026-06-03_
