# Share inventory

Read [README.md](README.md) before changing anything here. General practice
(branching, pull requests, commits) is the repo's `CONTRIBUTING.md`. The rules
below are specific to this folder and are the ones that cause damage when
missed.

## Data

- **No crawled data in git.** No inventory database, report, finding, or file
  listing. They live outside the repo (`%LOCALAPPDATA%\SDC-Brain` by default;
  `SDC_BRAIN_DATA` overrides it). The `.gitignore` here is a second line of
  defence, not the first.
- **No real customer, job, person or path names** in code, tests, comments,
  commit messages or pull requests. Tests use invented names (Acme, Globex). A
  share path a command needs is passed as an argument, not hard-coded.
- **Open questions and findings** go in `open-items.md` beside the database,
  not in the repo.

## The shares

- **Read-only.** Nothing here creates, changes, moves or deletes anything on a
  share.
- **Metadata only, unless a step says otherwise.** The inventory opens no
  files. A step that reads file contents says so, names the file types it
  reads, and is reviewed as such.
- **Flag, don't extract.** Something that looks sensitive (payroll, HR,
  credentials, customer NDA material) is recorded by path and reason, and that
  is all: do not open it, copy it, or send its contents to a model. Escalation
  is a person's decision.
- **Never use anything found.** A credentials file is reported, not tried.

## Code

- Python 3.12 or later, **standard library only** in `inventory`, `mining` and
  `findings`. A third-party dependency needs Jon's OK and goes in a separate
  package, not these three.
- `python -m unittest discover -s tests`, run from this folder, must pass
  before a commit. CI does not run these tests yet.
- Everything mined from names is a candidate for a person to confirm. Record
  how it was arrived at; do not present a guess as a fact, and do not tune a
  heuristic until a wrong answer disappears.
