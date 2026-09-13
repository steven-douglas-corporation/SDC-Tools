"use server";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// A saved Hours-tab view — the URL state (filters, group-by order, sort). Deliberately
// PARALLEL to, not sharing code with, saved-views-actions.ts's Projects-tab views:
// generalizing that file (a `feature` param reprefixing its hardcoded "shared"/
// "default" scope literals) would orphan every view a real user has already published
// for Projects in production — listSharedViews() would start querying prefixed scopes
// and find the existing unprefixed rows nowhere, a data migration in disguise. Its
// ViewConfig also carries Projects-only graveyard/toggle fields (`grid`, `actuals`)
// that don't belong on a Hours type, and Rename plus a personal default are both new
// here regardless. Reusing the SAME SavedView table under a new scope value needs no
// schema migration either way — `scope` is a plain string column with no DB-level
// enum/check constraint.
//
// No Team-Default pair (setTeamDefault/deleteTeamDefault have no Hours counterpart) —
// only a PERSONAL default is asked for, and that's a localStorage pointer (see
// hours-saved-views.ts), not a server concept: this app's only working login is
// email/password (src/lib/auth.ts), sign-in is optional, and `owner` is null for an
// anonymous visit — there's nothing to reliably hang a per-user server row on.

export type ViewConfig = { params: Record<string, string> };
export type SharedView = { id: number; name: string; owner: string | null; config: ViewConfig };

const SCOPE = "hours_shared";

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

function isPrismaError(e: unknown, code: string): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === code;
}

export async function listSharedHoursViews(): Promise<{ shared: SharedView[] }> {
  const rows = await prisma.savedView.findMany({ where: { scope: SCOPE }, orderBy: { name: "asc" } });
  const shared: SharedView[] = [];
  for (const r of rows) {
    const config = parseConfig(r.config);
    if (config) shared.push({ id: r.id, name: r.name, owner: r.owner, config });
  }
  return { shared };
}

// Publish a view team-wide (or overwrite one of the same name) — upserts on the
// (scope, name) unique key, same idiom saved-views-actions.ts's publishView uses.
export async function publishHoursView(name: string, config: ViewConfig): Promise<void> {
  const clean = name.trim();
  if (!clean) throw new Error("Give the view a name before sharing it.");
  const owner = await currentOwner();
  await prisma.savedView.upsert({
    where: { scope_name: { scope: SCOPE, name: clean } },
    create: { scope: SCOPE, name: clean, owner, config: JSON.stringify(config) },
    update: { owner, config: JSON.stringify(config) },
  });
  await logAudit({ action: "saved_view.publish", entityType: "SavedView", entityId: clean, summary: `Shared Hours view "${clean}"` });
  revalidatePath("/hours");
}

export async function deleteSharedHoursView(name: string): Promise<void> {
  await prisma.savedView.deleteMany({ where: { scope: SCOPE, name } });
  await logAudit({ action: "saved_view.delete", entityType: "SavedView", entityId: name, summary: `Deleted shared Hours view "${name}"` });
  revalidatePath("/hours");
}

/**
 * Keyed by `id`, not by `{scope, name: oldName}` — idempotent under a retried/doubled
 * request (a repeat just sets the same name again rather than 404ing because the name
 * already changed), and the `@@unique([scope, name])` constraint makes this safe under
 * concurrency with no separate check-then-write race: attempt the write, and MySQL
 * rejects it atomically if another row already holds the target name.
 */
export async function renameSharedHoursView(id: number, oldName: string, newName: string): Promise<void> {
  const clean = newName.trim();
  if (!clean) throw new Error("Give the view a name before renaming it.");
  const owner = await currentOwner();
  try {
    await prisma.savedView.update({ where: { id }, data: { name: clean, owner } });
  } catch (e) {
    if (isPrismaError(e, "P2002")) throw new Error(`A shared view named "${clean}" already exists.`);
    if (isPrismaError(e, "P2025")) throw new Error("That view no longer exists.");
    throw e;
  }
  await logAudit({
    action: "saved_view.rename",
    entityType: "SavedView",
    entityId: String(id),
    summary: `Renamed shared Hours view "${oldName}" to "${clean}"`,
  });
  revalidatePath("/hours");
}
