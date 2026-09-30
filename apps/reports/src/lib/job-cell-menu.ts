// The attributes a grid cell carries to become right-clickable, and the selector
// the menu host finds it by.
//
// Deliberately NOT in JobCellMenuHost.tsx, even though that is the only thing
// that reads them. That file is `"use client"`, and every export of a client
// module is a client REFERENCE — so calling this from the server render of
// quoted/page.tsx or etc/page.tsx throws "Attempted to call jobCellMenuProps()
// from the server". Both call sites are server components, which is the entire
// point of the delegated menu: the cells stay server-rendered and only one
// client component exists per grid.
//
// A plain .ts module with no directive is importable from both sides.

import { rawCodesFoldingInto } from "@/lib/sections";

export const JOB_MENU_ID_ATTR = "data-job-menu-id";
export const JOB_MENU_CELL_SELECTOR = `[${JOB_MENU_ID_ATTR}]`;

export function jobCellMenuProps({
  jobId,
  jobName,
  schedulerUrl,
}: {
  jobId: string;
  jobName: string;
  // Null when this job has no matching Scheduler project, so the menu never
  // offers a dead link.
  schedulerUrl: string | null;
}) {
  return {
    [JOB_MENU_ID_ATTR]: jobId,
    "data-job-menu-name": jobName,
    // Omitted entirely rather than set empty: absent means "no Scheduler
    // project", which is exactly how the menu reads it.
    ...(schedulerUrl ? { "data-job-menu-url": schedulerUrl } : {}),
  } as const;
}

// ── Where the right-click menu goes (2026-08-28) ────────────────────────────
//
// Pure, and here rather than inline in JobCellMenuHost's layout effect, because
// it is the part that was WRONG and the part worth a test.
//
// The bug: globals.css puts `zoom: var(--app-zoom)` on <html> (lib/app-zoom.ts,
// §45). A `position: fixed` child of document.body sits inside that zoomed
// root, so a `top` of N paints at N x zoom physical pixels — while a
// MouseEvent's clientX/clientY are unzoomed viewport pixels. Assigning
// `top: clientY` therefore misses by `clientY x (zoom - 1)`: LOW above 100%,
// high below it, and worse the further down the grid you click. Measured with a
// real right-click at zoom 1.25: clientY 756, menu painted at 945 — 189px below
// the cursor. After this: 759, i.e. 3px.
//
// Everything is therefore converted into the zoomed layout space the element is
// positioned in. `size` must come from offsetWidth/offsetHeight (layout px);
// getBoundingClientRect() reports the zoom-MULTIPLIED size (213 vs 267 at 1.25)
// and would put the same error straight back into the flip test.
export type MenuPlacement = { x: number; y: number };

export function placeContextMenu(opts: {
  /** MouseEvent clientX/clientY — unzoomed viewport pixels. */
  clientX: number;
  clientY: number;
  /** window.innerWidth/innerHeight — also unzoomed. */
  viewportWidth: number;
  viewportHeight: number;
  /** offsetWidth/offsetHeight of the menu — layout pixels. */
  width: number;
  height: number;
  /** currentZoom(); 1 when the app is at 100%. */
  zoom: number;
}): MenuPlacement {
  const zoom = opts.zoom || 1;
  const px = opts.clientX / zoom;
  const py = opts.clientY / zoom;
  const vw = opts.viewportWidth / zoom;
  const vh = opts.viewportHeight / zoom;
  const pad = 6;
  // Beside the pointer, not under it: otherwise the first item sits directly
  // beneath the cursor and a stray click right after the right-click fires it.
  const nudge = 2;
  let x = px + opts.width + pad > vw ? px - opts.width - nudge : px + nudge;
  let y = py + opts.height + pad > vh ? py - opts.height - nudge : py + nudge;
  // Clamp after flipping, so a menu taller than the viewport still starts on
  // screen rather than at a negative offset.
  x = Math.min(Math.max(pad, x), Math.max(pad, vw - opts.width - pad));
  y = Math.min(Math.max(pad, y), Math.max(pad, vh - opts.height - pad));
  return { x, y };
}

