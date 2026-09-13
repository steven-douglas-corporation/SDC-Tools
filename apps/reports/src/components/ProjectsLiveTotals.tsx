"use client";

import { useEffect } from "react";
import { hoursExact } from "@/components/ui/format";
import { quotedCellTone, TONE_CLASSES } from "@/lib/quoted-tone";

// Keeps the ENG TOTAL / SHOP TOTAL columns in step with the section cells as they
// are typed.
//
// ── Why this exists (2026-08-03) ────────────────────────────────────────────
// Both totals are summed on the SERVER from job.estimatedHours and rendered as
// plain text. So editing a section cell never moved them: the number you had just
// typed was excluded from the total sitting three columns to its right, until
// something re-rendered the route.
//
// That was already wrong — a total that disagrees with the cells it sums is worse
// than no total — but it was survivable while every save called revalidatePath and
// the page re-rendered a second later. Dropping that revalidate (see
// quoted-actions.ts, the fix for saving being slow) would have left them stale
// until a reload. Hence this.
//
// ── How ─────────────────────────────────────────────────────────────────────
// ONE delegated listener on the form, like ProjectsAutosave — this grid renders
// thousands of inputs and they come and go as filters and column pickers change,
// so per-input handlers would be both slow and impossible to keep attached.
//
// It recomputes from the DOM rather than from React state on purpose: the section
// cells are uncontrolled server-rendered inputs (that is what keeps ~4,700 controls
// off the client bundle), so the DOM is the only place the current values live.
//
// Only the QUOTED half of a total moves. The "/ actual" half comes from booked
// hours and no one can edit it here, so it is left exactly as the server
// rendered it.
//
// ── It also re-tints the section cells ──────────────────────────────────────
// The over/under colour (red over quoted, green complete, yellow under) is
// another formula on editable inputs — quoted hours and the row's Status — and
// it had the same staleness: raising a quote to cover an overrun left the cell
// red until a reload. The rule itself lives in lib/quoted-tone.ts so the server
// render and this recompute cannot disagree.

// Distinguishes an unsaved "+ Add Project" row's key from a real job's primary
// key in the same `data-job` attribute. Job ids are numeric, so the prefix can
// never collide with one.
export const NEW_ROW_PREFIX = "new-";

