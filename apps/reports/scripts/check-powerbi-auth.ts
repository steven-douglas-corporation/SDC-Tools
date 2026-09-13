/**
 * Power BI app-only preflight — can the service principal query the semantic
 * model without a signed-in user?
 *
 *   npx tsx scripts/check-powerbi-auth.ts
 *
 * Stages, so a failure names the missing step rather than a bare 401:
 *   1. PBI_* env vars present
 *   2. client-credentials token for the Power BI API
 *   3. workspace visible to the SP      (empty list => tenant setting is OFF,
 *                                        or the SP isn't in the workspace)
 *   4. dataset visible
 *   5. executeQueries actually returns rows
 *
 * Read-only: the DAX is a trivial ROW() constant, it touches no tables.
 */
import { ConfidentialClientApplication } from "@azure/msal-node";

const SCOPE = "https://analysis.windows.net/powerbi/api/.default";

function ok(msg: string) { console.log(`  OK    ${msg}`); }
function bad(msg: string) { console.log(`  FAIL  ${msg}`); }

async function main() {
  const { PBI_TENANT_ID, PBI_CLIENT_ID, PBI_CLIENT_SECRET, PBI_WORKSPACE_ID, PBI_DATASET_ID } = process.env;

  console.log("1. PBI_* env vars");
  if (!PBI_TENANT_ID || !PBI_CLIENT_ID || !PBI_CLIENT_SECRET || !PBI_WORKSPACE_ID || !PBI_DATASET_ID) {
    bad("missing one of PBI_TENANT_ID / PBI_CLIENT_ID / PBI_CLIENT_SECRET / PBI_WORKSPACE_ID / PBI_DATASET_ID");
    return;
  }
  ok(`client ${PBI_CLIENT_ID}, workspace ${PBI_WORKSPACE_ID}`);

  console.log("2. client-credentials token (Power BI API)");
  const cca = new ConfidentialClientApplication({
    auth: {
      clientId: PBI_CLIENT_ID,
      clientSecret: PBI_CLIENT_SECRET,
      authority: `https://login.microsoftonline.com/${PBI_TENANT_ID}`,
    },
  });
  let token: string;
  try {
    const r = await cca.acquireTokenByClientCredential({ scopes: [SCOPE] });
    if (!r?.accessToken) throw new Error("no accessToken in the response");
    token = r.accessToken;
    ok("acquired");
  } catch (e) {
    bad(`could not acquire a token: ${e instanceof Error ? e.message : String(e)}`);
    console.log("        Usually a wrong tenant/client id, or an EXPIRED client secret.");
    return;
  }
  const H = { Authorization: `Bearer ${token}` };

  console.log("3. workspace visible to the service principal");
  const wsResp = await fetch(`https://api.powerbi.com/v1.0/myorg/groups/${PBI_WORKSPACE_ID}`, { headers: H });
  if (!wsResp.ok) {
    // 401 with a valid token = the tenant switch, not the workspace role.
    bad(`HTTP ${wsResp.status}: ${(await wsResp.text()).slice(0, 200)}`);
    console.log("        Check BOTH: (a) Fabric admin portal > Tenant settings > Developer");
    console.log("        settings > \"Service principals can use Fabric APIs\" is ON, and");
    console.log("        (b) this app is a member of the workspace.");
    return;
  }
  ok(((await wsResp.json()) as { name?: string }).name ?? PBI_WORKSPACE_ID);

  console.log("4. dataset visible");
  const dsResp = await fetch(
    `https://api.powerbi.com/v1.0/myorg/groups/${PBI_WORKSPACE_ID}/datasets/${PBI_DATASET_ID}`,
    { headers: H }
  );
  if (!dsResp.ok) {
    bad(`HTTP ${dsResp.status}: ${(await dsResp.text()).slice(0, 200)}`);
    return;
  }
  ok(((await dsResp.json()) as { name?: string }).name ?? PBI_DATASET_ID);

  console.log("5. executeQueries");
  const q = await fetch(
    `https://api.powerbi.com/v1.0/myorg/groups/${PBI_WORKSPACE_ID}/datasets/${PBI_DATASET_ID}/executeQueries`,
    {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json" },
      body: JSON.stringify({ queries: [{ query: "EVALUATE ROW(\"probe\", 1)" }], serializerSettings: { includeNulls: true } }),
    }
  );
  if (!q.ok) {
    bad(`HTTP ${q.status}: ${(await q.text()).slice(0, 300)}`);
    console.log("        A 401/403 here (when step 3 passed) usually means the SP needs a");
    console.log("        higher workspace role — Viewer is not enough, use Member/Contributor.");
    return;
  }
  ok(JSON.stringify((await q.json() as { results: unknown[] }).results?.[0]).slice(0, 120));

  console.log("\nApp-only Power BI access works. runDax can drop the delegated token cache.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
