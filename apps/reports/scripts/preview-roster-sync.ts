/**
 * Preview what the hourly Paylocity roster sync WOULD do. Writes nothing.
 *
 *   npx tsx -r ./scripts/shim-server-only.cjs scripts/preview-roster-sync.ts
 *   npx tsx -r ./scripts/shim-server-only.cjs scripts/preview-roster-sync.ts "C:/path/to/Employee_Information.xlsx"
 *
 * With no argument it reads PAYLOCITY_EMPLOYEES_LOCAL_PATH, exactly as the
 * refresh step does. Run it before the first deploy of the sync (the first pass
 * adds everyone in the file), and whenever a pass reports something odd.
 * The rules are in src/lib/paylocity-roster-parse.ts.
 */
import "dotenv/config";
import { previewRosterSync } from "../src/lib/paylocity-roster-sync";
import { describePlan } from "../src/lib/paylocity-roster-parse";
import { prisma } from "../src/lib/prisma";

async function main() {
  const plan = await previewRosterSync(process.argv[2]?.trim() || undefined);
  if ("skip" in plan) {
    console.log(`Skipped: ${plan.skip}`);
    return;
  }

  console.log(`\n${describePlan(plan)}  (${plan.fileActive} active in Paylocity)\n`);

  const section = (title: string, lines: string[]) => {
    if (!lines.length) return;
    console.log(`${title} (${lines.length})`);
    for (const l of lines) console.log(`  ${l}`);
    console.log("");
  };
  section("ADD, hidden", plan.create.map((r) => `${r.name} [${r.paylocityId}]${r.paylocityActive ? "" : "  (inactive in Paylocity)"}${r.positionTitle ? ` — ${r.positionTitle}` : ""}`));
  section("LINK existing app row to its Paylocity id (matched by name)", plan.link.map((l) => `#${l.employeeId} ${l.name} -> [${l.paylocityId}]`));
  section("TITLE", plan.titleChanges.map((t) => `${t.name}: ${t.from ?? "(blank)"} -> ${t.to ?? "(blank)"}`));
  const pidName = new Map(plan.create.map((r) => [r.paylocityId, r.name]));
  section(
    "SUPERVISOR",
    plan.supervisorChanges.map((s) => `${s.name}: ${s.fromName ?? "(none)"} -> ${s.toPaylocityId ? (pidName.get(s.toPaylocityId) ?? `[${s.toPaylocityId}]`) : "(none)"}`),
  );
  section("SKIPPED — name matches more than one app row; set the Paylocity ID by hand", plan.ambiguous.map((a) => `${a.name} [${a.paylocityId}] ~ ${a.candidates.join(", ")}`));
  section("SUPERVISOR NOT FOUND — current supervisor left as is", plan.unresolvedSupervisors.map((u) => `${u.name}: [${u.supervisorPaylocityId}]`));
  console.log("Preview only — nothing was written.");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
