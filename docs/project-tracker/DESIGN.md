# SDC Project Tracker: design notes

Working design record for the in-house project and task tracker. It captures what has been
decided since the 2026-11-11 draft (spec, `sdc_tracker_schema.sql`, `forecast_prototype.py`)
and what is still open. Uncertain items are tracked in the SDC IT RAID Log workbook
(`SDC_IT_RAID_Log.xlsx`, kept outside this repo), under Scope = "Project Tracker". IDs below
such as D-08 or R-06 refer to rows in that workbook.

Status: draft, updated 2026-11-15. The schema, the forecast engine, the service layer and a first
set of screens are built and tested as a module of SDC Reports (`apps/reports/src/modules/tracker`). Nothing is deployed. In a running copy the screens are visible only to the ELT role.

## Decided

### Platform

| Topic                    | Decision                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database engine          | PostgreSQL for the tracker and for new work. Existing MySQL apps stay as they are.                                                                                                    |
| Naming                   | Lowercase with underscores (`tracker.task`), no quoted names. The warehouse is to be renamed to match (RAID I-07).                                                                    |
| Sign-in                  | Single sign-on for every app. Mechanism still open (RAID D-11).                                                                                                                       |
| Forecast engine language | TypeScript, ported from the Python prototype. The spec's worked example is kept as a fixed test so the port is provably identical.                                                    |
| One write path           | The UI, the AI chat and any webhook all go through the service. Enforced in the database: the chat gets a read-only login, and the engine's login can write only the forecast tables. |
| AI chat                  | Talks to API endpoints, never to the tables directly.                                                                                                                                 |

### Estimates

- Original estimates are chosen from an enforced company standard, not typed freely.
- Each choice is a label paired with hours, and both are shown, for example **1 Day (6 hours)**.
- Hours follow the global definition of a day of project work (6 of 8 hours today):

  | Label                     | Hours |
  | ------------------------- | ----- |
  | Half a day or less        | 3     |
  | 1 Day                     | 6     |
  | 3 Days                    | 18    |
  | 1 Week                    | 30    |
  | 2 Weeks (should be split) | 60    |

- The hours are stored on the task, not the label, so a later change to the global day does
  not alter estimates already made.
- Remaining effort stays a free number, because it burns down.
- There is no default estimate. A task with no estimate is reported as unscheduled, with the
  reason "no estimate", and is counted on the project roll-up.

### Statuses

- Blocked is its own status category, alongside to do, in progress, done and cancelled. It is
  not a kind of in progress.

### Remaining effort

- A last-updated date is kept for remaining effort, in addition to the change history that is
  already logged.

### Capacity

- Capacity is configurable at three levels: a global default, a team override and a person
  override. The most specific one wins.
- Estimate buckets are global and do not vary by team or person. A person with less capacity
  simply takes longer: a 6-hour task for someone with 2 project hours a day takes 3 days.
- Work done outside the tracker is reflected in the person's capacity setting.

### Dates on a task

- **Planned start**: a person's intent. The engine ignores it; it is shown beside the forecast.
- **Not before**: a constraint the engine obeys. Set through an explicit action with a reason.
- **Due date**: a commitment, at least for milestones, so a single milestone can be flagged
  at risk. New; not in the draft schema.

### Scheduling

- A task that blocks higher-priority work is scheduled at the priority of the most important
  thing waiting on it. This applies to the whole ordering (project rank, sprint, task priority),
  passes down through chains of dependencies, is computed on each run without changing the
  stored priority, and is recorded as the reason on the forecast.

### Kinds of card (decided 2026-11-15)

- Every card has a **kind**: Epic, Feature, Story, Task, Bug, Issue or Milestone. It is chosen on
  the card itself and is **Task unless something else is picked**, so a team that wants a plain
  list never opens the menu and has a board of Tasks. There are no project types.
- A card with no kind was allowed at first and treated exactly like a Task. That gave one thing
  two names, so it was removed the same day (`0005_kind_required.sql`): existing cards with no
  kind became Tasks. "Card" remains the general word for any item, whatever its kind.
- **Milestone is a kind**, at the bottom level: a date that matters, with no hours. It used to be
  a separate setting. The old `type` column stays for the forecast and is kept in step by the
  database.
- A "?" beside each Kind field opens a small picture of the kinds as a ladder, with one line on
  what each is for.
