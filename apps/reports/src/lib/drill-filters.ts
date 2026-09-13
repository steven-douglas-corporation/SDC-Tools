// ── One filter model for every Monthly ETC drill-through (§73) ────────────────
//
// The drills already shared a rollup (groupHoursRows) and a design (ui/Drill.tsx), and
// filtered with whatever each panel had grown: HoursDetailPanel had three single-choice
// <select>s, UndefinedHoursPanel had a free-text search and a set of reason cards, and
// the two hand-rolled drills on the KPI strip (Parts spent, Hours off the grid) had
// nothing at all. So "narrow this table" meant something different in each of them, and
// in two of them it meant nothing.
//
// This is the vocabulary, the arithmetic and the semantics — one place, no React, so the
// properties that matter are testable:
//
//   * multi-select, so "Mechanical AND Controls" is expressible (a <select> could only
//     ever ask one question at a time);
//   * OR within a dimension, AND across dimensions — the only reading under which
//     ticking a second department can never REMOVE rows from the table;
//   * an empty selection means "not filtering", NOT "match nothing". A menu whose boxes
//     are all unticked is the state the panel opens in, and it must show everything;
//   * the active count is a count of FILTERS, never of rows (§62 removed row counts from
//     every drill and they are not coming back through this door).
//
// Group By stays entirely separate: it decides what a row IS, this decides which rows
// there are. Nothing here reads or writes a grouping dimension, which is what keeps the
// two independent — a filter change must never reshape the table and a rollup change
// must never widen the set.

/**
 * The dimensions a drill can filter on. A superset: each panel offers the ones its rows
 * actually carry (there is no reason on a punch list and no status on a punch at all),
 * and one vocabulary is what stops "Section" meaning two things in two panels.
 */
export type DrillFilterKey = "department" | "employee" | "section" | "job" | "reason" | "status";

export const DRILL_FILTER_LABEL: Record<DrillFilterKey, string> = {
  department: "Department",
  employee: "Employee",
  section: "Section",
  job: "Job",
  reason: "Reason",
  status: "Status",
};

/**
 * The filter state. `values` holds the ticked options per dimension; `from`/`to` are the
 * inclusive date bounds as "YYYY-MM-DD" ("" = unbounded).
 *
 * Deliberately one plain object rather than a state variable per dimension: "how many
 * filters are active" and "clear them all" are then single expressions over one value,
 * and a panel cannot acquire a fourth filter that the count and the Clear button don't
 * know about — which is exactly how HoursDetailPanel's job filter came to be missing
 * from its own "Shown" wording.
 */
export type DrillFilters = {
  values: Partial<Record<DrillFilterKey, string[]>>;
  from: string;
  to: string;
};

/** The opened state, and the state Clear filters returns to. */
export const NO_DRILL_FILTERS: DrillFilters = { values: {}, from: "", to: "" };

/** The fields a row must be able to answer for. All optional — see DrillFilterKey. */
export type DrillFilterRow = {
  department?: string | null;
  employee?: string | null;
  section?: string | null;
  job?: string | null;
  reason?: string | null;
  status?: string | null;
  /** "YYYY-MM-DD", or anything else (the punch lists use "—") for a row with no date. */
  date?: string | null;
};

export function selectedValues(f: DrillFilters, key: DrillFilterKey): string[] {
  return f.values[key] ?? [];
}

/**
 * How many filters are NARROWING the table. The date range counts once however many of
 * its two ends are set — it is one control and reads as one filter.
 *
 * This is the number beside "Filters", and it is the only count a drill states: rows,
 * punches and records stay uncounted (§62).
 */
export function activeFilterCount(f: DrillFilters): number {
  let n = 0;
  for (const key of Object.keys(f.values) as DrillFilterKey[]) {
    if ((f.values[key] ?? []).length > 0) n++;
  }
  if (f.from || f.to) n++;
  return n;
}

export function isFiltering(f: DrillFilters): boolean {
  return activeFilterCount(f) > 0;
}

/** Add or remove one option. Empties the key rather than leaving `[]` lying around. */
export function toggleFilterValue(f: DrillFilters, key: DrillFilterKey, value: string): DrillFilters {
  const cur = selectedValues(f, key);
  return setFilterValues(f, key, cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]);
}

/** Replace one dimension's selection outright — Select all / Clear inside a menu. */
export function setFilterValues(f: DrillFilters, key: DrillFilterKey, values: string[]): DrillFilters {
  const next = { ...f, values: { ...f.values } };
  // An empty selection is DELETED, not stored as []. Otherwise "Select all then Clear"
  // leaves a key behind that reads as a filter to anything counting keys, and the
  // badge would say 1 while the table showed everything.
  if (values.length === 0) delete next.values[key];
  else next.values[key] = values;
  return next;
}

export function setFilterRange(f: DrillFilters, from: string, to: string): DrillFilters {
  return { ...f, from, to };
}

export function clearDrillFilters(): DrillFilters {
  // A fresh object, not the shared constant: callers hold this in React state and an
  // aliased constant is one accidental mutation away from a very confusing bug.
  return { values: {}, from: "", to: "" };
}

/** A row's value for one dimension, normalised the way the menus list them. */
function rowValue(row: DrillFilterRow, key: DrillFilterKey): string {
  const raw = row[key];
  // Em dash, matching what the panels print for a missing department or job — so the
  // option the menu offers for those rows is the option that selects them.
  return raw == null || raw === "" ? "—" : raw;
}

/**
 * Is this row in the filtered set?
 *
 * OR within a dimension, AND across dimensions. Dates are compared as ISO strings, which
 * sorts correctly for "YYYY-MM-DD" and needs no Date parsing — and no timezone, which is
 * the trap that made the KPI card's month title render a month early.
 *
 * A row with no usable date is EXCLUDED once a bound is set, and included otherwise: a
 * date filter is a statement about when, and "unknown" is not an answer to it. It cannot
 * silently drop hours out of an unfiltered total, because with no bound set nothing here
 * looks at the date at all.
 */
export function matchesDrillFilters(row: DrillFilterRow, f: DrillFilters): boolean {
  for (const key of Object.keys(f.values) as DrillFilterKey[]) {
    const sel = f.values[key] ?? [];
    if (sel.length === 0) continue;
    if (!sel.includes(rowValue(row, key))) return false;
  }
  if (f.from || f.to) {
    const d = row.date ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    if (f.from && d < f.from) return false;
    if (f.to && d > f.to) return false;
  }
  return true;
}

/**
 * The distinct values a dimension takes across a row set, for the menu's option list.
 * Built from the UNFILTERED rows by the callers, so ticking one department does not make
 * every other department disappear from the menu that would let you tick it back.
 *
 * Sorted with the em-dash bucket last — it is the absence of a value, not a value.
 */
export function filterOptions(rows: DrillFilterRow[], key: DrillFilterKey): string[] {
  const seen = new Set<string>();
  for (const r of rows) seen.add(rowValue(r, key));
  return [...seen].sort((a, b) => (a === "—" ? 1 : b === "—" ? -1 : a.localeCompare(b)));
}

/**
 * The date bounds present in a row set, so the two date inputs can offer min/max rather
 * than the whole of recorded history. Empty strings when nothing has a usable date.
 */
export function dateBounds(rows: DrillFilterRow[]): { min: string; max: string } {
  let min = "";
  let max = "";
  for (const r of rows) {
    const d = r.date ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (!min || d < min) min = d;
    if (!max || d > max) max = d;
  }
  return { min, max };
}
