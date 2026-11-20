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
  /** Why it is worth doing: what it saves, earns or prevents. Required. */
  justification: string;
  /** What it is worth to the bottom line in a year, as a tracker.value_bucket. Required. */
  valueBucketId: number;
  /** The department the project is for: the one that benefits. A tracker.team. Required. */
  forDepartmentId: number;
  targetDate?: string | null;
  teamId?: number | null;
  jobNumber?: string | null;
}

export interface ProjectChanges {
  /** Can be reworded, never emptied. */
  justification?: string;
  valueBucketId?: number;
  forDepartmentId?: number;
  targetDate?: string | null;
  state?: ProjectState;
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
  const justification = cleanJustification(input.justification);
  if (input.valueBucketId == null) throw new TrackerError("invalid", NO_VALUE);
  if (input.forDepartmentId == null) throw new TrackerError("invalid", NO_DEPARTMENT);
  assertIsoDate(input.targetDate, "Target date");

  return db.transaction(async (tx) => {
    const taken = await tx.query(`SELECT 1 FROM tracker.project WHERE key = $1`, [key]);
    if (taken.rows.length) throw new TrackerError("conflict", `The key ${key} is already used by another project.`);
    await valueBucketLabel(tx, input.valueBucketId);
    await departmentName(tx, input.forDepartmentId);

    const row = await one<{ id: number }>(
      tx,
      `INSERT INTO tracker.project
         (key, name, description, objective, definition_of_done, owner_person_id, created_by,
          target_date, team_id, job_number, justification, value_bucket_id, for_team_id)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        key,
        input.name.trim(),
        input.description ?? null,
        input.objective ?? null,
        input.definitionOfDone ?? null,
        actor.personId,
        input.targetDate ?? null,
        input.teamId ?? null,
        input.jobNumber ?? null,
        justification,
        input.valueBucketId,
        input.forDepartmentId,
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

const NO_VALUE = "Choose what the project is worth to the bottom line in a year.";

/** The reason in words, trimmed. A project without one is refused, here and on every later edit. */
function cleanJustification(text: string | null | undefined): string {
  const clean = (text ?? "").trim();
  if (!clean) {
    throw new TrackerError(
      "invalid",
      "A project needs a justification: what it saves, earns or prevents, and so why it is worth doing.",
    );
  }
  if (clean.length > 2000) throw new TrackerError("invalid", "Keep the justification under 2,000 characters.");
  return clean;
}

/** The label of a value bucket, or a refusal if there is no such bucket. */
async function valueBucketLabel(tx: Tx, id: number): Promise<string> {
  const { rows } = await tx.query<{ label: string }>(`SELECT label FROM tracker.value_bucket WHERE id = $1`, [id]);
  if (!rows.length) throw new TrackerError("invalid", NO_VALUE);
  return rows[0]!.label;
}

const NO_DEPARTMENT = "Choose the department the project is for.";

/** The name of a department a project can be for, or a refusal if there is none such in use. */
async function departmentName(tx: Tx, id: number): Promise<string> {
  const { rows } = await tx.query<{ name: string }>(
    `SELECT name FROM tracker.team WHERE id = $1 AND code IS NOT NULL AND active`,
    [id],
  );
  if (!rows.length) throw new TrackerError("invalid", NO_DEPARTMENT);
  return rows[0]!.name;
}

/** Changes a project's justification, value, department, target date, state or owner. Each change is logged. */
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
      owner_person_id: number;
      portfolio_rank: number | null;
      justification: string | null;
      value_bucket_id: number | null;
      for_team_id: number | null;
    }>(
      tx,
      `SELECT target_date::text, state, owner_person_id, portfolio_rank, justification, value_bucket_id, for_team_id
         FROM tracker.project WHERE id = $1 FOR UPDATE`,
      [projectId],
      "Project",
    );

    // What the project will hold once this call is done, for the rule on making it active.
    let justification = cur.justification;
    let valueBucketId = cur.value_bucket_id == null ? null : Number(cur.value_bucket_id);
    let forDepartmentId = cur.for_team_id == null ? null : Number(cur.for_team_id);
    if (changes.justification !== undefined) {
      const next = cleanJustification(changes.justification);
      if (next !== cur.justification) {
        await tx.query(`UPDATE tracker.project SET justification = $2 WHERE id = $1`, [projectId, next]);
        await logProjectChange(tx, projectId, "justification", cur.justification, next, actor, reason ?? null);
        justification = next;
      }
    }
    if (changes.valueBucketId !== undefined && changes.valueBucketId !== valueBucketId) {
      const label = await valueBucketLabel(tx, changes.valueBucketId);
      const was = valueBucketId == null ? null : await valueBucketLabel(tx, valueBucketId);
      await tx.query(`UPDATE tracker.project SET value_bucket_id = $2 WHERE id = $1`, [
        projectId,
        changes.valueBucketId,
      ]);
      await logProjectChange(tx, projectId, "value", was, label, actor, reason ?? null);
      valueBucketId = changes.valueBucketId;
    }
    if (changes.forDepartmentId !== undefined && changes.forDepartmentId !== forDepartmentId) {
      const name = await departmentName(tx, changes.forDepartmentId);
      // The old one is named even if the roster has since dropped it.
      const was =
        forDepartmentId == null
          ? null
          : ((await tx.query<{ name: string }>(`SELECT name FROM tracker.team WHERE id = $1`, [forDepartmentId]))
              .rows[0]?.name ?? null);
      await tx.query(`UPDATE tracker.project SET for_team_id = $2 WHERE id = $1`, [projectId, changes.forDepartmentId]);
      await logProjectChange(tx, projectId, "for_department", was, name, actor, reason ?? null);
      forDepartmentId = changes.forDepartmentId;
    }
    if (changes.targetDate !== undefined && changes.targetDate !== cur.target_date) {
      await tx.query(`UPDATE tracker.project SET target_date = $2 WHERE id = $1`, [projectId, changes.targetDate]);
      await logProjectChange(tx, projectId, "target_date", cur.target_date, changes.targetDate, actor, reason ?? null);
    }
    if (changes.ownerPersonId !== undefined && changes.ownerPersonId !== Number(cur.owner_person_id)) {
      const person = await tx.query(`SELECT 1 FROM tracker.person WHERE id = $1`, [changes.ownerPersonId]);
      if (!person.rows.length) throw new TrackerError("invalid", "That person is not in the tracker.");
      // The owner can always manage the project; the previous owner keeps the role they had.
      await tx.query(
        `INSERT INTO tracker.project_member (project_id, person_id, role) VALUES ($1, $2, 'manager')
         ON CONFLICT (project_id, person_id) DO UPDATE SET role = 'manager'`,
        [projectId, changes.ownerPersonId],
      );
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
      // Asked of every new project when it is created; this catches the ones made before that.
      if (changes.state === "active" && (!justification || valueBucketId == null || forDepartmentId == null)) {
        throw new TrackerError(
          "invalid",
          "A project needs a justification, a yearly value and a department before it can be made active. Add them in Project settings.",
        );
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

/**
 * Moves one project in the stack rank and renumbers the rest so the ranks of open projects
 * always run 1, 2, 3 with no gaps and no clashes:
 *
 *   "up" / "down"   swaps it with its neighbour
 *   a number        puts it at that rank; the projects from there down each move one place
 *   null            takes it out of the ranking
 *
 * A finished or cancelled project is outside the ranking and is left as it is.
 */
export async function moveProjectRank(
  db: Database,
  actor: Actor,
  projectId: number,
  to: number | "up" | "down" | null,
  reason?: string | null,
): Promise<void> {
  if (typeof to === "number" && (!Number.isInteger(to) || to < 1)) {
    throw new TrackerError("invalid", "A stack rank is a whole number, 1 or higher.");
  }
  const order = await db.transaction(async (tx) => {
    await requireGlobalRole(tx, actor, "portfolio_owner");
    const me = await one<{ state: string }>(
      tx,
      `SELECT state FROM tracker.project WHERE id = $1`,
      [projectId],
      "Project",
    );
    if (me.state === "completed" || me.state === "cancelled") {
      throw new TrackerError("invalid", "A finished or cancelled project is not ranked.");
    }
    const { rows } = await tx.query<{ id: number }>(
      `SELECT id FROM tracker.project
        WHERE portfolio_rank IS NOT NULL AND state NOT IN ('completed', 'cancelled')
        ORDER BY portfolio_rank, id`,
    );
    return rows.map((r) => Number(r.id));
  });

  const at = order.indexOf(projectId);
  if (to === "up" || to === "down") {
    if (at < 0) throw new TrackerError("invalid", "This project has no stack rank yet. Give it one first.");
    const other = to === "up" ? at - 1 : at + 1;
    if (other < 0 || other >= order.length) return; // already at that end
    [order[at], order[other]] = [order[other]!, order[at]!];
  } else {
    if (at >= 0) order.splice(at, 1);
    if (to !== null) order.splice(Math.min(to - 1, order.length), 0, projectId);
  }

  const ranks: { projectId: number; rank: number | null }[] = order.map((id, i) => ({ projectId: id, rank: i + 1 }));
  if (to === null) ranks.push({ projectId, rank: null });
  await setPortfolioRanks(db, actor, ranks, reason);
}

/** What typing a stack rank that is already taken would do, so the person can be asked first. */
export interface RankClash {
  /** The project that holds the rank now. */
  holderKey: string;
  holderName: string;
  /** How many ranked projects change place, the holder included, and which way they go. */
  moved: number;
  direction: "down" | "up";
}

/**
 * Says whether giving `projectId` the stack rank `rank` would displace another open project.
 * Null when the rank is free, is past the end of the list, or is the one the project has. It
 * changes nothing: `moveProjectRank` does the move once the person has agreed.
 *
 * A project that moves up the list, or joins it, pushes the ones from that rank down one place.
 * A project that moves down the list pulls the ones it passes up one place.
 */
export async function rankClash(
  db: Database,
  actor: Actor,
  projectId: number,
  rank: number,
): Promise<RankClash | null> {
  return db.transaction(async (tx) => {
    await requireGlobalRole(tx, actor, "portfolio_owner");
    const { rows } = await tx.query<{ id: number; key: string; name: string; portfolio_rank: number }>(
      `SELECT id, key, name, portfolio_rank FROM tracker.project
        WHERE portfolio_rank IS NOT NULL AND state NOT IN ('completed', 'cancelled')
        ORDER BY portfolio_rank, id`,
    );
    const holder = rows.find((r) => Number(r.portfolio_rank) === rank);
    if (!holder || Number(holder.id) === projectId) return null;
    const mine = rows.find((r) => Number(r.id) === projectId);
    const from = mine ? Number(mine.portfolio_rank) : null;
    const movingDown = from !== null && from < rank;
    const moved = rows.filter((r) => {
      const at = Number(r.portfolio_rank);
      if (Number(r.id) === projectId) return false;
      return movingDown ? at > from && at <= rank : at >= rank && (from === null || at < from);
    }).length;
    return { holderKey: holder.key, holderName: holder.name, moved, direction: movingDown ? "up" : "down" };
  });
}
