"use server";

import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { logAudit } from "@/lib/audit";
// The one place a cell change is both recorded and announced. Every write below goes
// through it — see the §33.1 notes at each call site.
import { recordChanges, classifyChange, type CellChange } from "@/lib/change-log";
import { sectionName } from "@/lib/off-grid-hours";
import { VALID_JOB_TYPES, JOB_STATUSES, isSdcCustomer } from "@/lib/job-filters";
import { assertProjectsEditable } from "@/lib/projects-edit-mode";
import { CELL_SPECS, parseCell } from "@/lib/cell-rules";

const HOURS_PREFIX = "quoted__";

const FIELD_PREFIX = "jobField__";
const NEW_ROW_FIELD_PREFIX = "newRow__";
const NEW_ROW_HOURS_PREFIX = "newRowHours__";

// Job-level text/date fields that don't need special parsing/validation
// beyond "trim, empty string means null".
const PLAIN_FIELDS = ["jobName", "customer"] as const;
const DATE_FIELDS = ["startDate", "completeDate"] as const;
const MONEY_FIELDS = ["costQuoted", "costActualHistorical"] as const;
type PlainField = (typeof PLAIN_FIELDS)[number];
type DateField = (typeof DATE_FIELDS)[number];
type MoneyField = (typeof MONEY_FIELDS)[number];

// ── Refusing a write that would revert another user ─────────────────────────
//
// The Projects grid's write helpers below decide what to save by comparing the
// POSTED value against the DATABASE. That is fine for one user and wrong for two:
// a page working from stale data posts its old value, the comparison reads it as a
// deliberate edit, and a colleague's saved cell is silently reverted. Exactly the
// defect found on the Monthly ETC grid on 2026-08-04, present here too.
//
// So every changed control also declares the value it BELIEVED was stored
// (`__base__<name>`, see lib/dirty-form.ts). If that belief no longer matches what
// is in the database, this client was not looking at current data and its write is
// refused rather than applied.
//
// Both sides are parsed by the SAME parser as the posted value, so a belief and a
// stored figure are compared as values rather than as strings — "40" and 40.0 are
// not a conflict, and neither is a date typed in a different notation.
//
// A control that declared no baseline is allowed through unchanged: that is the
// pre-existing behaviour for cells whose render site never stated one, and
// refusing them would break saving rather than protect anything.
function believedBase(formData: FormData, fieldName: string): string | null {
  const raw = formData.get(`__base__${fieldName}`);
  return raw === null ? null : String(raw);
}

// True when the client's belief about the stored value disagrees with the stored
// value. `parse` maps a raw string to the comparable form; `stored` is already in
// it. Deliberately conservative: an unparseable belief counts as a disagreement,
// since we cannot show the client was up to date.
function beliefIsStale<T>(believed: string | null, stored: T, parse: (raw: string) => T): boolean {
  if (believed === null) return false;
  let parsed: T;
  try {
    parsed = parse(believed.trim());
  } catch {
    return true;
  }
  return parsed !== stored;
}

// What the Save button gets back. Returned rather than thrown, deliberately:
// this action used to only throw, which handed every validation slip to the
// route's error boundary — replacing the entire grid, and with it any unsaved
// edits in the other cells, over one mistyped number. A returned error keeps the
// user's work on screen next to the message about it.
export type SaveQuotedResult =
  | {
      ok: true;
      cells: number;
      jobs: number;
      created: number;
      // Writes REFUSED because another user had already changed those cells
      // (2026-08-04). Surfaced so the manager is told their value did not land and
      // the grid can pull the current figures in — a silent refusal would be worse
      // than the revert it prevents.
      conflicts: number;
      conflictDetail: string[];
      // Control names, for the client's re-baseline skip list.
      conflictFields: string[];
    }
  | { ok: false; error: string };

