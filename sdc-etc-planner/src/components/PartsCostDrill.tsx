"use client";

import { useEffect, useMemo, useState } from "react";
import { useColumnSort } from "@/components/useColumnSort";
import { sortRows, type SortColumns } from "@/lib/table-sort";
import { SortableTh } from "@/components/ui/SortableHeader";
import { DrillPanel, DrillControls, DrillEmpty, DRILL_NUM, DRILL_TOTAL_LABEL } from "@/components/ui/Drill";
import { usd, usd2 } from "@/components/ui/format";
import { loadPartsEtcHistory, type PartsEtcMonth } from "@/lib/parts-etc-history-actions";
import type { PartsCostFinancials } from "@/lib/parts-cost-financials-shared";
import type { PartsCostLine } from "@/lib/sync-totaleto";
import { normalizeVendor } from "@/lib/vendor-normalize";

// Drill-through for the Parts Cost card's Actual / Projection bar.
//
// ── It reconciles because it sums the SAME field the bar does ───────────────
//
// The card's figures come out of getPartsCostFinancials, which derives them from
// exactly these rows (parts-cost-financials.ts:130-131):
//
//   Invoiced           = Σ line.actualAmount          (GL-posted spend, lifetime)
//   Left to be invoiced = Σ line.totalPrice − Invoiced, floored at 0
//
// `financials.lines` carries those same rows, already fetched for the card, so this
// panel re-sums the identical field rather than issuing a second query with a second
// chance to disagree. That is what makes "no mismatch is acceptable" a property of
// the construction rather than a promise — and it is also why there is no loading
// state here: the data is already on the client when the bar is drawn.
//
// ── ETC drills to its own history, not to parts ─────────────────────────────
//
// Invoiced and Left to be invoiced are line-level and drill straight out of `lines`.
// ETC is not: `financials.etc` is one figure per job per month, maintained on the
// Monthly ETC grid, and there is no per-part ETC anywhere in this system.
// Apportioning it across parts by value would produce a table that sums correctly
// and means nothing.
//
// What the figure IS made of is the monthly drawdown behind it — opened at last
// month's close, reduced by what was booked, left where the manager set it. That
// chain answers "where did this number come from" honestly, and it is the same
// chain the Monthly ETC grid renders. It is the one mode that needs the server
// (lib/parts-etc-history-actions.ts), so it is the one mode with a loading state,
// and that state is confined to this panel — the page behind it is never blocked.

// Money in this panel carries CENTS, unlike the card above it (2026-09-02).
//
// The card shows five rounded figures and reconciles them with
// reconcilePartsCostRounding so they visibly add up. A 645-row ledger cannot use
// that trick: largest-remainder redistribution would make the column total correct
// by nudging individual rows a dollar off their true value, which is exactly wrong
// for lines someone may check against an actual invoice. So the rows show what they
// really are. Whole dollars here made 504 rows appear to miss their own footer by
// ~$13 — the footer was right and the rows were rounded, but a reader has no way to
// know that, and "the numbers don't add up" is the one impression a reconciliation
// panel cannot afford.
const money = usd2;

export type PartsDrillMode = "projection" | "invoiced" | "left" | "etc";

const MODE_TITLE: Record<PartsDrillMode, string> = {
  projection: "Parts Cost Detail — Actual / Projection",
  invoiced: "Parts Cost Detail — Invoiced",
  left: "Parts Cost Detail — Yet to invoice",
  etc: "Parts Cost Detail — ETC",
};

type Row = PartsCostLine & { leftToInvoice: number };

type ColKey =
  | "po"
  | "pn"
  | "desc"
  | "supplier"
  | "qty"
  | "unit"
  | "total"
  | "invoiced"
  | "left"
  | "invoicedDate"
  | "purchaseDate";

const COLUMNS: { key: ColKey; label: string; type: "text" | "number" | "currency" | "date" }[] = [
  { key: "po", label: "PO #", type: "text" },
  { key: "pn", label: "Part No", type: "text" },
  { key: "desc", label: "Description", type: "text" },
  { key: "supplier", label: "Supplier", type: "text" },
  { key: "qty", label: "Qty", type: "number" },
  { key: "unit", label: "Unit $", type: "currency" },
  { key: "total", label: "Total $", type: "currency" },
  { key: "invoiced", label: "Invoiced $", type: "currency" },
  { key: "left", label: "Left to Invoice", type: "currency" },
  { key: "purchaseDate", label: "Purchased", type: "date" },
  { key: "invoicedDate", label: "Invoiced Date", type: "date" },
];

