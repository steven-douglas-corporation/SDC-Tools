import { TrackerError, assertIsoDate, one, type Actor, type Database, type Tx } from "./database";
import { requireGlobalRole, requireProjectRole } from "./access";

export type ProjectState = "planned" | "active" | "on_hold" | "completed" | "cancelled";

/** Keys that would collide with the tracker's own pages. */
const RESERVED_KEYS = new Set(["PEOPLE", "API", "NEW", "SETTINGS", "TIMELINE"]);

export interface NewProject {
  /** Short code used in task keys, e.g. BIN gives BIN-42. */
  key: string;
  name: string;
  description?: string | null;
  objective?: string | null;
  definitionOfDone?: string | null;
  priority?: number;
  targetDate?: string | null;
  teamId?: number | null;
  jobNumber?: string | null;
}

export interface ProjectChanges {
  targetDate?: string | null;
  state?: ProjectState;
  priority?: number;
  ownerPersonId?: number;
}

/**
 * The tracker's record of a person, created the first time they are seen. The app's own user
 * is matched by email, which is what links a signed-in user to their tracker work.
 */
export async function ensurePerson(db: Database, input: { email: string; displayName: string }): Promise<number> {
  const email = input.email.trim().toLowerCase();
  if (!email) throw new TrackerError("invalid", "An email address is required.");
  return db.transaction(async (tx) => {
    const row = await one<{ id: number }>(
      tx,
      `INSERT INTO tracker.person (email, display_name) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id`,
      [email, input.displayName.trim() || email],
      "Person",
    );
    return Number(row.id);
  });
}

/**
 * Makes sure each of these people has a tracker record, in one statement. Used to keep the
 * tracker's list of people in step with the app's users, so anyone can be assigned work
 * before they have opened the tracker themselves. Never removes or deactivates anyone.
 */
export async function ensurePeople(db: Database, people: { email: string; displayName: string }[]): Promise<void> {
  const rows = people
    .map((p) => ({
      email: p.email.trim().toLowerCase(),
      display_name: p.displayName.trim() || p.email.trim().toLowerCase(),
    }))
    .filter((p) => p.email);
  if (rows.length === 0) return;
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO tracker.person (email, display_name)
       SELECT x.email, x.display_name FROM jsonb_to_recordset($1::jsonb) AS x(email text, display_name text)
       ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
         WHERE tracker.person.display_name IS DISTINCT FROM EXCLUDED.display_name`,
      [JSON.stringify(rows)],
    );
  });
}

/**
 * Creates a project in the planned state with the default board columns, owned by the actor,
 * who becomes its first manager. It has no stack rank yet, so its work is not forecast until
 * the portfolio owner ranks it.
 */
export async function createProject(
  db: Database,
  actor: Actor,
  input: NewProject,
): Promise<{ id: number; key: string }> {
  const key = input.key.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,7}$/.test(key)) {
    throw new TrackerError("invalid", "A project key is 2 to 8 letters or digits, starting with a letter.");
  }
  // A project's board lives at /tracker/KEY, so a key cannot be the name of another tracker page.
  if (RESERVED_KEYS.has(key)) throw new TrackerError("invalid", `${key} is reserved. Choose a different key.`);
  if (!input.name.trim()) throw new TrackerError("invalid", "A project needs a name.");
  assertIsoDate(input.targetDate, "Target date");

  return db.transaction(async (tx) => {
    const taken = await tx.query(`SELECT 1 FROM tracker.project WHERE key = $1`, [key]);
    if (taken.rows.length) throw new TrackerError("conflict", `The key ${key} is already used by another project.`);

    const row = await one<{ id: number }>(
      tx,
      `INSERT INTO tracker.project
         (key, name, description, objective, definition_of_done, owner_person_id, created_by,
          priority, target_date, team_id, job_number)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        key,
        input.name.trim(),
        input.description ?? null,
        input.objective ?? null,
        input.definitionOfDone ?? null,
        actor.personId,
        input.priority ?? 3,
        input.targetDate ?? null,
        input.teamId ?? null,
        input.jobNumber ?? null,
      ],
      "Project",
    );
    const id = Number(row.id);
    await tx.query(`SELECT tracker.seed_default_statuses($1)`, [id]);
    await tx.query(`INSERT INTO tracker.project_member (project_id, person_id, role) VALUES ($1, $2, 'manager')`, [
      id,
      actor.personId,
    ]);
    return { id, key };
  });
}

export async function setProjectMember(
  db: Database,
  actor: Actor,
  projectId: number,
  personId: number,
  role: "viewer" | "contributor" | "manager" | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    await requireProjectRole(tx, projectId, actor, "manager");
    if (role === null) {
      await tx.query(`DELETE FROM tracker.project_member WHERE project_id = $1 AND person_id = $2`, [
        projectId,
        personId,
      ]);
    } else {
      await tx.query(
        `INSERT INTO tracker.project_member (project_id, person_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (project_id, person_id) DO UPDATE SET role = EXCLUDED.role`,
        [projectId, personId, role],
      );
    }
  });
}

