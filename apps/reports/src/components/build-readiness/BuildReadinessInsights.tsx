"use client";

import { useMemo, useState, type ReactNode } from "react";
import { usd } from "@/components/ui/format";
import { useColumnSort } from "@/components/useColumnSort";
import { SortableTh } from "@/components/ui/SortableHeader";
import { sortRows, type SortColumns } from "@/lib/table-sort";
import { ReadinessPill } from "@/components/build-readiness/ReadinessPill";
import { Stat } from "@/components/procurement/PoDetailPanel";
import { type JobSnapshotRow, type BlockerReason, type SupplierRiskRow, BLOCKER_REASON_LABEL } from "@/lib/build-readiness-types";
import { computeUpcomingUnlocks, computeSupplierRisk, computeReadinessForecast, mergeAssemblyInstances } from "@/lib/build-readiness-forecast";
import type { DrillFrame } from "@/components/build-readiness/useDrillStack";
import { useStableNow } from "@/lib/use-stable-now";

function num(n: number): string {
  return Math.round(n).toLocaleString();
}
function fmtDate(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── Card shell — one visual language for every summary card ─────────────────
//
// Ported from JobProcurement.tsx's own risk cards (Delivery Slip / No
// Purchase Order / Upcoming Deliveries — the reference this redesign
// matches): a colored icon badge next to the title, a Stat (label-over-
// value, reused from PoDetailPanel.tsx rather than re-implemented) pinned to
// the header's right edge, and a FIXED body height rather than a `max-h`
// stretch. Fixed, not max, is what makes "cards in the same row are the same
// height" true regardless of how many rows each one's data happens to have —
// a short table doesn't leave its card looking shorter, and a long one
// scrolls internally (`styled-scrollbar`) instead of growing the card.
// Copied rather than imported from JobProcurement.tsx on purpose: that
// component's own header sizing is tuned with `@container` breakpoints for a
// harder problem (3 stats + a button, in a row that can be 1-3 cards wide)
// that these single-stat headers don't have, and duplicating a few small
// classes is lower-risk than reworking an already-delicate, already-shipped
// component to serve a second caller.
type CardTone = "green" | "red" | "yellow" | "blue" | "gray";
const TONE_ICON_CLS: Record<CardTone, string> = {
  green: "bg-sdc-green-bg text-sdc-green-text",
  red: "bg-sdc-red-bg text-sdc-red-text",
  yellow: "bg-sdc-yellow-bg text-sdc-yellow-text",
  blue: "bg-sdc-blue-light text-sdc-blue-dark",
  gray: "bg-sdc-gray-100 text-sdc-gray-600",
};

function SectionCard({
  title,
  icon,
  tone,
  statLabel,
  statValue,
  statTone,
  extra,
  minWidth,
  children,
}: {
  title: string;
  icon: string;
  tone: CardTone;
  statLabel: string;
  statValue: string;
  statTone?: "danger";
  // A second header line — only Upcoming Unlocks' week picker needs this;
  // every other card keeps the compact one-line header, which is what keeps
  // What Can We Build Now and Top Blockers (the only two cards sharing a
  // row) the same height as each other with no measuring involved.
  extra?: ReactNode;
  // Table min-width, so a card squeezed by its row (or a wide table in a
  // 2-up row) scrolls horizontally instead of crushing its own columns — the
  // same `overflow-auto` + `min-w-[…]` pairing the main Project Readiness
  // table already uses.
  minWidth: number;
  children: ReactNode;
}) {
  const twoLineHeader = !!extra;
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-sdc-border bg-white shadow-sm">
      <div className={`flex flex-col justify-center gap-1.5 border-b border-sdc-border-soft bg-sdc-gray-100 px-4 ${twoLineHeader ? "h-20 py-2" : "h-14 py-1.5"}`}>
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 text-note font-bold uppercase tracking-wider text-sdc-navy">
            <span className={`inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded text-xs font-bold ${TONE_ICON_CLS[tone]}`} aria-hidden>
              {icon}
            </span>
            {title}
          </span>
          <Stat label={statLabel} value={statValue} tone={statTone} />
        </div>
        {extra}
      </div>
      <div className="h-[360px] overflow-auto styled-scrollbar">
        <div style={{ minWidth }}>{children}</div>
      </div>
    </div>
  );
}

