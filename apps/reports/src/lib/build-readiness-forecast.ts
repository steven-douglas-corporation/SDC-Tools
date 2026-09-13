// Pure aggregations over already-classified JobSnapshotRow[] (from
// build-readiness-actions.ts's getBuildReadinessData) — no I/O, no live
// TotalETO calls. Everything here re-groups numbers job-bom-rules.ts and
// build-readiness-sync.ts already computed; it introduces no new coverage or
// cost rule.

import type { JobSnapshotRow, SupplierRiskRow, ForecastWeek, UpcomingDeliveryEntry, AssemblyDetail } from "@/lib/build-readiness-types";

const DAY = 86_400_000;

// ── Merging BOM-position duplicates for "What Can We Build Now" ────────────
//
// The same assembly part number can legitimately occur at more than one BOM
// tree position in a job — job-bom-rules.ts's buildAssembly() explicitly
// renders a reused sub-assembly design "fully under each parent," not once
// (see its own comment). Each occurrence gets its own build-readiness-
// tree.ts key and its own AssemblyDetail row in the snapshot, which is
// correct for every PER-POSITION count elsewhere on the page (Assemblies/
// Ready/Partial/Blocked on the main table, the Assemblies drill list) — but
// "What Can We Build Now" is asking a different question ("what can I build
// of THIS assembly, across the whole job"), so it merges every position
// sharing a part number into one row, aggregating the figures each position
// already computed rather than picking one and discarding the rest.
// Exported so both the card (BuildReadinessInsights.tsx) and its drilldown
// (BuildReadinessAssemblyDetail.tsx) read the identical combined numbers —
// the two must never disagree about what a merged row's own stats are.
export function mergeAssemblyInstances(instances: AssemblyDetail[]): {
  requiredQty: number;
  coveredQty: number;
  readinessPct: number;
  buildableQty: number | null;
  buildablePct: number | null;
  materialValue: number;
  limitingParts: { pn: string; available: number; required: number }[];
  nextExpectedDelivery: string | null;
  estimatedBuildableDate: string | null;
} {
  const requiredQty = instances.reduce((s, a) => s + a.requiredQty, 0);
  const coveredQty = instances.reduce((s, a) => s + a.coveredQty, 0);
  // readinessPct is itself already quantity-weighted (job-bom-rules.ts's
  // quantityReadiness, via statsForRoots) — but AssemblyDetail only carries
  // the already-rounded percentage, not the raw required/covered quantities,
  // so a merged view can't re-derive it to the exact cent. A requiredQty-
  // weighted average of the rounded per-instance percentages is the closest
  // defensible proxy, and for the single-instance case (the overwhelming
  // majority) it's exact — one term, the weight cancels.
  const readinessPct =
    requiredQty > 0
      ? Math.round(instances.reduce((s, a) => s + a.readinessPct * a.requiredQty, 0) / requiredQty)
      : instances.length
        ? Math.round(instances.reduce((s, a) => s + a.readinessPct, 0) / instances.length)
        : 0;
  const materialValue = instances.reduce((s, a) => s + a.materialValue, 0);
  // Buildable qty and required qty are both quantity-based and additive —
  // each position's parts are its own distinct procurement/pull records
  // (job-bom.ts's per-edge correlated subqueries), not a pool shared across
  // positions — so summing is exact here, not an approximation the way
  // readinessPct above has to be.
  const anyUnbuildable = instances.some((a) => a.buildableQty === null);
  const buildableQty = anyUnbuildable ? null : instances.reduce((s, a) => s + (a.buildableQty ?? 0), 0);
  const buildablePct = buildableQty !== null && requiredQty > 0 ? Math.round((buildableQty / requiredQty) * 100) : null;

  const limitingByPn = new Map<string, { pn: string; available: number; required: number }>();
  for (const a of instances) {
    for (const lp of a.limitingParts) {
      const existing = limitingByPn.get(lp.pn);
      if (existing) {
        existing.available += lp.available;
        existing.required += lp.required;
      } else {
        limitingByPn.set(lp.pn, { ...lp });
      }
    }
  }

  const nextExpectedDelivery = instances.reduce<string | null>(
    (acc, a) => (a.nextExpectedDelivery && (!acc || a.nextExpectedDelivery < acc) ? a.nextExpectedDelivery : acc),
    null,
  );
  // Every instance has to clear its own bottleneck before the WHOLE merged
  // assembly is done, so the slowest still-blocked instance sets the combined
  // estimate — mirrors the single-instance rule (null once fully buildable)
  // rather than averaging in a date from an instance that's already ready.
  const stillBlocked = instances.filter((a) => a.buildableQty !== null && a.buildableQty < a.requiredQty);
  const estimatedDates = stillBlocked.map((a) => a.estimatedBuildableDate).filter((d): d is string => d != null);
  const estimatedBuildableDate = estimatedDates.length ? estimatedDates.reduce((a, b) => (a > b ? a : b)) : null;

  return {
    requiredQty,
    coveredQty,
    readinessPct,
    buildableQty,
    buildablePct,
    materialValue,
    limitingParts: [...limitingByPn.values()],
    nextExpectedDelivery,
    estimatedBuildableDate,
  };
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Same 8-week bucketing JobProcurement.tsx's own RiskCards uses (today+1 ..
// today+(w*7+1) days) — ported rather than re-derived, so "week 3" means the
// same date range here as it does on the per-job Procurement tab.
export function weekWindow(week: number, now: number): { start: number; end: number } {
  const today = startOfDay(now);
  return { start: today + ((week - 1) * 7 + 1) * DAY, end: today + (week * 7 + 1) * DAY };
}

// Upcoming deliveries across every job within the selected 1-8 week window,
// with a best-effort buildable-before/after per assembly: if the incoming
// part is a CURRENT limiting component for that assembly (the stored
// snapshot's own `limitingParts`), recompute what adding its quantity would
// allow; otherwise the part isn't the bottleneck and buildable qty is
// unchanged by its arrival.
export function computeUpcomingUnlocks(jobs: JobSnapshotRow[], week: number, now: number): UpcomingDeliveryEntry[] {
  const { start, end } = weekWindow(week, now);
  const out: UpcomingDeliveryEntry[] = [];
  for (const job of jobs) {
    const byKey = new Map(job.detail.assemblies.map((a) => [a.key, a]));
    for (const u of job.detail.upcoming) {
      const t = new Date(u.expectedDate).getTime();
      if (!Number.isFinite(t) || t < start || t >= end) continue;
      const asm = byKey.get(u.assemblyKey);
      const buildableBefore = asm?.buildableQty ?? null;
      let buildableAfter = buildableBefore;
      if (asm && asm.buildableQty != null) {
        const incoming = u.incomingParts[0];
        const limiting = incoming ? asm.limitingParts.find((lp) => lp.pn === incoming.pn) : undefined;
        if (limiting && incoming) {
          buildableAfter = Math.floor((limiting.available + incoming.qty) / limiting.required);
        }
      }
      out.push({ ...u, buildableBefore, buildableAfter });
    }
  }
  return out.sort((a, b) => a.expectedDate.localeCompare(b.expectedDate));
}

// One row per supplier across every job currently loaded — aggregates the
// same Vendor/PoLineGroup shape job-bom.ts already returns per job, plus the
// blocker entries attributable to that supplier.
export function computeSupplierRisk(jobs: JobSnapshotRow[]): SupplierRiskRow[] {
  const rows = new Map<string, SupplierRiskRow & { daysLateSum: number; daysLateCount: number; assemblyKeys: Set<string>; jobIds: Set<string> }>();

  const get = (name: string) => {
    let r = rows.get(name);
    if (!r) {
      r = { supplier: name, openPOs: 0, partsOutstanding: 0, pastDue: 0, avgDaysLate: null, assembliesBlocked: 0, projectsAffected: 0, materialValue: 0, daysLateSum: 0, daysLateCount: 0, assemblyKeys: new Set(), jobIds: new Set() };
      rows.set(name, r);
    }
    return r;
  };

  for (const job of jobs) {
    for (const v of job.detail.vendors) {
      const r = get(v.name);
      for (const po of v.pos) {
        if (po.received < po.itemCount) {
          r.openPOs++;
          r.partsOutstanding += po.itemCount - po.received;
        }
      }
    }
    for (const b of job.detail.blockers) {
      if (!b.supplier) continue;
      if (b.reason === "supplier_delay" || b.reason === "past_due") {
        const r = get(b.supplier);
        r.pastDue++;
        r.materialValue += b.materialValue;
        r.assemblyKeys.add(`${job.jobId}:${b.assemblyKey}`);
        r.jobIds.add(job.jobId);
        if (b.daysLate != null) {
          r.daysLateSum += b.daysLate;
          r.daysLateCount++;
        }
      }
    }
  }

  return [...rows.values()]
    .map((r) => ({
      supplier: r.supplier,
      openPOs: r.openPOs,
      partsOutstanding: r.partsOutstanding,
      pastDue: r.pastDue,
      avgDaysLate: r.daysLateCount ? Math.round(r.daysLateSum / r.daysLateCount) : null,
      assembliesBlocked: r.assemblyKeys.size,
      projectsAffected: r.jobIds.size,
      materialValue: r.materialValue,
    }))
    .sort((a, b) => b.materialValue - a.materialValue);
}

// 8-week table (deliberately not a Gantt): for each week, how many assemblies
// across every loaded job are expected to become fully buildable BY that
// week (cumulative), how many parts arrive that week, and how many
// PROJECTS reach 100% readiness for the first time that week — all derived
// from each assembly's own `estimatedBuildableDate` (job-bom-rules.ts's
// buildableQtyFor + build-readiness-sync.ts's limiting-parts date rollup),
// never a separately-modeled projection.
export function computeReadinessForecast(jobs: JobSnapshotRow[], now: number): ForecastWeek[] {
  const totalAssemblies = jobs.reduce((s, j) => s + j.detail.assemblies.filter((a) => a.buildableQty !== null).length, 0);
  const alreadyReady = jobs.reduce((s, j) => s + j.detail.assemblies.filter((a) => a.buildableQty !== null && a.buildableQty >= a.requiredQty).length, 0);

  const weeks: ForecastWeek[] = [];
  let cumulative = alreadyReady;
  let prevReadyJobIds = new Set(
    jobs.filter((j) => j.detail.assemblies.every((a) => a.buildableQty === null || a.buildableQty >= a.requiredQty)).map((j) => j.jobId),
  );

  for (let week = 1; week <= 8; week++) {
    const { start, end } = weekWindow(week, now);
    let unlockedThisWeek = 0;
    let partsArriving = 0;

    for (const job of jobs) {
      for (const a of job.detail.assemblies) {
        if (a.buildableQty === null || a.buildableQty >= a.requiredQty) continue;
        if (!a.estimatedBuildableDate) continue;
        const t = new Date(a.estimatedBuildableDate).getTime();
        if (Number.isFinite(t) && t >= start && t < end) unlockedThisWeek++;
      }
      for (const u of job.detail.upcoming) {
        const t = new Date(u.expectedDate).getTime();
        if (Number.isFinite(t) && t >= start && t < end) partsArriving++;
      }
    }

    cumulative += unlockedThisWeek;

    // A job "reaches 100%" the first week every one of its still-blocked/
    // partial assemblies has an estimated buildable date at or before this
    // week's end.
    const readyJobIds = new Set(
      jobs
        .filter((j) => j.detail.assemblies.every((a) => {
          if (a.buildableQty === null || a.buildableQty >= a.requiredQty) return true;
          const t = a.estimatedBuildableDate ? new Date(a.estimatedBuildableDate).getTime() : NaN;
          return Number.isFinite(t) && t < end;
        }))
        .map((j) => j.jobId),
    );
    let projectsReaching100 = 0;
    for (const id of readyJobIds) if (!prevReadyJobIds.has(id)) projectsReaching100++;
    prevReadyJobIds = readyJobIds;

    weeks.push({
      week,
      assembliesBuildableCumulative: Math.min(cumulative, totalAssemblies),
      cumulativeBuildablePct: totalAssemblies ? Math.min(100, Math.round((cumulative / totalAssemblies) * 100)) : 0,
      partsArriving,
      assembliesUnlocked: unlockedThisWeek,
      projectsReaching100,
    });
  }

  return weeks;
}