- A card can sit under another card only if that card is of a **higher kind**: Epic, then
  Feature, then Story, then Task, Bug, Issue and Milestone together at the bottom. Levels can be
  skipped, so a Story can sit straight under an Epic. Nothing can sit under the bottom level.
- A card with cards under it carries no hours of its own in the forecast. It shows what the
  cards under it add up to, and it finishes when the last of them does.
- **Hours on a parent are flagged, not moved.** A sized card that becomes a parent keeps its
  own estimate and hours left, but the forecast stops counting them once a card sits under it.
  While they are there, the board, the timeline and the card's page say how many hours are not
  counted and how that compares with what the cards under it add up to, including how many of those have no estimate yet. The page has a button to clear them. Nothing is cleared or moved automatically:
  only the person knows whether the cards under it already cover the work.
- **A parent follows the cards under it.** It moves to done when the last open card under it
  closes, and reopens when a card under it is open again or a new open card is put under it.
  A parent whose cards were all cancelled is left alone: nothing was finished.
- **Closing a parent by hand over open work asks first.** The screen lists the open cards under
  it and the person chooses: mark them done, cancel them, or leave everything as it is. The
  choice exists because leftover cards are either work that was done and never updated, or work
  no longer needed, and only the second should be cancelled.
- **A project's done count is over cards that carry work.** A parent is not counted beside the
  cards under it. Each kind the project uses gets its own count next to it.
- **A dependency on a parent means everything under it.** "Feature B waits on Feature A" is
  stored once, on the two Features, and applied by the forecast as: every work card under B
  waits on every work card under A. A card cannot wait on a card it sits under or over.
- Breadcrumbs are the only navigation on a card's page, and they show the cards it sits under.
  There is no close or back button.
- "Issue" is there so the open issues in the RAID log can move into the tracker as ordinary
  cards once it is in use. Risks and assumptions stay in the RAID log.

### Dependencies between projects (decided 2026-11-15)

- There is no "project B depends on project A" link. A project nearly always needs one
  particular thing from another, and waiting for the whole of it would hold work up for no reason.
- Instead **a card can wait on a card in another project**, usually on a Milestone there. All
  projects are forecast in one run, so this needed no change to the engine, and the rule that a
  blocking card is pulled forward to the priority of what waits on it already works across
  projects.
- A person can link only to a card in a project they have a role on. Someone who can see the
  waiting card but not the other project is shown that it waits, and on which key, but not the
  other card's title.
- The timeline of all projects shows the result: an arrow from one project to another whenever
  an open card in the second waits on an open card in the first. Nothing is maintained at
  project level.

### Who is behind a card (decided 2026-11-15)

- A card records two people besides its assignee, because they are two different facts.
- **Requested by**: who wants the work. It starts as whoever creates the card, can be changed on
  the card's page, and a change is logged in the history. This is what covers a card made on a
  colleague's behalf.
- **Created by**: who, or what, made the record, and when. It is set once and the database
  refuses to change it, so a card's history can be trusted.
- A card made by automation will name the user it acted for as the requester and itself as the
  creator, and the write API will refuse a card with no requester. Not built: the API is still
  read-only and automation has no identity of its own yet (backlog M-12).
- "Reported by", the first label, was dropped: it is bug-tracker wording and did not fit an Epic
  or a Task.

### Links to the rest of the business

- Projects and tasks can optionally link to a job number, section and function codes, a team,
  and a role pool. These are in the model from the start whether or not the first release
  uses them.
- A **role pool** is a named group of people with the same skill, for example "Controls
  engineer". A task can be assigned to a pool before a person is named, and the engine
  schedules it against the pool's free capacity. Pools are not the same as roles or
  departments: one person can be in several, and membership changes with need.
- A **team** is where a person sits in the organisation. It drives capacity defaults and
  reporting.

## Proposed, not yet confirmed

