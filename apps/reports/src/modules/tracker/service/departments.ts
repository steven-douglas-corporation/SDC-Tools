import type { Database } from "./database";

// The company's departments, as the tracker knows them: a copy of the org's own teams in two
// levels (a group, and the teams under it), kept in tracker.team. Nothing is typed in here.
// The layer that knows the employee roster (../org-units.ts, ../current-actor.ts) hands the
// current list to syncDepartments, and everything else in the tracker reads the copy.

/** One org unit as the roster describes it. `code` is the roster's own, and is what is matched on. */
export interface OrgUnit {
  code: string;
  name: string;
  /** The code of the group this unit sits under, or null for a group or a unit with none. */
  parentCode: string | null;
}

/** A department a project can be for. */
export interface Department {
  id: number;
  code: string;
  name: string;
  /** The group this one sits under; null when it is a group itself, or stands alone. */
  parentId: number | null;
  /** The group's name: the parent's, or its own when it has none. What lists are grouped by. */
  groupName: string;
}

interface Row {
  id: number;
  code: string;
  name: string;
  parent_code: string | null;
  sort_order: number;
  active: boolean;
}

/**
 * Makes tracker.team match `units`, in the order given. A unit the roster no longer has is
 * switched off, not deleted, so a project that was for it keeps saying so. Writes nothing when
 * nothing changed, which is nearly every time: this runs whenever a tracker page is opened.
 */
export async function syncDepartments(db: Database, units: OrgUnit[]): Promise<void> {
  await db.transaction(async (tx) => {
    const { rows } = await tx.query<Row>(
      `SELECT t.id, t.code, t.name, p.code AS parent_code, t.sort_order, t.active
         FROM tracker.team t LEFT JOIN tracker.team p ON p.id = t.parent_team_id
        WHERE t.code IS NOT NULL`,
    );
    const have = new Map(rows.map((r) => [r.code, r]));
    const same =
      rows.filter((r) => r.active).length === units.length &&
      units.every((u, i) => {
        const r = have.get(u.code);
        return r && r.active && r.name === u.name && r.parent_code === u.parentCode && Number(r.sort_order) === i;
      });
    if (same) return;

    // Groups first, so a team's parent exists by the time the team is written.
    const ordered = units.map((u, i) => ({ ...u, sort: i }));
    for (const pass of [ordered.filter((u) => u.parentCode == null), ordered.filter((u) => u.parentCode != null)]) {
      for (const u of pass) {
        await tx.query(
          `INSERT INTO tracker.team (code, name, parent_team_id, sort_order, active)
           VALUES ($1, $2, (SELECT id FROM tracker.team WHERE code = $3), $4, true)
           ON CONFLICT (code) DO UPDATE
             SET name = EXCLUDED.name, parent_team_id = EXCLUDED.parent_team_id,
                 sort_order = EXCLUDED.sort_order, active = true`,
          [u.code, u.name, u.parentCode, u.sort],
        );
      }
    }
    await tx.query(`UPDATE tracker.team SET active = false WHERE code IS NOT NULL AND NOT (code = ANY($1::text[]))`, [
      units.map((u) => u.code),
    ]);
  });
}

/** The departments a project can be for today: each group, then the teams under it. */
export async function listDepartments(db: Database): Promise<Department[]> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{
      id: number;
      code: string;
      name: string;
      parent_id: number | null;
      group_name: string;
    }>(
      `SELECT t.id, t.code, t.name, t.parent_team_id AS parent_id, coalesce(p.name, t.name) AS group_name
         FROM tracker.team t LEFT JOIN tracker.team p ON p.id = t.parent_team_id
        WHERE t.code IS NOT NULL AND t.active
        ORDER BY coalesce(p.sort_order, t.sort_order), (t.parent_team_id IS NOT NULL), t.sort_order`,
    );
    return rows.map((r) => ({
      id: Number(r.id),
      code: r.code,
      name: r.name,
      parentId: r.parent_id == null ? null : Number(r.parent_id),
      groupName: r.group_name,
    }));
  });
}

/**
 * The ids a choice of department covers: itself, and for a group every team under it. So
 * choosing Engineering finds a project that is for Controls Engineering, and choosing Controls
 * Engineering does not find one that is for Engineering as a whole.
 */
export function departmentScope(departments: Department[], id: number): Set<number> {
  return new Set([id, ...departments.filter((d) => d.parentId === id).map((d) => d.id)]);
}

/**
 * The ids several choices cover together, or null when nothing is chosen (which means all).
 * A choice that is not a department in use is ignored.
 */
export function departmentsScope(departments: Department[], ids: number[]): Set<number> | null {
  const known = ids.filter((id) => departments.some((d) => d.id === id));
  if (known.length === 0) return null;
  return new Set(known.flatMap((id) => [...departmentScope(departments, id)]));
}

/**
 * Puts each person in their department, matched by email and by the roster's own code for the
 * team. Someone whose team the tracker does not have is left where they are. Writes nothing
 * when nothing has changed.
 */
export async function setPeopleDepartments(db: Database, people: { email: string; teamCode: string }[]): Promise<void> {
  if (!people.length) return;
  await db.transaction((tx) =>
    tx.query(
      `UPDATE tracker.person p
          SET team_id = t.id
         FROM jsonb_to_recordset($1::jsonb) AS x(email text, code text)
         JOIN tracker.team t ON t.code = x.code
        WHERE lower(p.email) = lower(x.email) AND p.team_id IS DISTINCT FROM t.id`,
      [JSON.stringify(people.map((p) => ({ email: p.email, code: p.teamCode })))],
    ),
  );
}
