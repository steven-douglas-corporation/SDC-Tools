import "server-only";
import type { WarehouseHiringRow } from "@/lib/hiring-warehouse-parse";

// ── Fake Paylocity job postings, for LOCAL DEVELOPMENT ONLY (docs/DEV-ENVIRONMENT.md) ──
//
// Postings come from the DataWarehouse's "Paylocity"."HiringPosition" view, which a
// dev machine doesn't have, and setting DATAWAREHOUSE_URL would switch hours, temp
// punches and the roster to the warehouse too. So with SDC_DEV_FAKE_HIRING=1,
// readHiringPositionsFromWarehouse returns the rows below instead, and they go
// through the same parsing, team placement and request matching as real ones.
// Production never sets the flag, so none of this runs there.
//
// Hiring managers use the dev seed's roster ids (prisma/seed-dev.ts: 9900xx), so
// postings land on those people's cards. On a roster without them every posting
// is simply Unassigned. Dates are relative to today, so the cases hold over time:
//   • a posting a request turned into (Controls Engineer, published after the request)
//   • a posting older than a matching request, which must NOT close it (Machine Builder)
//   • a Paused posting, which doesn't count toward the totals
//   • a hiring manager outside the delivery teams (Buyer) and one not on the roster (Welder)
//   • Paylocity's evergreen "General Job Posting", which the parser drops

export function devFakeHiringEnabled(): boolean {
  return process.env.SDC_DEV_FAKE_HIRING === "1";
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setHours(9, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

const row = (id: string, title: string, managers: string, published: number, subStatus: string | null = null): WarehouseHiringRow => ({
  hiringJobId: id,
  jobTitle: title,
  hiringDepartment: null,
  hiringManagers: managers,
  jobStatus: "Published",
  jobSubStatus: subStatus,
  publishedAt: daysAgo(published),
});

export function fakeWarehouseHiringRows(): WarehouseHiringRow[] {
  return [
    row("DEV-1001", "Controls Engineer", "Finley DEV-Controls [990006]", 0),
    row("DEV-1002", "Mechanical Design Engineer", "Devon DEV-Mech [990004]", 20),
    row("DEV-1003", "Machine Builder", "Harper DEV-ShopLead [990008]", 40),
    row("DEV-1004", "Electrical Assembler", "Lennon DEV-WireLead [990022]", 10),
    row("DEV-1005", "Field Service Technician", "Jordan DEV-Service [990020]", 15, "Paused"),
    row("DEV-1006", "Project Coordinator", "Rowan DEV-PMLead [990017]", 5),
    row("DEV-1007", "Buyer", "Noel DEV-Buyer [990024]", 30),
    row("DEV-1008", "Welder", "Former DEV-Manager [990999]", 12),
    row("DEV-1009", "General Job Posting", "Peyton DEV-HR [990030]", 200),
  ];
}