// Saves every edited cell from the Projects grid — quoted hours by section
// AND the job-level fields (Job Name, Customer, Type, Status, Start/Complete
// Date, Parts Cost Quoted, Parts Cost Actual) — in one submission. Only cells
// whose value actually changed get written; Customer and Parts Cost Quoted get
// flagged manually-edited so the next TotalETO/Power BI sync can't silently
// overwrite a manager's correction (same pattern as quotedHoursManuallyEdited
// below) — those two are the only job fields either sync ever touches.
// Signature is (previousState, formData) for useActionState — the form is driven
// by QuotedSaveForm, which needs the result to show the confirmation banner.
export async function saveQuotedHours(_prev: SaveQuotedResult | null, formData: FormData): Promise<SaveQuotedResult> {
  try {
    // BEFORE anything is read out of the form, let alone written: the grid is
    // read-only unless a signed-in user turned Edit Mode on. Disabling the
    // inputs is what a user sees; this is what actually holds, since a form post
    // is just an HTTP request and doesn't care what the markup said. Throws, so
    // it lands in the catch below and comes back as a normal "not saved"
    // message rather than an unhandled error.
    await assertProjectsEditable();
    // Sequential, new-rows FIRST: saveNewRows carries the batch's validation
    // (blank Job Id / bad Type reject the whole submission), so it must run
    // before any other write lands. Running the three concurrently meant a
    // validation error could surface AFTER hours/job-field edits had already
    // committed — the user sees "failed", assumes nothing saved, and re-edits
    // against silently half-saved state.
    const created = await saveNewRows(formData);
    const cells = await saveHoursCells(formData);
    const jobs = await saveJobFields(formData);
    const conflictDetail = [...cells.conflicts, ...jobs.conflicts];
    const conflictFields = [...cells.conflictFields, ...jobs.conflictFields];
    // Revalidate ONLY when a row was created (2026-08-03). This is why saving
    // felt slow: the writes themselves measure ~10ms for a one-cell edit, but
    // revalidatePath makes the action's response carry a fresh render of the
    // WHOLE route — 50-233 rows x ~30 controls — which the browser then has to
    // receive and reconcile. Every keystroke-driven autosave paid for a full page
    // render to change one number the user had already typed.
    //
    // A pure cell edit needs none of it: the new value is on screen because the
    // user put it there, and QuotedSaveForm re-stamps the `data-baseline`
    // attributes client-side on success so the fields stop reading as dirty (see
    // dirty-form.ts — the baseline is the whole reason a re-render was needed).
    //
    // A CREATED row is different: it exists only in the browser until now, and
    // only the server can render it as a real row with an id. That one keeps the
    // round trip, and it is the rare case.
    if (created > 0) revalidatePath("/quoted");
    return {
      ok: true,
      cells: cells.written,
      jobs: jobs.written,
      created,
      conflicts: conflictDetail.length,
      conflictDetail,
      conflictFields,
    };
  } catch (err) {
    // Every message these helpers throw is written for a manager to read, so it
    // goes straight to the UI. Logged as well because this catch also swallows
    // the unexpected kind (a dropped DB connection), which the console is the
    // only remaining record of.
    console.error("[saveQuotedHours] failed:", err);
    return { ok: false, error: err instanceof Error ? err.message : "Save failed." };
  }
}

