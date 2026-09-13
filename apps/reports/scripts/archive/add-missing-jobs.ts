// One-time creation of jobs found in Project Planner Data Control.xlsx's
// "Estimated Hours" tab with no matching DB record (see
// scripts/verify-quoted-hours.ts's reverse-direction check). Run once,
// then delete or leave as a record of what was added — same convention as
// the other one-time scripts in this folder.
import { prisma } from "@/lib/prisma";
import { isSdcCustomer } from "@/lib/job-filters";

async function main() {
  // Job 1163 (Top Coil Assembly Machine) was already created by an earlier
  // run of this script; only "2025 Service" remains.

  // Excel's "2025 Service" row has no numeric Job#, and the app requires one
  // (createProject's `^\d+$` check) — "2025" itself is already
  // "2025 Spare Parts". Following the app's own precedent for a sibling
  // placeholder bucket (7000 -> 7001), used the next number after the
  // highest existing SDC-internal bucket (10000) instead: 10001.
  const serviceCustomer = "SDC";
  const service = await prisma.job.create({
    data: {
      jobId: "10001",
      jobName: "2025 Service",
      customer: serviceCustomer,
      type: "Custom",
      billable: !isSdcCustomer(serviceCustomer),
      status: "Active",
      startDate: null,
      completeDate: null,
      costQuoted: null,
      costActualHistorical: null,
      source: "manual",
    },
  });
  console.log("Created:", service);
}

main()
  .catch((e) => {
    console.error("FAILED:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
