/**
 * Transcribes the supplied July/August 2026 contractor Paylocity timecards into
 * ManualContractorPunch, one row per punch SEGMENT.
 *
 * Run:  npx tsx -r ./scripts/shim-server-only.cjs scripts/seed-manual-contractor-punches.ts
 *       (add --dry to print the reconciliation without writing)
 *
 * ── Rules this file obeys ───────────────────────────────────────────────────
 *
 * • NOTHING is estimated. `hours` is computed from in/out below, never typed, and
 *   never entered as a daily or monthly total.
 * • The lunch gap is not paid: it is simply the space between two segments, so it
 *   is excluded by construction rather than subtracted.
 * • A day where the transfer CHANGES is several rows. 08:00-12:00 job A,
 *   12:30-15:30 job A, 15:30-16:30 job B is 7h on A and 1h on B — never 8h on A.
 * • Only JULY and AUGUST work dates are seeded. Pay-period names are irrelevant
 *   to that: Lahu's 07/01-07/03 sit on a period starting 06/21 and ARE included;
 *   the June days on that same card are not (out of the requested scope — see the
 *   note at the bottom, they are transcribed but inactive).
 * • Transfer codes are parsed as FUNCTION/JOB/PHASE[/LOCATION] and then run
 *   through the app's own normalizers, exactly as a workbook punch is. No
 *   contractor-specific mapping exists anywhere.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!process.env[m[1]]) process.env[m[1]] = v;
}

import { prisma } from "@/lib/prisma";
import { parseTransferCode } from "@/lib/manual-contractor-punch-parse";

type Seg = [inTime: string, outTime: string, transfer: string];
type Day = { date: string; segs: Seg[] };
type Card = { employeeName: string; employeeRef: string; paylocityId: string; payPeriod: string; days: Day[] };

/** The overwhelmingly common shape: 4h, unpaid lunch, 4h, same transfer. */
const standardDay = (date: string, transfer: string): Day => ({
  date,
  segs: [
    ["08:00", "12:00", transfer],
    ["12:30", "16:30", transfer],
  ],
});

// ─────────────────────────────────────────────────────────────────────────────
// Vijayan, Vipin [Temp3]
// ─────────────────────────────────────────────────────────────────────────────
const VIPIN = { employeeName: "Vipin Vijayan", employeeRef: "Temp3", paylocityId: "100600" };
const C = "211/1158/10/Concord"; // the transfer he is on for most of the period
const N = "211/1158/10"; // same job, no location segment printed