// ── What Can We Build Now ────────────────────────────────────────────────────

// `assemblyKeys` (plural) — every BOM tree position sharing this part number
// within this job, merged into one row. See mergeAssemblyInstances's own
// header comment (build-readiness-forecast.ts) for why a reused sub-assembly
// design can legitimately produce more than one AssemblyDetail per job, and
// why this card merges them rather than listing each position separately.
type BuildableRow = { jobId: string; jobName: string; assemblyKeys: string[]; label: string; buildableQty: number; requiredQty: number; readinessPct: number; materialValue: number; riskCount: number };
type BuildableSortKey = "job" | "assembly" | "buildable" | "required" | "readiness" | "material" | "risk";
const BUILDABLE_COLUMNS: SortColumns<BuildableRow, BuildableSortKey> = {
  job: { type: "id", value: (r) => r.jobId },
  assembly: { type: "text", value: (r) => r.label },
  buildable: { type: "number", value: (r) => r.buildableQty },
  required: { type: "number", value: (r) => r.requiredQty },
  readiness: { type: "number", value: (r) => r.readinessPct },
  material: { type: "currency", value: (r) => r.materialValue },
  risk: { type: "number", value: (r) => r.riskCount },
};

// Order-independent equality — the same merged row can be reached (and its
// drawer re-opened) regardless of which order its underlying keys happen to
// rebuild in.
function sameKeySet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((k) => b.includes(k));
}

