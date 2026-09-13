# Paylocity hours that never reach job costing

**Report date:** 2026-09-02 · **Source:** `Current_Job_Hours.xlsx`, imported 13:49 · **Scope:** all punch history in the Reports App (2025-01 → 2026-09)

---

## The one-paragraph version

Of **170,580 hours** imported from Paylocity, **152,434 (89.4%)** are attributed to a job
and appear in job costing. **18,146 hours (10.6%)** are not, and they split into two
completely different problems:

| | Hours | What it is | Who can fix it |
|---|---|---|---|
| **1. No job number typed** | **16,919** | The Job field says "Not Defined" | Whoever manages Paylocity time entry |
| **2. A job number typed, but no matching job** | **1,227** | e.g. `0925`, `0735`, `0911` | Whoever manages the app's job list |
| | **18,146** | | |

Problem 1 is **93%** of the missing hours. Problem 2 is the one I was asked to detail,
and it is the smaller half — but it is also the more tractable one, because the person
who booked the time *did* say which machine they worked on.

Nothing here is hidden by the app. Every one of these 18,146 hours is visible in
**Dashboard → Data Quality → Undefined Hours**, with the date, the employee, the section
and the reason on each row. They are excluded from *job* reports for the simple reason
that there is no job to put them against.

---

## Problem 2 in detail: 1,227 hours on 34 job numbers

### What kind of work is it?

This is the finding that explains almost everything:

| Work type | Hours | Share |
|---|---|---|
| **Service / Spare Parts** (sections `80-*`, `90-*`) | **992.2** | **81%** |
| Build / Engineering phases | 214.3 | 17% |
| Warranty (`70-*`) | 20.8 | 2% |

Four fifths of it is **service work**. And the job numbers involved — `0925`, `0735`,
`0911`, `0964`, `0923`, `0934`, `0803`, `0710`, `0833` — sit in the 700–990 range, at or
below the oldest job the app knows about (the app holds 240 jobs, numbered 788 to 25590).

**The likely explanation:** SDC built a machine years ago, the service team is now
servicing it, and the technician books their time to that original build-job number —
which was never imported into the Reports App. The time is booked correctly by the
technician; the app just has no record of the machine.

That is a job-list gap, not a time-entry mistake, and it means service labour on older
machines is currently invisible to job costing.

### One of them is our bug, not a data problem

| Typed | Hours | Should be |
|---|---|---|
| `1037-02` | **25.95** | Job **1037 — 60L Seamer Conversion** |

Rob Caspio booked 25.95 hours to `1037-02` between 2025-03-31 and 2025-04-15. Job 1037
exists in the app; the `-02` suffix is what stops it matching. The app can be taught to
strip that suffix — nobody needs to re-enter anything.

### The full list — everything the app could not match

Sorted by hours. "People" is who booked the time, largest first.

