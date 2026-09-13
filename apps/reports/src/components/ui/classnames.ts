// Shared class-string vocabulary — every page draws cards, buttons, inputs, and
// table headers from here instead of hand-rolling the same Tailwind strings.

// ── Motion is a token, not a per-button decision (§36.17) ───────────────────
//
// Every class string below used to carry its own transition: `transition-all` on
// three of the buttons, `transition-colors` on three more, `transition-shadow` on
// the card and the input, and no duration on any of them — so they all inherited
// Tailwind's 150ms default while the sidebar animated at 150ms and the chevrons at
// 150ms by coincidence rather than agreement.
//
// `motion-interactive` (globals.css) is now the single answer: it reads
// --motion-hover, shortens itself to --motion-press while the control is held, and
// lists the properties that carry STATE. What it deliberately omits is `all` —
// which also animated width, height and the two-layer brand shadow, so a button
// whose label changed while loading animated its own geometry on the way. That is
// the size jump §36.3 forbids, and it was in the shared class the whole app uses.
const MOTION = "motion-interactive";
// The gridline colour, as a border token. Named because the SCROLLER's border has to be
// the same colour — it is the grid's top and right edge (see GRID_SCROLLER) — and two
// copies of a hex literal in two files is how they came to disagree in the first place.
export const GRID_LINE_BORDER = "border-[#808080]";

export const CARD_BASE = `rounded-xl border border-sdc-border bg-white shadow-sm ${MOTION}`;

export function card(padding: string = "p-5"): string {
  return `${CARD_BASE} ${padding}`;
}

// ── Button geometry, one token per category (§41.21, §41.22) ─────────────────
//
// The audit that produced these: measuring every control in the Projects toolbar band on
// the running app found EIGHT distinct heights and FOUR distinct corner radii in one row.
// The worst of it was §41.21's own worked example — "Export" rendered 39px tall beside six
// 34px menu triggers, with "Show all" a third height at 30px between them.
//
// So height, radius and horizontal padding are no longer written per button. A category
// picks a geometry token and a colour variant, and two buttons in the same category cannot
// disagree.
//
// ── Why rem and not px ──────────────────────────────────────────────────────
//
// The root font-size is 15px and the sidebar's Text size control moves it (12-20px). A px
// height would stop matching its own label as soon as anyone touched that control — the
// same rem-vs-px trap the frozen grid columns hit (§ sticky-column offsets). h-9 is
// 2.25rem = 33.75px at the default root, which is under §41.20's 36px floor for a primary
// desktop control, so STANDARD is set explicitly at 2.4rem = 36px.
const BTN_BASE = `inline-flex items-center justify-center gap-1.5 whitespace-nowrap select-none ${MOTION}`;

// Toolbar triggers, primary and secondary actions — everything that sits in a toolbar row
// together. 36px at the default root: §41.20's floor, and a REDUCTION from the 39-40px the
// primary/secondary pair used to render at (§41.19).
export const BTN_H_STANDARD = "h-[2.4rem]";
// The same height as a FLOOR, for a toolbar-height strip that is allowed to wrap onto a
// second line (the department checklist). A fixed `h-` would clip its second row; a
// bare `min-h-` written at the call site would be the 2.4rem literal living in two
// files, which is the drift §41.21 was about. Kept adjacent so they move together, and
// tests/control-tokens.test.ts asserts they are the same number.
export const BTN_MIN_H_STANDARD = "min-h-[2.4rem]";
// In-menu and in-row actions (Select all, Clear, Detail). Smaller, but still a real click
// target — these were 15px tall, which §41.20 rules out outright.
export const BTN_H_COMPACT = "h-[1.9rem]";

const BTN_STD = `${BTN_BASE} ${BTN_H_STANDARD} rounded-lg px-3.5 text-sm font-semibold`;
const BTN_CMP = `${BTN_BASE} ${BTN_H_COMPACT} rounded-md px-2.5 text-xs font-medium`;

export const BUTTON_PRIMARY =
  `${BTN_STD} bg-sdc-blue text-white shadow-[0_1px_2px_rgba(21,116,196,0.25),0_4px_10px_rgba(21,116,196,0.18)] hover:bg-sdc-blue-dark hover:shadow-[0_2px_4px_rgba(21,116,196,0.3),0_6px_14px_rgba(21,116,196,0.22)] active:translate-y-px active:shadow-[0_1px_2px_rgba(21,116,196,0.25)] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:translate-y-0`;

