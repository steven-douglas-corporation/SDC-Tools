import "server-only";

import { prisma } from "@/lib/prisma";
import { warehouseConfigured, warehouseSnapshot } from "@/lib/data-warehouse";
import { logAudit } from "@/lib/audit";
import { recordChanges, type CellChange } from "@/lib/change-log";
import { normalizeName } from "@/lib/manual-contractor-hours";
import { TEMP_REPORT_KEY, loadTypedInIds } from "@/lib/temp-punches";

// ── Temps the roster has never heard of are added to it (mvest, 2026-10-22) ──
//
// Paylocity's Temp Punches report names everyone who clocked in. A temp is not on the
// Paylocity roster (that is why the report exists), so the roster sync never adds them, and
// until someone typed them onto the Employees page their hours had no person to belong to.
// Now the refresh adds them: a row with no department, so they land on the Employees page's
// "No department" card, under Contractors, like the temps typed in by hand.
//
// Run BEFORE the hours are read (auto-sync.ts), so the same pass already files their
// hours under their new id instead of a pass later under a stand-in.
//
// ── What it will and will not do ─────────────────────────────────────────────
//
//   • It only ever ADDS or fills in an id. It never renames, moves, hides or removes anyone.
//   • A row with that exact name and NO id (someone typed in by hand) is given the id rather
//     than duplicated.
//   • It does not add a name when someone with the SAME LAST NAME is already on the roster:
//     "Mike Pike" in the report against "Morgan Pike" there is far more likely one person
//     with a nickname than two, and a duplicate would split their hours between two people.
//     Those are left for a person (Data Management lists them).
//   • The id is a placeholder, TEMP<next number>, the convention the temps already use,
//     or the report's own Employee Id when it carries one. A placeholder is not a Paylocity
//     ID: Data Management lists it until someone replaces it with the real one on the
//     Employees page. The roster sync links by name only people with NO id, so a temp who
//     later reaches Paylocity's roster must be given their real id by hand, as TEMP1 was.
//
// Never throws: a failure is reported in the returned object and the hours go on.

export type KnownPerson = { id: number; name: string; paylocityId: string | null };
export type TempNameSeen = { name: string; reportId: string | null };

export type TempEmployeePlan = {
  create: { name: string; paylocityId: string; placeholder: boolean }[];
  /** Existing rows with this exact name and no id: given the id instead of being duplicated. */
  adopt: { employeeId: number; name: string; paylocityId: string }[];
  skipped: { name: string; reason: string }[];
};

const lastWord = (name: string) => normalizeName(name).split(/\s+/).filter(Boolean).pop() ?? "";
const TEMP_ID = /^TEMP(\d+)$/i;

/** Pure: who gets added, who gets an id, and who is left for a person. */
export function planTempEmployees(
  seen: readonly TempNameSeen[],
  people: readonly KnownPerson[],
  /** Ids on still-active typed-in timecards, so a new placeholder never reuses one. */
  typedInIds: readonly string[] = [],
): TempEmployeePlan {
  const plan: TempEmployeePlan = { create: [], adopt: [], skipped: [] };

  const inUse = new Set<string>();
  let maxTemp = 0;
  for (const id of [...people.map((p) => p.paylocityId), ...typedInIds]) {
    if (!id) continue;
    inUse.add(id.trim().toLowerCase());
    const m = TEMP_ID.exec(id.trim());
    if (m) maxTemp = Math.max(maxTemp, Number(m[1]));
  }
  const nextId = (reportId: string | null) => {
    if (reportId) {
      inUse.add(reportId.toLowerCase());
      return { id: reportId, placeholder: false };
    }
    maxTemp += 1;
    inUse.add(`temp${maxTemp}`);
    return { id: `TEMP${maxTemp}`, placeholder: true };
  };

  const done = new Set<string>();
  for (const s of seen) {
    const name = s.name.trim();
    const key = normalizeName(name);
    if (!key || done.has(key)) continue;
    done.add(key);

    const sameName = people.filter((p) => normalizeName(p.name) === key);
    if (sameName.some((p) => p.paylocityId)) continue; // known: matched, or ambiguous (reported elsewhere)

    const reportId = s.reportId?.trim() || null;
    if (reportId && inUse.has(reportId.toLowerCase())) {
      plan.skipped.push({ name, reason: `the report's ID ${reportId} already belongs to someone else here` });
      continue;
    }

    if (sameName.length === 1) {
      const { id } = nextId(reportId);
      plan.adopt.push({ employeeId: sameName[0].id, name: sameName[0].name, paylocityId: id });
      continue;
    }
    if (sameName.length > 1) {
      plan.skipped.push({ name, reason: "several people here have this name and no ID" });
      continue;
    }

    const lw = lastWord(name);
    if (lw && people.some((p) => lastWord(p.name) === lw)) {
      plan.skipped.push({ name, reason: `someone with the last name “${lw}” is already on the roster; add them by hand if they are a different person` });
      continue;
    }
    const { id, placeholder } = nextId(reportId);
    plan.create.push({ name, paylocityId: id, placeholder });
  }
  return plan;
}

