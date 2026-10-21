"use client";

import { useEffect, useState } from "react";
import { usd } from "@/components/ui/format";
import type { PartsCostFinancials } from "@/lib/parts-cost-financials-shared";
import { previousMonthKey } from "@/lib/still-to-purchase";
import { loadBomStillToBuy, type BomStillToBuy } from "@/lib/parts-bom-check-actions";

// ── "How is Still to purchase calculated?" (2026-10-19, reworked 2026-10-21) ─
//
// The card says  Projected total = Purchased to date + Still to purchase.  Still to purchase is last
// month's Left to Purchase (the Monthly ETC tab) less what has been purchased this month, shown with
// the job's own figures. A negative result is an excess: it is stated, not floored away, and the panel
// says it is already inside Purchased. A job with no Left to Purchase last month falls back to the
// forecast estimate (Adjusted ETC − open POs). A last line sets the BOM's own "not yet ordered" figure
// beside the estimate; it loads on demand because reading a BOM from Total ETO can be slow.

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
  const lastMonth = monthLabel(financials.etcMonth ? previousMonthKey(financials.etcMonth) : null);
  const fromMonthly = financials.stpJobsFromMonthlyEtc > 0;
  const fromForecast = financials.stpJobsFromForecast > 0;
  const stp = financials.stillToPurchase;
  const excess = financials.excessPurchased;
  // Where Purchased and Invoiced + Not yet invoiced part company (invoices above what was ordered),
  // the projection is shown as three terms so the sum still checks.
  const threeTerms = Math.abs(financials.purchased + stp - financials.projection) > 1;
  const redText = "font-mono font-semibold tabular-nums text-sdc-red-text";

  return (
    <div className="space-y-3 border-b border-sdc-border px-4 py-3 text-note leading-relaxed text-sdc-gray-600">
      <p className="font-semibold text-sdc-navy">How &ldquo;Still to purchase&rdquo; is calculated</p>
      <p>
        <span className="font-semibold">Projected total = Purchased to date + Still to purchase.</span> Still to purchase
        is what was left to purchase at the end of last month, less what has been purchased since.
      </p>

      {fromMonthly && financials.leftToPurchaseLastMonth != null && (
        <table className="w-full max-w-xl border-collapse text-left">
          <tbody>
            <tr>
              <td className="py-0.5 pr-3">
                Left to Purchase at the end of {lastMonth} (from the Monthly ETC tab)
              </td>
              <td className={`py-0.5 text-right ${num}`}>{usd(financials.leftToPurchaseLastMonth)}</td>
            </tr>
            <tr>
              <td className="py-0.5 pr-3">− Purchased in {month} (POs dated this month)</td>
              <td className={`py-0.5 text-right ${num}`}>{signed(-financials.purchasedThisMonth)}</td>
            </tr>
            <tr className="border-t border-sdc-border">
              <td className="py-0.5 pr-3 font-semibold text-sdc-navy">= Still to purchase</td>
              <td className={`py-0.5 text-right ${financials.stillToPurchaseSigned < 0 ? redText : num}`}>
                {signed(financials.stillToPurchaseSigned)}
              </td>
            </tr>
          </tbody>
        </table>
      )}
      {excess > 0.5 && (
        <p className="rounded-md border border-sdc-red/30 bg-sdc-red/5 px-3 py-2">
          <span className="font-semibold text-sdc-red-text">Excess purchased: {usd(excess)}.</span> More was purchased
          this month than was left to purchase last month. That money is already inside Purchased to date, so the
          projected total is not increased a second time; it is shown in red on the chart, above a dotted line that
          separates it from what is still to be bought.
          {fromMonthly && financials.stpJobsFromMonthlyEtc > 1 && (
            <> Each job is worked on its own, so one job&apos;s excess is not netted against another job&apos;s remainder.</>
          )}
        </p>
      )}

      {fromForecast && (
        <div>
          <p className="mb-1">
            {fromMonthly
              ? `${financials.stpJobsFromForecast} job${financials.stpJobsFromForecast === 1 ? " has" : "s have"} no Left to Purchase on last month's Monthly ETC, so for ${financials.stpJobsFromForecast === 1 ? "it" : "them"} the forecast is used instead (combined figures below cover the selection):`
              : `No Left to Purchase was entered on last month's Monthly ETC, so it is estimated from the forecast:`}
          </p>
          {financials.etcUnknown ? (
            <p>
              No prior-month ETC is on file for this job either, so nothing is forecast beyond what is already ordered:
              still to purchase is <span className={num}>{usd(0)}</span> and the projected total equals purchased to date.
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
                  <td className="py-0.5 pr-3 font-semibold text-sdc-navy">= Still to purchase (never below $0)</td>
                  <td className={`py-0.5 text-right ${num}`}>
                    {usd(Math.max(0, financials.adjustedEtc - financials.openBalance))}
                  </td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      )}
      {!fromMonthly && !fromForecast && (
        <p>
          Nothing is left to purchase: still to purchase is <span className={num}>{usd(0)}</span> and the projected total
          equals purchased to date.
        </p>
      )}
      <p>
        {threeTerms ? (
          <>
            Projected total = invoiced <span className={num}>{usd(financials.invoiced)}</span> + not yet invoiced{" "}
            <span className={num}>{usd(financials.openBalance)}</span> + still to purchase{" "}
            <span className={num}>{usd(stp)}</span> = <span className={num}>{usd(financials.projection)}</span>.
          </>
        ) : (
          <>
            Projected total = purchased to date <span className={num}>{usd(financials.purchased)}</span> + still to purchase{" "}
            <span className={num}>{usd(stp)}</span> = <span className={num}>{usd(financials.projection)}</span>.
          </>
        )}
        {excess > 0.5 && <> A negative still to purchase counts as $0 here because the excess is already in purchased.</>}
      </p>

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
              {stp > bom.amount + 1 ? (
                <>
                  The estimate above is <span className={num}>{usd(stp - bom.amount)}</span> higher. That is
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