// ── Hours cells → the Hours tab (2026-09-30) ────────────────────────────────
//
// Right-clicking an hours cell on the Projects grid (a section, ENG/SHOP TOTAL,
// Service & Spare Parts, Unmapped) opens the Hours tab filtered to that job and
// the RAW Paylocity codes behind the cell. Same delegation as the Job cell: the
// row carries the job, the cell carries a short column key, and JobCellMenuHost
// resolves the key through ONE column map handed to it per page — so a 233-row
// grid does not repeat a code list in every one of its ~7,000 hours cells.
// Service and Unmapped are the exception: their codes differ per job, so those
// two cells carry their own (short) list.

export const HOURS_ROW_JOB_ATTR = "data-hours-job";
export const HOURS_CELL_SELECTOR = "[data-hours-col]";

/** On a job row's <tr>. */
export function hoursRowProps(jobId: string, jobName: string) {
  return { [HOURS_ROW_JOB_ATTR]: jobId, "data-hours-job-name": jobName } as const;
}

/**
 * On an hours <td>. `codes` only for cells whose codes vary by row (Service,
 * Unmapped) — everything else is looked up in the page's HoursColumnMap.
 */
export function hoursCellProps(col: string, codes?: readonly string[]) {
  return { "data-hours-col": col, ...(codes ? { "data-hours-codes": codes.join(",") } : {}) } as const;
}

export type HoursColumn = {
  label: string;
  /** Raw Paylocity codes — what the Hours tab's Section-Function filter holds. */
  codes: string[];
  /** Shown under the menu item when the Hours tab can't match the cell exactly. */
  note?: string;
};
export type HoursColumnMap = Record<string, HoursColumn>;

// 10-311 is split 30/70 onto 10-312 and 10-313 (mapPunchToColumns), so either
// column's filter has to include the whole 10-311 punch — the Hours tab lists the
// punch, not the share. Said on the menu rather than left to surprise.
const SPLIT_NOTE = "Includes 10-311, which this grid splits 30/70 between 10-312 and 10-313 — the Hours tab shows those punches whole.";

/**
 * The Projects grid's column map: one entry per visible section, plus the two
 * billing-group totals. Built with rawCodesFoldingInto, the same inverse fold the
 * Hours filters use, so a column's filter finds every raw code that lands in it.
 */
export function buildProjectsHoursColumns(
  sections: readonly { code: string; name: string }[],
  engCodes: readonly string[],
  shopCodes: readonly string[],
): HoursColumnMap {
  const map: HoursColumnMap = {};
  const withNote = (codes: string[]) => (codes.includes("10-311") ? SPLIT_NOTE : undefined);
  for (const s of sections) {
    const codes = rawCodesFoldingInto([s.code]);
    map[s.code] = { label: `${s.code} ${s.name}`, codes, note: withNote(codes) };
  }
  const eng = rawCodesFoldingInto(engCodes);
  const shop = rawCodesFoldingInto(shopCodes);
  // A total spans both 10-312 and 10-313 or neither, so the split needs no note
  // there unless only one of the pair is visible.
  const partial = (codes: readonly string[]) => codes.includes("10-312") !== codes.includes("10-313");
  map.eng = { label: "ENG TOTAL (visible columns)", codes: eng, note: partial(engCodes) ? SPLIT_NOTE : undefined };
  map.shop = { label: "SHOP TOTAL (visible columns)", codes: shop, note: partial(shopCodes) ? SPLIT_NOTE : undefined };
  map.service = { label: "Service & Spare Parts", codes: [] };
  map.unmapped = { label: "Unmapped", codes: [] };
  return map;
}

/** The Hours tab URL for a job (or every job) and a set of raw codes (or all of them). */
export function hoursHref(opts: { jobId?: string; codes?: readonly string[] }): string {
  const qs = new URLSearchParams();
  if (opts.jobId) qs.set("jobs", opts.jobId);
  const codes = [...new Set(opts.codes ?? [])].filter(Boolean).sort();
  if (codes.length) qs.set("sections", codes.join(","));
  const s = qs.toString();
  return s ? `/hours?${s}` : "/hours";
}