function WhatCanWeBuildNow({ jobs, stack, push }: { jobs: JobSnapshotRow[]; stack: DrillFrame[]; push: (f: DrillFrame) => void }) {
  const sort = useColumnSort<BuildableSortKey>({ key: "material", direction: "desc" });
  const rows = useMemo<BuildableRow[]>(() => {
    const out: BuildableRow[] = [];
    for (const j of jobs) {
      const blockersByAsm = new Map<string, number>();
      for (const b of j.detail.blockers) blockersByAsm.set(b.assemblyKey, (blockersByAsm.get(b.assemblyKey) ?? 0) + 1);

      // Grouped by part number, not by BOM tree position — the same reused
      // sub-assembly design can appear more than once in one job's BOM (see
      // mergeAssemblyInstances's own header comment), and this card asks
      // "what can I build of THIS assembly, across the whole job," not
      // "list every position it occurs at." Falls back to the node's own
      // key when there's no real part number (defensive — every assembly
      // that reaches this card already has buildableQty > 0, which the
      // pn-less "Loose parts" synthetic bucket never does, but grouping by
      // an empty string would otherwise merge unrelated loose-parts buckets
      // from different sections).
      const groups = new Map<string, { label: string; assemblyKeys: string[]; instances: typeof j.detail.assemblies }>();
      for (const a of j.detail.assemblies) {
        if (a.buildableQty == null || a.buildableQty <= 0) continue;
        const groupKey = a.pn || a.key;
        let g = groups.get(groupKey);
        if (!g) {
          g = { label: a.label, assemblyKeys: [], instances: [] };
          groups.set(groupKey, g);
        }
        g.assemblyKeys.push(a.key);
        g.instances.push(a);
      }

      for (const g of groups.values()) {
        const merged = mergeAssemblyInstances(g.instances);
        out.push({
          jobId: j.jobId,
          jobName: j.jobName,
          assemblyKeys: g.assemblyKeys,
          label: g.label,
          // Never actually null here — every instance in `g.instances` was
          // pre-filtered to buildableQty > 0 above, so the merged sum can't
          // be null either; the `?? 0` is only to satisfy BuildableRow's
          // non-nullable type.
          buildableQty: merged.buildableQty ?? 0,
          requiredQty: merged.requiredQty,
          readinessPct: merged.readinessPct,
          materialValue: merged.materialValue,
          riskCount: g.assemblyKeys.reduce((s, k) => s + (blockersByAsm.get(k) ?? 0), 0),
        });
      }
    }
    return out;
  }, [jobs]);
  const sorted = useMemo(() => sortRows(rows, sort.sort, BUILDABLE_COLUMNS), [rows, sort.sort]);

  return (
    <SectionCard title="What Can We Build Now" icon="✓" tone="green" statLabel="Assemblies" statValue={num(rows.length)} minWidth={640}>
      <table className="w-full border-collapse text-left">
        <thead className="sticky top-0 z-[1]">
          <tr className="bg-sdc-navy text-micro font-bold uppercase tracking-wider text-white">
            <SortableTh label="Job" sortKey="job" type="id" sort={sort.sort} onSort={sort.onSort} className="px-3 py-2" />
            <SortableTh label="Assembly" sortKey="assembly" type="text" sort={sort.sort} onSort={sort.onSort} className="px-2 py-2" />
            <SortableTh label="Buildable" sortKey="buildable" type="number" sort={sort.sort} onSort={sort.onSort} className="px-2 py-2" />
            <SortableTh label="Required" sortKey="required" type="number" sort={sort.sort} onSort={sort.onSort} className="px-2 py-2" />
            <SortableTh label="Readiness" sortKey="readiness" type="number" sort={sort.sort} onSort={sort.onSort} className="px-2 py-2" />
            <SortableTh label="Material $" sortKey="material" type="currency" sort={sort.sort} onSort={sort.onSort} className="px-2 py-2" />
            <SortableTh label="Risk" sortKey="risk" type="number" sort={sort.sort} onSort={sort.onSort} className="px-2 py-2" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const open = stack.some((f) => f.kind === "assemblyDetail" && f.jobId === r.jobId && sameKeySet(f.assemblyKeys, r.assemblyKeys));
            return (
              <tr
                key={`${r.jobId}-${r.assemblyKeys.join(",")}`}
                onClick={() => push({ kind: "assemblyDetail", jobId: r.jobId, assemblyKeys: r.assemblyKeys })}
                className={`cursor-pointer border-b border-sdc-border-soft/60 hover:bg-sdc-blue-light/20 ${open ? "bg-sdc-blue-light/40" : ""}`}
              >
                <td className="px-3 py-1.5">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); push({ kind: "assemblies", jobId: r.jobId, filter: "all" }); }}
                    className="font-mono text-note font-semibold text-sdc-blue hover:underline"
                  >
                    {r.jobId}
                  </button>
                </td>
                <td className="px-2 py-1.5 text-note text-sdc-blue hover:underline">{r.label}</td>
                <td className="px-2 py-1.5 text-right font-mono text-note font-semibold tabular-nums text-sdc-green-text">{num(r.buildableQty)}</td>
                <td className="px-2 py-1.5 text-right font-mono text-note tabular-nums text-sdc-gray-600">{num(r.requiredQty)}</td>
                <td className="px-2 py-1.5 text-right">
                  <span className="inline-flex justify-end">
                    <ReadinessPill pct={r.readinessPct} />
                  </span>
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-note tabular-nums">{usd(r.materialValue)}</td>
                {/* Always a real count, never null — 0 prints as 0 (§9). */}
                <td className="px-2 py-1.5 text-right font-mono text-note tabular-nums text-sdc-muted">{num(r.riskCount)}</td>
              </tr>
            );
          })}
          {sorted.length === 0 && (
            <tr><td colSpan={7} className="px-4 py-6 text-center text-xs text-sdc-gray-400">Nothing is buildable right now.</td></tr>
          )}
        </tbody>
      </table>
    </SectionCard>
  );
}

// ── Top Blockers ─────────────────────────────────────────────────────────────

type BlockerGroupRow = { reason: BlockerReason; projects: number; assemblies: number; parts: number; materialValue: number; avgDaysLate: number | null };
type BlockerSortKey = "reason" | "projects" | "assemblies" | "parts" | "material" | "daysLate";
const BLOCKER_COLUMNS: SortColumns<BlockerGroupRow, BlockerSortKey> = {
  reason: { type: "text", value: (r) => BLOCKER_REASON_LABEL[r.reason] },
  projects: { type: "number", value: (r) => r.projects },
  assemblies: { type: "number", value: (r) => r.assemblies },
  parts: { type: "number", value: (r) => r.parts },
  material: { type: "currency", value: (r) => r.materialValue },
  daysLate: { type: "number", value: (r) => r.avgDaysLate },
};

