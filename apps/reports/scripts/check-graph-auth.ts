/**
 * Graph auth preflight — answers "is app-only working yet?" in one command:
 *
 *   npx tsx scripts/check-graph-auth.ts
 *
 * Checks each stage independently so a failure points at the step that's
 * missing, rather than the opaque 401 Graph returns for an ungranted app:
 *   1. Are GRAPH_* env vars present?      (absent → still on the delegated path)
 *   2. Does a client-credentials token issue?
 *   3. Does it carry a Sites/Files APPLICATION role? (empty = consent not granted)
 *   4. Can it resolve the site?           (403/401 here = Sites.Selected granted
 *                                          tenant-wide but not on THIS site)
 *   5. Can it download the hours file?
 *
 * Read-only throughout. See docs/GRAPH-APP-ONLY-SETUP.md for the admin steps.
 */
import { ConfidentialClientApplication } from "@azure/msal-node";

const SITE = "stevendouglascorp.sharepoint.com:/sites/SDC-PowerBIIntegration";
const FILE_PATH = "Project Planner V2/Job Hours Report/Job Hours From Paylocity/Current_Job_Hours.xlsx";

function ok(msg: string) { console.log(`  OK    ${msg}`); }
function bad(msg: string) { console.log(`  FAIL  ${msg}`); }

async function main() {
  const { GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET } = process.env;

  console.log("1. GRAPH_* env vars");
  if (!GRAPH_TENANT_ID || !GRAPH_CLIENT_ID || !GRAPH_CLIENT_SECRET) {
    bad("not set — the app is still using the delegated (DPAPI cache) path.");
    console.log("        Set GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET in .env.");
    return;
  }
  ok(`tenant ${GRAPH_TENANT_ID}, client ${GRAPH_CLIENT_ID}`);

  console.log("2. client-credentials token");
  const cca = new ConfidentialClientApplication({
    auth: {
      clientId: GRAPH_CLIENT_ID,
      clientSecret: GRAPH_CLIENT_SECRET,
      authority: `https://login.microsoftonline.com/${GRAPH_TENANT_ID}`,
    },
  });
  let token: string;
  try {
    const r = await cca.acquireTokenByClientCredential({ scopes: ["https://graph.microsoft.com/.default"] });
    if (!r?.accessToken) throw new Error("no accessToken in the response");
    token = r.accessToken;
    ok("acquired");
  } catch (e) {
    bad(`could not acquire a token: ${e instanceof Error ? e.message : String(e)}`);
    console.log("        Usually a wrong tenant/client id, or an EXPIRED client secret.");
    return;
  }

  console.log("3. application permissions (token `roles` claim)");
  let roles: string[] = [];
  try {
    roles = (JSON.parse(Buffer.from(token.split(".")[1], "base64").toString("utf8")) as { roles?: string[] }).roles ?? [];
  } catch { /* leave empty */ }
  if (!roles.some((r) => /^Sites\.|^Files\./.test(r))) {
    bad(`no Sites/Files role (roles: ${roles.length ? roles.join(", ") : "none"})`);
    console.log("        The admin has not added Sites.Selected + granted admin consent yet.");
    return;
  }
  ok(roles.join(", "));

  const H = { Authorization: `Bearer ${token}` };

  console.log("4. site lookup");
  const siteResp = await fetch(`https://graph.microsoft.com/v1.0/sites/${SITE}`, { headers: H });
  if (!siteResp.ok) {
    bad(`HTTP ${siteResp.status}: ${(await siteResp.text()).slice(0, 200)}`);
    console.log("        With Sites.Selected this means the per-site grant is missing —");
    console.log("        the app needs `read` on the SDC-PowerBIIntegration site itself.");
    return;
  }
  const siteId = ((await siteResp.json()) as { id: string }).id;
  ok(siteId);

  console.log("5. hours file download");
  const dl = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${encodeURI(FILE_PATH)}:/content`,
    { headers: H }
  );
  if (!dl.ok) {
    bad(`HTTP ${dl.status}: ${(await dl.text()).slice(0, 200)}`);
    return;
  }
  ok(`${(await dl.arrayBuffer()).byteLength.toLocaleString()} bytes`);

  console.log("\nApp-only Graph auth is fully working. The sync no longer depends on");
  console.log("an interactive Windows session or the DPAPI token cache.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