const VIPIN_CARDS: Card[] = [
  {
    ...VIPIN,
    payPeriod: "2026-08-16..2026-08-29",
    days: [
      { date: "2026-08-17", segs: [["08:35", "12:35", C], ["13:05", "17:27", C]] },
      { date: "2026-08-18", segs: [["08:09", "12:09", C], ["12:39", "17:05", C]] },
      { date: "2026-08-19", segs: [["07:54", "11:54", C], ["12:24", "17:24", C]] },
      { date: "2026-08-20", segs: [["08:17", "12:17", C], ["12:47", "17:25", C]] },
      { date: "2026-08-21", segs: [["07:25", "11:25", C], ["11:55", "17:07", C]] },
      { date: "2026-08-24", segs: [["08:28", "12:28", C], ["12:58", "17:05", C]] },
      { date: "2026-08-25", segs: [["07:37", "11:37", C], ["12:07", "16:19", C]] },
      { date: "2026-08-26", segs: [["07:25", "11:25", C], ["11:55", "16:32", C]] },
      { date: "2026-08-27", segs: [["07:51", "11:51", C], ["12:21", "16:26", C]] },
      { date: "2026-08-28", segs: [["08:00", "12:00", N], ["12:30", "17:29", N]] },
    ],
  },
  {
    ...VIPIN,
    payPeriod: "2026-08-02..2026-08-15",
    days: [
      { date: "2026-08-03", segs: [["08:16", "12:16", N], ["12:46", "17:19", N]] },
      { date: "2026-08-04", segs: [["07:54", "11:54", C], ["12:24", "17:18", C]] },
      { date: "2026-08-05", segs: [["07:47", "11:47", C], ["12:17", "16:57", C]] },
      { date: "2026-08-06", segs: [["07:38", "11:38", C], ["12:08", "16:44", C]] },
      { date: "2026-08-07", segs: [["07:54", "11:54", C], ["12:24", "17:23", C]] },
      { date: "2026-08-10", segs: [["07:36", "11:36", C], ["12:06", "17:25", C]] },
      { date: "2026-08-11", segs: [["07:45", "11:45", C], ["12:15", "17:10", C]] },
      { date: "2026-08-12", segs: [["08:03", "12:03", C], ["12:33", "17:07", C]] },
      { date: "2026-08-13", segs: [["07:45", "11:45", C], ["12:15", "16:42", C]] },
      { date: "2026-08-14", segs: [["07:51", "11:51", C], ["12:21", "17:02", C]] },
    ],
  },
  {
    ...VIPIN,
    payPeriod: "2026-07-19..2026-08-01",
    days: [
      standardDay("2026-07-20", C),
      standardDay("2026-07-21", C),
      { date: "2026-07-22", segs: [["08:00", "12:00", C], ["12:30", "17:15", C]] },
      { date: "2026-07-23", segs: [["07:30", "11:30", C], ["12:00", "16:30", C]] },
      { date: "2026-07-24", segs: [["08:00", "12:00", C], ["12:30", "16:00", C]] },
      { date: "2026-07-27", segs: [["10:15", "12:00", N], ["12:30", "18:45", N]] },
      { date: "2026-07-28", segs: [["07:50", "12:00", N], ["12:30", "16:20", N]] },
      { date: "2026-07-29", segs: [["07:43", "12:00", N], ["12:30", "16:07", N]] },
      // Three segments: a one-minute punch, then the rest of the morning, then
      // the afternoon. All the same transfer; the 09:34-09:39 gap is not paid.
      { date: "2026-07-30", segs: [["09:33", "09:34", N], ["09:39", "12:00", N], ["12:30", "18:15", N]] },
      { date: "2026-07-31", segs: [["07:44", "11:44", C], ["12:14", "17:17", C]] },
    ],
  },
  {
    ...VIPIN,
    payPeriod: "2026-07-05..2026-07-18",
    days: [
      // Multi-job days. Each segment carries the transfer active FOR THAT SEGMENT.
      { date: "2026-07-07", segs: [["08:00", "12:00", "211/1145/40"], ["12:30", "15:30", "211/1145/40"], ["15:30", "16:30", "211/1118/40"]] },
      { date: "2026-07-08", segs: [["08:00", "09:30", "211/1145/40"], ["09:30", "13:30", "211/1118/40"], ["14:00", "16:30", "211/1118/40"]] },
      { date: "2026-07-09", segs: [["08:00", "12:00", "211/7000/80"], ["12:30", "13:30", "211/7000/80"], ["13:30", "14:30", "211/1118/40"], ["14:30", "16:30", "211/1104/40"]] },
      { date: "2026-07-10", segs: [["08:00", "12:00", "211/7000/80"], ["12:30", "15:30", "211/7000/80"]] },
      { date: "2026-07-13", segs: [["08:00", "11:00", "211/1118/40"], ["11:00", "14:30", "211/7000/80"], ["14:30", "16:30", "211/1135/40"]] },
      { date: "2026-07-14", segs: [["08:00", "12:00", N], ["12:30", "14:30", N]] },
      { date: "2026-07-15", segs: [["08:00", "12:00", N], ["12:30", "14:30", N]] },
      standardDay("2026-07-16", N),
      { date: "2026-07-17", segs: [["08:00", "12:00", N], ["12:30", "15:30", N]] },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Tarlekar, Kedar [Temp2] — function 312 (System Design & Drawings)
// ─────────────────────────────────────────────────────────────────────────────
const KEDAR = { employeeName: "Kedar Tarlekar", employeeRef: "Temp2", paylocityId: "100700" };
const K60 = "312/1160/10";

const KEDAR_CARDS: Card[] = [
  {
    ...KEDAR,
    payPeriod: "2026-08-16..2026-08-29",
    days: [
      { date: "2026-08-17", segs: [["03:35", "07:35", K60], ["08:05", "14:05", K60]] },
      { date: "2026-08-18", segs: [["03:58", "07:58", K60], ["08:28", "15:00", K60]] },
      { date: "2026-08-19", segs: [["02:44", "06:44", "312/1131/10"], ["07:14", "12:18", "312/1131/10"]] },
      { date: "2026-08-20", segs: [["06:57", "10:57", K60], ["11:27", "16:25", K60]] },
      { date: "2026-08-24", segs: [["03:33", "07:33", "312/1158/10"], ["08:03", "13:32", "312/1158/10"]] },
      { date: "2026-08-25", segs: [["03:42", "07:42", "312/1158/10"], ["08:12", "12:27", "312/1158/10"]] },
      { date: "2026-08-26", segs: [["03:41", "07:41", "312/1158/10"], ["08:11", "13:39", "312/1158/10"]] },
      { date: "2026-08-27", segs: [["02:39", "06:39", "312/1158/10"], ["07:09", "13:14", "312/1158/10"]] },
      { date: "2026-08-28", segs: [["03:04", "07:04", "312/1158/10"], ["07:34", "13:41", "312/1158/10"]] },
    ],
  },
  {
    ...KEDAR,
    payPeriod: "2026-08-02..2026-08-15",
    days: [
      standardDay("2026-08-05", K60),
      standardDay("2026-08-06", K60),
      standardDay("2026-08-07", K60),
      { date: "2026-08-10", segs: [["06:10", "10:10", K60], ["10:40", "14:44", K60]] },
      { date: "2026-08-11", segs: [["02:47", "06:47", K60], ["07:17", "13:14", K60]] },
      { date: "2026-08-12", segs: [["03:32", "07:32", K60], ["08:02", "12:47", K60]] },
      { date: "2026-08-13", segs: [["02:50", "06:50", K60], ["07:20", "13:37", K60]] },
      { date: "2026-08-14", segs: [["04:24", "08:24", K60], ["08:54", "13:12", K60]] },
    ],
  },
  {
    ...KEDAR,
    payPeriod: "2026-07-19..2026-08-01",
    days: ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24", "2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31"].map((d) =>
      standardDay(d, K60),
    ),
  },
  {
    ...KEDAR,
    payPeriod: "2026-07-05..2026-07-18",
    days: [
      standardDay("2026-07-13", K60),
      standardDay("2026-07-14", K60),
      // Four segments, three jobs.
      { date: "2026-07-15", segs: [["08:00", "12:00", K60], ["12:30", "14:30", K60], ["14:30", "16:00", "312/1146/10"], ["16:00", "16:30", "312/1147/10"]] },
      standardDay("2026-07-16", K60),
      standardDay("2026-07-17", K60),
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Shedole, Lahu [Temp1] — function 211
// ─────────────────────────────────────────────────────────────────────────────
// No Employee row existed for Lahu at all (the other two do, with real Paylocity
// ids). The seed creates one, and the id below is a STRING placeholder marked as
// temporary — see §6 of the request and the dedup note in
// lib/manual-contractor-hours.ts for what happens when Paylocity issues a real one.
const LAHU = { employeeName: "Lahu Shedole", employeeRef: "Temp1", paylocityId: "TEMP1" };
const L58 = "211/1158/10";
const L60 = "211/1160/10";
const L63 = "211/1163/10";
const L68 = "211/1168/10";

const LAHU_CARDS: Card[] = [
  {
    ...LAHU,
    payPeriod: "2026-08-16..2026-08-29",
    days: [
      { date: "2026-08-17", segs: [["02:37", "06:37", L68], ["07:07", "13:51", L68]] },
      standardDay("2026-08-18", L63),
      { date: "2026-08-19", segs: [["03:25", "07:25", L63], ["07:55", "13:52", L63]] },
      { date: "2026-08-20", segs: [["04:15", "08:15", L63], ["08:45", "14:13", L63]] },
      { date: "2026-08-21", segs: [["02:41", "06:41", L63], ["07:11", "12:10", L63]] },
      standardDay("2026-08-24", L63),
      { date: "2026-08-25", segs: [["02:45", "06:45", L63], ["07:15", "12:36", L63]] },
      { date: "2026-08-26", segs: [["02:46", "06:46", L63], ["07:16", "13:36", L63]] },
      { date: "2026-08-27", segs: [["02:43", "06:43", "211/1145/10"], ["07:13", "14:04", "211/1145/10"]] },
    ],
  },
  {
    ...LAHU,
    payPeriod: "2026-08-02..2026-08-15",
    days: [
      { date: "2026-08-04", segs: [["03:07", "07:07", "211/1159/10"], ["07:37", "13:28", "211/1159/10"]] },
      { date: "2026-08-05", segs: [["03:01", "07:01", "211/1159/10"], ["07:31", "12:31", "211/1159/10"]] },
      { date: "2026-08-06", segs: [["05:43", "09:43", L68], ["10:13", "14:23", L68]] },
      { date: "2026-08-07", segs: [["00:16", "04:16", L68], ["04:46", "11:57", L68]] },
      standardDay("2026-08-10", L68),
      { date: "2026-08-11", segs: [["03:09", "07:09", L68], ["07:39", "12:33", L68]] },
      { date: "2026-08-12", segs: [["02:34", "06:34", L68], ["07:04", "13:52", L68]] },
      { date: "2026-08-13", segs: [["03:05", "07:05", L68], ["07:35", "14:14", L68]] },
      { date: "2026-08-14", segs: [["03:03", "07:03", L68], ["07:33", "14:06", L68]] },
    ],
  },
  {
    ...LAHU,
    payPeriod: "2026-07-19..2026-08-01",
    days: [
      ...["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24"].map((d) => standardDay(d, L60)),
      ...["2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31"].map((d) => standardDay(d, L58)),
    ],
  },
  {
    ...LAHU,
    payPeriod: "2026-07-05..2026-07-18",
    days: [
      ...["2026-07-06", "2026-07-08", "2026-07-09", "2026-07-10", "2026-07-13", "2026-07-14", "2026-07-15"].map((d) => standardDay(d, L58)),
      // The transfer changes over lunch: morning on 1158, afternoon on 1160.
      { date: "2026-07-16", segs: [["08:00", "12:00", L58], ["12:30", "16:30", L60]] },
      standardDay("2026-07-17", L60),
    ],
  },
  {
    ...LAHU,
    // The card starts in June, but reporting groups by WORK DATE — so July 1-3
    // belong to July and are included here. The June days on the same card
    // (06/22-06/26) are outside the requested July/August scope and are
    // deliberately NOT seeded; see the note printed at the end of this script.
    payPeriod: "2026-06-21..2026-07-04",
    days: [
      // Transfer changes over lunch: morning 1158, afternoon 1154.
      { date: "2026-07-01", segs: [["08:00", "12:00", L58], ["12:30", "16:30", "211/1154/10"]] },
      standardDay("2026-07-02", L58),
      standardDay("2026-07-03", L58),
    ],
  },
];

const CARDS = [...VIPIN_CARDS, ...KEDAR_CARDS, ...LAHU_CARDS];

/** Minutes since midnight. Times are as printed on the card, local wall clock. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    throw new Error(`Bad time "${hhmm}"`);
  }
  return h * 60 + m;
}

/**
 * Segment duration in hours. Derived — never transcribed.
 *
 * Rounded to 2dp because that is the grain the whole pipeline stores: every hours
 * column in this schema is Decimal(10,2) (JobHoursDetail.hours,
 * JobMonthlyActualHours.hours, EtcEntry.hoursWorked). Keeping 4dp here produced a
 * source of truth the app could not represent, and the reconciliation broke by
 * exactly that: Lahu's August was 172.7666 at the source and 172.76 once stored,
 * a 0.01 gap with nowhere to go. Six of his segments are odd-minute (07:07-13:51
 * is 6.7333h).
 *
 * 2dp is also how Paylocity itself reports hours, so rounding here makes the
 * manual source agree with the official one it will eventually be replaced by,
 * rather than being marginally more precise than anything downstream can hold.
 */
function segmentHours(inTime: string, outTime: string): number {
  const mins = toMinutes(outTime) - toMinutes(inTime);
  if (mins <= 0) throw new Error(`Segment ${inTime}-${outTime} is not positive — check the transcription`);
  return Math.round((mins / 60) * 100) / 100;
}

type Row = {
  employeeName: string;
  employeeRef: string;
  paylocityId: string;
  workDate: string;
  transferRaw: string;
  jobNumber: string;
  machineSec: string;
  functionId: string;
  location: string;
  startTime: string;
  endTime: string;
  hours: number;
  payPeriod: string;
};

function buildRows(): Row[] {
  const out: Row[] = [];
  for (const card of CARDS) {
    for (const day of card.days) {
      if (!/^2026-(07|08)-\d\d$/.test(day.date)) {
        throw new Error(`${card.employeeName} ${day.date}: only July/August 2026 work dates are in scope`);
      }
      for (const [inTime, outTime, transfer] of day.segs) {
        const parsed = parseTransferCode(transfer);
        if (!parsed) throw new Error(`Unparseable transfer "${transfer}" (${card.employeeName} ${day.date})`);
        out.push({
          employeeName: card.employeeName,
          employeeRef: card.employeeRef,
          paylocityId: card.paylocityId,
          workDate: day.date,
          transferRaw: transfer,
          jobNumber: parsed.jobNumber,
          machineSec: parsed.machineSec,
          functionId: parsed.functionId,
          location: parsed.location,
          startTime: inTime,
          endTime: outTime,
          hours: segmentHours(inTime, outTime),
          payPeriod: card.payPeriod,
        });
      }
    }
  }
  return out;
}

async function main() {
  const dry = process.argv.includes("--dry");
  const rows = buildRows();

  // ── Reconciliation, printed BEFORE anything is written ────────────────────
  const f = (n: number) => n.toFixed(2).padStart(9);
  const byEmpMonth = new Map<string, number>();
  const byEmpMonthJob = new Map<string, number>();
  const bySection = new Map<string, number>();
  for (const r of rows) {
    const month = r.workDate.slice(0, 7);
    byEmpMonth.set(`${r.employeeName}|${month}`, (byEmpMonth.get(`${r.employeeName}|${month}`) ?? 0) + r.hours);
    const k = `${r.employeeName}|${month}|${r.jobNumber}`;
    byEmpMonthJob.set(k, (byEmpMonthJob.get(k) ?? 0) + r.hours);
    const s = `${r.machineSec}-${r.functionId}`;
    bySection.set(s, (bySection.get(s) ?? 0) + r.hours);
  }

  console.log(`Transcribed ${rows.length} punch segments across ${new Set(rows.map((r) => `${r.employeeName}|${r.workDate}`)).size} employee-days\n`);
  console.log("── Hours by employee and month ──");
  for (const [k, v] of [...byEmpMonth].sort()) console.log(`  ${k.replace("|", "  ").padEnd(32)}${f(v)}`);
  console.log(`  ${"TOTAL".padEnd(32)}${f(rows.reduce((a, r) => a + r.hours, 0))}`);

  console.log("\n── Hours by employee, month and job ──");
  for (const [k, v] of [...byEmpMonthJob].sort()) {
    const [name, month, job] = k.split("|");
    console.log(`  ${name.padEnd(18)}${month}  job ${job.padEnd(6)}${f(v)}`);
  }

  console.log("\n── Hours by standardized section (phase-function) ──");
  for (const [k, v] of [...bySection].sort()) console.log(`  ${k.padEnd(12)}${f(v)}`);

  if (dry) {
    console.log("\n--dry: nothing written.");
    return;
  }

  // Lahu has no Employee row; without one the punch drill cannot name him and the
  // dedup has nothing to resolve against. Created idempotently.
  const lahu = await prisma.$queryRaw<{ id: number }[]>`SELECT id FROM Employee WHERE name = 'Lahu Shedole' LIMIT 1`;
  if (lahu.length === 0) {
    await prisma.$executeRaw`
      INSERT INTO Employee (name, paylocityId, department, active, createdAt, updatedAt)
      VALUES ('Lahu Shedole', 'TEMP1', 'Mechanical Engineering', true, NOW(3), NOW(3))
    `;
    console.log("\nCreated Employee row for Lahu Shedole (paylocityId TEMP1).");
  } else {
    console.log("\nEmployee row for Lahu Shedole already exists — left alone.");
  }

  // $executeRaw, not the typed client: `prisma generate` cannot run while a server
  // holds node_modules/.prisma open, so ManualContractorPunch has no generated
  // type yet (the same standing constraint RolePermission lives with).
  let written = 0;
  for (const r of rows) {
    await prisma.$executeRaw`
      INSERT INTO ManualContractorPunch
        (employeeName, employeeRef, paylocityId, workDate, transferRaw, jobNumber, machineSec, functionId,
         location, startTime, endTime, hours, source, payPeriod, active, createdByEmail, createdAt)
      VALUES
        (${r.employeeName}, ${r.employeeRef}, ${r.paylocityId}, ${r.workDate}, ${r.transferRaw}, ${r.jobNumber},
         ${r.machineSec}, ${r.functionId}, ${r.location}, ${r.startTime}, ${r.endTime}, ${r.hours},
         'manual_contractor_timecard', ${r.payPeriod}, true, 'akamuju@sdcautomation.com', NOW(3))
      ON DUPLICATE KEY UPDATE
        hours = VALUES(hours), transferRaw = VALUES(transferRaw), payPeriod = VALUES(payPeriod),
        location = VALUES(location), employeeName = VALUES(employeeName), active = true
    `;
    written++;
  }
  console.log(`\nWrote ${written} segments (insert-or-update on the segment key, so re-running is safe).`);
  console.log(
    "\nNOTE: Lahu's card for 2026-06-21..2026-07-04 also shows 06/22-06/26 (5 standard days).\n" +
      "Those are JUNE work dates, outside the requested July/August scope, and were NOT seeded.\n" +
      "Say the word and they can be added — the seed is idempotent.",
  );
}

main().finally(() => prisma.$disconnect());