// Returns the number of cells actually WRITTEN, not the number submitted — the
// whole grid is one form, so every visible cell resubmits on every save and a
// submitted count would report thousands for a one-cell edit.
async function saveHoursCells(formData: FormData): Promise<{ written: number; conflicts: string[]; conflictFields: string[] }> {
  const edits: { jobId: number; section: string; quotedHours: number; believed: string | null }[] = [];

  for (const [key, rawValue] of formData.entries()) {
    if (!key.startsWith(HOURS_PREFIX)) continue;
    const rest = key.slice(HOURS_PREFIX.length);
    const sepIndex = rest.indexOf("__");
    if (sepIndex === -1) continue;
    const jobId = Number(rest.slice(0, sepIndex));
    const section = rest.slice(sepIndex + 2);
    if (!Number.isInteger(jobId)) continue;

    // §27.15 — the shared spec. Blank still means 0, which is this column's
    // documented rule (an unquoted section).
    const parsed = parseCell(rawValue, CELL_SPECS["projects.quotedHours"]);
    if (parsed.kind === "invalid") {
      throw new Error(`${parsed.message} (job ${jobId}, section ${section})`);
    }
    const quotedHours = parsed.kind === "value" ? (parsed.value as number) : 0;
    edits.push({ jobId, section, quotedHours, believed: believedBase(formData, key) });
  }

  if (edits.length === 0) return { written: 0, conflicts: [], conflictFields: [] };

  // Fetch by the (bounded) set of distinct job ids, not a giant OR-of-pairs:
  // the whole Projects grid is one <form>, so `edits` is jobs × sections
  // (thousands of cells). One OR clause per cell produced a query that grew
  // with the grid and would eventually hit SQL statement-size limits. Filtering
  // sections in memory afterward is trivial and keeps the query flat.
  const editJobIds = [...new Set(edits.map((e) => e.jobId))];
  const existing = await prisma.estimatedHours.findMany({
    where: { jobId: { in: editJobIds } },
    select: { jobId: true, section: true, quotedHours: true },
  });
  const existingByKey = new Map(existing.map((e) => [`${e.jobId}::${e.section}`, Number(e.quotedHours)]));

  // The grid only ever displays/accepts whole numbers (see wholeHours() in
  // page.tsx) — its <input defaultValue> is Math.round(current). Compare
  // against the ROUNDED current value, not the raw one: otherwise an
  // untouched cell holding a fractional Power-BI-synced value (e.g. 40.33)
  // reads back as "changed" the moment ANY other cell on the page is saved
  // (the whole grid is one <form>, so every hours cell resubmits its
  // rendered value regardless of which one the manager actually edited),
  // silently truncating its precision and permanently locking it out of
  // future syncs via quotedHoursManuallyEdited.
  const candidates = edits.filter((e) => {
    const current = existingByKey.get(`${e.jobId}::${e.section}`) ?? 0;
    return Math.round(current) !== e.quotedHours;
  });

  // Refuse the ones whose page was out of date — see beliefIsStale. The grid
  // renders whole hours, so the belief is compared as a whole number too.
  // Job NUMBERS for every job in this batch, fetched once. Needed by both the
  // conflict messages and the change events below — "job 47" is a primary key and
  // means nothing to the manager reading the banner.
  const jobNumbers = new Map(
    (await prisma.job.findMany({ where: { id: { in: editJobIds } }, select: { id: true, jobId: true } })).map((j) => [j.id, j.jobId]),
  );
  const cellLabel = (e: { jobId: number; section: string }) =>
    `Job ${jobNumbers.get(e.jobId) ?? e.jobId} · ${sectionName(e.section) ?? e.section}`;

  const conflicts: string[] = [];
  // The control NAMES, so the client can leave exactly those cells dirty instead of
  // re-baselining a value the server never wrote.
  const conflictFields: string[] = [];
  const changed: typeof candidates = [];
  // Refused writes, recorded as such (§33.4/§33.12). recordChanges supports a
  // "rejected" change type precisely so a refusal leaves a trail — otherwise the only
  // evidence that a manager's value was thrown away is a banner they can dismiss.
  const refusedChanges: CellChange[] = [];
  for (const e of candidates) {
    const current = Math.round(existingByKey.get(`${e.jobId}::${e.section}`) ?? 0);
    if (beliefIsStale(e.believed, current, (raw) => (raw === "" ? 0 : Math.round(Number(raw))))) {
      // Both figures §33.4 asks for, in the order a person needs them: what is
      // actually stored now, and what they tried to put there. The old wording gave
      // "stored 40, this page believed 72" — the BASELINE, not the attempted value,
      // so it never actually told anyone what their own edit was.
      conflicts.push(`${cellLabel(e)}: now ${current}, your ${e.quotedHours} was not saved`);
      conflictFields.push(`${HOURS_PREFIX}${e.jobId}__${e.section}`);
      refusedChanges.push({
        tab: "Projects",
        rowRef: `Job ${jobNumbers.get(e.jobId) ?? e.jobId}`,
        columnName: `${sectionName(e.section) ?? e.section} Quoted Hours`,
        previousValue: String(e.quotedHours), // what was attempted
        newValue: String(current), // what stands instead
        changeType: "rejected",
        entityType: "EstimatedHours",
        entityId: `${e.jobId}::${e.section}`,
      });
      continue;
    }
    changed.push(e);
  }
  if (refusedChanges.length > 0) await recordChanges(refusedChanges, { action: "quoted.saveQuotedHours.refused" });

  if (changed.length === 0) {
    if (conflicts.length > 0) {
      await logAudit({
        action: "quoted.saveQuotedHours",
        entityType: "EstimatedHours",
        summary: `REFUSED ${conflicts.length} stale quoted-hours write(s) already changed by another user`,
        metadata: { conflicts },
      });
    }
    return { written: 0, conflicts, conflictFields };
  }

  await prisma.$transaction(
    changed.map((e) =>
      prisma.estimatedHours.upsert({
        where: { jobId_section: { jobId: e.jobId, section: e.section } },
        update: { quotedHours: e.quotedHours, quotedHoursManuallyEdited: true },
        create: {
          jobId: e.jobId,
          section: e.section,
          quotedHours: e.quotedHours,
          actualHistoricalHours: 0,
          estimateToCompleteHours: 0,
          quotedHoursManuallyEdited: true,
        },
      })
    )
  );

  await logAudit({
    action: "quoted.saveQuotedHours",
    entityType: "EstimatedHours",
    summary:
      `Updated quoted hours for ${changed.length} job/section cell${changed.length === 1 ? "" : "s"}` +
      (conflicts.length > 0 ? ` — REFUSED ${conflicts.length} stale write(s) already changed by another user` : ""),
    metadata: { changed, conflicts },
  });

  // ── Announce them (§33.1) ─────────────────────────────────────────────────
  //
  // This is what was missing: the Projects grid saved correctly and told nobody. Only
  // the ETC grid's save path called recordChanges, so a colleague's quoted-hours edit
  // was invisible until someone reloaded — which is the whole of the "changes are not
  // appearing live for other users" report.
  //
  // `jobNumbers` is the map built above the conflict loop — one query for the whole
  // batch, shared by the refusal messages and these events.
  await recordChanges(
    changed.map((e) => {
      const previous = String(Math.round(existingByKey.get(`${e.jobId}::${e.section}`) ?? 0));
      const next = String(e.quotedHours);
      return {
        tab: "Projects",
        rowRef: `Job ${jobNumbers.get(e.jobId) ?? e.jobId}`,
        // The section's human name, falling back to its code — the banner should say
        // "Design & Drawings", not "10-312".
        columnName: `${sectionName(e.section) ?? e.section} Quoted Hours`,
        previousValue: previous,
        newValue: next,
        // On this column an unquoted section IS 0, so clearing a cell back to zero is
        // a removal rather than an edit-to-zero. See classifyChange.
        changeType: classifyChange(previous, next, { emptyIsBlank: true }),
        entityType: "EstimatedHours",
        entityId: `${e.jobId}::${e.section}`,
        // The form-field name, so a receiving browser can put the value straight into
        // this one cell instead of refetching the route.
        cellKey: `${HOURS_PREFIX}${e.jobId}__${e.section}`,
      };
    }),
    { action: "quoted.saveQuotedHours" },
  );

  return { written: changed.length, conflicts, conflictFields };
}

