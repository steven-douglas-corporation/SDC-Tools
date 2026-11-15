import { TrackerError, type Actor, type Tx } from "./database";

// Who may do what inside the tracker. The app's own permissions decide who can reach the
// tracker at all; these checks decide what a person may do to one project.

export type ProjectRole = "viewer" | "contributor" | "manager";
export type GlobalRole = "admin" | "portfolio_owner";

const RANK: Record<ProjectRole, number> = { viewer: 1, contributor: 2, manager: 3 };

export async function hasGlobalRole(tx: Tx, actor: Actor, role: GlobalRole): Promise<boolean> {
  const { rows } = await tx.query(
    `SELECT 1 FROM tracker.person_global_role WHERE person_id = $1 AND (role::text = $2 OR role::text = 'admin')`,
    [actor.personId, role],
  );
  return rows.length > 0;
}

/** The actor's role on a project, or null if they have none. An admin is a manager everywhere. */
export async function projectRole(tx: Tx, projectId: number, actor: Actor): Promise<ProjectRole | null> {
  if (await hasGlobalRole(tx, actor, "admin")) return "manager";
  const { rows } = await tx.query<{ role: ProjectRole }>(
    `SELECT role FROM tracker.project_member WHERE project_id = $1 AND person_id = $2`,
    [projectId, actor.personId],
  );
  return rows[0]?.role ?? null;
}

export async function requireProjectRole(tx: Tx, projectId: number, actor: Actor, atLeast: ProjectRole): Promise<void> {
  const role = await projectRole(tx, projectId, actor);
  if (!role || RANK[role] < RANK[atLeast]) {
    throw new TrackerError("forbidden", `You need to be a ${atLeast} on this project to do that.`);
  }
}

export async function requireGlobalRole(tx: Tx, actor: Actor, role: GlobalRole): Promise<void> {
  if (!(await hasGlobalRole(tx, actor, role))) {
    throw new TrackerError("forbidden", "You don't have permission to do that.");
  }
}
