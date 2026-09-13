import { ConfidentialClientApplication, PublicClientApplication, type AccountInfo } from "@azure/msal-node";
import { DataProtectionScope, PersistenceCreator, PersistenceCachePlugin } from "@azure/msal-node-extensions";
import path from "path";
import os from "os";

// Delegated auth via the well-known, pre-consented Azure PowerShell public
// client ID — no app registration or admin consent needed. Reuses the same
// token cache the `sdc-powerbi-mcp.exe` CLI (N:\MCP_SERVERS\Powerbi MCP)
// already created, so a machine that's run that tool's `login` command once
// doesn't need to log in again here. Queries run as the signed-in user, so
// row-level security is honored.
const CLIENT_ID = "1950a258-227b-4e31-a9cf-717495945fc2";
const SCOPES = ["https://analysis.windows.net/powerbi/api/.default"];
const CACHE_PATH = path.join(os.homedir(), "AppData", "Local", "SdcPowerBiMcp", "msal_cache.bin");

const PBI_GROUP_ID = process.env.PBI_WORKSPACE_ID;
const PBI_DATASET_ID = process.env.PBI_DATASET_ID;

// The on-disk MSAL cache at CACHE_PATH is shared by every process that talks
// to Power BI on this machine — this app's dev/prod server plus any one-off
// script (scripts/*.ts all import this module directly). @azure/msal-node-
// extensions serializes access with a companion .lockfile, but two of its
// failure paths have no retry of their own and surface as hard errors on a
// transient collision instead of settling on their own:
//   - CrossPlatformLock.unlock() straight-up throws on a Windows EBUSY when
//     it can't unlink the lockfile because another process's handle to it
//     hasn't closed yet (confirmed live 2026-07-17: a verification script
//     and a browser-triggered Sync History both hit the cache within ~1s of
//     each other and this fired).
//   - PersistenceCreator.createPersistence()'s own verification step (write
//     a probe value, read it back) can read back a DIFFERENT process's probe
//     under concurrent first-use, throwing CachePersistenceError (reproduced
//     directly: 6 processes starting at once, most bursts saw several fail
//     this way).
// Both are `PersistenceError` instances (@azure/msal-node-extensions doesn't
// export the class, hence the duck-typed check) representing transient
// shared-file contention, not a real auth/config problem — safe to retry.
function isTransientPersistenceError(err: unknown): boolean {
  return err instanceof Error && err.name === "PersistenceError";
}

async function withCacheContentionRetry<T>(fn: () => Promise<T>, attempts = 5, delayMs = 300): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientPersistenceError(err) || attempt >= attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

let pcaPromise: Promise<PublicClientApplication> | null = null;

async function getPca(): Promise<PublicClientApplication> {
  if (!pcaPromise) {
    // Assigned before the async work settles, so a rejection has to clear
    // this back to null itself — otherwise every later call in this process
    // just re-awaits the same permanently-rejected promise forever (confirmed
    // live: one transient CachePersistenceError at startup, and Power BI sync
    // stayed broken for the rest of the process's life until restarted).
    pcaPromise = withCacheContentionRetry(async () => {
      const persistence = await PersistenceCreator.createPersistence({
        cachePath: CACHE_PATH,
        dataProtectionScope: DataProtectionScope.CurrentUser,
        serviceName: "SdcPowerBiMcp",
        accountName: "SdcPowerBiMcp",
        usePlaintextFileOnLinux: false,
      });
      return new PublicClientApplication({
        auth: { clientId: CLIENT_ID, authority: "https://login.microsoftonline.com/organizations" },
        cache: { cachePlugin: new PersistenceCachePlugin(persistence) },
      });
    }).catch((err) => {
      pcaPromise = null;
      throw err;
    });
  }
  return pcaPromise;
}

async function getAccount(pca: PublicClientApplication): Promise<AccountInfo> {
  const accounts = await pca.getTokenCache().getAllAccounts();
  if (accounts.length === 0) {
    throw new Error(
      "No cached Power BI login found. Run `sdc-powerbi-mcp.exe login` once " +
        "(N:\\MCP_SERVERS\\Powerbi MCP\\publish\\win-x64) to authenticate this machine."
    );
  }
  return accounts[0];
}

