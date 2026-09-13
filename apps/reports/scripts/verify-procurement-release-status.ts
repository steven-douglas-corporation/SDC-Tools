import "dotenv/config";
import { getJobBom } from "../src/lib/job-bom";
import type { BomNode, BomPart } from "../src/lib/job-bom";

// Live, re-runnable proof for the release-status / coverage / LPP rework of the
// procurement BOM (2026-08-11). Reads the real Total ETO database and checks the
// properties the requirement is written in terms of.
//
//   npx tsx scripts/verify-procurement-release-status.ts [jobId …]
//
// Default jobs: 1116 (Pat's example, and the job the SDC Standard Project BOM
// report page 3 of 26 was pulled from) plus a few others, since the rule has to
// hold universally and not just for the job it was demonstrated on.
//
// The 1116 assertions come from the reference report and from the tables directly:
//   · 1116-DB-000 LEFT PICK CONVEYOR is BOMAssemblyReleaseID 2 (Assembly Only),
//     bought whole on PO 101563 at $1,430 — so it must appear exactly once as a
//     requirement, and its subcomponents (089-D-001 CONVEYOR FOOT, 1116-DBA-000
//     CONVEYOR DRIVE ASSY, 1116-DBB-000 SDC CONVEYOR, 995-DA-015-1/2 BOWL FEEDER
//     EXIT RAIL) must appear nowhere in the requirement list.
//   · 1116-DCB-000 RETURN CONVEYOR is also Assembly Only (LastCost $2,744.23).
//   · No requirement may be reported uncovered while an inventory pull or a
//     process schedule covers it.

const ASSEMBLY_ONLY_1116 = ["1116-DB-000", "1116-DCB-000"];
const MUST_NOT_APPEAR_1116 = [
  "089-D-001",
  "1116-DBA-000",
  "1116-DBB-000",
  "995-DA-015-1",
  "995-DA-015-2",
];

type Flat = { part: BomPart; parent: string; section: string };

function flatten(roots: BomNode[]): Flat[] {
  const out: Flat[] = [];
  const walk = (n: BomNode, section: string, parent: string) => {
    if (n.self) out.push({ part: n.self, parent, section });
    for (const p of n.parts) out.push({ part: p, parent: n.pn, section });
    for (const c of n.children) walk(c, section, n.pn);
  };
  for (const sec of roots) {
    const label = `${sec.id} ${sec.desc}`.trim();
    for (const p of sec.parts) out.push({ part: p, parent: "", section: label });
    for (const c of sec.children) walk(c, label, String(sec.id));
  }
  return out;
}

