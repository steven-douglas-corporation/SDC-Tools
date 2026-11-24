# The vocabulary model (draft 1)

The shape of the curated ontology the [README](README.md) asks for: the things
SDC tracks, the words it uses for them, and how those words changed over time.

This page describes structure only. The model's rows are data and live outside
the repo, in `model\` beside the inventory database (`%LOCALAPPDATA%\SDC-Brain`
by default). So do the two scripts that currently build it, because they carry
counts taken from the shares.

**Status: every row is a candidate.** The first draft (2026-11-24) came from
file and folder names in the inventory and from the lists inside Total ETO. No
document contents were read, and no person has confirmed anything yet. Open
questions for reviewers are in `open-items.md` beside the database.

## Two sources, two jobs

| Source | Used for | Why |
|---|---|---|
| File shares | The words | Entirely SDC's own wording, and decades deep |
| Total ETO | The structure | It is the system of record, but its history is short and its field names are its vendor's |

Total ETO's vendor names are kept as synonyms, never as the preferred word. A
list SDC typed into Total ETO (section types, hour types, part categories,
phases) counts as SDC wording. Where SDC renamed a vendor field on screen, the
model keeps all the names: the vendor's, the table's, and SDC's.

## Tables

| Table | One row is | Main columns |
|---|---|---|
| `system` | A source system | what it holds, how far back its history goes |
| `entity` | A kind of thing SDC tracks | SDC name, kind, definition, vendor name, Total ETO table, system of record, status |
| `relationship` | A link between two entities | from, verb, to, evidence |
| `term` | The suggested standard word for an idea | concept, preferred word, entity, status |
| `term_variant` | One synonym for an idea, in one system | jobs using it, first and last job, jobs per hundred-band, trend |
| `change_event` | An older wording replaced by a newer one | old, new, around which job, evidence, confidence |
| `list_value` | One allowed value in a list | list, value, times used, system, origin |

Entity kinds in use: party, thing, event, document, container, list.

Status values are the README's: `candidate`, `confirmed`, `rejected`. Reviewer
and review date are not columns yet; add them when the first review comes back.

## Rules

1. **Job number is the clock.** File timestamps are unreliable after a bulk
   reorganisation of the job folders, so "when" is measured by job number, in
   bands of one hundred.
2. **Keep every synonym.** A word that fell out of use stays in `term_variant`
   with its first and last job. Old folders still use it, and so do people.
3. **Every entity names its system of record.** Where two systems hold the same
   thing, that column says which copy wins. "No single system" is a valid
   answer and worth recording.
4. **Counts are of names, not contents.** A word is counted when it appears in a
   file or folder name.
5. **Trend** compares an early run of job bands with the latest ones: rising,
   fading, steady, or rare (too few jobs to say).
6. **A change is a claim with evidence.** Each `change_event` row states the
   counts behind it and a confidence, so a reviewer can disagree with it.

## Known limits

- The word families are chosen by hand. A word nobody thought of is not counted.
- Jobs still in progress undercount late-stage documents.
- Short abbreviations match by accident and need a person to read the hits.
- Systems other than Total ETO and the shares are listed but have not been read.
- Total ETO facts were read once through the read-only connector and typed in;
  a rebuild does not refresh them.

## Not built yet

- The build scripts are not in this package. Moving them in means separating
  the code from the counts they embed, and adding tests with invented names.
- A loader that reads the Total ETO lists directly instead of a typed copy.
- Writing reviewers' answers back into the model as `confirmed` or `rejected`.