// ── App-only (client credentials) — the service-safe path ────────────────────
// Preferred when the PBI_* service-principal vars are set. No user, no session,
// no DPAPI cache on disk: the token is fetched per process and held in memory,
// so this survives Windows session 0, running as a service, and reboots — none
// of which the delegated cache above can (see job-hours-source.ts for the same
// treatment and the outage it caused).
//
// Verified live 2026-07-29 with the "SDC Sheet" registration
// (6ec09511-0e91-4354-b7cc-2eb735a02ba6 = PBI_CLIENT_ID): workspace visible,
// dataset visible, executeQueries returned real rows (30,924 from 'Hours
// Actual'). It already works because that SP is an Admin on the SDC Reports
// workspace AND the tenant's "service principals can use Fabric APIs" switch is
// on — both prerequisites, neither of them something this code can check for.
//
// One semantic difference worth knowing: delegated queries run AS the signed-in
// user, so row-level security applies. A service principal has no user identity,
// so RLS does not filter it — it sees the whole model. Fine for the ETC rollups
// this app reads; relevant if anything user-scoped is ever added.
let ccaPromise: ConfidentialClientApplication | null = null;

function appOnlyConfigured(): boolean {
  return Boolean(process.env.PBI_TENANT_ID && process.env.PBI_CLIENT_ID && process.env.PBI_CLIENT_SECRET);
}

async function getAppOnlyToken(): Promise<string> {
  if (!ccaPromise) {
    ccaPromise = new ConfidentialClientApplication({
      auth: {
        clientId: process.env.PBI_CLIENT_ID!,
        clientSecret: process.env.PBI_CLIENT_SECRET!,
        authority: `https://login.microsoftonline.com/${process.env.PBI_TENANT_ID}`,
      },
    });
  }
  const result = await ccaPromise.acquireTokenByClientCredential({ scopes: SCOPES });
  if (!result?.accessToken) throw new Error("Failed to acquire an app-only Power BI token.");
  return result.accessToken;
}

async function getAccessToken(): Promise<string> {
  // App-only first. On any failure — expired secret, the tenant switch turned
  // back off, the SP removed from the workspace — fall back to the delegated
  // cache rather than taking the sync down, and log why so a regression is
  // visible instead of silent.
  if (appOnlyConfigured()) {
    try {
      return await getAppOnlyToken();
    } catch (err) {
      console.warn(
        `[powerbi-client] app-only auth failed, falling back to the delegated token cache: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
  return getDelegatedAccessToken();
}

// ── Delegated (cached interactive login) — the legacy path ───────────────────
async function getDelegatedAccessToken(): Promise<string> {
  const pca = await getPca();
  const account = await withCacheContentionRetry(() => getAccount(pca));
  const result = await withCacheContentionRetry(() => pca.acquireTokenSilent({ account, scopes: SCOPES }));
  if (!result) throw new Error("Failed to acquire Power BI access token silently.");
  return result.accessToken;
}

// Runs a DAX query (e.g. "EVALUATE ...") against the Job Hours Report -
// Management Level semantic model and returns the rows as plain objects,
// with the "[Table Name]" column-name brackets stripped.
export async function runDax(dax: string): Promise<unknown[]> {
  if (!PBI_GROUP_ID || !PBI_DATASET_ID) {
    throw new Error("PBI_WORKSPACE_ID and PBI_DATASET_ID must be set in the environment.");
  }
  const token = await getAccessToken();
  const url = `https://api.powerbi.com/v1.0/myorg/groups/${PBI_GROUP_ID}/datasets/${PBI_DATASET_ID}/executeQueries`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      queries: [{ query: dax }],
      serializerSettings: { includeNulls: true },
    }),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Power BI executeQueries failed (HTTP ${resp.status}): ${text}`);
  }

  const parsed = JSON.parse(text);
  const rows: Record<string, unknown>[] = parsed?.results?.[0]?.tables?.[0]?.rows ?? [];
  return rows.map((row) => {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      const cleanKey = key.length > 1 && key.startsWith("[") && key.endsWith("]") && key.indexOf("[", 1) < 0
        ? key.slice(1, -1)
        : key;
      clean[cleanKey] = value;
    }
    return clean;
  });
}
