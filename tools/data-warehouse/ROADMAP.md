# Data warehouse roadmap

## Why we're building it

The end goal is an **AI "brain" for SDC**: a chat assistant that answers questions about
the business by calling tools against trusted data — find the right measure, run SQL, look
up a job or a person — rather than guessing. Every phase below exists to make those tools
safe and accurate: reliable loads (Phase 2), one agreed model (Phase 3), measures and
meanings defined once (Phase 4), and semantic search over them (Phase 5). Phase 6 puts
the tools behind an API and hands them to the assistant.

Each phase builds on the one before it: semantic work (Phases 4–5) assumes a stable
model (Phase 3), and a stable model assumes the warehouse runs reliably (Phase 2).

| Phase | Theme | Outcome |
|---|---|---|
| 1 | Paylocity ingest | **Done (2026-10-04).** SFTP → raw → staging → `"Dimension"."Employee"`, `"Dimension"."Date"`, `"Fact"."JobHours"`. Reports app reads it |
| 2 | Run it like production | Service, schedule, backups, logging, observability, data-quality checks, schema change process |
| 3 | The model, derived from Power BI | Every Power BI table and relationship replaced by a warehouse dimension or fact, reconciled against Power BI's numbers |
| 4 | Measure catalog and semantics | Every measure defined once in SQL, with descriptions, synonyms and ownership on every table, column and measure |
| 5 | Vectors, tags and semantic search | Embeddings of the catalog in pgvector, subject-area tags, "find the measure for…" search, grounding for an AI assistant |
| 6 | Tools for the SDC AI brain | An API of tools (semantic search, measure lookup, read-only SQL, lineage, freshness) exposed to an AI chat assistant |

## Phase 2 — Run it like production

**Platform** (the open items in the README)
- Register Postgres as a Windows service; schedule the daily run; open the firewall rule.
- Backups: a nightly `pg_dump` plus the file archive, stored off this machine, with a quarterly test restore.
- Decide where the warehouse lives long term. A Linux VM is the better home: it gets off the shared app server, and Phase 5 needs pgvector, which the Windows Postgres binaries don't include.

**Logging**
- Structured logs: one JSON line per event (run, step, file, rows, duration, outcome), written to `D:\DataWarehouse\logs` and kept 90 days.
- Step timings in `"Integration"."Batch"."Counts"`, so slow steps show up as a trend, not a surprise.

**Observability**
- Health views in the database, e.g. `"Integration"."Health"`: last successful run, age of the newest file per report, and failed or stuck files.
- Alerts by email or Teams when a run fails, no new file arrives for a report within 26 hours, or a check below fails.
- A status page (in the reports app, or as a published dashboard) showing freshness per report, rows per load and recent failures.

**Data-quality checks**, run after every load and recorded per batch:
- **Volume:** rows per report against the previous version. Warn on a large swing.
- **Reconciliation:** hours in `"Fact"."JobHours"` equal hours in staging; staging equals raw.
- **Completeness:** share of punches with an Unknown employee or date. The goal is 0.
- **Schema drift:** a report's header row changed (new, missing or renamed column).

**Change process**
- Move the SQL from re-runnable scripts to numbered migrations (Flyway), plus re-runnable view definitions, so the repo always shows the current schema and every change is applied once, in order. Alternatively adopt dbt for staging, dimensions and facts. Decide before Phase 3 adds most of the model.
- CI: run the SQL against a scratch Postgres in GitHub Actions, then the loader's tests.

## Phase 3 — The model, derived from Power BI

`docs/reference/powerbi/Job Hours Report - Management Level` holds the Power BI model as text (TMDL): 48 tables, the relationships between them, and about 170 DAX measures. It's the specification for the warehouse.

1. **Inventory.** Parse the TMDL into catalog tables: every table, column, data type, relationship, and measure with its DAX, plus each table's data source (Power Query). Generated, not hand-typed, so it can be rerun when another report is exported.
2. **Bus matrix.** Map each Power BI table to a warehouse dimension or fact. The table-by-table
   review, sources and redesign candidates are in [POWERBI-REVIEW.md](POWERBI-REVIEW.md). First draft:

   | Power BI table | Warehouse |
   |---|---|
   | `Employee` | `"Dimension"."Employee"` (done) |
   | `Date`, `LocalDateTable_*` | `"Dimension"."Date"` (done; the 18 auto date tables go away) |
   | `Hours Actual`, `Job Employee Hours` | `"Fact"."JobHours"` (done) |
   | `Job`, `Assembly` | `"Dimension"."Job"`, `"Dimension"."Assembly"` from Total ETO |
   | `Function Hierarchy` | `"Dimension"."Function"` (section / function / department) |
   | `Hours Estimated`, `Hours Estimated to Complete History`, `Costs Estimated to Complete History`, `Estimated to Complete Period` | `"Fact"."EstimateToComplete"` (monthly snapshot) and `"Dimension"."EtcPeriod"` |
   | `Job Sales` | `"Fact"."JobSales"` |
   | `Part Purchase`, `Sage Part Cost` | `"Fact"."PartPurchase"`, `"Dimension"."Part"` |
   | `Travel Expenses` | `"Fact"."Expense"` (from `"Paylocity"."PaidExpense"`) |
   | `Standard Fees`, `Profitability - *` | Settings tables, or measures in the catalog |