function TopBlockers({ jobs, stack, push }: { jobs: JobSnapshotRow[]; stack: DrillFrame[]; push: (f: DrillFrame) => void }) {
  const sort = useColumnSort<BlockerSortKey>({ key: "material", direction: "desc" });
  const rows = useMemo<BlockerGroupRow[]>(() => {
    const byReason = new Map<BlockerReason, { projects: Set<string>; assemblies: Set<string>; parts: number; materialValue: number; daysLateSum: number; daysLateCount: number }>();
    for (const j of jobs) {
      for (const b of j.detail.blockers) {
        let g = byReason.get(b.reason);
        if (!g) {
          g = { projects: new Set(), assemblies: new Set(), parts: 0, materialValue: 0, daysLateSum: 0, daysLateCount: 0 };
          byReason.set(b.reason, g);
        }
        g.projects.add(j.jobId);
        g.assemblies.add(`${j.jobId}:${b.assemblyKey}`);
        g.parts++;
        g.materialValue += b.materialValue;
        if (b.daysLate != null) {
          g.daysLateSum += b.daysLate;
          g.daysLateCount++;
        }
      }
    }
    return [...byReason.entries()].map(([reason, g]) => ({
      reason,
      projects: g.projects.size,
      assemblies: g.assemblies.size,
      parts: g.parts,
      materialValue: g.materialValue,
      avgDaysLate: g.daysLateCount ? Math.round(g.daysLateSum / g.daysLateCount) : null,
    }));
  }, [jobs]);
  const sorted = useMemo(() => sortRows(rows, sort.sort, BLOCKER_COLUMNS), [rows, sort.sort]);

  return (
    <SectionCard title="Top Blockers" icon="!" tone="red" statLabel="Parts Blocked" statValue={num(rows.reduce((s, r) => s + r.parts, 0))} minWidth={560}>
      <table className="w-full border-collapse text-left">
        <thead className="sticky top-0 z-[1]">
          <tr className="bg-sdc-navy text-micro font-bold uppercase tracking-wider text-white">
            <SortableTh label="Reason" sortKey="reason" type="text" sort={sort.sort} onSort={sort.onSort} className="px-3 py-2" />
            <SortableTh label="Projects" sortKey="projects" type="number" sort={sort.sort} onSort={sort.onSort} className="px-2 py-2" />
            <SortableTh label="Assemblies" sortKey="assemblies" type="number" sort={sort.sort} onSort={sort.onSort} className="px-2 py-2" />
            <SortableTh label="Parts" sortKey="parts" type="number" sort={sort.sort} onSort={sort.onSort} className="px-2 py-2" />
            <SortableTh label="Material $" sortKey="material" type="currency" sort={sort.sort} onSort={sort.onSort} className="px-2 py-2" />
            <SortableTh label="Avg Days Late" sortKey="daysLate" type="number" sort={sort.sort} onSort={sort.onSort} className="px-2 py-2" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const open = stack.some((f) => f.kind === "blockerReason" && f.reason === r.reason);
            return (
              <tr
                key={r.reason}
                onClick={() => push({ kind: "blockerReason", reason: r.reason })}
                className={`cursor-pointer border-b border-sdc-border-soft/60 hover:bg-sdc-blue-light/20 ${open ? "bg-sdc-blue-light/40" : ""}`}
              >
                <td className="px-3 py-1.5 text-note font-semibold text-sdc-blue hover:underline">{BLOCKER_REASON_LABEL[r.reason]}</td>
                <td className="px-2 py-1.5 text-right font-mono text-note tabular-nums">{num(r.projects)}</td>
                <td className="px-2 py-1.5 text-right font-mono text-note tabular-nums">{num(r.assemblies)}</td>
                <td className="px-2 py-1.5 text-right font-mono text-note font-semibold tabular-nums text-sdc-red-text">{num(r.parts)}</td>
                <td className="px-2 py-1.5 text-right font-mono text-note tabular-nums">{usd(r.materialValue)}</td>
                <td className="px-2 py-1.5 text-right font-mono text-note tabular-nums">{r.avgDaysLate != null ? `${r.avgDaysLate}d` : "—"}</td>
              </tr>
            );
          })}
          {sorted.length === 0 && (
            <tr><td colSpan={6} className="px-4 py-6 text-center text-xs text-sdc-gray-400">No blockers across active projects.</td></tr>
          )}
        </tbody>
      </table>
    </SectionCard>
  );
}