| Job number | Hours | Punches | Worked between | Mostly | People |
|---|---|---|---|---|---|
| `0925` | 315.74 | 89 | 2025-10-15 → 2026-05-07 | Service `80-311` | Robert Klingensmith (164.75), Ivan Galvez (102.50), Darrin McCauley (37.07), +4 |
| `0735` | 131.50 | 45 | 2025-02-06 → 2026-07-17 | Service `80-*` | Jesse Brown (32.23), Ian Milne (30.76), Ivan Galvez (24.00), +4 |
| `0911` | 110.55 | 42 | 2025-06-25 → 2026-06-08 | Service `80-311` | Ivan Galvez (44.25), Neil Davis (27.50), Darrin McCauley (11.00), +3 |
| `1090` | 92.49 | 30 | 2025-01-06 → 2026-01-19 | Build phases | Andre Shirk (67.49), Timothy Spehar (18.50), +2 |
| `0964` | 73.36 | 16 | 2025-07-21 → 2026-04-13 | Service `80-412` | Darrin McCauley (49.11), Monica Saggio (23.50), +1 |
| `0923` | 64.28 | 27 | 2025-04-17 → 2026-01-27 | Service `80-*` | Loyd Miller (19.26), John Raguz (9.69), Timothy Spehar (9.00), +5 |
| `4263` | 56.00 | 19 | 2026-01-30 → 2026-02-23 | Service `80-311` | Robert Klingensmith (56.00) |
| `0934` | 47.21 | 17 | 2025-04-30 → 2026-04-23 | Service `80-*` | Ivan Galvez (20.50), Darrin McCauley (19.23), +2 |
| `0803` | 36.50 | 10 | 2026-02-25 → 2026-03-02 | Service `80-311` | Robert Klingensmith (34.00), Timothy Spehar (2.50) |
| `0710` | 35.75 | 9 | 2025-04-30 → 2025-06-09 | Service `80-311` | David Shaner (35.75) |
| `0833` | 34.50 | 12 | 2025-06-04 → 2025-06-19 | Service `80-311` | Ivan Galvez (29.00), David Shaner (5.50) |
| `0930` | 26.31 | 10 | 2025-03-07 → 2025-06-06 | Build `10-414` | Keith Schwentker (18.50), Eric Knapp (4.90), +2 |
| **`1037-02`** | **25.95** | 8 | 2025-03-31 → 2025-04-15 | Build `10-411` | Rob Caspio — **app bug, see above** |
| `2024` | 24.34 | 12 | 2025-01-13 → 2025-03-31 | Build | Sean Hamp (12.53), Kevin Novotney (7.86), +2 |
| `624` | 20.50 | 9 | 2026-05-20 → 2026-05-28 | Service `80-311` | Ivan Galvez (20.00), Monica Saggio (0.50) |
| `680` | 17.50 | 4 | 2025-07-09 → 2025-10-31 | Service `80-*` | Jesse Brown (9.50), Ivan Galvez (8.00) |
| `0627` | 15.83 | 4 | 2025-04-03 → 2025-04-04 | Service `80-*` | — |
| `740` | 10.63 | 4 | 2025-06-06 → 2025-06-10 | Spare Parts `90-211` | — |
| `0690` | 10.50 | 4 | 2025-04-11 → 2025-05-14 | Service `80-311` | — |
| `0907` | 10.50 | 7 | 2025-04-15 → 2026-07-27 | Service / Warranty | — |
| `1025` | 9.50 | 2 | 2025-01-24 | Build `1-411` | — |
| `2022` | 8.00 | 2 | 2025-05-08 | Spare Parts `90-411` | — |
| `099` | 6.36 | 3 | 2025-01-23 → 2025-01-24 | Build | — |
| `036` | 6.00 | 3 | 2026-02-13 → 2026-02-18 | Service `80-311` | — |
| `661` | 5.50 | 2 | 2025-05-20 | Service `80-311` | — |
| `0915` | 5.25 | 3 | 2026-06-18 → 2026-06-22 | Service `80-311` | — |
| `0089` | 4.83 | 2 | 2025-06-12 | Build `10-414` | — |
| `0916` | 4.65 | 2 | 2025-06-10 | Warranty `70-211` | — |
| `2023` | 4.37 | 2 | 2025-04-15 | Build `10-414` | — |
| `0114` | 4.00 | 2 | 2026-03-11 → 2026-03-12 | Service `80-311` | — |
| *(4 more under 4 h)* | ~7 | | | | |

Every punch, with employee name, date, hours, section and the exact source-file row, is
in the attached **`unmatched-job-hours.csv`** (407 rows).

---

## What I suggest doing about it

**1. Ask the service team what `0925`, `0735`, `0911`, `0964`, `0923` are.**
Those five carry 695 hours — 57% of the problem — and are almost all service work. If
they are machines SDC built, the question for the job-list owner is whether those build
jobs should exist in the Reports App so service time can be booked against them.

**2. Decide where legacy service time should land.**
If old build jobs are deliberately *not* in the app, then service work on them needs a
home — a standing "Service — legacy machines" job, or one job per machine. Right now it
has none, so 992 hours of real service labour is outside job costing. This is a business
decision, not a code fix.

**3. Let me fix the `1037-02` case.**
One line: strip a `-NN` suffix before matching a job number. It recovers 25.95 hours and
prevents the same thing happening to every future `-02` entry. Low risk.

**4. Separately, look at the 16,919 hours with no job number at all.**
That is 93% of all unattributed time and dwarfs everything above. It is a Paylocity
time-entry question — why "Not Defined" is available, or being chosen — and worth its own
conversation with whoever owns time entry.

---

## How to check this yourself, any time

```
npx tsx -r ./scripts/shim-server-only.cjs scripts/audit-punch-coverage.ts
npx tsx -r ./scripts/shim-server-only.cjs scripts/audit-unmatched-job-labels.ts --csv
```

Both are read-only and safe to run against production. The first gives the 89% / 11%
split; the second produces this report's tables and the CSV.

---

### A note on what this report does *not* say

These 18,146 hours are **not** missing from Paylocity, and they are **not** hidden by the
Reports App — they are recorded, imported, stored and visible in the Undefined Hours
panel. What they lack is a job to be counted against. Everything above is about finding
those jobs, not about recovering lost data.

Job-level figures elsewhere in the app reconcile exactly to the punches they *can*
attribute: verified 2026-09-02 on jobs 1131, 1104 and 1118, each matching its punch total
to the penny.