| Topic                               | Proposal                                                                                                                                                                                                                                           | RAID       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Where the tracker's tables live     | Decided 2026-11-14: a `tracker` schema in the shared PostgreSQL database, with its own logins. Restore by schema, never the whole database.                                                                                                        | D-10, R-10 |
| How sign-in works                   | Decided 2026-11-14: sign in against Entra directly. One `person` table keyed by Entra object id, carrying email and Paylocity id. Blocked in production until the apps have an HTTPS address.                                                      | D-11, R-14 |
| Permissions                         | Per-project membership (viewer, contributor, manager) plus two global roles: admin, and the owner of the stack rank.                                                                                                                               |            |
| App shape                           | Service functions with API routes and screens, inside SDC Reports. The tracker is the first module of the one SDC app (ADR 0006, decided 2026-11-14); that app is SDC Reports, changed in place; moving this work into it is conversion task M-00. |            |
| Schema changes                      | Numbered SQL migrations, as planned for the warehouse.                                                                                                                                                                                             |            |
| Blocked tasks                       | Require a reason; allow an expected-unblock date. With a date the engine schedules from it; without one the task is unscheduled.                                                                                                                   |            |
| AI estimate                         | The AI suggests a bucket and its reasoning in a separate field; a person accepts or overrides. Later, grounded in similar finished tasks.                                                                                                          |            |
| At-risk flag                        | Based on P50 or P80, not the single-date forecast.                                                                                                                                                                                                 | R-06       |
| Remaining effort on job-linked work | Defaults to budget minus Paylocity actuals, refreshed daily, with manual override.                                                                                                                                                                 | D-09, I-05 |
| Time off and holidays               | Roster from the Paylocity tables the warehouse loads, copied into the tracker daily, never read live and never from reporting tables. Holidays and time off typed into the tracker at first; time off from Paylocity later (M-15).                 | DEP-05     |

## Open items

The SDC Scheduler question is open and recorded as RAID D-08: whether the Scheduler remains
the customer-facing timeline with its ship date feeding a linked tracker project, or whether
the tracker eventually takes over its planning. Until that is decided the design assumes the
Scheduler is unchanged and the tracker only links to a job number.

Other open items in the RAID log: decisions D-09 to D-14, issues I-05 to I-07, risks R-06 to
R-13, assumptions A-04 to A-09 and dependencies DEP-03 to DEP-07.

## What is built

The tracker is a module of SDC Reports, laid out as [apps/reports/docs/MODULES.md](../../apps/reports/docs/MODULES.md)
describes. Its 59 tests run with Reports' own `npm test` and need no database server: they load
the schema into a real Postgres engine that runs inside the test.

| Piece                     | Where, under `apps/reports`                                                 |
| ------------------------- | --------------------------------------------------------------------------- |
| Schema and database roles | `db/tracker/migrations/`                                                    |
| Forecast engine           | `src/modules/tracker/forecast/engine.ts`                                    |
| Service layer             | `src/modules/tracker/service/`                                              |
| Database connection       | `src/modules/tracker/db.ts`                                                 |
| Forecast job              | `scripts/tracker/run-forecast.ts`                                           |
| Screen actions            | `src/modules/tracker/actions.ts`                                            |
| API routes (read-only)    | `src/app/api/tracker/` and `src/modules/tracker/api.ts`                     |
| Screens                   | `src/app/(app)/tracker/` (thin pages) and `src/modules/tracker/components/` |
| Tests                     | `tests/tracker-*.test.ts`                                                   |

### Schema

`0001_schema.sql` replaces the 2026-11-11 draft. `0002_roles.sql` adds the three database roles
that enforce the one write path.

- `blocked` status category, with a reason and an expected-unblock date on the task.
- `due_date`, a required reason for `not_before_date`, and a last-updated stamp for remaining
  effort that is set on change or by a confirm.
- A `baseline_completion_date` so slip is measured against the first date typed, not the latest.
- Estimate buckets as a company standard (`effort_bucket`), with the hours stored on the task.
  All effort is hours; the per-project effort unit and points are gone.
- `person` as the shared user key, plus `team`, `role_pool` and pool membership.
- Capacity at global, team and person level with date ranges (`capacity_setting`,
  `person_capacity_on`).
- Optional job number on projects, and job, section and function codes on tasks.
- A project change log; dependency changes logged on the task.
- Stack-rank uniqueness that can be deferred, so ranks can be swapped. An active project must
  have a rank; a planned one may not have one yet.
- Parent cards in the same project. `0003_work_kinds.sql` replaced the first rule (one level
  deep) with kinds: a card sits only under a card of a higher kind, enforced by a trigger.
- Roll-up view: forecast dates from one place, current run only, at-risk on P80, with counts of
  unscheduled, unestimated and stale tasks. A parent's hours are not counted on top of its subtasks.