// ── Upcoming Unlocks ─────────────────────────────────────────────────────────

function UpcomingUnlocks({ jobs, now, stack, push }: { jobs: JobSnapshotRow[]; now: number; stack: DrillFrame[]; push: (f: DrillFrame) => void }) {
  const [week, setWeek] = useState(1);
  const rows = useMemo(() => computeUpcomingUnlocks(jobs, week, now), [jobs, week, now]);

  return (
    <SectionCard
      title="Upcoming Unlocks"
      icon="→"
      tone="blue"
      statLabel="Expected"
      statValue={num(rows.length)}
      minWidth={860}
      extra={
        <div className="flex flex-wrap items-center gap-1">
          {Array.from({ length: 8 }, (_, i) => i + 1).map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWeek(w)}
              className={`rounded-md px-2 py-1 text-note font-semibold motion-interactive ${w === week ? "bg-sdc-blue text-white" : "bg-sdc-blue-light text-sdc-blue-dark hover:bg-sdc-blue-100"}`}
            >
              {w}W
            </button>
          ))}
        </div>
      }
    >
      <table className="w-full border-collapse text-left">
        <thead className="sticky top-0 z-[1]">
          <tr className="bg-sdc-navy text-micro font-bold uppercase tracking-wider text-white">
            <th className="px-3 py-2">Expected</th>
            <th className="px-2 py-2">PO</th>
            <th className="px-2 py-2">Supplier</th>
            <th className="px-2 py-2">Job</th>
            <th className="px-2 py-2">Incoming</th>
            <th className="px-2 py-2">Assembly</th>
            <th className="px-2 py-2">Buildable</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const open = r.poNumber != null && stack.some((f) => f.kind === "po" && f.jobId === r.jobId && f.poNumber === r.poNumber);
            return (
              <tr key={`${r.jobId}-${r.assemblyKey}-${i}`} className={`border-b border-sdc-border-soft/60 ${open ? "bg-sdc-blue-light/40" : ""}`}>
                <td className="px-3 py-1.5 whitespace-nowrap font-mono text-label text-sdc-gray-600">{fmtDate(r.expectedDate)}</td>
                <td className="px-2 py-1.5 font-mono text-note font-semibold text-sdc-blue">
                  {r.poNumber ? (
                    <button type="button" onClick={() => push({ kind: "po", jobId: r.jobId, supplier: r.supplier, poNumber: r.poNumber! })} title="View PO details" className="cursor-pointer hover:underline">
                      {r.poNumber}
                    </button>
                  ) : (
                    "No PO"
                  )}
                </td>
                <td className="px-2 py-1.5 text-note text-sdc-navy">{r.supplier ?? "—"}</td>
                <td className="px-2 py-1.5">
                  <button type="button" onClick={() => push({ kind: "assemblies", jobId: r.jobId, filter: "all" })} className="font-mono text-note text-sdc-blue hover:underline">
                    {r.jobId}
                  </button>
                </td>
                <td className="px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => push({ kind: "assemblyDetail", jobId: r.jobId, assemblyKeys: [r.assemblyKey], highlightPn: r.incomingParts[0]?.pn })}
                    className="text-note text-sdc-blue hover:underline"
                  >
                    {r.incomingParts.map((p) => `+${p.qty} ${p.pn}`).join(", ")}
                  </button>
                </td>
                <td className="px-2 py-1.5">
                  <button type="button" onClick={() => push({ kind: "assemblyDetail", jobId: r.jobId, assemblyKeys: [r.assemblyKey] })} className="text-note text-sdc-blue hover:underline">
                    {r.assemblyLabel}
                  </button>
                </td>
                <td className="px-2 py-1.5 text-right">
                  <button
                    type="button"
                    onClick={() =>
                      push({
                        kind: "buildableCalc",
                        jobId: r.jobId,
                        assemblyKey: r.assemblyKey,
                        poNumber: r.poNumber,
                        supplier: r.supplier,
                        expectedDate: r.expectedDate,
                        incomingPn: r.incomingParts[0]?.pn ?? "",
                        incomingQty: r.incomingParts[0]?.qty ?? 0,
                        buildableBefore: r.buildableBefore,
                        buildableAfter: r.buildableAfter,
                      })
                    }
                    className="font-mono text-note font-semibold tabular-nums hover:underline"
                  >
                    {r.buildableBefore ?? "—"} → <span className="text-sdc-green-text">{r.buildableAfter ?? "—"}</span>
                  </button>
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr><td colSpan={7} className="px-4 py-6 text-center text-xs text-sdc-gray-400">No parts expected in week {week}.</td></tr>
          )}
        </tbody>
      </table>
    </SectionCard>
  );
}