function parseDate(raw: string): Date | null {
  if (raw === "") return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date "${raw}".`);
  return d;
}

// Accepts what a human would type or paste into a money cell — "1,300,000",
// "$1,300,000", "1 300 000" — not just what <input type="number"> used to emit.
// The grid's cells are currency-formatted now (MoneyCell), and people paste
// figures straight out of Excel, so a bare Number() here rejected values that
// were perfectly valid to a reader. Stripping is limited to currency/grouping
// punctuation: anything else still fails loudly rather than being coerced.
function parseMoney(raw: string, field: string, label: number | string): number | null {
  // Now the shared parser (§27.15). Its normalisation is a superset of the local
  // strip this replaces — it also reads Excel's accounting negatives and every
  // flavour of non-breaking space — and, unlike the local one, it REFUSES the
  // European "1.234,56" instead of silently reading it as 1.23456. That was a live
  // hole: `raw.replace(/[$\s,]/g, "")` turns it into a valid-looking number a
  // thousand times too small.
  const spec = { ...CELL_SPECS["projects.costQuoted"], label: field };
  const out = parseCell(raw, spec);
  if (out.kind === "clear" || out.kind === "absent") return null;
  if (out.kind === "invalid") {
    throw new Error(`${out.message} (${typeof label === "number" ? `job ${label}` : label})`);
  }
  return out.value as number;
}

async function saveJobFields(formData: FormData): Promise<{ written: number; conflicts: string[]; conflictFields: string[] }> {
  // jobId -> field -> raw string value, collected from every jobField__ input present.
  const byJob = new Map<number, Map<string, string>>();
  // The same shape for the `__base__` tokens: what the posting page believed was
  // already stored in each of those fields.
  const baseByJob = new Map<number, Map<string, string>>();
  for (const [key, rawValue] of formData.entries()) {
    if (!key.startsWith(FIELD_PREFIX)) continue;
    const rest = key.slice(FIELD_PREFIX.length);
    const sepIndex = rest.indexOf("__");
    if (sepIndex === -1) continue;
    const jobId = Number(rest.slice(0, sepIndex));
    const field = rest.slice(sepIndex + 2);
    if (!Number.isInteger(jobId)) continue;
    if (!byJob.has(jobId)) byJob.set(jobId, new Map());
    byJob.get(jobId)!.set(field, String(rawValue));
    // What this page believed was stored, keyed the same way — see beliefIsStale.
    if (!baseByJob.has(jobId)) baseByJob.set(jobId, new Map());
    const believed = believedBase(formData, key);
    if (believed !== null) baseByJob.get(jobId)!.set(field, believed);
  }
  if (byJob.size === 0) return { written: 0, conflicts: [], conflictFields: [] };

  const jobIds = [...byJob.keys()];
  const currentJobs = await prisma.job.findMany({
    where: { id: { in: jobIds } },
    select: {
      id: true,
      // The human job number ("1165"), for the change banner's rowRef. `id` is the
      // primary key and means nothing to a reader.
      jobId: true,
      jobName: true,
      customer: true,
      type: true,
      status: true,
      startDate: true,
      completeDate: true,
      costQuoted: true,
      costActualHistorical: true,
      billable: true,
    },
  });
  const currentById = new Map(currentJobs.map((j) => [j.id, j]));

  const updates: { id: number; data: Record<string, unknown> }[] = [];
  const changedFieldSummaries: string[] = [];

  const conflicts: string[] = [];
  const conflictFields: string[] = [];

  for (const [jobId, fields] of byJob) {
    const current = currentById.get(jobId);
    if (!current) continue;
    const data: Record<string, unknown> = {};
    const bases = baseByJob.get(jobId);
    // One gate for every field below: does this page's belief about the STORED
    // value still hold? If not, it was editing against data somebody has since
    // changed, and applying its value would revert them. Refused and reported
    // rather than written. `parse` is the same normalisation the field's own
    // comparison uses, so a belief and a stored value are compared as values.
    const stale = <T,>(field: string, stored: T, parse: (raw: string) => T): boolean => {
      const believed = bases?.get(field) ?? null;
      if (!beliefIsStale(believed, stored, parse)) return false;
      // Same wording as the hours cells (§33.4): the value that stands now, and the
      // one this page tried to write. `fields.get(field)` is what the user actually
      // typed — the old message reported `believed`, which is the baseline and told
      // nobody what their own edit had been.
      const attempted = fields.get(field) ?? "";
      conflicts.push(
        `Job ${current.jobId} · ${JOB_FIELD_LABELS[field] ?? field}: now ${stored === null || stored === "" ? "(blank)" : String(stored)}, your "${attempted}" was not saved`,
      );
      conflictFields.push(`${FIELD_PREFIX}${jobId}__${field}`);
      return true;
    };

    for (const field of PLAIN_FIELDS) {
      if (!fields.has(field)) continue;
      const raw = fields.get(field)!.trim();
      if (field === "jobName" && raw === "") throw new Error(`Job Name cannot be blank for job ${jobId}.`);
      const nextValue: string | null = field === "jobName" ? raw : raw === "" ? null : raw;
      const storedPlain = current[field as PlainField] ?? null;
      if (stale(field, storedPlain, (r) => (field === "jobName" ? r : r === "" ? null : r))) continue;
      if (nextValue !== storedPlain) {
        data[field] = nextValue;
        if (field === "customer") data.customerManuallyEdited = true;
      }
    }

    // Status is validated against the lifecycle, not saved as free text. It used
    // to be a PLAIN_FIELD — trim and store — so a mistyped "Headstart" would
    // become a real fourth status, appear in every dropdown, and quietly fall
    // outside the Active/HeadStart/Complete filters.
    if (fields.has("status")) {
      const raw = fields.get("status")!.trim();
      if (!JOB_STATUSES.includes(raw as (typeof JOB_STATUSES)[number])) {
        throw new Error(`Invalid Status "${raw}" for job ${jobId} — must be one of ${JOB_STATUSES.join(", ")}.`);
      }
      if (!stale("status", current.status, (r) => r) && raw !== current.status) data.status = raw;
    }

    if (fields.has("type")) {
      const raw = fields.get("type")!.trim();
      if (!VALID_JOB_TYPES.includes(raw as (typeof VALID_JOB_TYPES)[number])) {
        throw new Error(`Invalid Type "${raw}" for job ${jobId} — must be one of ${VALID_JOB_TYPES.join(", ")}.`);
      }
      if (!stale("type", current.type, (r) => r) && raw !== current.type) data.type = raw;
    }

    const effectiveCustomer = "customer" in data ? (data.customer as string | null) : current.customer;
    if (isSdcCustomer(effectiveCustomer)) {
      // SDC's own internal projects are never billable — this wins over
      // whatever the dropdown was submitted as.
      if (current.billable !== false) data.billable = false;
    } else if (fields.has("billable")) {
      const raw = fields.get("billable")!.trim();
      if (raw !== "Billable" && raw !== "Non-Billable") {
        throw new Error(`Invalid Billable value "${raw}" for job ${jobId} — must be "Billable" or "Non-Billable".`);
      }
      const nextValue = raw === "Billable";
      if (!stale("billable", current.billable, (r) => r === "Billable") && nextValue !== current.billable) {
        data.billable = nextValue;
      }
    }

    for (const field of DATE_FIELDS) {
      if (!fields.has(field)) continue;
      const nextValue = parseDate(fields.get(field)!.trim());
      const currentValue = current[field as DateField];
      const currentIso = currentValue ? currentValue.toISOString().slice(0, 10) : null;
      const nextIso = nextValue ? nextValue.toISOString().slice(0, 10) : null;
      // Compared as ISO day strings, which is exactly what the date input renders.
      if (stale(field, currentIso, (r) => (r === "" ? null : (parseDate(r)?.toISOString().slice(0, 10) ?? null)))) continue;
      if (nextIso !== currentIso) data[field] = nextValue;
    }

    for (const field of MONEY_FIELDS) {
      if (!fields.has(field)) continue;
      const nextValue = parseMoney(fields.get(field)!.trim(), field, jobId);
      const currentValue = current[field as MoneyField] != null ? Number(current[field as MoneyField]) : null;
      if (stale(field, currentValue, (r) => parseMoney(r, field, jobId))) continue;
      if (nextValue !== currentValue) {
        data[field] = nextValue;
        if (field === "costQuoted") data.costQuotedManuallyEdited = true;
      }
    }

    if (Object.keys(data).length > 0) {
      updates.push({ id: jobId, data });
      changedFieldSummaries.push(`job ${jobId}: ${Object.keys(data).filter((k) => !k.endsWith("ManuallyEdited")).join(", ")}`);
    }
  }

  if (updates.length === 0) {
    if (conflicts.length > 0) {
      await logAudit({
        action: "quoted.saveJobFields",
        entityType: "Job",
        summary: `REFUSED ${conflicts.length} stale job-field write(s) already changed by another user`,
        metadata: { conflicts },
      });
    }
    return { written: 0, conflicts, conflictFields };
  }

  await prisma.$transaction(updates.map((u) => prisma.job.update({ where: { id: u.id }, data: u.data })));

  await logAudit({
    action: "quoted.saveJobFields",
    entityType: "Job",
    summary:
      `Updated fields on ${updates.length} job${updates.length === 1 ? "" : "s"}` +
      (conflicts.length > 0 ? ` — REFUSED ${conflicts.length} stale write(s) already changed by another user` : ""),
    metadata: { changed: changedFieldSummaries, conflicts },
  });

  // Announce every field that actually moved (§33.1). One event per CELL, not per
  // job: the banner names a column, and a receiving browser updates one input.
  const fieldChanges: CellChange[] = [];
  for (const u of updates) {
    const before = currentById.get(u.id);
    if (!before) continue;
    for (const [field, nextRaw] of Object.entries(u.data)) {
      // Bookkeeping flags, not cells anyone edits or reads.
      if (field.endsWith("ManuallyEdited")) continue;
      const label = JOB_FIELD_LABELS[field];
      if (!label) continue; // an internal field with no cell on the grid
      const previousValue = formatJobFieldValue(field, (before as Record<string, unknown>)[field]);
      const newValue = formatJobFieldValue(field, nextRaw);
      if (previousValue === newValue) continue; // nothing a reader would see
      fieldChanges.push({
        tab: "Projects",
        rowRef: `Job ${before.jobId}`,
        columnName: label,
        previousValue,
        newValue,
        // 0 is a real figure in a money column and "" is not, so the default rule
        // applies here — only a genuinely blank value counts as a removal.
        changeType: classifyChange(previousValue, newValue),
        entityType: "Job",
        entityId: u.id,
        cellKey: `${FIELD_PREFIX}${u.id}__${field}`,
      });
    }
  }
  await recordChanges(fieldChanges, { action: "quoted.saveJobFields" });

  return { written: updates.length, conflicts, conflictFields };
}

// Column names as a human reads them on the Projects grid. A field absent from this
// map is deliberately not announced — it has no cell for a notification to point at.
const JOB_FIELD_LABELS: Record<string, string> = {
  jobName: "Job Name",
  customer: "Customer",
  status: "Status",
  type: "Type",
  billable: "Billable",
  startDate: "Start Date",
  completeDate: "Complete Date",
  costQuoted: "Cost Quoted",
  costActualHistorical: "Cost Actual (Historical)",
};

// Stringify a job field the way its CELL displays it, so a `previousValue`/`newValue`
// pair reads like the grid and a receiving browser can put `newValue` straight into
// the input. A Date rendered with toString() would say "Tue Jul 22 2026 00:00:00
// GMT+0000…" in the banner; the cell shows 2026-07-22.
function formatJobFieldValue(field: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (field === "billable") return value ? "Billable" : "Non-Billable";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  // Prisma Decimal for the money columns — Number() first so "1200" and "1200.00"
  // cannot read as a change.
  if (typeof value === "object" && value !== null && "toString" in value) return String(Number(String(value)));
  if (typeof value === "number") return String(value);
  const s = String(value);
  return s === "" ? null : s;
}

// Creates every "+ Add Project" blank row the manager filled in. Job Id is
// the only required field — everything else has a safe default (Job Name
// falls back to the Job Id, Status to "Active", Type/dates/costs to null) —
// per explicit request, a missing Job Id blocks the WHOLE save with a clear
// error rather than silently skipping that row or inventing a placeholder.
async function saveNewRows(formData: FormData): Promise<number> {
  const fieldsByTemp = new Map<string, Map<string, string>>();
  const hoursByTemp = new Map<string, Map<string, string>>();

  for (const [key, rawValue] of formData.entries()) {
    if (key.startsWith(NEW_ROW_HOURS_PREFIX)) {
      const rest = key.slice(NEW_ROW_HOURS_PREFIX.length);
      const sepIndex = rest.indexOf("__");
      if (sepIndex === -1) continue;
      const tempId = rest.slice(0, sepIndex);
      const section = rest.slice(sepIndex + 2);
      if (!hoursByTemp.has(tempId)) hoursByTemp.set(tempId, new Map());
      hoursByTemp.get(tempId)!.set(section, String(rawValue));
    } else if (key.startsWith(NEW_ROW_FIELD_PREFIX)) {
      const rest = key.slice(NEW_ROW_FIELD_PREFIX.length);
      const sepIndex = rest.indexOf("__");
      if (sepIndex === -1) continue;
      const tempId = rest.slice(0, sepIndex);
      const field = rest.slice(sepIndex + 2);
      if (!fieldsByTemp.has(tempId)) fieldsByTemp.set(tempId, new Map());
      fieldsByTemp.get(tempId)!.set(field, String(rawValue));
    }
  }

  if (fieldsByTemp.size === 0) return 0;

  type NewRow = {
    jobId: string;
    jobName: string;
    customer: string | null;
    type: string | null;
    billable: boolean;
    status: string;
    startDate: Date | null;
    completeDate: Date | null;
    costQuoted: number | null;
    costActualHistorical: number | null;
    hours: { section: string; quotedHours: number }[];
  };

  // Validate every new row BEFORE creating anything — one bad row (missing
  // Job Id, invalid Type, duplicate Job Id) must reject the whole batch
  // rather than half-create some projects and silently drop others.
  const rows: NewRow[] = [];
  const seenJobIds = new Set<string>();

  for (const [tempId, fields] of fieldsByTemp) {
    const jobId = (fields.get("jobId") ?? "").trim();
    if (jobId === "") {
      throw new Error("Job Id is required to add a new project — enter a Job Id or remove the blank row before saving.");
    }
    if (!/^\d+$/.test(jobId)) {
      throw new Error(`Job Id must be a whole number — got "${jobId}".`);
    }
    if (seenJobIds.has(jobId)) {
      throw new Error(`Job Id "${jobId}" was entered more than once among the new rows you're adding.`);
    }
    seenJobIds.add(jobId);

    const jobNameRaw = (fields.get("jobName") ?? "").trim();
    const jobName = jobNameRaw === "" ? jobId : jobNameRaw;

    const customerRaw = (fields.get("customer") ?? "").trim();
    const customer = customerRaw === "" ? null : customerRaw;

    // Type is required, not just validated-if-present: the app's type-gating
    // policy (validJobTypeFilter in job-filters.ts) excludes null-type jobs
    // from every list/count/dashboard/export, so a job created here with no
    // Type would be written to the DB successfully, permanently reserve its
    // Job Id (the uniqueness check above queries unfiltered prisma.job), and
    // then never appear anywhere in the app again — no error, just silently
    // invisible history.
    const typeRaw = (fields.get("type") ?? "").trim();
    if (typeRaw === "") {
      throw new Error(`Type is required for new project "${jobId}" — select one of ${VALID_JOB_TYPES.join(", ")}.`);
    }
    if (!VALID_JOB_TYPES.includes(typeRaw as (typeof VALID_JOB_TYPES)[number])) {
      throw new Error(`Invalid Type "${typeRaw}" for new project "${jobId}".`);
    }
    const type = typeRaw;

    const billableRaw = (fields.get("billable") ?? "Billable").trim();
    if (billableRaw !== "Billable" && billableRaw !== "Non-Billable") {
      throw new Error(`Invalid Billable value "${billableRaw}" for new project "${jobId}" — must be "Billable" or "Non-Billable".`);
    }
    const billable = isSdcCustomer(customer) ? false : billableRaw === "Billable";

    const status = (fields.get("status") ?? "Active").trim() || "Active";
    if (!JOB_STATUSES.includes(status as (typeof JOB_STATUSES)[number])) {
      throw new Error(`Invalid Status "${status}" for new project "${jobId}" — must be one of ${JOB_STATUSES.join(", ")}.`);
    }
    const startDate = parseDate((fields.get("startDate") ?? "").trim());
    const completeDate = parseDate((fields.get("completeDate") ?? "").trim());
    const costQuoted = parseMoney((fields.get("costQuoted") ?? "").trim(), "Parts Cost Quoted", `new project "${jobId}"`);
    const costActualHistorical = parseMoney((fields.get("costActualHistorical") ?? "").trim(), "Parts Cost Actual", `new project "${jobId}"`);

    const hoursMap = hoursByTemp.get(tempId) ?? new Map();
    const hours: { section: string; quotedHours: number }[] = [];
    for (const [section, raw] of hoursMap) {
      // §27.15 — the shared spec, so a pasted "1,200" is read here exactly as it is
      // in the money cell two columns over. It used to be refused by a bare
      // Number.isInteger, which also refused a perfectly ordinary "8.0".
      const parsed = parseCell(raw, CELL_SPECS["projects.quotedHours"]);
      if (parsed.kind === "absent" || parsed.kind === "clear") continue;
      if (parsed.kind === "invalid") {
        throw new Error(`${parsed.message} (new project "${jobId}", section ${section})`);
      }
      const n = parsed.value as number;
      if (n !== 0) hours.push({ section, quotedHours: n });
    }

    rows.push({ jobId, jobName, customer, type, billable, status, startDate, completeDate, costQuoted, costActualHistorical, hours });
  }

  if (rows.length === 0) return 0;

  const existing = await prisma.job.findMany({ where: { jobId: { in: rows.map((r) => r.jobId) } }, select: { jobId: true } });
  if (existing.length > 0) {
    throw new Error(`Job Id already in use: ${existing.map((e) => e.jobId).join(", ")}. Use a different Job Id.`);
  }

  const created = await prisma.$transaction(
    rows.map((r) =>
      prisma.job.create({
        data: {
          jobId: r.jobId,
          jobName: r.jobName,
          customer: r.customer,
          type: r.type,
          billable: r.billable,
          status: r.status,
          startDate: r.startDate,
          completeDate: r.completeDate,
          costQuoted: r.costQuoted,
          costActualHistorical: r.costActualHistorical,
          source: "manual",
          estimatedHours: r.hours.length
            ? { create: r.hours.map((h) => ({ section: h.section, quotedHours: h.quotedHours, quotedHoursManuallyEdited: true })) }
            : undefined,
        },
      })
    )
  );

  await logAudit({
    action: "quoted.addProject",
    entityType: "Job",
    summary: `Added ${created.length} new project${created.length === 1 ? "" : "s"} from the Projects tab`,
    metadata: { jobIds: created.map((j) => j.jobId) },
  });

  return created.length;
}
