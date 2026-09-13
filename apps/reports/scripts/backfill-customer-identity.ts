/**
 * scripts/backfill-customer-identity.ts
 *
 * Fills Job.totEtoCompanyId / Job.totEtoAccountId from TotalETO for every job
 * that already exists in this app.
 *
 * WHY IT EXISTS, given syncFromTotalEto() writes the same two columns: that sync
 * only visits projects whose PStatus is 'Sold', and it is a button somebody has
 * to press. Migration 20260831120000 left both columns NULL on all ~250 existing
 * jobs, and until they are populated lib/customer-canonical.ts has no stable
 * source identifier to group on and falls back to name rules — which is safe
 * (nothing over-merges) but leaves the First Solar site records as their own
 * bars, and the reviewed decision was that they roll up.
 *
 * Idempotent, and writes nothing it does not have to: run it as often as you
 * like. Reads TotalETO and writes only these two columns, never `customer` — a
 * manager's manual name edit is not this script's business.
 *
 *   npx tsx -r ./scripts/shim-server-only.cjs scripts/backfill-customer-identity.ts
 *   npx tsx -r ./scripts/shim-server-only.cjs scripts/backfill-customer-identity.ts --dry-run
 *
 * After it runs, scripts/audit-customer-canonical.ts reconciles the result.
 */
import "dotenv/config";
import sql from "mssql";
import { prisma } from "../src/lib/prisma";

const DRY_RUN = process.argv.includes("--dry-run");

// Same connection the app's own TotalETO sync uses. Duplicated rather than
// exported from sync-totaleto.ts because that module is "server-only" and pulls
// in the whole sync; the credentials come from the same .env either way.
const config: sql.config = {
  server: "SERVER-APP1.stevendouglas.local",
  database: "SDC",
  user: process.env.TOTALETO_DB_USER,
  password: process.env.TOTALETO_DB_PASSWORD,
  domain: "stevendouglas",
  port: 1433,
  options: { trustServerCertificate: true, encrypt: false },
  connectionTimeout: 15_000,
  requestTimeout: 30_000,
};

type Row = { ProjectID: number; CompanyID: number | null; AccountID: string | null };

async function main() {
  const pool = await sql.connect(config);
  let rows: Row[];
  try {
    // EVERY project, not just PStatus = 'Sold'. This is a backfill of identity,
    // and a job whose TotalETO project has since moved out of 'Sold' still has
    // the same customer — the app's own status column decides what is active.
    const result = await pool.request().query<Row>(`
      SELECT P.ProjectID, P.CompanyID, C.CAccCustomerID AS [AccountID]
      FROM vwProjects P WITH(NOLOCK)
      LEFT JOIN tblCompany C WITH(NOLOCK) ON C.CompanyID = P.CompanyID
    `);
    rows = result.recordset;
  } finally {
    await pool.close();
  }

  const byProjectId = new Map(rows.map((r) => [String(r.ProjectID), r]));

  const jobs = await prisma.job.findMany({
    select: { jobId: true, customer: true, totEtoCompanyId: true, totEtoAccountId: true },
  });

  let updated = 0;
  let unchanged = 0;
  let noProject = 0;

  for (const job of jobs) {
    const source = byProjectId.get(job.jobId);
    if (!source) {
      // The internal 4000 / 7000 / 10000-series and any job entered by hand.
      // Left NULL on purpose: "TotalETO has no project for this" is a real fact,
      // and customer-canonical.ts handles it with the alias/name rules.
      noProject++;
      continue;
    }
    const companyId = source.CompanyID ?? null;
    const accountId = source.AccountID?.trim() || null;
    if (job.totEtoCompanyId === companyId && job.totEtoAccountId === accountId) {
      unchanged++;
      continue;
    }
    console.log(
      `${job.jobId.padEnd(8)} ${JSON.stringify(job.customer ?? null).padEnd(46)} ` +
        `company ${job.totEtoCompanyId ?? "-"} -> ${companyId ?? "-"}   account ${JSON.stringify(job.totEtoAccountId)} -> ${JSON.stringify(accountId)}`,
    );
    if (!DRY_RUN) {
      await prisma.job.update({
        where: { jobId: job.jobId },
        data: { totEtoCompanyId: companyId, totEtoAccountId: accountId },
      });
    }
    updated++;
  }

  console.log(
    `\n${DRY_RUN ? "[dry run] would update" : "updated"} ${updated} job(s); ${unchanged} already correct; ` +
      `${noProject} with no TotalETO project (left NULL).`,
  );
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