const usd = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  if (ok) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function report(jobId: string) {
  console.log(`\n${"═".repeat(78)}\nJob ${jobId}\n${"═".repeat(78)}`);
  const bom = await getJobBom(jobId);
  if (bom.roots.length === 0) {
    console.log("  (no BOM rows — skipped)");
    return;
  }

  const flat = flatten(bom.roots);
  const unique = new Map<number, Flat>();
  for (const f of flat) if (!unique.has(f.part.id)) unique.set(f.part.id, f);
  const parts = [...unique.values()].map((f) => f.part);

  const by = (pred: (p: BomPart) => boolean) => parts.filter(pred).length;
  console.log(
    `  ${bom.rowCount} BOM edges → ${parts.length} unique requirements · ` +
      `${by((p) => p.status === "received")} received · ${by((p) => p.status === "ordered")} committed · ` +
      `${by((p) => p.status === "noPO")} uncovered`,
  );
  console.log(
    `  coverage: ${by((p) => p.source === "po")} PO · ${by((p) => p.source === "stock")} inventory · ` +
      `${by((p) => p.source === "process")} process schedule · ${by((p) => p.source === "none")} nothing`,
  );
  console.log(
    `  pricing: ${by((p) => p.costBasis === "po")} PO price · ${by((p) => p.costBasis === "pull")} pull price · ` +
      `${by((p) => p.costBasis === "bom")} BOM line · ${by((p) => p.costBasis === "lastCost")} last cost (LPP) · ` +
      `${by((p) => p.costBasis === "listCost")} list · ${by((p) => p.costBasis === "none")} unpriced`,
  );
  console.log(`  materials ${usd(bom.grandTotalCost)}`);

  const assemblies = parts.filter((p) => p.isAssembly);
  if (assemblies.length) {
    console.log(`  assemblies bought as one item (${assemblies.length}):`);
    for (const a of assemblies.slice(0, 12)) {
      console.log(
        `    ${a.pn.padEnd(22)} ${a.release === "assemblyOnly" ? "Assembly Only" : "Both Assembly and Contents"}` +
          ` · ${usd(a.unitPrice)} (${a.costBasis}) · ${a.status}${a.poId ? ` · PO ${a.poId}` : ""}`,
      );
    }
    if (assemblies.length > 12) console.log(`    … +${assemblies.length - 12} more`);
  }

  // ── Universal invariants ───────────────────────────────────────────────────

  // 1. Nothing beneath an Assembly-Only purchase is a separate requirement. The
  //    structural form of that: a node for an Assembly-Only item must not exist
  //    anywhere in the tree, because a node is exactly what exposes contents.
  let assemblyOnlyNodes = 0;
  const scan = (n: BomNode) => {
    if (n.release === "assemblyOnly") assemblyOnlyNodes++;
    n.children.forEach(scan);
  };
  bom.roots.forEach((r) => r.children.forEach(scan));
  check(assemblyOnlyNodes === 0, "no Assembly Only item is exploded into a node", `${assemblyOnlyNodes} found`);

  // 2. Uncovered means uncovered: no PO, no pull, no process schedule.
  const wrongUncovered = parts.filter((p) => p.status === "noPO" && p.source !== "none");
  check(
    wrongUncovered.length === 0,
    "nothing covered by inventory/process is reported uncovered",
    wrongUncovered.length ? wrongUncovered.slice(0, 5).map((p) => p.pn).join(", ") : "",
  );

  // 3. A part with a PO is never reported as having no PO.
  const wrongNoPo = parts.filter((p) => p.status === "noPO" && p.poQty > 0);
  check(wrongNoPo.length === 0, "nothing with PO quantity is reported uncovered", wrongNoPo.map((p) => p.pn).join(", "));

  // 4. Every requirement that has any price at all is priced.
  const unpriced = parts.filter((p) => p.unitPrice === 0);
  console.log(`  note: ${unpriced.length} requirement(s) have no price anywhere (PO, pull, BOM line, item master)`);

  // 5. Cost rolls up consistently: the grand total equals the sum over unique
  //    requirements is NOT expected (shared parts appear under each parent, by
  //    design) — but no node's cost may be negative or NaN.
  let badCost = 0;
  const costScan = (n: BomNode) => {
    if (!Number.isFinite(n.totalCost) || n.totalCost < 0) badCost++;
    n.children.forEach(costScan);
  };
  bom.roots.forEach(costScan);
  check(badCost === 0, "every node's material cost is a finite, non-negative figure");

  // ── Job 1116: Pat's example, against the reference report ──────────────────
  if (jobId === "1116") {
    const seen = new Map<string, BomPart[]>();
    for (const p of parts) {
      const arr = seen.get(p.pn);
      if (arr) arr.push(p);
      else seen.set(p.pn, [p]);
    }
    for (const pn of ASSEMBLY_ONLY_1116) {
      const hits = seen.get(pn) ?? [];
      check(hits.length === 1, `${pn} is exactly one requirement`, `${hits.length} found`);
      const h = hits[0];
      if (h) {
        check(h.release === "assemblyOnly", `${pn} carries Assembly Only`, h.release);
        check(h.unitPrice > 0, `${pn} is priced`, `${usd(h.unitPrice)} via ${h.costBasis}`);
      }
    }
    for (const pn of MUST_NOT_APPEAR_1116) {
      check(!seen.has(pn), `${pn} is inside an Assembly Only purchase and is not a separate requirement`);
    }
    const db = seen.get("1116-DB-000")?.[0];
    if (db) {
      // The reference report's own figure for this line.
      check(Math.abs(db.unitPrice - 1430) < 0.005, "1116-DB-000 prices at the report's $1,430.00", usd(db.unitPrice));
    }
  }
}

async function main() {
  const jobs = process.argv.slice(2).length ? process.argv.slice(2) : ["1116", "1101", "1122", "1079"];
  for (const j of jobs) await report(j);
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
