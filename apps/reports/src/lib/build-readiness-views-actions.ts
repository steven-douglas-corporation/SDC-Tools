"use server";

import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import type { BuildReadinessFilters } from "@/lib/build-readiness-types";

// Build Readiness's own "Views" — same three-tier shape as
// saved-views-actions.ts (Team Default / Shared / private "My views" in
// localStorage), against its own dedicated BuildReadinessSavedView table
// rather than SavedView — see that model's schema comment for why.

export type BuildReadinessViewConfig = { filters: BuildReadinessFilters };
export type BuildReadinessSharedView = { name: string; owner: string | null; config: BuildReadinessViewConfig };

const DEFAULT_ROW = "__default__";

function parseConfig(raw: string): BuildReadinessViewConfig | null {
  try {
    const c = JSON.parse(raw) as BuildReadinessViewConfig;
    if (!c || typeof c !== "object" || typeof c.filters !== "object") return null;
    return c;
  } catch {
    return null;
  }
}

async function currentOwner(): Promise<string | null> {
  const session = await auth();
  return session?.user?.name ?? session?.user?.email ?? null;
}

type RawRow = { name: string; scope: string; owner: string | null; config: string };

export async function listBuildReadinessViews(): Promise<{ default: BuildReadinessSharedView | null; shared: BuildReadinessSharedView[] }> {
  const rows = await prisma.$queryRaw<RawRow[]>`
    SELECT name, scope, owner, config FROM BuildReadinessSavedView WHERE scope IN ('shared', 'default') ORDER BY name ASC
  `;
  let def: BuildReadinessSharedView | null = null;
  const shared: BuildReadinessSharedView[] = [];
  for (const r of rows) {
    const config = parseConfig(r.config);
    if (!config) continue;
    if (r.scope === "default") def = { name: "Team Default", owner: r.owner, config };
    else shared.push({ name: r.name, owner: r.owner, config });
  }
  return { default: def, shared };
}

export async function publishBuildReadinessView(name: string, config: BuildReadinessViewConfig): Promise<void> {
  const clean = name.trim();
  if (!clean) throw new Error("Give the view a name before sharing it.");
  const owner = await currentOwner();
  const json = JSON.stringify(config);
  await prisma.$executeRaw`
    INSERT INTO BuildReadinessSavedView (name, scope, owner, config, createdAt, updatedAt)
    VALUES (${clean}, 'shared', ${owner}, ${json}, ${new Date()}, ${new Date()})
    ON DUPLICATE KEY UPDATE owner = VALUES(owner), config = VALUES(config), updatedAt = ${new Date()}
  `;
  await logAudit({ action: "saved_view.publish", entityType: "BuildReadinessSavedView", entityId: clean, summary: `Shared Build Readiness view "${clean}"` });
  revalidatePath("/build-readiness");
}

export async function deleteBuildReadinessSharedView(name: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM BuildReadinessSavedView WHERE scope = 'shared' AND name = ${name}`;
  await logAudit({ action: "saved_view.delete", entityType: "BuildReadinessSavedView", entityId: name, summary: `Deleted shared Build Readiness view "${name}"` });
  revalidatePath("/build-readiness");
}

export async function setBuildReadinessTeamDefault(config: BuildReadinessViewConfig): Promise<void> {
  const owner = await currentOwner();
  const json = JSON.stringify(config);
  await prisma.$executeRaw`
    INSERT INTO BuildReadinessSavedView (name, scope, owner, config, createdAt, updatedAt)
    VALUES (${DEFAULT_ROW}, 'default', ${owner}, ${json}, ${new Date()}, ${new Date()})
    ON DUPLICATE KEY UPDATE owner = VALUES(owner), config = VALUES(config), updatedAt = ${new Date()}
  `;
  await logAudit({ action: "saved_view.set_default", entityType: "BuildReadinessSavedView", summary: "Set the Build Readiness Team Default view" });
  revalidatePath("/build-readiness");
}

export async function deleteBuildReadinessTeamDefault(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM BuildReadinessSavedView WHERE scope = 'default'`;
  await logAudit({ action: "saved_view.clear_default", entityType: "BuildReadinessSavedView", summary: "Cleared the Build Readiness Team Default view" });
  revalidatePath("/build-readiness");
}
