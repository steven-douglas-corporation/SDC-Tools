"use server";

import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// A saved Projects-grid view — the URL state (columns + filters + the Actuals
// toggle). Mirrors the Scheduler's shared column-views. `params` are the raw /quoted
// query values; empty/absent keys simply aren't stored.
//
// `grid` is a GRAVEYARD FIELD, kept deliberately. It held this tab's own row height
// and column width, which §45 replaced with one application-wide zoom that a view does
// not carry. Views published before that are rows in the database and JSON blobs in
// people's browsers, and both still contain it. Declaring it (deprecated) means such a
// view still parses and re-publishes without a type error, while nothing reads or
// writes it — dropping the field outright would make `parseConfig`'s cast lie about
// what is in the JSON.
export type ViewConfig = {
  params: Record<string, string>;
  /** @deprecated Retired with the Grid Size steppers (§45). Read from old views, never written. */
  grid?: { rowPy?: number; colPx?: number } | null;
  actuals?: boolean;
};

export type SharedView = { name: string; owner: string | null; config: ViewConfig };

const DEFAULT_ROW = "__default__"; // the single team-default row's `name`

function parseConfig(raw: string): ViewConfig | null {
  try {
    const c = JSON.parse(raw) as ViewConfig;
    if (!c || typeof c !== "object" || typeof c.params !== "object") return null;
    return c;
  } catch {
    return null;
  }
}

async function currentOwner(): Promise<string | null> {
  const session = await auth();
  return session?.user?.name ?? session?.user?.email ?? null;
}

// Everyone loads these at page render: the one pinned team default (if set)
// and every published/shared view, newest name-sorted on the client.
export async function listSharedViews(): Promise<{ default: SharedView | null; shared: SharedView[] }> {
  const rows = await prisma.savedView.findMany({
    where: { scope: { in: ["shared", "default"] } },
    orderBy: { name: "asc" },
  });
  let def: SharedView | null = null;
  const shared: SharedView[] = [];
  for (const r of rows) {
    const config = parseConfig(r.config);
    if (!config) continue;
    if (r.scope === "default") def = { name: "Team Default", owner: r.owner, config };
    else shared.push({ name: r.name, owner: r.owner, config });
  }
  return { default: def, shared };
}

// Publish a view team-wide (or overwrite one of the same name). Upserts on the
// (scope, name) unique key so re-publishing the same name updates it in place.
export async function publishView(name: string, config: ViewConfig): Promise<void> {
  const clean = name.trim();
  if (!clean) throw new Error("Give the view a name before sharing it.");
  const owner = await currentOwner();
  await prisma.savedView.upsert({
    where: { scope_name: { scope: "shared", name: clean } },
    create: { scope: "shared", name: clean, owner, config: JSON.stringify(config) },
    update: { owner, config: JSON.stringify(config) },
  });
  await logAudit({ action: "saved_view.publish", entityType: "SavedView", entityId: clean, summary: `Shared Projects view “${clean}”` });
  revalidatePath("/quoted");
}

export async function deleteSharedView(name: string): Promise<void> {
  await prisma.savedView.deleteMany({ where: { scope: "shared", name } });
  await logAudit({ action: "saved_view.delete", entityType: "SavedView", entityId: name, summary: `Deleted shared Projects view “${name}”` });
  revalidatePath("/quoted");
}

// The single pinned team default — upserted onto the reserved __default__ row.
export async function setTeamDefault(config: ViewConfig): Promise<void> {
  const owner = await currentOwner();
  await prisma.savedView.upsert({
    where: { scope_name: { scope: "default", name: DEFAULT_ROW } },
    create: { scope: "default", name: DEFAULT_ROW, owner, config: JSON.stringify(config) },
    update: { owner, config: JSON.stringify(config) },
  });
  await logAudit({ action: "saved_view.set_default", entityType: "SavedView", summary: "Set the Projects Team Default view" });
  revalidatePath("/quoted");
}

export async function deleteTeamDefault(): Promise<void> {
  await prisma.savedView.deleteMany({ where: { scope: "default" } });
  await logAudit({ action: "saved_view.clear_default", entityType: "SavedView", summary: "Cleared the Projects Team Default view" });
  revalidatePath("/quoted");
}