export const BUTTON_SECONDARY =
  `${BTN_STD} border border-sdc-border bg-white text-sdc-navy shadow-sm hover:border-sdc-blue-100 hover:bg-sdc-blue-light hover:shadow-md active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50`;

// Compact neutral — in-row and in-menu actions. Replaces BUTTON_PRIMARY_SM, BUTTON_GHOST
// and BUTTON_DANGER, all three of which had ZERO call sites: they were three of the six
// "categories" §41.22 asks to standardise, and none of them existed in the rendered UI.
// One live compact token beats three dead ones.
export const BUTTON_COMPACT =
  `${BTN_CMP} border border-sdc-border bg-white text-sdc-navy shadow-sm hover:bg-sdc-blue-light disabled:cursor-not-allowed disabled:opacity-50`;

// Compact destructive. Same geometry as BUTTON_COMPACT so the two line up in a row, and
// the red tokens so the shade stops drifting file to file.
export const BUTTON_COMPACT_DANGER =
  `${BTN_CMP} border border-sdc-red-border bg-white font-semibold text-sdc-red-text shadow-sm hover:bg-sdc-red-bg disabled:cursor-not-allowed disabled:opacity-50`;

// An understated in-menu action ("Select all", "Clear"). Reads as a text link, but carries
// the compact height and a padded hit box — it was a bare underlined span 15px tall.
export const BUTTON_MENU_LINK =
  `${BTN_BASE} ${BTN_H_COMPACT} rounded-md px-1.5 text-label font-medium text-sdc-muted underline decoration-sdc-gray-400/60 hover:bg-sdc-gray-100 hover:text-sdc-navy disabled:opacity-50`;

// ── A control whose label changes while it works (§36.3, §36.14) ────────────
//
// "Loading states must not cause the button to jump in size" and "button labels
// must not shift unexpectedly" are the same requirement, and the fix is the same
// everywhere: the label sits in a slot wide enough for its LONGEST state, centred,
// so the swap happens inside a box that never moves. Callers pass the width they
// measured for their own longest label — there is no universal number, and
// guessing one is how a label ends up clipped.
//
// tabular-nums because several of these labels count ("3 of 5"), and proportional
// digits change width as the count rises.
export function busySlot(minWidthClass: string): string {
  return `inline-flex items-center justify-center gap-1.5 tabular-nums ${minWidthClass}`;
}

// One consistent shape/size for EVERY control in the Projects toolbar — filter
// pills, Actuals, Columns, Grid Size, Views. Geometry only (fixed height, same
// radius/padding/font/border/shadow); callers append one color variant below so
// they line up evenly regardless of state.
//
// Shares BTN_H_STANDARD with BUTTON_PRIMARY/SECONDARY, which is the whole point of
// §41.21: these sit in the same row as Export and Submit, and it was the 34-vs-39px
// mismatch between them that read as a jagged toolbar. `list-none cursor-pointer` because
// most of these are <summary> elements, which need both.
export const TOOLBAR_BTN =
  `list-none cursor-pointer ${BTN_BASE} ${BTN_H_STANDARD} rounded-lg border px-3.5 text-sm font-medium shadow-sm`;
// Same shape family as TOOLBAR_BTN, at BUTTON_COMPACT's geometry (1.9rem) instead
// of BTN_H_STANDARD's 2.4rem — for a toolbar that's explicitly asked to run denser
// than the app's usual row (Job Cost Explorer, 2026-08-10). The color variants
// below are pure color with no geometry of their own, so they drop onto this or
// TOOLBAR_BTN unchanged — one pair of tokens, two densities.
export const TOOLBAR_BTN_COMPACT =
  `list-none cursor-pointer ${BTN_BASE} ${BTN_H_COMPACT} rounded-md border px-2.5 text-xs font-medium shadow-sm`;
// Neutral (menus with no on/off state), Active (a filter/toggle that's engaged),
// Muted (a filter with nothing selected).
export const TOOLBAR_BTN_NEUTRAL = "border-sdc-border bg-white text-sdc-navy hover:bg-sdc-blue-light";
export const TOOLBAR_BTN_ACTIVE = "border-sdc-blue bg-sdc-blue-light text-sdc-blue-dark";
export const TOOLBAR_BTN_MUTED = "border-sdc-border bg-white text-sdc-muted hover:bg-sdc-blue-light";