3. **New sources.** Total ETO (SQL Server `SDC`, read-only), the Scheduler and ETC Planner (MySQL), and the Fabric tables (ETC history, Standard Fees) before Fabric is shut off.
4. **Reconciliation.** The Power BI model's SharePoint inputs are frozen as of 2026-10-04, so its numbers are a fixed target. Each new fact must match Power BI for settled months before Power BI is retired.
5. **Open decisions:** which family each of the 8 position codes listed under more than one family belongs to; the job dimension's handling of named categories ("2025 SERVICE") and machine-suffixed codes ("1037-02"), matching the reports app's rules.

## Phase 4 — Measure catalog and semantics

**Measure catalog**: every business number defined once, in SQL, shared by the reports app, any BI tool and any AI assistant.

| Field | Example |
|---|---|
| Name | Actual Hours |
| Definition (SQL) | `sum("Hours")` over `"Fact"."JobHours"` |
| Grain and allowed dimensions | Employee, Date, Job, Section, Function |
| Filters built in | e.g. Concord vs Travel |
| Source DAX | The Power BI measure it replaces, for traceability |
| Owner, status | Who signs off on it; draft / certified / deprecated |
| Validation | A query whose result must match a known figure |

Measure definitions live in the repo (YAML, reviewed in PRs) and are loaded into `"Catalog"` tables. The ~170 Power BI measures are the starting list, translated from DAX to SQL with LLM help and checked against Power BI's output.

**Semantic information** on every table, column and measure:
- Description in plain English, units, and example values.
- **Synonyms:** the Power BI model's `cultures/en-US.tmdl` already holds Q&A synonyms. Import them rather than starting from scratch.
- Sensitivity flags (personal data, pay), owner, and source lineage (raw table → staging → model).
- Stored in `"Catalog"` tables and mirrored to Postgres `COMMENT ON`, so tools like DBeaver show them.

## Phase 5 — Vectors, tags and semantic search

**Embeddings**
- One embedding per catalog item (table, column, measure), built from its name, description, synonyms and, for measures, the definition. Re-embed when any of those change.
- Stored in Postgres with pgvector: `"Catalog"."Embedding"` (item, model name and version, vector, source text hash), with an HNSW index.
- Store vectors, not pairwise distances. Postgres computes cosine distance at query time in milliseconds at this size. Distances stored in advance go stale with every model or description change. If a screen needs "related items", keep a small precomputed top-10 per item and rebuild it when embeddings change.
- Model: the source text is metadata, not row data, so a hosted embedding model is reasonable. Voyage AI is Anthropic's recommended provider. A local open-source model keeps everything on-site if preferred. Record the model and version with each vector, because vectors from different models can't be compared.

**Tagging**
- Use a **controlled list of subject areas** (Labor, Projects, Procurement, Finance, HR, Service…, about 10–20), assigned by an LLM from each item's description and reviewed by a person. Tags then mean the same thing every time they're regenerated.
- **Use clustering to discover the list, not as the tags.** k-means needs the number of groups chosen in advance and returns unnamed groups that reshuffle when items are added. HDBSCAN or hierarchical clustering on the embeddings, with an LLM naming each cluster, is a better way to propose the initial subject areas. A person then fixes the list.
- Multi-tag is allowed (a measure can be both Labor and Projects).

**What it enables**
- Search: "where is overtime?" finds the right measure even when nothing is named "overtime".
- Duplicate detection: measures with near-identical meaning, e.g. the same hours number defined two ways.
- An AI assistant (Claude) answering questions in plain English, grounded in certified measures and descriptions rather than guessing at table names.

## Phase 6 — Tools for the SDC AI brain

Expose the warehouse to an AI chat assistant as a small set of **tools** behind an API,
so the assistant answers from certified data and can show its work.

**Tools**

| Tool | What it does | Built on |
|---|---|---|
| `search_catalog` | "Where is overtime?" → the tables, columns and measures that mean it | Phase 5 embeddings and tags |
| `describe` | A table, column or measure: meaning, units, owner, lineage, freshness | Phase 4 catalog |
| `get_measure` | A certified measure by name, sliced by allowed dimensions and filtered (e.g. Actual Hours by job for September) | Phase 4 measure definitions |
| `run_sql` | Ad-hoc read-only SQL for what the measures don't cover | A read-only login, with guardrails |
| `data_freshness` | When each source last loaded, and anything failed or stale | Phase 2 health views |

`get_measure` is the preferred path. The assistant asks for a measure, and the server
writes the SQL from its certified definition, so two people asking the same question get
the same number. `run_sql` is the escape hatch.

**How it's served**
- An **MCP server** (Model Context Protocol), the same way `tools/totaleto/mcp-server`
  already gives Claude read-only Total ETO tools, plus a plain HTTP API for apps that
  aren't AI clients. One implementation behind both.
- The assistant is the "brain": Claude, with these tools and the existing Total ETO tools,
  so a question can span the warehouse and the live ERP.

**Guardrails** (`run_sql` especially)
- Its own read-only login with SELECT on the model schemas only, a statement timeout, a row cap,
  and a single `SELECT`/`WITH` statement per call. Copy the Total ETO server's read-only
  enforcement, which runs every query in a transaction that's always rolled back.
- **Per-person access:** the assistant acts as the person asking, using the same Windows
  identity as `sql/06_people.sql`. Sensitive data (pay, personal details) is protected by
  Postgres row- and column-level security, not by the prompt.
- Every call is logged (who, which tool, the SQL, row count, time) in an `"Integration"`
  audit table, which is also how we learn which questions people actually ask.

**Measuring it**
- A set of real questions with known answers (e.g. "hours on job 1118 in September",
  checked against the warehouse). Run it whenever the model, catalog or tools change,
  and track how often the assistant gets the right number from the right measure.

