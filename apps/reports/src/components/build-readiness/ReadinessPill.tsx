import { readinessBand, type ReadinessBand } from "@/lib/build-readiness-types";
import { safePct } from "@/components/ui/format";
import { StatusBadge } from "@/components/ui/StatusBadge";

// One readiness-% visual for the whole Build Readiness tab — a small colored
// dot plus the number (`● 68%`), or a neutral/red badge for the states that
// aren't a percentage at all ("No BOM", "Not Released", "Failed"). Previously
// this dot was only in the main table; the drill panel and Insights each
// printed a plain, uncolored `{pct}%` instead, so the same figure read three
// different ways depending on which table it appeared in.

const BAND_DOT: Record<ReadinessBand, string> = {
  green: "bg-sdc-green",
  yellow: "bg-sdc-yellow",
  red: "bg-sdc-red",
  grey: "bg-sdc-gray-300",
};
const BAND_TEXT: Record<ReadinessBand, string> = {
  green: "text-sdc-green-text",
  yellow: "text-sdc-yellow-text",
  red: "text-sdc-red-text",
  grey: "text-sdc-gray-400",
};

// Below this many required parts, a 100% is real but built on very little
// released scope — visually indistinguishable otherwise from a mature
// project's 100%. A heuristic, not a business rule; kept in sync with
// scripts/readiness-audit.ts's own LIMITED_SCOPE_THRESHOLD so the UI marker
// and the audit's flag never disagree about which jobs qualify.
export const LIMITED_SCOPE_THRESHOLD = 10;

export function ReadinessPill({
  pct,
  status = "ok",
  requiredQtyTotal,
}: {
  pct: number;
  // Assembly-level readiness (AssemblyDetail) has no status of its own — it is
  // always a real measured percentage, so callers with no job status default
  // to "ok" rather than passing one in.
  status?: "ok" | "failed" | "empty" | "notReleased";
  // Project-level only (JobSnapshotRow.requiredQtyTotal) — omit for assembly-
  // level pills, which don't need the "limited scope" marker.
  requiredQtyTotal?: number;
}) {
  if (status === "empty") return <StatusBadge variant="neutral">No BOM</StatusBadge>;
  if (status === "notReleased") return <StatusBadge variant="neutral">Not Released</StatusBadge>;
  if (status === "failed") return <StatusBadge variant="failed">Failed</StatusBadge>;
  const band = readinessBand({ status: "ok", overallReadinessPct: pct });
  const limitedScope = pct === 100 && requiredQtyTotal != null && requiredQtyTotal < LIMITED_SCOPE_THRESHOLD;
  return (
    <span className="inline-flex items-center gap-1.5 font-mono font-semibold tabular-nums">
      <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${BAND_DOT[band]}`} aria-hidden />
      {/* Clamped at the boundary — see safePct. A pill is handed a plain `number`,
          which includes NaN, and interpolating it raw is how `NaN%` reached a screen. */}
      <span className={BAND_TEXT[band]}>{safePct(pct)}%</span>
      {limitedScope && (
        <span
          className="text-note font-sans font-normal text-sdc-yellow-text"
          title={`100% of only ${requiredQtyTotal} required part${requiredQtyTotal === 1 ? "" : "s"} — limited released scope`}
          aria-label="Limited released scope"
        >
          ⚠
        </span>
      )}
    </span>
  );
}