// ── One width rhythm for a toolbar row (2026-08-05, by request) ─────────────
//
// §41.21 got every control in a row onto one HEIGHT. The widths were still whatever
// each label happened to measure — on Monthly ETC that was 169 / 76 / 76 / 95 / 131 / 95,
// which reads as a jumble however neatly it is aligned.
//
// A FLOOR, not a fixed width: a control still grows for a long label ("Hide Standards"
// needs 131px and clipping it would be worse than the unevenness). What this removes is
// the bottom half of the range — nothing sits at 76px next to something at 131px any
// more, so the row scans as a set of controls rather than a ransom note.
//
// 6.5rem = ~98px at the 15px root, which is the widest of the SHORT labels (Export, ETC
// Rates) plus a little. Deliberately not the widest overall: pulling everything out to
// 131px adds ~130px to a row that has ~25px of slack once Standards is unlocked, and a
// row that wraps to two lines is a worse answer to "make them even" than one that does
// not.
export const TOOLBAR_MIN_W = "min-w-[6.5rem]";

export const INPUT =
  `rounded-lg border border-sdc-border bg-white px-3.5 py-2.5 text-sm text-sdc-navy shadow-sm ${MOTION} outline-none focus:border-sdc-blue focus:ring-2 focus:ring-sdc-blue/15`;

export const LABEL = "text-sm font-semibold text-sdc-navy";

// Bottom-border only, no flat gray fill band — reads closer to a considered
// spreadsheet/ledger header than a generic admin-template table.
export const TABLE_HEADER_ROW =
  "border-b-2 border-sdc-border text-center text-label font-semibold uppercase tracking-wider text-sdc-gray-600";

// Uniform width for every hour data column on the Monthly ETC grid — header and
// body alike, so a column is one width regardless of what is in it.
//
// 61px is not a taste call, it is the measurement. The sub-column labels render
// at 10px semibold uppercase with tracking-wider (TABLE_HEADER_ROW), where the
// longest word, "WORKED", is 52.2px in Montserrat — measured in the running app,
// not estimated, because the fallback font is ~20% narrower and measuring in it
// is how this column got sized too small the first time. Add the cells' px-1
// either side and the column must be at least 60.2px for that word to fit on one
// line. 64, not 61: a single pixel of slack is not slack — sub-pixel rounding and
// Windows font hinting move text by more than that, and being one pixel short
// means a clipped word rather than a tidy one.
//
// It was 46px, which left 38px of content and made "HOURS WORKED MONTH" render
// as "HOUR S WOR KED MONT H" — the header was being broken mid-word to fit. If
// these labels ever change, re-measure the longest WORD (not the phrase) and
// resize; never solve it by letting words break.
export const ETC_COL_W = "w-[64px] min-w-[64px]";

// Parts Cost columns are MONEY, and money on this page runs to seven figures — so
// they get their own, wider width. 64px (ETC_COL_W, sized for hours) clipped them:
// "$1,065,713" rendered as "$1,065,7…" on job 1142 and "$1,336,100" on 1164, which
// is a figure nobody could read without clicking into the cell (reported 2026-08-04).
//
// 96px fits "-$1,336,100" — eleven glyphs including a minus and a currency symbol,
// which is the widest thing this column can hold at the current data volumes — with
// a little headroom. Applied to every Parts Cost cell: Prior ETC, Money Spent Month,
// Money Left, New ETC and Diff, plus their footer totals, so the block stays aligned.
//
// The grid already scrolls horizontally inside its own container, so widening a
// column costs scroll distance rather than breaking the layout on a small screen.
export const PARTS_COL_W = "w-[96px] min-w-[96px]";

export const TABLE_ROW_HOVER = `${MOTION} hover:bg-sdc-blue-light/40`;