- Only finish-to-start dependencies; the other three types were removed until the engine supports them.

### Forecast engine

A TypeScript port of the Python prototype. It reproduces the spec's worked example date for
date, which is kept as a test.

- Priority inheritance through chains of dependencies, reported as `priorityFrom`.
- "No estimate", "no assignee" and "blocked" as unscheduled reasons; zero-effort scheduling for
  milestones only.
- Role-pool scheduling: a pool task goes to the member who would finish it first.
- Allocation shares with no work are released; allocation and capacity date ranges are honoured.
- Simulation shares part of each task's estimate error across its project. On a 60-task plan the
  P50 to P80 gap is 13 days, against 4 when every task is sampled independently.
- Self-checks (`verify`) for capacity, calendar, dependencies, effort and priority order.
- Speed on a development PC: a 1,000-task schedule in about 10 ms; 2,000 simulation runs of it
  in about 26 s. A schedule after every change is fine; the simulation belongs in a nightly job.

### Service layer

The only code that touches the tracker's tables. Each function does its work and its logging in
one transaction.

- People: a tracker person is created the first time an email is seen, which is how a
  signed-in user is matched to their work.
- Projects: create (default columns, creator as manager), change target date, state, priority or
  owner with a change-log row each, manage members, and set stack ranks, several at once so two
  projects can swap.
- Tasks: create with a number from the project's counter and the first status-log row; edit with
  a change-log row per tracked field; the first estimated completion date becomes the baseline
  and is never replaced; confirm remaining effort without changing it; archive.
- Status changes: the status-log row, the actual completion date set on entering done and
  cleared on leaving it, and a required reason for a blocked status.
- Dependencies: a link that would create a loop is refused; adding and removing are logged on
  the waiting task.
- Access: a project role (viewer, contributor, manager) is checked on every change; ranking is
  for the portfolio owner; an admin can do anything.
- Forecast run: loads tasks, people, capacity, time off, allocations, pools and holidays from
  the tables, runs the engine, and replaces the stored forecast in one transaction. Work in a
  project that is on hold or has no stack rank is reported with that reason. A quick run leaves
  the last simulation's P50 and P80 in place.

### Screens

Reached from a "Project Tracker" entry in the sidebar, which only roles holding `tracker:view`
see. Both permissions ship off for every role, so on a fresh deploy that is ELT alone.

- **Project list** (`/tracker`): projects in stack-rank order with the target, the forecast, P80,
  whether it is at risk, and the work the forecast leaves out. New projects are created here;
  ELT sets the stack rank and a manager makes a ranked project active.
- **Board** (`/tracker/KEY`): one column per status. A card shows who has it, the hours left, the
  due date, the forecast dates and one sentence on why it starts when it does, or why it is not
  forecast. Tasks are added at the top, moved by dragging or with a status menu on the card, and
  edited in place. Moving a card to a blocked status, either way, asks what is blocking it and
  when it is expected to clear. A panel under the board lists the people on the project; a
  manager adds people, changes their role or removes them there.
- **Task page** (`/tracker/KEY/42`): every field, with an optional reason for a change; the
  forecast and its reason; what the task waits on (add and remove, with lag) and what waits on
  it; comments; and the history, which is the status log and the change log read back together
  in plain words, newest first.
- **Kinds and hierarchy**: the new-card form and the task page have a kind, Task by default, with a "?" that explains the kinds. The task
  page has a "Sits under" menu that lists only cards of a higher kind, and the service refuses
  anything else in a sentence that names the cards involved. A card shows its kind and the card
  it sits under; a card with cards under it shows how many, how many are done, the hours left
  and the latest forecast finish among them, on the board and on its own page. The breadcrumb
  on a task page shows the cards above it. Changes to kind and parent are in the history.
- **Timeline** (`/tracker/KEY/timeline`, a tab beside Board): a row per card, grouped under the
  card it sits under and ordered by start date; a bar from the forecast's start to its finish,
  with a paler tail to P80; a thin dark bar for a parent, spanning the cards under it; an arrow
  for each dependency; marks for today, the project target, due dates, milestones and finished
  cards. Read-only. Every date on it is the stored forecast, the same one the board shows.
