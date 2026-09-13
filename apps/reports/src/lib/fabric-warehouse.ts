import sql from "mssql";
import { ConfidentialClientApplication } from "@azure/msal-node";

// Direct read access to the SDC Fabric Data Warehouse — the SAME store the
// Power BI semantic model imports from. Reading it here lets the app source
// ETC/Standard-Fees history without going through Power BI's dataset (and its
// fragile scheduled refresh / gateway / credential chain). Uses the existing
// Power BI service principal (verified 2026-07-19 it can read this warehouse)
// with a database-scoped token.
//
// Connection string is the workspace's SQL analytics endpoint, from the
// semantic model's own Sql.Database() source (committed TMDL).
const SERVER = "ixt2ry3uwdpureqiskgh3zw4yy-hhghvviya5guhil4cjq5swsnda.database.fabric.microsoft.com";
const DATABASE = "SDC-DataWarehouse-16d09d69-e06b-4e00-94b9-be7ccf8f2b1f";
const SCOPE = "https://database.windows.net/.default";

let cca: ConfidentialClientApplication | null = null;

async function getToken(): Promise<string> {
  if (!cca) {
    cca = new ConfidentialClientApplication({
      auth: {
        clientId: process.env.PBI_CLIENT_ID!,
        clientSecret: process.env.PBI_CLIENT_SECRET!,
        authority: `https://login.microsoftonline.com/${process.env.PBI_TENANT_ID}`,
      },
    });
  }
  const result = await cca.acquireTokenByClientCredential({ scopes: [SCOPE] });
  if (!result?.accessToken) throw new Error("Failed to acquire Fabric warehouse access token.");
  return result.accessToken;
}

// ETC period dimension: one row per monthly ETC period. Name is "Apr 2026",
// Key is a YYYYMM-style int (e.g. 202605). Sorted ascending by key so the
// immediately-previous period is the prior array element.
export type EtcPeriod = { key: number; name: string };
export async function getEtcPeriods(): Promise<EtcPeriod[]> {
  const rows = await queryWarehouse<{ Key: number; Name: string }>(`SELECT [Key], [Name] FROM [dbo].[EstimateToClosePeriod] ORDER BY [Key]`);
  return rows.map((r) => ({ key: r.Key, name: r.Name }));
}

// The 13 ETC section columns in EstimateToClose (plus PartCost), each holding
// the submitted New ETC value for that job/period/section.
export const ESTIMATE_TO_CLOSE_SECTIONS = [
  "10-211", "10-312", "10-313", "10-515", "10-516", "10-517", "10-518", "10-411", "10-412", "40-211", "40-411", "50-211", "50-411",
] as const;

export type EstimateToCloseRow = { periodKey: number; jobId: string } & Record<string, number>;

// Every submitted ETC snapshot: one row per (period, job) with a column per
// section + PartCost. Job Id normalized to the app's un-padded string form.
export async function getEstimateToClose(): Promise<EstimateToCloseRow[]> {
  const cols = [...ESTIMATE_TO_CLOSE_SECTIONS].map((c) => `[${c}]`).join(", ");
  const rows = await queryWarehouse<Record<string, unknown>>(
    `SELECT EstimateToClosePeriodKey, JobID, ${cols}, PartCost FROM [dbo].[EstimateToClose]`
  );
  return rows.map((r) => {
    const out: EstimateToCloseRow = { periodKey: Number(r.EstimateToClosePeriodKey), jobId: String(Number(r.JobID)) } as EstimateToCloseRow;
    for (const c of ESTIMATE_TO_CLOSE_SECTIONS) out[c] = Number(r[c] ?? 0);
    out.PartCost = Number(r.PartCost ?? 0);
    return out;
  });
}

// Runs a read-only query against the warehouse and returns the rows. Opens and closes
// a fresh pool per call — these syncs run on a slow cadence, so pooling isn't worth the
// added lifecycle complexity.
//
// ── Why a dedicated ConnectionPool and not the global one (2026-09-03) ──────
//
// This used to call mssql's `connect()`, which is not "a fresh pool per call" — it is
// ONE GLOBAL pool for the process. That function begins `if (!globalConnection)`, so
// the config below was applied only if this happened to be the first query in the
// process and was otherwise DISCARDED: this function would be handed whatever pool
// already existed and run Fabric warehouse SQL against Total ETO, or the reverse.
// Different server, different database, different auth (an Azure AD access token here,
// NTLM there), different encrypt setting — silently swapped.
//
// The `close()` below made it worse in the other direction: it closed the global pool,
// aborting any Total ETO query in flight elsewhere. That is the bug documented in
// lib/totaleto-connection.ts, which is where it was found.
//
// A dedicated pool is what the comment above always claimed, and it makes the two
// systems incapable of reaching each other's connections.
export async function queryWarehouse<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const token = await getToken();
  const pool = await new sql.ConnectionPool({
    server: SERVER,
    port: 1433,
    database: DATABASE,
    authentication: { type: "azure-active-directory-access-token", options: { token } },
    options: { encrypt: true },
    connectionTimeout: 30000,
    requestTimeout: 120000,
  } as sql.config).connect();
  try {
    const result = await pool.request().query(query);
    return result.recordset as T[];
  } finally {
    await pool.close();
  }
}