// Full gridlines + tabular-width numerals — makes data tables read like a
// spreadsheet grid (what finance/PM reviewers expect) instead of a generic
// borderless admin-table list.
// border-separate (not collapse) is load-bearing: collapsed borders belong to
// the shared grid edges on the scrolling layer, so sticky cells pin in place
// while their borders scroll away — ghost gridlines float over the frozen
// columns/headers. With separate borders each cell owns its bottom+left edge
// and they travel with the cell; border-spacing-0 keeps the grid seamless.
export const TABLE_GRID =
  "border-separate border-spacing-0 [&_th]:border-b [&_th]:border-l [&_th]:border-[#808080] [&_td]:border-b [&_td]:border-l [&_td]:border-[#808080] [&_td]:tabular-nums [&_td]:font-semibold";


// Table wrapper — sharp corners (not CARD_BASE's rounded-xl) so the grid's
// straight gridlines run flush to the container edge, like a real spreadsheet.
export const TABLE_CARD = `overflow-hidden border ${GRID_LINE_BORDER} bg-white shadow-sm`;

// ── The scrolling frame around a big grid (§41.23, §41.24) ───────────────────
//
// One token, because the two big grids had drifted into two different treatments and the
// shared TABLE_CARD above was used by neither of them:
//
//   Monthly ETC  sharp corners, border-sdc-border on three sides and #808080 on top
//   Projects     rounded-xl corners, border-sdc-border all round
//
// The colour is not a taste call. TABLE_GRID gives every cell a BOTTOM and LEFT border
// only, so the topmost cells have no top edge and the rightmost have no right edge — the
// CONTAINER's border is literally the grid's top and right gridline. If it is a different
// colour from the gridlines it continues, the frame is two-toned and the corners do not
// meet, which is §41.23's "grid lines meet cleanly" and "left and right table edges are
// visually complete". The ETC grid had noticed half of this and matched its top border
// only; Projects had not noticed at all.
//
// Sharp corners for the same reason TABLE_CARD is sharp: `rounded-xl` on a scroll
// container clips the gridlines of the corner cells, which is §41.23's "scroll containers
// do not cut off rounded corners incorrectly". A rounded frame and a square grid cannot
// both be right, and the grid wins — these read as spreadsheets.
//
// Geometry only. Each page still sets its own max-height (they have different chrome above
// them) and Projects its own min-width.
export const GRID_SCROLLER =
  `overflow-auto border ${GRID_LINE_BORDER} bg-white shadow-sm select-none styled-scrollbar`;

// ── PAGE_SHELL — the one page-level wrapper, for every tab (2026-09-01) ──────
//
// Reported as "at 110% zoom the dashboard leaves a 300px blank column on the
// right". The cause was NOT the zoom control: `zoom` is a CSS length scaler that
// participates in layout (see lib/app-zoom.ts), so the layout viewport shrinks
// with it and a `width: 100%` container fills it at every level.
//
// The cause was a hard cap. The Dashboard wrapper was `max-w-[1800px]` and the
// Jobs list `max-w-[1440px]`, so on any workspace wider than that the content
// simply stopped and the remainder stayed white. Everything INSIDE the Dashboard
// was already fluid and had been all along — the KPI cards are
// `min-w-0 flex-1 basis-[11rem]` flex items that grow, Active Work is
// `xl:grid-cols-[minmax(320px,0.85fr)_minmax(0,1.6fr)]`, and the Execution
// Calendar is `grid-cols-7` inside `min-w-0`. They were all being held back by
// one class on an ancestor.
//
// So the fix is to remove the ceiling, not to raise it, and to put the page
// wrapper in ONE place so a future page cannot quietly reintroduce one. The
// AppShell above it already does the right thing and needed no change: it is a
// flex row with a `shrink-0` aside and `main` at `min-w-0 flex-1`, so the
// content offset IS the current sidebar width by construction — collapsing the
// sidebar hands the freed space to the active tab with no JS and no listener.
//
//   w-full     — take the whole of `main`, whatever that currently is
//   min-w-0    — never let a wide child (a grid, a long table) push the shell
//                wider than the viewport and create a page-level scrollbar;
//                such tables scroll inside their own GRID_SCROLLER instead
//   no max-w   — deliberately. This is the whole point.
//
// The gutter replaces four different values that had accumulated across the tabs
// (p-8, p-6, px-6 md:px-10, and px-8 md:px-13 — 52px, which is well past a
// gutter). 24px, 32px from md up: a standard page margin, and the same one
// everywhere so tabs stop disagreeing about where content starts.
export const PAGE_SHELL = "w-full min-w-0 px-6 py-6 md:px-8 md:py-7";
