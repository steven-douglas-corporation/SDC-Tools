# Share inventory

Part of the SDC Brain: capture the terms, taxonomy and ontology the company
already uses by reverse engineering them from what exists on the shares, rather
than inventing them. It also gives the warehouse its file index, and doubles as
an access audit of the shares.

This code was its own repository (`SDC-Brain`) until 2026-11-23; see
[ADR 0006](../../docs/adr/0006-share-inventory-under-tools.md).

## Where this fits

- **The design of the Brain** is the data warehouse roadmap,
  [`tools/data-warehouse/ROADMAP.md`](../data-warehouse/ROADMAP.md): the model,
  the measure catalog, vectors and tags, and the tools an assistant calls.
- **What feeds it** is the SDC Pipelines page
  (<https://claude.ai/artifact/VvudJqpSYySCvKxs3bCXZZ>, visible to the SDC
  organization): each lifecycle, the software behind it, and where its data
  lands in the warehouse. There this folder is the "file scan of the shares"
  that feeds the file index and the documents index.

Neither of those is repeated here. This page covers only the share inventory.

## Plan

1. **Inventory** (built): a metadata-only crawl of the shares. Paths, sizes,
   timestamps and attributes; no file is opened.
2. **Mine the paths** (built): job number formats, customer names, folder
   templates and document-type conventions, from the inventory alone.
3. **Flag exposure** (built): names that suggest sensitive material, and who
   can read them.
4. **Seed from structured sources**: reconcile the mined candidates against the
   entities the warehouse and the apps already define (jobs, customers,
   employees), rather than keeping a second list.
5. **Targeted content extraction**: templates, SOPs, quote and proposal
   templates, BOMs, title blocks, spreadsheet headers. Only file types named in
   advance, and only files a person has cleared.
6. **Human review**: each candidate term carries where it was seen, how often
   and how recently, and is confirmed by someone in that domain.

## Next

- A file format for the curated ontology: term, definition, synonyms, source
  evidence (where seen, how often, how recently), domain, status (candidate,
  confirmed, rejected), reviewer and review date.
- A script that turns the mining reports into candidate entries in that format.
  Output stays outside the repo until reviewed.
- Map the findings categories to the catalog's sensitivity flags (roadmap
  Phase 4), so a finding can set a flag by rule.
- Load the inventory into the warehouse as a raw schema. It lists where
  sensitive files sit, so it needs tighter access than the general read-only
  login. Today the inventory is one SQLite file on one laptop, with no backup.
- A shortlist, by metadata only, of pilot material for the engineering rules
  ([plan](../../docs/engineering-rules-plan.md)): PLC exports, drawing sets and
  title-block templates per job.
- Needs a person: name the reviewers for each domain, and get access to the
  six shares the crawl was denied.

## Rules

- **Git holds code and the curated ontology, never crawled data.** The
  inventory database lists where everything sits, including material that
  should not be widely readable. It lives outside the repo by default.
- **Everything reachable is crawled at metadata level**, so the crawl doubles
  as an access audit.
- **Sensitive finds are flagged, not extracted.** Record the path, why it was
  flagged and who can reach it; do not open it, copy it or send it to a model.
  Escalation to the owning team is a human step.
- **Read-only.** Nothing here writes to the shares.

## Inventory

Python 3.12 or later, standard library only. Run everything from this folder
(`tools/share-inventory`).

```
python -m inventory crawl "\\server\share\Job Folder"
python -m inventory status
```

The database defaults to `%LOCALAPPDATA%\SDC-Brain\inventory.db`. Set
`SDC_BRAIN_DATA` to a folder, or pass `--db <file>` before the command, to put
it elsewhere.

A crawl is a queue of directories held in the database, so it can be stopped
at any point and resumed by running the same command again. If the connection
drops it waits (30 minutes by default, `--max-outage-minutes`) and carries on
when the share comes back.

| Option | Effect |
|---|---|
| `--workers N` | Directories read at once. Default 8. |
| `--rescan` | Re-read every directory already known. |
| `--limit-dirs N` | Stop after N directories, leaving the rest queued. |

### What is recorded

- **Directories:** path, depth, modified and created times, attributes, and a
  status: `done`, `pending`, `denied` (access refused), `missing` (gone since
  it was listed), `error`, or `skipped` (a symlink or junction, recorded but
  not followed).
- **Files:** name, extension, size, modified, created and last-accessed times,
  attributes. Hidden and system files are included.

Timestamps are whole seconds since the Unix epoch, UTC. A file whose created
time is later than its modified time was copied or migrated: the modified time
is still the real one. Last-accessed is recorded but should not be trusted.

### Known limits

- A rescan marks a deleted directory `missing` but leaves its old file rows in
  place.
- Permissions are not part of the inventory. The findings step reads them for
  flagged folders only.

## Mining

Reads the inventory database only; no share access and no files opened.

```
python -m mining jobs
```

Treats each top-level folder of a crawled job share as one row and writes four
CSV reports to a `reports` folder beside the database:

| Report | Contents |
|---|---|
| `jobs.csv` | Job number, customer, description and quantity read from the folder name; file count, size, when it was active, sub-folder count. |
| `customers.csv` | Each customer with its job range, spelling variants, a possible parent (site or division) and similarly spelled names. |
| `job_subfolders.csv` | Sub-folder names used inside jobs and the job numbers they span, which shows the folder template and how it changed. |
| `description_terms.csv` | Words and word pairs used in job descriptions and the job numbers they span. |

Every customer records how it was identified: `delimited` (the name spells it
out), `known` (it starts with a customer seen in delimited form) or `inferred`
(leading words that recur). These are candidates for review, not facts.

`active_from` is the first year by which 5% of a job's files existed, because
the oldest file in a job is usually something copied in from elsewhere.

## Findings

Flags file and folder names that suggest sensitive material, so the people who
own it can check who is able to reach it.

```
python -m findings scan
python -m findings scan --acl
```

Reads the inventory database only and writes `findings.csv` beside the other
reports. Names are matched; **no file is opened**, so a finding means "worth a
look", not "confirmed". The report holds real paths and stays out of git.

| Category | Flags |
|---|---|
| Credentials | Passwords in a name, password stores, private keys, config files that usually hold secrets |
| People | Payroll, government ID, tax forms, HR and medical documents |
| Finance | Payment cards, bank details, tax returns, company books, invoices and receipts |
| Legal | NDAs, legal matters, anything marked confidential |
| Data stores | Mailbox files, database backups, disk images |
| Personal folders | Each folder another account can read in a share that holds a folder per person |

To keep the report readable, a flagged folder stands for everything beneath it,
matching files are grouped by the folder they are in, and third-party code
folders, source files and CAD models are skipped.

`--acl` asks Windows who can read each flagged folder (`icacls`, which does not
open or list the folder) and fills in `who_can_read` and `broad_access`, the
second being groups that mean nearly everyone. It needs the shares to be
reachable and works most severe first, up to `--acl-limit` folders.

The rules are in `findings/rules.py`. They are conservative on purpose: words
that are sensitive in an office but ordinary in a machine shop are left out,
and the reason for each omission is written there.

## Tests

```
python -m unittest discover -s tests
```