export type RegisteredTemps = {
  created: string[];
  adopted: string[];
  skipped: { name: string; reason: string }[];
  error: string | null;
};

const NOTHING: RegisteredTemps = { created: [], adopted: [], skipped: [], error: null };

/** Adds the temps in the report that the roster does not have. Never throws. */
export async function registerTempPeople(): Promise<RegisteredTemps> {
  if (!warehouseConfigured()) return NOTHING;
  try {
    const seen = await warehouseSnapshot((q) =>
      q<TempNameSeen>(
        `SELECT DISTINCT "EmployeeName" AS "name", "EmployeeId" AS "reportId"
         FROM "Fact"."JobHours" WHERE "SourceReport" = $1 AND "EmployeeName" IS NOT NULL`,
        [TEMP_REPORT_KEY],
      ),
    );
    if (seen.length === 0) return NOTHING;

    const [people, typedIn] = await Promise.all([
      prisma.employee.findMany({ select: { id: true, name: true, paylocityId: true } }),
      loadTypedInIds(),
    ]);
    const plan = planTempEmployees(seen, people, typedIn.map((t) => t.paylocityId));
    const out: RegisteredTemps = { created: [], adopted: [], skipped: [...plan.skipped], error: null };

    for (const a of plan.adopt) {
      try {
        // Only while the row still has no id: someone may have given it one since the read.
        const r = await prisma.employee.updateMany({ where: { id: a.employeeId, paylocityId: null }, data: { paylocityId: a.paylocityId } });
        if (r.count === 1) {
          out.adopted.push(a.name);
          await logAudit({
            action: "employee.update",
            entityType: "Employee",
            entityId: a.employeeId,
            summary: `Gave ${a.name} the ID ${a.paylocityId} (found in the Temp Punches report)`,
            metadata: { name: a.name, paylocityId: a.paylocityId, source: "temp punches report" },
          });
        }
      } catch (err) {
        out.skipped.push({ name: a.name, reason: `could not save (${err instanceof Error ? err.message : String(err)})` });
      }
    }
    for (const c of plan.create) {
      try {
        const e = await prisma.employee.create({ data: { name: c.name, paylocityId: c.paylocityId, active: true } });
        out.created.push(c.name);
        await logAudit({
          action: "employee.create",
          entityType: "Employee",
          entityId: e.id,
          summary: `Added ${c.name} (${c.paylocityId}) from the Temp Punches report — no one by that name was on the roster`,
          metadata: { name: c.name, paylocityId: c.paylocityId, placeholder: c.placeholder, source: "temp punches report" },
        });
      } catch (err) {
        // A unique-id clash with a concurrent write is the likely one; the next refresh retries with fresh numbers.
        out.skipped.push({ name: c.name, reason: `could not add (${err instanceof Error ? err.message : String(err)})` });
      }
    }

    const added = [...out.created, ...out.adopted];
    if (added.length > 0) {
      const change: CellChange = {
        tab: "Employees",
        rowRef: "Temp Punches report",
        columnName: "Temps added",
        previousValue: null,
        newValue: added.length <= 5 ? added.join(", ") : `${added.length} people`,
        changeType: "added",
        system: true,
      };
      await recordChanges([change]).catch((err: unknown) => console.error("[temp-employees] could not publish the change:", err));
    }
    return out;
  } catch (err) {
    console.error("[temp-employees] could not register the temps:", err);
    return { ...NOTHING, error: err instanceof Error ? err.message : String(err) };
  }
}

/** One sentence for the temp source's step detail; empty when nothing happened. */
export function describeRegisteredTemps(r: RegisteredTemps): string {
  const parts: string[] = [];
  if (r.created.length > 0) parts.push(`added ${r.created.length} to the roster (No department)`);
  if (r.adopted.length > 0) parts.push(`gave ${r.adopted.length} existing person(s) an ID`);
  if (r.skipped.length > 0) parts.push(`${r.skipped.length} left for a person (see Data Management)`);
  if (r.error) parts.push(`could not check the roster for new temps: ${r.error}`);
  return parts.join("; ");
}
