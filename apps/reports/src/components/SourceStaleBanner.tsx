import "server-only";
import { prisma } from "@/lib/prisma";

// ── "The figures below did not refresh" (2026-09-01) ────────────────────────
//
// Written after four Total ETO sources failed for two hours while every page
// that depends on them kept rendering the last successful numbers with nothing to
// say so. The refresh toast reported it — once, to whoever happened to click
// Refresh — and the Dashboard's Data Sync card had it, but a manager opening Cash
// Flow or a parts view saw confident figures and no reason to doubt them.
//
// That is the dangerous half of a partial refresh: not that a source failed, but
// that its consumers looked identical either way.
//
// This reads the SAME PowerBiFreshness rows the refresh pass writes — one row per
// source, holding `status` ("Failed: ..." or a stated wait) and `checkedAt`. No
// new tracking, no second source of truth: if the banner and the Data Sync card
// ever disagreed, one of them would be lying, so they read the same table.
//
// Deliberately silent when everything is healthy. A banner that is always present
// is furniture, and stops being read long before the day it matters.

/** A failure recorded against one source, as `recordSyncFailure` writes it. */
type FreshnessRow = { source: string; status: string | null; checkedAt: Date | null };

function ageLabel(checkedAt: Date | null): string {
  if (!checkedAt) return "unknown";
  const mins = Math.round((Date.now() - checkedAt.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Renders nothing unless one of `sources` last failed.
 *
 * @param sources the freshness rows this page's figures actually come from —
 *        named by the caller rather than inferred, so a page cannot accidentally
 *        warn about a feed it does not use, or stay quiet about one it does.
 * @param what a short noun phrase for the figures at risk ("this forecast").
 */
export async function SourceStaleBanner({ sources, what }: { sources: string[]; what: string }) {
  if (sources.length === 0) return null;

  let rows: FreshnessRow[] = [];
  try {
    rows = await prisma.powerBiFreshness.findMany({
      where: { source: { in: sources } },
      select: { source: true, status: true, checkedAt: true },
    });
  } catch {
    // The banner is a warning, not a feature: if its own read fails it must not
    // take the page down with it. A page that renders without the warning is
    // strictly better than a page that does not render.
    return null;
  }

  // "Failed: " is the prefix recordSyncFailure writes. Anything else in `status`
  // is a stated WAIT (recordSyncNote) — the source is fine, upstream just has not
  // published yet — which is not what this banner is for.
  const failed = rows.filter((r) => r.status?.startsWith("Failed:"));
  if (failed.length === 0) return null;

  // The reason, minus the prefix. These are described sentences now
  // (describeTotalEtoFailure), so they already name the system and say whether
  // retrying can help.
  const reasons = [...new Set(failed.map((r) => (r.status ?? "").replace(/^Failed:\s*/, "").trim()))];
  const oldest = failed.reduce<Date | null>(
    (acc, r) => (r.checkedAt && (!acc || r.checkedAt < acc) ? r.checkedAt : acc),
    null,
  );

  return (
    <div
      role="status"
      className="mb-4 rounded-xl border border-sdc-yellow bg-sdc-yellow-bg px-4 py-3 text-sm text-sdc-yellow-text"
    >
      <p className="font-semibold">
        {what} may be out of date — {failed.length === 1 ? "a source" : `${failed.length} sources`} failed to refresh.
      </p>
      <p className="mt-1 text-sdc-navy/80">
        Showing the last figures that loaded successfully, from {ageLabel(oldest)}. They are not wrong, they are simply
        not current.
      </p>
      {reasons.map((reason) => (
        <p key={reason} className="mt-1.5 text-note text-sdc-navy/70">
          {reason}
        </p>
      ))}
    </div>
  );
}
