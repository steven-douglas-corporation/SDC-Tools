// Baseline dataset for LOCAL DEVELOPMENT. Run with `npm run db:seed-dev`.
//
// Gives a fresh Docker database enough shape to open every page: one login per
// role, a small roster with a reporting line, jobs of each type, estimated and
// worked hours across several months, and ETC months that are locked behind the
// current open one. It is deliberately small and deterministic — the same rows
// every run — so a bug found on it can be reproduced by anyone.
//
// For bigger or more specific data, see docs/DEV-TEST-DATA.md.
//
// Idempotent: safe to run repeatedly. Rows it owns are rewritten; anything else
// in the database is left alone. Every seeded name carries a "DEV" marker so it
// can never be mistaken for a real person or job.
//
// SAFETY: refuses to run against anything but a loopback database. A seed script
// that can be pointed at production by a copy-pasted .env is a data-loss bug
// waiting to happen.
import { Prisma, PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";

let host = "";
try {
  host = new URL(process.env.DATABASE_URL ?? "").hostname;
} catch {
  /* reported below */
}
if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) {
  console.error(`Refusing to seed: DATABASE_URL host is "${host || "(unset)"}", not localhost.`);
  console.error("This script only runs against the local Docker database. See docs/DEV-ENVIRONMENT.md.");
  process.exit(1);
}

const prisma = new PrismaClient();

// Deterministic PRNG (mulberry32) so every run produces identical hours.
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261005);
const round2 = (n: number) => Math.round(n * 100) / 100;

const PASSWORD = "devpass123";

const USERS: { email: string; name: string; role: Role }[] = [
  { email: "elt@dev.local", name: "Dev ELT", role: "ELT" },
  { email: "manager@dev.local", name: "Dev Manager", role: "MANAGER" },
  { email: "pm@dev.local", name: "Dev PM", role: "PM" },
  { email: "sales@dev.local", name: "Dev Sales", role: "SALES" },
  { email: "all@dev.local", name: "Dev All", role: "ALL" },
];

// team = Scheduler discipline code (see src/lib/employee-teams.ts).
const EMPLOYEES: { id: string; name: string; department: string; team: string | null; title: string; boss: string | null }[] = [
  { id: "D001", name: "Avery DEV-Director", department: "Engineering", team: null, title: "Director of Engineering", boss: null },
  { id: "D002", name: "Blake DEV-PM", department: "Project Management", team: "pm", title: "Project Manager", boss: "D001" },
  { id: "D003", name: "Casey DEV-PM", department: "Project Management", team: "pm", title: "Project Manager", boss: "D001" },
  { id: "D004", name: "Devon DEV-Mech", department: "Engineering", team: "mech", title: "Mechanical Engineer", boss: "D001" },
  { id: "D005", name: "Emery DEV-Mech", department: "Engineering", team: "mech", title: "Sr Mechanical Engineer", boss: "D001" },
  { id: "D006", name: "Finley DEV-Controls", department: "Engineering", team: "controls", title: "Controls Engineer", boss: "D001" },
  { id: "D007", name: "Gray DEV-Controls", department: "Engineering", team: "controls", title: "Controls Engineer", boss: "D001" },
  { id: "D008", name: "Harper DEV-ShopLead", department: "Shop", team: "build", title: "Build Lead", boss: null },
  { id: "D009", name: "Indy DEV-Builder", department: "Shop", team: "build", title: "Machine Builder", boss: "D008" },
  { id: "D010", name: "Jules DEV-Builder", department: "Shop", team: "build", title: "Machine Builder", boss: "D008" },
  { id: "D011", name: "Kai DEV-Electrician", department: "Shop", team: "wire", title: "Electrician", boss: "D008" },
  { id: "D012", name: "Lane DEV-Electrician", department: "Shop", team: "wire", title: "Electrician", boss: "D008" },
];

const JOBS = [
  { jobId: "9001", jobName: "DEV Custom Assembly Cell", customer: "Acme DEV Co", type: "Custom", status: "Active", costQuoted: 1850000, billable: true },
  { jobId: "9002", jobName: "DEV Duplicate Line", customer: "Acme DEV Co", type: "Duplicate", status: "Active", costQuoted: 920000, billable: true },
  { jobId: "9003", jobName: "DEV Hybrid Tester", customer: "Globex DEV", type: "Hybrid", status: "Active", costQuoted: 1240000, billable: true },
  { jobId: "9004", jobName: "DEV Packaging Station", customer: "Initech DEV", type: "Custom", status: "Active", costQuoted: 640000, billable: true },
  { jobId: "9005", jobName: "DEV Service Callout", customer: "Globex DEV", type: "Service", status: "Active", costQuoted: 38000, billable: true },
  { jobId: "9006", jobName: "DEV Finished Cell", customer: "Initech DEV", type: "Custom", status: "Complete", costQuoted: 710000, billable: true },
  { jobId: "9900", jobName: "DEV Internal Non-Billable", customer: "SDC DEV Internal", type: "Custom", status: "Active", costQuoted: 0, billable: false },
];

// Sections the ETC grid knows (src/lib/sections.ts), grouped by who works them.
const ENG_SECTIONS = ["10-111", "10-211", "10-312", "10-313"];
const SHOP_SECTIONS = ["10-411", "10-412", "10-413"];
const SECTIONS = [...ENG_SECTIONS, ...SHOP_SECTIONS];