- **Timeline of all projects** (`/tracker/timeline`, a tab beside the project list): a row for each
  open project in stack-rank order, a bar from the first forecast start of its work to its
  forecast finish with a tail to P80, its target date, and an arrow where one project has a card
  waiting on another's. A project's key opens that project's own timeline.
- **Waiting on another project's card**: the "Make it wait on" menu lists this project's cards,
  then the cards of every other open project the person has a role on.
- **People and time** (`/tracker/people`): the length of a normal project day, a figure of their
  own for anyone whose day is shorter, time off, and company holidays. ELT sets the default,
  other people's hours and the holidays; anyone can enter their own time off.
- After every change the quick forecast is re-run, so the dates on screen are never older than
  the last edit. The simulation is never run from a screen.
- A quick run drops the last simulation's P50 and P80 when they can no longer be true (made for
  another day, or earlier than the new forecast date). Risk is then judged on the plain forecast
  until the next simulation.
- This app's users are copied into the tracker's list of people, so anyone can be assigned work
  before they have opened the tracker.

### Not built, and known limits

- The API is read-only and uses the browser session: `GET /api/tracker/projects`, one project,
  and one task. There is no service token yet, so an AI tool running on a server cannot call it,
  and nothing can be changed through it.
- Dragging was checked by sending the browser's drag events to the page, not with a real mouse
  drag; the testing tool could not perform one. It needs a try by hand.
- No screens yet for sprints, role pools, teams and team capacity, date-ranged capacity, a
  not-before date, archiving a task, or dependencies on a task in another project. The schema
  supports all of them.
- The P50/P80 simulation is not scheduled anywhere. It runs only when someone runs
  `npm run tracker:forecast`, so P80 is blank after any edit until it is run again.
- Someone with `tracker:view` but not `tracker:edit` cannot enter their own time off.
- Timeline: there is one for each project and one across all projects, but none by person. It cannot
  be zoomed or filtered, cards cannot be dragged on it, and a long project scrolls sideways. It
  was checked by eye in a local copy with a handful of cards, not with a large project.
- Dependencies and parents: moving a card under a different parent is not checked against the
  dependencies already there. If that makes a loop, the forecast reports the cards as "its
  dependencies form a loop" instead of the move being refused.
- Kinds: the board has no view grouped by Epic or Feature and no filter by kind. A
  parent's P80 is not shown, only the latest plain forecast finish under it. The list of kinds
  is fixed in a migration; there is no screen to change it. A parent card can only be chosen on
  the task page, not when a card is first added.
- Time off is typed in by hand. Approved time off is already in Paylocity, and the plan is to
  import it from there daily (backlog M-15). Not started, and nothing at SDC receives time off
  from Paylocity today: Reports gets worked hours, the roster and position families as report
  files the warehouse loader loads, and there is no Paylocity API connection. A time-off report
  has to be added to that load first.
- Keeping operational and reporting data apart: the tracker copies what it needs from a source
  system into its own tables on a schedule, and the forecast reads only those. It never queries
  the warehouse while serving a page, and never reads the warehouse's reporting tables. The
  warehouse's loaded Paylocity tables are the one allowed source there, because they are the
  only place Paylocity's files land.
- Run against a real server once, by hand (2026-11-15): the migrations, the service and the
  forecast job passed against PostgreSQL 16 in the dev Docker container, through the production
  driver and under the restricted logins. That check is not automated; the tests that run on
  every change use the in-process database.
- The forecast refuses to run if the global capacity default is missing. That run against a real
  server is what showed the need: without the row every person had zero hours and all work was
  reported as "no capacity".
- A dependency on a parent task is ignored by the forecast. Only tasks that carry effort
  themselves are scheduled.
- A failed forecast run leaves no record: the run row is rolled back with everything else.
- Dependency lag is in calendar days. Whether it should be working days is undecided.
- The simulation's range (0.8 to 1.5, or a bucket's low and high hours) and its shared-error
  weight (0.5) are placeholders until there is history to calibrate them (RAID R-06).
- Allocation release looks at whether a project has any work for the person in the run, not day
  by day, and does not count pool tasks.
- A coarse task larger than the biggest bucket (for example 120 hours for one job and function)
  can be stored with typed hours; nothing yet stops an ordinary task doing the same.
- The AI estimate suggestion has no columns yet.
- The 2026-11-11 Word spec has not been rewritten; this document and the code supersede it
  where they differ.
