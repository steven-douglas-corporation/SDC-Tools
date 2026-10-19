"use client";

import { useEffect, useMemo, useState } from "react";
import { usd } from "@/components/ui/format";
import type { PartsCostFinancials } from "@/lib/parts-cost-financials-shared";
import { computeStillToPurchase } from "@/lib/still-to-purchase";
import { loadBomStillToBuy, type BomStillToBuy } from "@/lib/parts-bom-check-actions";

// ── "How is Still to purchase calculated?" (2026-10-19) ──────────────────────
//
// The card says  Projected total = Purchased to date + Still to purchase.  This is the page that
// shows where "still to purchase" comes from, with the job's own figures in every step, and works
// it a second way so the two can be compared:
//
//   1. the way the card computes it   Adjusted ETC − open POs
//   2. the way a manager thinks of it  what was still to buy last month − what was bought this month
//
// They are the same quantity (lib/still-to-purchase.ts has the algebra), so they agree to within
// the money that was neither "a purchase" nor "an invoice" this month — and the difference is shown
// rather than hidden. A third line sets the BOM's own "not yet ordered" figure beside the estimate;
// it loads on demand because reading a BOM from Total ETO can be slow.

const num = "font-mono font-semibold tabular-nums text-sdc-navy";
const signed = (n: number) => `${n < 0 ? "−" : ""}${usd(Math.abs(n))}`;