const SORT_COLUMNS: SortColumns<Row, ColKey> = {
  po: { type: "text", value: (r) => r.poNumber },
  pn: { type: "text", value: (r) => r.partNumber },
  desc: { type: "text", value: (r) => r.description },
  supplier: { type: "text", value: (r) => r.supplier },
  qty: { type: "number", value: (r) => r.quantity },
  unit: { type: "currency", value: (r) => r.unitPrice },
  total: { type: "currency", value: (r) => r.totalPrice },
  invoiced: { type: "currency", value: (r) => r.actualAmount },
  left: { type: "currency", value: (r) => r.leftToInvoice },
  purchaseDate: { type: "date", value: (r) => r.purchaseDate },
  invoicedDate: { type: "date", value: (r) => r.invoicedDate },
};

/** The rows each mode is about — and nothing else, so a total is never a partial sum of a wider list. */
function rowsForMode(rows: Row[], mode: PartsDrillMode): Row[] {
  if (mode === "invoiced") return rows.filter((r) => r.actualAmount !== 0);
  if (mode === "left") return rows.filter((r) => r.leftToInvoice !== 0);
  return rows; // projection — every line behind the bar
}

const dash = (s: string | null) => (s && s.trim() ? s : "—");

export function PartsCostDrill({
  financials,
  mode,
  jobIds,
  jobLabel,
  onModeChange,
  onClose,
  className,
}: {
  financials: PartsCostFinancials;
  mode: PartsDrillMode;
  /** The jobs this card covers — the ETC history is fetched for exactly these. */
  jobIds: number[];
  /** "1131 — Tile Grinder Automatic Loader and Unloader", so the panel states its own scope. */
  jobLabel: string;
  onModeChange: (mode: PartsDrillMode) => void;
  onClose: () => void;
  className?: string;
}) {
  const [query, setQuery] = useState("");

  // ── The ETC history, fetched only when that mode is opened ────────────────
  //
  // `history === undefined` means "not asked for yet", `null` means "asked, and it
  // failed" — distinguishable states, because an empty result and a broken query
  // must not render the same. The abort flag drops an answer that arrives after the
  // panel has closed or switched mode rather than setting state on a view nobody is
  // looking at.
  const [history, setHistory] = useState<PartsEtcMonth[] | null | undefined>(undefined);
  // Which job set the history answer belongs to. "Loading" is DERIVED from this
  // — ETC mode is open and the answer on hand is not for these jobs — rather than
  // held as its own flag flipped true at the top of the effect. Same meaning,
  // same frames, but nothing sets state synchronously inside the effect, which
  // is a lint error in this repo and can cascade a render.
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const jobKey = jobIds.join(",");
  const historyLoading = mode === "etc" && historyFor !== jobKey;
  useEffect(() => {
    if (mode !== "etc") return;
    let alive = true;
    loadPartsEtcHistory(jobIds)
      .then((rows) => {
        if (alive) setHistory(rows);
      })
      .catch(() => {
        if (alive) setHistory(null);
      })
      .finally(() => {
        if (alive) setHistoryFor(jobKey);
      });
    return () => {
      alive = false;
    };
    // `jobIds` by its joined key: a fresh array with the same ids on every render
    // would restart the fetch forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, jobKey]);
  const sort = useColumnSort<ColKey>({ key: "invoiced", direction: "desc" });

  const rows: Row[] = useMemo(
    // Vendor names normalized here too (2026-09-03). This panel reads the RAW
    // PartsCostLine rather than FlatPart, so it does not inherit po-detail.ts's
    // normalization — without this the drill would show "SDC" beside a Parts List
    // showing "Steven Douglas Corp (SDC)" for the same line, and its own search box
    // would not find the canonical name.
    () =>
      financials.lines.map((l) => ({
        ...l,
        supplier: normalizeVendor(l.supplier),
        manufacturer: normalizeVendor(l.manufacturer),
        leftToInvoice: l.totalPrice - l.actualAmount,
      })),
    [financials.lines],
  );

  const scoped = useMemo(() => rowsForMode(rows, mode), [rows, mode]);
  const searched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return scoped;
    return scoped.filter((r) =>
      [r.poNumber, r.partNumber, r.description, r.supplier].some((v) => v?.toLowerCase().includes(q)),
    );
  }, [scoped, query]);
  const sorted = useMemo(() => sortRows(searched, sort.sort, SORT_COLUMNS), [searched, sort.sort]);

  // ── The reconciliation, computed from the rows on screen ──────────────────
  //
  // Summed over `scoped` (mode's rows, unfiltered by the search box) rather than over
  // `sorted`: the search is a find-a-row tool, and a total that silently shrank as
  // someone typed would be a different number wearing the same label. When a search
  // is active the count says how many of the mode's rows are showing, and the totals
  // keep answering the question the bar asked.
  const sums = useMemo(() => {
    let invoiced = 0;
    let purchased = 0;
    for (const r of scoped) {
      invoiced += r.actualAmount;
      purchased += r.totalPrice;
    }
    return { invoiced, purchased, left: purchased - invoiced };
  }, [scoped]);

  // ── The floor note, on a tolerance and not on `!==` (2026-09-02) ──────────
  //
  // `leftToInvoice` is floored at 0 job-wide, so on a job whose posted spend exceeds
  // its purchased total the per-row sum is negative while the card shows 0. Worth
  // saying — but the exact `!==` this used fired on job 1101, where both sides are
  // $61,126.04 and differ only in the last bits of a float accumulated over 2,132
  // rows. It printed "these rows sum to $61,126; the card shows $61,126 because that
  // figure is floored" — a contradiction in its own sentence, and precisely the kind
  // of thing that costs a reconciliation panel its credibility.
  //
  // Half a cent: below any difference that could be real money, above every
  // difference that is only floating-point noise.
  const floored = mode !== "invoiced" && Math.abs(financials.leftToInvoice - sums.left) > 0.005;

  // ── The breakdown, in the order spec §14 lists it (2026-09-03) ────────────
  //
  // Every input to the bar plus the two figures it is judged against, so the panel
  // PROVES the picture rather than restating it. Three rows exist purely so the
  // arithmetic checks on sight, which is what §23's "difference must be zero" asks:
  //
  //     Prior-month ETC − Parts spent this month  = Adjusted ETC
  //     Yet to invoice  − Adjusted ETC            = Additional exposure   (when > 0)
  //     Invoiced + Adjusted ETC + Additional      = Total projection
  //
  // The list is rebuilt rather than extended: its previous version described the
  // coverage model (an "ETC-covered remaining" row and a "Current Parts ETC" taken
  // from the latest SUBMITTED entry), and neither quantity exists in this model.
  // §20 is explicit that the current month's New ETC must not stand in for the prior
  // month's, so showing it here would invite exactly that confusion.
  const adjustedIsFloored =
    financials.adjustedEtcRaw != null && financials.adjustedEtcRaw < -0.005;

  const totals: { label: string; value: string; hint?: string }[] = [
    { label: "Budget", value: financials.budget == null ? "—" : usd(financials.budget) },
    {
      label: "Purchased / committed",
      value: usd(financials.purchased),
      hint: "Every parts line's total cost on this job, invoiced or not",
    },
    // ── Scope in the label, not only in a hint (2026-09-02) ─────────────────
    //
    // The Parts List footer also says "Invoiced", and on job 1101 it says $290,266
    // against this card's $730,483 — the same word for a BOM-matched, newest-PO-line,
    // filtered subset and for the job's whole life. The two are reconcilable (see
    // that footer's own scope line) but only if each says which it is.
    {
      label: "Invoiced actual (lifetime)",
      value: usd(financials.invoiced),
      hint: "Every GL-posted line on this job, all POs, all dates. The bar's blue section",
    },
    {
      label: "Left to invoice",
      value: usd(financials.openBalance),
      hint:
        financials.inHouseRows > 0
          ? `External remaining exposure. Excludes ${usd(financials.inHouseExcluded)} on ${financials.inHouseRows} in-house (SDC) row${financials.inHouseRows === 1 ? "" : "s"}, which produce no supplier invoice`
          : "External remaining exposure — purchased less GL-posted, on rows that will produce a supplier invoice",
    },
    ...(financials.inHouseRows > 0
      ? [
          {
            label: "In-house (SDC) excluded",
            value: usd(financials.inHouseExcluded),
            hint: `Remaining exposure on ${financials.inHouseRows} row${financials.inHouseRows === 1 ? "" : "s"} SDC builds itself. Reported so 'Yet to invoice' reconciles against the ${usd(financials.openBalance)} whole open balance`,
          },
        ]
      : []),
    {
      label: "Prior-month ETC",
      value: financials.priorEtc == null ? "—" : usd(financials.priorEtc),
      hint:
        financials.priorEtcSource === "quoted-parts"
          ? "This job's FIRST parts ETC month, so the forecast opens at the quoted parts value rather than at zero"
          : `The previous month's confirmed New ETC, carried forward${financials.etcMonth ? ` into ${financials.etcMonth}` : ""}. NOT this month's New ETC entry`,
    },
    {
      label: "Parts spent this month",
      value: usd(financials.partsSpentThisMonth),
      hint: `The selected month's booked parts cost — the same 'Money Spent Month' the Monthly ETC grid shows${financials.etcMonth ? ` for ${financials.etcMonth}` : ""}`,
    },
    {
      label: "Adjusted ETC",
      value: usd(financials.adjustedEtc),
      hint: adjustedIsFloored
        ? `Prior-month ETC − parts spent this month = ${usd(financials.adjustedEtcRaw!)}, shown as $0 because a bar cannot have negative height. The month has already spent past its own forecast`
        : "Prior-month ETC − parts spent this month. The bar's yellow section",
    },
    {
      label: "Additional exposure",
      value: usd(financials.additionalExposure),
      hint:
        financials.additionalExposure > 0
          ? "Yet to invoice − Adjusted ETC. Remaining exposure the adjusted forecast does not cover — the bar's red section"
          : "Nothing: the adjusted ETC covers the whole remaining exposure, so there is no red section",
    },
    {
      label: "Total projection",
      value: usd(financials.projection),
      hint: "Invoiced + Adjusted ETC + Additional exposure. Equivalently, Invoiced + max(Adjusted ETC, Yet to invoice)",
    },
    {
      label: "Projection vs Budget",
      value: financials.variance == null ? "—" : `${financials.variance > 0 ? "+" : "−"}${usd(Math.abs(financials.variance))}`,
      hint: "Total projection − Budget. Over is positive",
    },
  ];

  const MODES: { key: PartsDrillMode; label: string }[] = [
    { key: "projection", label: "All rows" },
    { key: "invoiced", label: "Invoiced" },
    { key: "left", label: "Yet to invoice" },
    { key: "etc", label: "ETC" },
  ];

  return (
    <DrillPanel
      title={MODE_TITLE[mode]}
      meta={jobLabel}
      note={
        floored
          ? `These rows sum to ${usd(sums.left)} left to invoice; the card shows ${usd(financials.leftToInvoice)} because that figure is floored at zero job-wide.`
          : undefined
      }
      onClose={onClose}
      className={className}
      controls={
        <DrillControls>
          {/* Switching mode inside the panel, so someone who clicked one segment can
              reach the others without going back to the bar and aiming at a 20px
              target. Same state the bar sets — one source of truth for which view is
              open, which is what keeps the bar's own highlight honest. */}
          <div className="flex flex-wrap items-center gap-1.5">
            {MODES.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => onModeChange(m.key)}
                aria-pressed={mode === m.key}
                className={`motion-interactive rounded-full border px-3 py-1 text-xs ${
                  mode === m.key
                    ? "border-sdc-blue bg-sdc-blue-light text-sdc-blue-dark"
                    : "border-sdc-border-soft text-sdc-muted hover:text-sdc-navy"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          {mode !== "etc" && (
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search PO, part, description, supplier…"
              aria-label="Search parts cost detail"
              className="min-w-[16rem] flex-1 rounded-md border border-sdc-border px-2.5 py-1 text-xs text-sdc-navy placeholder:text-sdc-muted"
            />
          )}
        </DrillControls>
      }
    >
      {/* Totals first, above the rows — the question "what makes up this bar" is
          answered by these six figures, and the table is the evidence for them. */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-b border-sdc-border bg-sdc-gray-50 px-4 py-3 sm:grid-cols-3 lg:grid-cols-7">
        {totals.map((t) => (
          <div key={t.label} className="min-w-0">
            <p className={DRILL_TOTAL_LABEL} title={t.hint}>
              {t.label}
            </p>
            <p className="font-mono text-sm font-bold tabular-nums text-sdc-navy">{t.value}</p>
          </div>
        ))}
      </div>

      {mode === "etc" ? (
        <div>
          {/* The explanation stays — it is what stops someone hunting for a
              part-level breakdown that does not exist — but it is now the caption
              above real rows rather than the whole view. */}
          <div className="space-y-2 border-b border-sdc-border px-4 py-3 text-note leading-relaxed text-sdc-gray-600">
            <p>
              Parts ETC is one figure per month, maintained on the{" "}
              <span className="font-semibold">Monthly ETC</span> grid — not built up from part rows, so there is no
              part-level breakdown of it. What it IS made of is the drawdown below: each month opens at the previous
              month&apos;s close, is reduced by the parts booked against the job, and ends where the manager left it.
            </p>
            {/* Rewritten 2026-09-03 for Dan's model. Two earlier versions of this
                paragraph described projections the card no longer draws — first "the
                larger of ETC and Left to be invoiced", then a coverage split of the
                open balance. */}
            <p>
              The bar starts from the <span className="font-semibold">prior month&apos;s</span> ETC and draws it down by
              this month&apos;s parts spend
              {financials.priorEtc != null && (
                <>
                  {" "}
                  — {usd(financials.priorEtc)} less {usd(financials.partsSpentThisMonth)} leaves{" "}
                  <span className="font-semibold">{usd(financials.adjustedEtc)}</span>
                </>
              )}
              . What is still to be invoiced externally is then compared against that remainder, and only the
              uncovered difference is added on top.
              {financials.additionalExposure > 0 ? (
                <>
                  {" "}
                  Here {usd(financials.openBalance)} of exposure exceeds it by{" "}
                  <span className="font-semibold">{usd(financials.additionalExposure)}</span>, which is the red section.
                  For the rows behind that exposure, switch to{" "}
                  <button
                    type="button"
                    onClick={() => onModeChange("left")}
                    className="font-semibold text-sdc-blue-dark underline underline-offset-2"
                  >
                    Yet to invoice
                  </button>
                  .
                </>
              ) : (
                <> Here the remainder covers the whole {usd(financials.openBalance)} of exposure, so none is red.</>
              )}
            </p>
          </div>
          {/* ── The monthly series does NOT sum to lifetime, and says so ──────
              Measured across three jobs: Σ "parts booked" over every ETC month falls
              short of the job's lifetime GL-posted spend — 1101 by $39,842, 1104 by
              $89,972, 1131 by $4,136. Three causes, all structural rather than
              broken data:

                • Spend posted BEFORE the job's first ETC month belongs to no month
                  here at all (1101: $103,070 invoiced from 2025-05, first ETC month
                  2025-09. 1104: $379,089).
                • Spend after the latest ETC month has no month yet — invoices run to
                  2026-09 on all three jobs while ETC stops at 2026-08.
                • A duplicated ETC month double-books its spend (1101 has 2025-09 and
                  2025-10 carrying an identical $59,258.55).

              Nothing above says this, so a reader would reasonably add the column up
              and conclude one of the two figures is wrong. Stating the delta turns an
              apparent contradiction into a known, quantified difference — and makes
              the duplicate-month case visible on the job it affects. */}
          {!historyLoading && history && history.length > 0 && (() => {
            const booked = history.reduce((sum, h) => sum + h.spent, 0);
            const delta = booked - financials.invoiced;
            if (Math.abs(delta) < 1) return null;
            return (
              <p className="border-b border-sdc-border bg-sdc-yellow-bg/50 px-4 py-2 text-note leading-relaxed text-sdc-gray-600">
                These months book{" "}
                <span className="font-mono font-semibold tabular-nums text-sdc-navy">{usd(booked)}</span> of parts
                against a lifetime GL-posted total of{" "}
                <span className="font-mono font-semibold tabular-nums text-sdc-navy">{usd(financials.invoiced)}</span> —
                a difference of{" "}
                <span className="font-mono font-semibold tabular-nums text-sdc-navy">
                  {delta > 0 ? "+" : "−"}
                  {usd(Math.abs(delta))}
                </span>
                . The two are not the same population: spend posted before this job&apos;s first ETC month, or after its
                latest one, belongs to no row here. This column is the ETC drawdown, not a record of every invoice.
              </p>
            );
          })()}
          {historyLoading ? (
            // Confined to the panel — the charts and the page behind it keep working.
            <p className="flex items-center gap-2 px-4 py-4 text-note text-sdc-muted">
              <span
                aria-hidden
                className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-sdc-border border-t-sdc-blue"
              />
              Loading the ETC history…
            </p>
          ) : history === null ? (
            // A failed fetch and an empty history are different facts and must not
            // render as the same sentence.
            <p className="px-4 py-4 text-note text-sdc-red-text">Couldn&apos;t load the ETC history.</p>
          ) : !history || history.length === 0 ? (
            <DrillEmpty>No parts ETC has been entered for this job yet.</DrillEmpty>
          ) : (
            <table className="w-full border-collapse text-left text-xs">
              <thead className="sticky top-0 z-[1] bg-sdc-navy text-micro font-bold uppercase tracking-wider text-white">
                <tr>
                  <th className="border-r border-white/15 px-2 py-1.5">Month</th>
                  <th className="border-r border-white/15 px-2 py-1.5 text-right">Opened at</th>
                  <th className="border-r border-white/15 px-2 py-1.5 text-right">Parts booked</th>
                  <th className="border-r border-white/15 px-2 py-1.5 text-right">New ETC</th>
                  <th className="border-r border-white/15 px-2 py-1.5">Status</th>
                  <th className="px-2 py-1.5">Entered by</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.month} className="border-b border-sdc-border-soft hover:bg-sdc-blue-light/40">
                    <td className="px-2 py-1 font-mono">{h.month}</td>
                    <td className={`px-2 py-1 ${DRILL_NUM}`}>{money(h.priorEtc)}</td>
                    <td className={`px-2 py-1 ${DRILL_NUM}`}>{money(h.spent)}</td>
                    <td className={`px-2 py-1 font-semibold ${DRILL_NUM}`}>{money(h.newEtc)}</td>
                    <td className="px-2 py-1">
                      {/* "Submitted" is a decision; anything else is provisional and
                          is labelled as such rather than left to look settled. */}
                      {h.needsReview ? (
                        <span className="text-sdc-yellow-text">Draft / suggested</span>
                      ) : (
                        <span className="text-sdc-green-text">Submitted</span>
                      )}
                    </td>
                    <td className="max-w-[12rem] truncate px-2 py-1">{dash(h.enteredBy)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : sorted.length === 0 ? (
        <DrillEmpty>{query.trim() ? "No rows match that search." : "No rows contribute to this figure."}</DrillEmpty>
      ) : (
        <table className="w-full border-collapse text-left text-xs">
          <thead className="sticky top-0 z-[1] bg-sdc-navy text-micro font-bold uppercase tracking-wider text-white">
            <tr>
              {COLUMNS.map((c) => (
                <SortableTh
                  key={c.key}
                  label={c.label}
                  sortKey={c.key}
                  type={c.type}
                  sort={sort.sort}
                  onSort={sort.onSort}
                  className="border-r border-white/15 px-2 py-1.5"
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={`${r.poNumber}-${r.partNumber}-${i}`} className="border-b border-sdc-border-soft hover:bg-sdc-blue-light/40">
                <td className="px-2 py-1 font-mono">{dash(r.poNumber)}</td>
                <td className="px-2 py-1 font-mono">{dash(r.partNumber)}</td>
                <td className="max-w-[22rem] truncate px-2 py-1" title={r.description ?? undefined}>{dash(r.description)}</td>
                <td className="max-w-[12rem] truncate px-2 py-1" title={r.supplier ?? undefined}>{dash(r.supplier)}</td>
                <td className={`px-2 py-1 ${DRILL_NUM}`}>{r.quantity}</td>
                <td className={`px-2 py-1 ${DRILL_NUM}`}>{money(r.unitPrice)}</td>
                <td className={`px-2 py-1 ${DRILL_NUM}`}>{money(r.totalPrice)}</td>
                <td className={`px-2 py-1 ${DRILL_NUM}`}>{money(r.actualAmount)}</td>
                <td className={`px-2 py-1 ${DRILL_NUM}`}>{money(r.leftToInvoice)}</td>
                <td className="px-2 py-1">{dash(r.purchaseDate)}</td>
                <td className="px-2 py-1">{dash(r.invoicedDate)}</td>
              </tr>
            ))}
          </tbody>
          {/* The sum of what this mode is about, stated under the rows it is the sum
              of — so the tie-back to the bar is visible without adding a column up. */}
          <tfoot className="sticky bottom-0 bg-sdc-navy text-xs font-bold text-white">
            <tr>
              <td className="px-2 py-1.5" colSpan={4}>
                {scoped.length.toLocaleString()} line{scoped.length === 1 ? "" : "s"}
                {query.trim() ? ` · ${sorted.length.toLocaleString()} shown` : ""}
              </td>
              <td colSpan={2} />
              {/* Cents here too, so the footer is literally the sum of the column
                  above it — the whole point of showing cents in the rows. */}
              <td className={`px-2 py-1.5 ${DRILL_NUM} text-white`}>{money(sums.purchased)}</td>
              <td className={`px-2 py-1.5 ${DRILL_NUM} text-white`}>{money(sums.invoiced)}</td>
              <td className={`px-2 py-1.5 ${DRILL_NUM} text-white`}>{money(sums.left)}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      )}
    </DrillPanel>
  );
}