async function logProjectChange(
  tx: Tx,
  projectId: number,
  field: string,
  oldValue: unknown,
  newValue: unknown,
  actor: Actor,
  reason: string | null,
): Promise<void> {
  await tx.query(
    `INSERT INTO tracker.project_change_log (project_id, field, old_value, new_value, changed_by, reason)
     VALUES ($1, $2::tracker.project_tracked_field, $3, $4, $5, $6)`,
    [
      projectId,
      field,
      oldValue == null ? null : String(oldValue),
      newValue == null ? null : String(newValue),
      actor.personId,
      reason,
    ],
  );
}

/** Changes a project's target date, state, priority or owner. Each change is logged. */
export async function updateProject(
  db: Database,
  actor: Actor,
  projectId: number,
  changes: ProjectChanges,
  reason?: string | null,
): Promise<void> {
  assertIsoDate(changes.targetDate, "Target date");
  await db.transaction(async (tx) => {
    await requireProjectRole(tx, projectId, actor, "manager");
    const cur = await one<{
      target_date: string | null;
      state: ProjectState;
      priority: number;
      owner_person_id: number;
      portfolio_rank: number | null;
    }>(
      tx,
      `SELECT target_date::text, state, priority, owner_person_id, portfolio_rank FROM tracker.project WHERE id = $1 FOR UPDATE`,
      [projectId],
      "Project",
    );

    if (changes.targetDate !== undefined && changes.targetDate !== cur.target_date) {
      await tx.query(`UPDATE tracker.project SET target_date = $2 WHERE id = $1`, [projectId, changes.targetDate]);
      await logProjectChange(tx, projectId, "target_date", cur.target_date, changes.targetDate, actor, reason ?? null);
    }
    if (changes.priority !== undefined && changes.priority !== cur.priority) {
      if (!Number.isInteger(changes.priority) || changes.priority < 1 || changes.priority > 5) {
        throw new TrackerError("invalid", "Priority is a whole number from 1 (highest) to 5.");
      }
      await tx.query(`UPDATE tracker.project SET priority = $2 WHERE id = $1`, [projectId, changes.priority]);
      await logProjectChange(tx, projectId, "priority", cur.priority, changes.priority, actor, reason ?? null);
    }
    if (changes.ownerPersonId !== undefined && changes.ownerPersonId !== Number(cur.owner_person_id)) {
      await tx.query(`UPDATE tracker.project SET owner_person_id = $2 WHERE id = $1`, [
        projectId,
        changes.ownerPersonId,
      ]);
      await logProjectChange(tx, projectId, "owner", cur.owner_person_id, changes.ownerPersonId, actor, reason ?? null);
    }
    if (changes.state !== undefined && changes.state !== cur.state) {
      if (changes.state === "active" && cur.portfolio_rank == null) {
        throw new TrackerError("invalid", "A project needs a stack rank before it can be made active.");
      }
      const done = changes.state === "completed";
      await tx.query(
        `UPDATE tracker.project
            SET state = $2::tracker.project_state,
                actual_completion_date = CASE WHEN $3 THEN coalesce(actual_completion_date, CURRENT_DATE) ELSE NULL END
          WHERE id = $1`,
        [projectId, changes.state, done],
      );
      await logProjectChange(tx, projectId, "state", cur.state, changes.state, actor, reason ?? null);
    }
  });
}

/**
 * Sets the company-wide stack rank of one or more projects in a single step, so two projects
 * can swap places. Only the portfolio owner (or an admin) may do this. No two open projects may
 * end up sharing a rank; if they would, nothing is changed.
 */
export async function setPortfolioRanks(
  db: Database,
  actor: Actor,
  ranks: { projectId: number; rank: number | null }[],
  reason?: string | null,
): Promise<void> {
  for (const r of ranks) {
    if (r.rank !== null && (!Number.isInteger(r.rank) || r.rank < 1)) {
      throw new TrackerError("invalid", "A stack rank is a whole number, 1 or higher.");
    }
  }
  try {
    await db.transaction(async (tx) => {
      await requireGlobalRole(tx, actor, "portfolio_owner");
      await tx.query(`SET CONSTRAINTS tracker.project_rank_unique DEFERRED`);
      for (const r of ranks) {
        const cur = await one<{ portfolio_rank: number | null }>(
          tx,
          `SELECT portfolio_rank FROM tracker.project WHERE id = $1 FOR UPDATE`,
          [r.projectId],
          "Project",
        );
        if (cur.portfolio_rank === r.rank) continue;
        await tx.query(`UPDATE tracker.project SET portfolio_rank = $2 WHERE id = $1`, [r.projectId, r.rank]);
        await logProjectChange(tx, r.projectId, "portfolio_rank", cur.portfolio_rank, r.rank, actor, reason ?? null);
      }
      await tx.query(`SET CONSTRAINTS tracker.project_rank_unique IMMEDIATE`);
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("project_rank_unique")) {
      throw new TrackerError("conflict", "Two open projects cannot share a stack rank.");
    }
    if (message.includes("project_active_needs_rank")) {
      throw new TrackerError("invalid", "An active project must keep a stack rank.");
    }
    throw e;
  }
}