function monthLabel(m: string | null): string {
  if (!m) return "this month";
  const [y, mo] = m.split("-").map(Number);
  return new Date(y, mo - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
}

export function StillToPurchasePanel({
  financials,
  jobIds,
  onShowOpenPos,
}: {
  financials: PartsCostFinancials;
  jobIds: number[];
  /** Switches the drill to the rows behind "Not yet invoiced". */
  onShowOpenPos: () => void;
}) {
  const todayMonth = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }, []);
  const r = useMemo(
    () =>
      computeStillToPurchase({
        priorEtc: financials.priorEtc,
        partsSpentThisMonth: financials.partsSpentThisMonth,
        adjustedEtc: financials.adjustedEtc,
        openBalance: financials.openBalance,
        purchased: financials.purchased,
        projection: financials.projection,
        etcUnknown: financials.etcUnknown,
        etcMonth: financials.etcMonth,
        lines: financials.lines,
        todayMonth,
      }),
    [financials, todayMonth],
  );

  // The BOM cross-check — one job only (a BOM belongs to one job), fetched when this panel opens.
  // `undefined` = not asked yet, `null` = asked and nothing to show. Loading is DERIVED from which
  // job the answer belongs to, not held as a flag set inside the effect.
  const jobKey = jobIds.length === 1 ? jobIds[0] : null;
  const [bom, setBom] = useState<BomStillToBuy | null | undefined>(undefined);
  const [bomFor, setBomFor] = useState<number | null>(null);
  const bomLoading = jobKey !== null && bomFor !== jobKey;
  useEffect(() => {
    if (jobKey === null) return;
    let alive = true;
    loadBomStillToBuy(jobKey)
      .then((v) => {
        if (alive) setBom(v);
      })
      .catch(() => {
        if (alive) setBom(null);
      })
      .finally(() => {
        if (alive) setBomFor(jobKey);
      });
    return () => {
      alive = false;
    };
  }, [jobKey]);

  const prior = financials.priorEtc;
  const month = monthLabel(financials.etcMonth);
  // Where Purchased and Invoiced + Not yet invoiced part company (invoices above what was ordered),
  // the projection is shown as three terms so the sum still checks.
  const threeTerms = Math.abs(financials.purchased + r.stillToPurchase - financials.projection) > 1;

  return (
    <div className="space-y-3 border-b border-sdc-border px-4 py-3 text-note leading-relaxed text-sdc-gray-600">
      <p className="font-semibold text-sdc-navy">How &ldquo;Still to purchase&rdquo; is calculated</p>
      <p>
        <span className="font-semibold">Projected total = Purchased to date + Still to purchase.</span> The forecast
        (the ETC) means &ldquo;all cost still to come&rdquo;, so it already contains what is ordered but not yet invoiced.
        Taking that out leaves what has not been ordered yet.
      </p>

      {financials.etcUnknown ? (
        <p>
          No prior-month ETC is on file for this job, so nothing is forecast beyond what is already ordered: still to
          purchase is <span className={num}>{usd(0)}</span> and the projected total equals purchased to date.
        </p>
      ) : (
        <table className="w-full max-w-xl border-collapse text-left">
          <tbody>
            <tr>
              <td className="py-0.5 pr-3">Prior-month New ETC (all cost still to come)</td>
              <td className={`py-0.5 text-right ${num}`}>{prior == null ? "—" : usd(prior)}</td>
            </tr>
            <tr>
              <td className="py-0.5 pr-3">− Invoiced in {month}</td>
              <td className={`py-0.5 text-right ${num}`}>{signed(-financials.partsSpentThisMonth)}</td>
            </tr>
            <tr className="border-t border-sdc-border-soft">
              <td className="py-0.5 pr-3">= Adjusted ETC</td>
              <td className={`py-0.5 text-right ${num}`}>{usd(financials.adjustedEtc)}</td>
            </tr>
            <tr>
              <td className="py-0.5 pr-3">
                − Not yet invoiced (open POs, already ordered){" "}
                <button
                  type="button"
                  onClick={onShowOpenPos}
                  className="font-semibold text-sdc-blue-dark underline underline-offset-2"
                >
                  see the rows
                </button>
              </td>
              <td className={`py-0.5 text-right ${num}`}>{signed(-financials.openBalance)}</td>
            </tr>
            <tr className="border-t border-sdc-border">
              <td className="py-0.5 pr-3 font-semibold text-sdc-navy">= Still to purchase</td>
              <td className={`py-0.5 text-right ${num}`}>{usd(r.stillToPurchase)}</td>
            </tr>
          </tbody>
        </table>
      )}
      {r.floored && (
        <p>
          The forecast ({usd(financials.adjustedEtc)}) is below what is already ordered ({usd(financials.openBalance)}), so
          nothing more is expected to be purchased and the projection is the committed cost.
        </p>
      )}
      <p>
        {threeTerms ? (
          <>
            Projected total = invoiced <span className={num}>{usd(financials.invoiced)}</span> + not yet invoiced{" "}
            <span className={num}>{usd(financials.openBalance)}</span> + still to purchase{" "}
            <span className={num}>{usd(r.stillToPurchase)}</span> = <span className={num}>{usd(financials.projection)}</span>.
          </>
        ) : (
          <>
            Projected total = purchased to date <span className={num}>{usd(financials.purchased)}</span> + still to purchase{" "}
            <span className={num}>{usd(r.stillToPurchase)}</span> = <span className={num}>{usd(financials.projection)}</span>.
          </>
        )}
      </p>

      {r.secondRoute != null && r.stillToPurchaseLastMonth != null && r.openAtLastMonthEnd != null && r.purchasedThisMonth != null && prior != null && (
        <div className="rounded-md border border-sdc-border-soft bg-sdc-gray-50 px-3 py-2">
          <p className="mb-1 font-semibold text-sdc-navy">The same figure, worked the other way</p>
          <p className="mb-1">What was still to be bought last month, less what has been bought this month:</p>
          <table className="w-full max-w-xl border-collapse text-left">
            <tbody>
              <tr>
                <td className="py-0.5 pr-3">
                  Still to purchase at the end of last month ({usd(prior)} ETC − {usd(r.openAtLastMonthEnd)} open POs)
                </td>
                <td className={`py-0.5 text-right ${num}`}>{usd(r.stillToPurchaseLastMonth)}</td>
              </tr>
              <tr>
                <td className="py-0.5 pr-3">− Purchased in {month} (POs dated this month)</td>
                <td className={`py-0.5 text-right ${num}`}>{signed(-r.purchasedThisMonth)}</td>
              </tr>
              <tr className="border-t border-sdc-border">
                <td className="py-0.5 pr-3 font-semibold text-sdc-navy">= Still to purchase</td>
                <td className={`py-0.5 text-right ${num}`}>{usd(r.secondRoute)}</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-1">
            {Math.abs(r.difference ?? 0) < 1 ? (
              <>The two routes give the same figure.</>
            ) : (
              <>
                The two routes differ by <span className={num}>{usd(Math.abs(r.difference ?? 0))}</span>: money that was
                neither a purchase nor an invoice this month, such as an invoice SDC billed itself, a PO changed after it
                was placed, or a credit.
              </>
            )}
          </p>
        </div>
      )}

      {jobKey !== null && (
        <div className="rounded-md border border-sdc-border-soft bg-sdc-gray-50 px-3 py-2">
          <p className="mb-1 font-semibold text-sdc-navy">Check against the BOM</p>
          {bomLoading ? (
            <p className="flex items-center gap-2 text-sdc-muted">
              <span
                aria-hidden
                className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-sdc-border border-t-sdc-blue"
              />
              Reading the BOM…
            </p>
          ) : bom == null ? (
            <p className="text-sdc-muted">The BOM check isn&apos;t available right now.</p>
          ) : (
            <p>
              The BOM shows <span className={num}>{usd(bom.amount)}</span> of parts not yet ordered
              {bom.parts > 0 ? ` (${bom.parts} part${bom.parts === 1 ? "" : "s"})` : ""}.{" "}
              {r.stillToPurchase > bom.amount + 1 ? (
                <>
                  The estimate above is <span className={num}>{usd(r.stillToPurchase - bom.amount)}</span> higher. That is
                  not necessarily wrong — freight, fees and change orders are not on the BOM — but it is the figure to
                  review.
                </>
              ) : (
                <>The estimate above is in line with that.</>
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