// ── Supplier Risk ────────────────────────────────────────────────────────────

type SupplierSortKey = "supplier" | "openPOs" | "outstanding" | "pastDue" | "avgDaysLate" | "assemblies" | "projects" | "material";
const SUPPLIER_COLUMNS: SortColumns<SupplierRiskRow, SupplierSortKey> = {
  supplier: { type: "text", value: (r) => r.supplier },
  openPOs: { type: "number", value: (r) => r.openPOs },
  outstanding: { type: "number", value: (r) => r.partsOutstanding },
  pastDue: { type: "number", value: (r) => r.pastDue },
  avgDaysLate: { type: "number", value: (r) => r.avgDaysLate },
  assemblies: { type: "number", value: (r) => r.assembliesBlocked },
  projects: { type: "number", value: (r) => r.projectsAffected },
  material: { type: "currency", value: (r) => r.materialValue },
};

function SupplierRisk({ jobs, stack, push }: { jobs: JobSnapshotRow[]; stack: DrillFrame[]; push: (f: DrillFrame) => void }) {
  const sort = useColumnSort<SupplierSortKey>({ key: "material", direction: "desc" });
  const rows = useMemo(() => computeSupplierRisk(jobs), [jobs]);
  const sorted = useMemo(() => sortRows(rows, sort.sort, SUPPLIER_COLUMNS), [rows, sort.sort]);

  return (
    <SectionCard title="Supplier Risk" icon="!" tone="yellow" statLabel="Suppliers" statValue={num(rows.length)} minWidth={720}>
      <table className="w-full border-collapse text-left">
        <thead className="sticky top-0 z-[1]">
          <tr className="bg-sdc-navy text-micro font-bold uppercase tracking-wider text-white">
            <SortableTh label="Supplier" sortKey="supplier" type="text" sort={sort.sort} onSort={sort.onSort} className="px-3 py-2" />
            <SortableTh label="Open POs" sortKey="openPOs" type="number" sort={sort.sort} onSort={sort.onSort} className="px-2 py-2" />
            <SortableTh label="Outstanding" sortKey="outstanding" type="number" sort={sort.sort} onSort={sort.onSort} className="px-2 py-2" />
            <SortableTh label="Past Due" sortKey="pastDue" type="number" sort={sort.sort} onSort={sort.onSort} className="px-2 py-2" />
            <SortableTh label="Avg Days Late" sortKey="avgDaysLate" type="number" sort={sort.sort} onSort={sort.onSort} className="px-2 py-2" />
            <SortableTh label="Assemblies Blocked" sortKey="assemblies" type="number" sort={sort.sort} onSort={sort.onSort} className="px-2 py-2" />
            <SortableTh label="Projects" sortKey="projects" type="number" sort={sort.sort} onSort={sort.onSort} className="px-2 py-2" />
            <SortableTh label="Material $" sortKey="material" type="currency" sort={sort.sort} onSort={sort.onSort} className="px-2 py-2" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const open = stack.some((f) => f.kind === "supplier" && f.supplier === r.supplier);
            return (
              <tr
                key={r.supplier}
                onClick={() => push({ kind: "supplier", supplier: r.supplier })}
                className={`cursor-pointer border-b border-sdc-border-soft/60 hover:bg-sdc-blue-light/20 ${open ? "bg-sdc-blue-light/40" : ""}`}
              >
                <td className="px-3 py-1.5 text-note font-semibold text-sdc-blue hover:underline">{r.supplier}</td>
                <td className="px-2 py-1.5 text-right font-mono text-note tabular-nums">{num(r.openPOs)}</td>
                <td className="px-2 py-1.5 text-right font-mono text-note tabular-nums">{num(r.partsOutstanding)}</td>
                <td className="px-2 py-1.5 text-right font-mono text-note tabular-nums text-sdc-red-text">{num(r.pastDue)}</td>
                <td className="px-2 py-1.5 text-right font-mono text-note tabular-nums">{r.avgDaysLate != null ? `${r.avgDaysLate}d` : "—"}</td>
                <td className="px-2 py-1.5 text-right font-mono text-note tabular-nums">{num(r.assembliesBlocked)}</td>
                <td className="px-2 py-1.5 text-right font-mono text-note tabular-nums">{num(r.projectsAffected)}</td>
                <td className="px-2 py-1.5 text-right font-mono text-note tabular-nums">{usd(r.materialValue)}</td>
              </tr>
            );
          })}
          {sorted.length === 0 && (
            <tr><td colSpan={8} className="px-4 py-6 text-center text-xs text-sdc-gray-400">No supplier data yet.</td></tr>
          )}
        </tbody>
      </table>
    </SectionCard>
  );
}