export function ProjectsLiveTotals({ engCodes, shopCodes }: { engCodes: string[]; shopCodes: string[] }) {
  useEffect(() => {
    const form = document.querySelector<HTMLInputElement>("input[name^='quoted__']")?.form;
    if (!form) return;

    // An existing row's cells are `quoted__<jobPk>__<code>`; an unsaved
    // "+ Add Project" row's are `newRowHours__<tempId>__<code>`. Both are summed
    // the same way — a new row's totals used to render a hardcoded "—" however
    // many hours were typed into it, which is the one place on this grid where
    // the total was not merely stale but absent.
    const fieldName = (rowKey: string, code: string) =>
      rowKey.startsWith(NEW_ROW_PREFIX)
        ? `newRowHours__${rowKey.slice(NEW_ROW_PREFIX.length)}__${code}`
        : `quoted__${rowKey}__${code}`;

    const sumFor = (rowKey: string, codes: string[]) => {
      let total = 0;
      for (const code of codes) {
        // Attribute selector with a quoted value: section codes contain a hyphen,
        // and job ids are numeric, so neither is a valid bare CSS identifier.
        const el = form.querySelector<HTMLInputElement>(`input[name="${fieldName(rowKey, code)}"]`);
        if (!el) continue; // column hidden by the Sections picker — not part of the total
        const n = Number(el.value);
        if (Number.isFinite(n)) total += n;
      }
      return total;
    };

    // The row's Status <select>, read fresh each time rather than cached: it is
    // itself editable, and changing it re-tints every cell in the row — the
    // totals included, now that they carry the same tone as a section cell.
    const isComplete = (jobId: string) =>
      form.querySelector<HTMLSelectElement>(`select[name="jobField__${jobId}__status"]`)?.value === "Complete";

    const paint = (jobId: string) => {
      // A "+ Add Project" row has no actual hours and no saved Status yet — the
      // same reason onEdit below never retints ITS section cells — so its totals
      // stay untoned too rather than reading "yellow" the instant any quote is
      // typed, before there is any actual to compare it against.
      const isNewRow = jobId.startsWith(NEW_ROW_PREFIX);
      const jobComplete = !isNewRow && isComplete(jobId);
      for (const [kind, codes] of [
        ["eng", engCodes],
        ["shop", shopCodes],
      ] as const) {
        const cell = form.querySelector<HTMLElement>(`[data-total="${kind}"][data-job="${jobId}"]`);
        if (!cell) continue;
        const quoted = sumFor(jobId, codes);
        const target = cell.querySelector<HTMLElement>("[data-total-quoted]");
        // Math.round().toString(), NOT the shared hours() helper: this column is
        // rendered by wholeHours() in quoted/page.tsx, which omits thousands
        // separators. Matching it exactly means the number does not visibly change
        // shape the moment you touch a cell.
        if (target) target.textContent = Math.round(quoted).toString();
        // The tooltip states the same two numbers; leaving it on the old quoted
        // figure would have it contradict the cell it is attached to.
        const actualAttr = cell.getAttribute("data-actual") ?? "0";
        const label = kind === "eng" ? "Engineering" : "Shop";
        cell.setAttribute("title", `${label} — Quoted ${hoursExact(quoted)} / Actual ${actualAttr}`);
        if (isNewRow) continue;
        // Same rule as a section cell (lib/quoted-tone.ts), over the group's summed
        // quoted/actual — the total's ACTUAL half is never edited here, so it comes
        // straight off the data attribute the server rendered rather than being
        // re-summed.
        const actual = Number(actualAttr);
        const tone = quotedCellTone({
          quoted: Number.isFinite(quoted) ? quoted : 0,
          actual: Number.isFinite(actual) ? actual : 0,
          jobComplete,
        });
        cell.classList.remove(...TONE_CLASSES);
        if (tone) cell.classList.add(tone);
      }
    };

    // Re-tint one section cell. The over/under colour is a formula on (quoted,
    // actual, job Complete), and quoted and Status are both editable — so a cell
    // stayed red after the quote was raised to cover the overrun, which is the
    // one moment the colour is supposed to change.
    const retint = (input: HTMLInputElement, jobComplete: boolean) => {
      const td = input.closest("td");
      if (!td) return;
      const actual = Number(td.getAttribute("data-cell-actual") ?? "0");
      const quoted = Number(input.value);
      const next = quotedCellTone({
        quoted: Number.isFinite(quoted) ? quoted : 0,
        actual: Number.isFinite(actual) ? actual : 0,
        jobComplete,
      });
      td.classList.remove(...TONE_CLASSES);
      if (next) td.classList.add(next);
    };

    const onStatusChange = (e: Event) => {
      const el = e.target;
      if (!(el instanceof HTMLSelectElement)) return;
      const m = /^jobField__(\d+)__status$/.exec(el.name);
      if (!m) return;
      const jobId = m[1];
      const complete = el.value === "Complete";
      for (const input of form.querySelectorAll<HTMLInputElement>(`input[name^="quoted__${jobId}__"]`)) {
        retint(input, complete);
      }
      // The totals' tone depends on jobComplete too now — a status flip must
      // repaint them the same moment it re-tints the section cells above.
      paint(jobId);
    };

    const onEdit = (e: Event) => {
      const el = e.target;
      if (!(el instanceof HTMLInputElement)) return;
      const isExisting = el.name.startsWith("quoted__");
      const isNew = el.name.startsWith("newRowHours__");
      if (!isExisting && !isNew) return;
      // "<prefix>__<row>__<section-code>" — split on the FIRST separator after the
      // prefix, since a section code contains no "__" but it is safer not to
      // assume it never will.
      const rest = el.name.slice((isExisting ? "quoted__" : "newRowHours__").length);
      const sep = rest.indexOf("__");
      if (sep === -1) return;
      const row = rest.slice(0, sep);
      paint(isNew ? `${NEW_ROW_PREFIX}${row}` : row);
      // A new row has no actual hours and no saved Status, so it has no
      // over/under story to tell — only saved rows get re-tinted.
      if (isExisting) retint(el, isComplete(row));
    };

    form.addEventListener("input", onEdit);
    // `change` as well: a paste or a spinner click on <input type="number"> does
    // not always emit `input` in every browser.
    form.addEventListener("change", onEdit);
    form.addEventListener("change", onStatusChange);
    return () => {
      form.removeEventListener("input", onEdit);
      form.removeEventListener("change", onEdit);
      form.removeEventListener("change", onStatusChange);
    };
  }, [engCodes, shopCodes]);

  return null;
}
