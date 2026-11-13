import "server-only";
import { prisma } from "@/lib/prisma";

// ── "These hours are not current" (2026-11-13) ───────────────────────────────
//
// Job Details' "Hours Refreshed Thru" card showed 2026-11-06 for a week while the
// warehouse load was not running, and it looked exactly as it does on a good day: a
// date in a box. Four or five times now, someone noticed before the system did.
//
// This puts the reason above the figures whenever either half of the hours chain
// is unhealthy:
//   • warehouse_load: the warehouse's daily Paylocity load missed its deadline,
//     or ran but the hours did not reach the prior business day
//     (lib/warehouse-load-check.ts)
//   • hours_actual: the app could not read the hours from the warehouse
//
// Not SourceStaleBanner: that one dates the figures by when the failure was
// recorded ("from just now"), which for a check that runs hourly says nothing
// about how old the hours are. Here the date the hours reach is the point.
//
// Silent when both are healthy. Never throws: a warning that takes the page down
// is worse than no warning.

export async function HoursFreshnessBanner() {
  let rows: { source: string; status: string | null; refreshedThrough: Date }[] = [];
  try {
    rows = await prisma.powerBiFreshness.findMany({
      where: { source: { in: ["warehouse_load", "hours_actual"] } },
      select: { source: true, status: true, refreshedThrough: true },
    });
  } catch {
    return null;
  }
  const failed = rows.filter((r) => r.status?.startsWith("Failed:"));
  if (failed.length === 0) return null;

  const hoursThrough = rows.find((r) => r.source === "hours_actual")?.refreshedThrough ?? null;
  const reasons = [...new Set(failed.map((r) => (r.status ?? "").replace(/^Failed:\s*/, "").trim()))];

  return (
    <div role="status" className="mb-4 rounded-xl border border-sdc-yellow bg-sdc-yellow-bg px-4 py-3 text-sm text-sdc-yellow-text">
      <p className="font-semibold">
        Hours are not current
        {hoursThrough ? ` — they run through ${hoursThrough.toISOString().slice(0, 10)}` : ""}.
      </p>
      {reasons.map((reason) => (
        <p key={reason} className="mt-1 text-sdc-navy/80">
          {reason}
        </p>
      ))}
      <p className="mt-1.5 text-note text-sdc-navy/70">
        Figures below are correct as of that date. Details on the Dashboard&apos;s Data Sync card.
      </p>
    </div>
  );
}