// ── 8-Week Readiness Forecast ────────────────────────────────────────────────

function ReadinessForecast({ jobs, now, stack, push }: { jobs: JobSnapshotRow[]; now: number; stack: DrillFrame[]; push: (f: DrillFrame) => void }) {
  const weeks = useMemo(() => computeReadinessForecast(jobs, now), [jobs, now]);
  return (
    <SectionCard title="8-Week Readiness Forecast" icon="▸" tone="gray" statLabel="Weeks" statValue={num(weeks.length)} minWidth={560}>
      <table className="w-full border-collapse text-left">
        <thead className="sticky top-0 z-[1]">
          <tr className="bg-sdc-navy text-micro font-bold uppercase tracking-wider text-white">
            <th className="px-3 py-2">Week</th>
            <th className="px-2 py-2">Assemblies Buildable</th>
            <th className="px-2 py-2">Cumulative %</th>
            <th className="px-2 py-2">Parts Arriving</th>
            <th className="px-2 py-2">Unlocked</th>
            <th className="px-2 py-2">Projects → 100%</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((w) => {
            const open = stack.some((f) => f.kind === "forecastWeek" && f.week === w.week);
            return (
              <tr
                key={w.week}
                onClick={() => push({ kind: "forecastWeek", week: w.week })}
                className={`cursor-pointer border-b border-sdc-border-soft/60 hover:bg-sdc-blue-light/20 ${open ? "bg-sdc-blue-light/40" : ""}`}
              >
                <td className="px-3 py-1.5 font-semibold text-sdc-blue hover:underline">{w.week}W</td>
                <td className="px-2 py-1.5 text-right font-mono text-note tabular-nums">{num(w.assembliesBuildableCumulative)}</td>
                <td className="px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-sdc-gray-100">
                      <div className="h-full rounded-full bg-sdc-green" style={{ width: `${w.cumulativeBuildablePct}%` }} />
                    </div>
                    <span className="font-mono text-note tabular-nums">{w.cumulativeBuildablePct}%</span>
                  </div>
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-note tabular-nums">{num(w.partsArriving)}</td>
                <td className="px-2 py-1.5 text-right font-mono text-note tabular-nums text-sdc-green-text">{num(w.assembliesUnlocked)}</td>
                <td className="px-2 py-1.5 text-right font-mono text-note tabular-nums">{num(w.projectsReaching100)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </SectionCard>
  );
}

export function BuildReadinessInsights({ jobs, push, stack }: { jobs: JobSnapshotRow[]; push: (f: DrillFrame) => void; stack: DrillFrame[] }) {
  const now = useStableNow();
  return (
    <div className="flex flex-col gap-4">
      {/* Row 1 — What Can We Build Now / Top Blockers. Upcoming Unlocks moved
          to its own full-width row below (2026-08-17, by request): its own
          7-column table lost too many columns to a 1/3-width card, worse
          than the vertical space a dedicated row costs it. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <WhatCanWeBuildNow jobs={jobs} stack={stack} push={push} />
        <TopBlockers jobs={jobs} stack={stack} push={push} />
      </div>
      <UpcomingUnlocks jobs={jobs} now={now} stack={stack} push={push} />
      {/* Row 2 — Supplier Risk / 8-Week Readiness Forecast. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SupplierRisk jobs={jobs} stack={stack} push={push} />
        <ReadinessForecast jobs={jobs} now={now} stack={stack} push={push} />
      </div>
    </div>
  );
}