function monthKey(offsetFromNow: number): string {
  const d = new Date();
  const m = new Date(d.getFullYear(), d.getMonth() + offsetFromNow, 1);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`;
}

function workDays(month: string): Date[] {
  const [y, m] = month.split("-").map(Number);
  const out: Date[] = [];
  for (let day = 1; day <= 31; day++) {
    const d = new Date(Date.UTC(y, m - 1, day));
    if (d.getUTCMonth() !== m - 1) break;
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d);
  }
  return out;
}

async function main() {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  const roster = new Map<string, number>();
  for (const e of EMPLOYEES) {
    const data = { name: e.name, department: e.department, team: e.team, positionTitle: e.title, active: true };
    const row = await prisma.employee.upsert({ where: { paylocityId: e.id }, update: data, create: { paylocityId: e.id, ...data } });
    roster.set(e.id, row.id);
  }
  for (const e of EMPLOYEES) {
    await prisma.employee.update({ where: { id: roster.get(e.id)! }, data: { supervisorId: e.boss ? roster.get(e.boss)! : null } });
  }

  for (const u of USERS) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: { name: u.name, role: u.role, passwordHash, active: true },
      create: { ...u, passwordHash },
    });
  }

  const months = [monthKey(-3), monthKey(-2), monthKey(-1), monthKey(0)];
  const lockedMonths = months.slice(0, 3);
  const jobRows = new Map<string, number>();

  for (const j of JOBS) {
    const row = await prisma.job.upsert({
      where: { jobId: j.jobId },
      update: j,
      create: { ...j, source: "manual", startDate: new Date(`${months[0]}-01`) },
    });
    jobRows.set(j.jobId, row.id);
  }

  for (const j of JOBS.filter((x) => x.billable && x.status === "Active")) {
    const jobPk = jobRows.get(j.jobId)!;
    // Reset what this seed owns for the job so reruns converge on the same rows.
    await prisma.jobHoursDetail.deleteMany({ where: { jobId: jobPk } });
    await prisma.jobMonthlyActualHours.deleteMany({ where: { jobId: jobPk } });
    await prisma.etcEntry.deleteMany({ where: { jobId: jobPk } });

    const punches: Prisma.JobHoursDetailCreateManyInput[] = [];
    const monthTotals = new Map<string, number>();

    for (const section of SECTIONS) {
      const isEng = ENG_SECTIONS.includes(section);
      const workers = isEng ? ["D004", "D005", "D006", "D007", "D002"] : ["D009", "D010", "D011", "D012"];
      const quoted = round2(80 + rand() * 500);
      const perMonth = new Map<string, number>();

      for (const mo of lockedMonths) {
        let total = 0;
        for (const d of workDays(mo)) {
          if (rand() < 0.65) continue; // not every section is worked every day
          const hours = round2(1 + rand() * 7);
          total += hours;
          punches.push({
            jobId: jobPk, section, month: mo, workDate: d, employeeId: workers[Math.floor(rand() * workers.length)], hours,
            rawSection: section.split("-")[0], rawFunction: section.split("-")[1],
            standardDepartment: isEng ? "Engineering" : "Shop", standardTaskDescription: "Dev seed", mappingStatus: "Mapped", source: "dev-seed",
          });
        }
        perMonth.set(mo, round2(total));
        monthTotals.set(mo, (monthTotals.get(mo) ?? 0) + total);
      }

      const done = [...perMonth.values()].reduce((a, b) => a + b, 0);
      const remaining = round2(Math.max(quoted - done, 0));
      await prisma.estimatedHours.upsert({
        where: { jobId_section: { jobId: jobPk, section } },
        update: { quotedHours: quoted, actualHistoricalHours: round2(done), estimateToCompleteHours: remaining },
        create: { jobId: jobPk, section, quotedHours: quoted, actualHistoricalHours: round2(done), estimateToCompleteHours: remaining },
      });

      // ETC chain: each month's prior is the previous month's confirmed value.
      // Three months locked (submitted), the current month open (needsReview).
      let prior = round2(remaining + done * 0.4);
      for (const mo of months) {
        const hoursWorked = perMonth.get(mo) ?? 0;
        const left = round2(Math.max(prior - hoursWorked, 0));
        const locked = lockedMonths.includes(mo);
        await prisma.etcEntry.create({
          data: { jobId: jobPk, section, month: mo, priorEtc: prior, hoursWorked, hoursLeftCalc: left, newEtc: left, needsReview: !locked, submittedAt: locked ? new Date() : null },
        });
        prior = left;
      }
    }

    await prisma.jobHoursDetail.createMany({ data: punches });
    for (const [mo, h] of monthTotals) {
      await prisma.jobMonthlyActualHours.create({ data: { jobId: jobPk, month: mo, actualHours: round2(h), source: "dev-seed" } });
    }
  }

  console.log(`Seeded ${USERS.length} users, ${EMPLOYEES.length} employees, ${JOBS.length} jobs.`);
  console.log(`ETC months: ${lockedMonths.join(", ")} locked; ${months[3]} open.`);
  console.log(`Sign in with ${USERS.map((u) => u.email).join(", ")}  /  password: ${PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
