import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { APP_VERSION } from "@/lib/app-version";
import { publishChanges } from "@/lib/realtime-hub";

// ── THE one place a cell change is recorded ─────────────────────────────────
//
// Every add, edit and removal of a value anywhere in the app comes through here.
// It does two things that used to be nobody's job:
//
//   1. Writes a queryable audit row per changed cell — user, tab, row, column,
//      previous value, new value, change type, app version and a transaction id
//      shared by every cell in one save (schema.prisma, AuditLog).
//   2. Publishes the same facts to the realtime hub, so every connected browser
//      can show a notification banner without polling (lib/realtime-hub.ts).
//
// One function for both, deliberately: a change that is announced but not recorded
// (or recorded but not announced) is the kind of inconsistency that makes an audit
// trail untrustworthy. There is no way to do one without the other.
//
// ── Why raw SQL for the insert ──────────────────────────────────────────────
// The nine columns below were added on 2026-08-04 and `prisma generate` cannot run
// while the production process holds the client open (EPERM on
// node_modules/.prisma/client). A parameter-bound INSERT works against the schema
// as it actually is, so audit writing does not wait on a deploy window. It is also
// a reasonable permanent shape for an append-only log: one explicit statement, no
// ORM behaviour to reason about, and nothing that can fail because a generated
// type is out of date.
//
// Values are interpolated through Prisma's tagged template, which parameterises
// them — they are never concatenated into the SQL string.

export type ChangeType = "added" | "edited" | "removed" | "recalculated" | "rejected";

export type CellChange = {
  // Which tab a human would name: "Monthly ETC", "Projects", "Standard Sheet".
  tab: string;
  // The row a human would name — a job number, an employee name. NOT a primary key:
  // this is what appears in the banner and in a history search.
  rowRef: string;
  // The column a human would name: "New ETC", "Parts Cost Quoted", "Hours Pulled".
  columnName: string;
  // Stringified so one column holds hours, money and free text. `null` means the
  // cell held nothing — distinct from "0", which is a real figure.
  previousValue: string | null;
  newValue: string | null;
  changeType: ChangeType;
  // ── Transport only: sync every tab, but do NOT narrate this to anyone ──────
  //
  // A change event does two unrelated jobs: it tells other browsers their data
  // moved (LiveRefresh reacts to it), and it tells the PERSON what somebody
  // changed (the notification card). For a cell somebody typed in, both are
  // wanted. For the hourly refresh pass they are not: the tabs must still
  // refetch, but the pass is the app's own background work, and announcing it
  // produced a second card beside the refresh toast that already said the same
  // thing in better words — one action, two notifications, which is exactly the
  // noise the notification rules forbid.
  //
  // Set true and the event still reaches every browser and still drives the
  // refetch; ChangeNotifications simply does not draw a card for it.
  system?: boolean;
  // For joining back to the record, when there is one.
  entityType?: string;
  entityId?: string | number;
  // ── The cell this change lands in, if it is one cell ──────────────────────
  //
  // The form-field name of the affected input (`newEtcOverride__123`), i.e. the
  // same identifier the presence indicators already use as `cellKey`. Optional:
  // plenty of changes are not a single addressable cell (a bulk sync, a month
  // submit), and those simply don't set it.
  //
  // What it buys (2026-08-04, performance pass): a browser receiving this event can
  // put the new value straight into the one cell it belongs to. Before, the only way
  // to show a colleague's value was to re-render the whole route — 854 KB and ~600ms
  // on Monthly ETC, per event. See lib/etc-remote-values.ts.
  cellKey?: string;
  // The SAME cell's other legitimate name. A New ETC cell posts under its entry id
  // once a row exists and under `newEtcCreate__<jobPk>__<section>` before that, and
  // two browsers can be holding different ones depending on when each page rendered.
  // Sending both is what lets the incremental path reach the ~half of the grid that
  // is sections nobody quoted.
  altCellKey?: string;
};

// Who made the change. Resolved once per batch rather than per cell.
async function currentActor(): Promise<{ userId: number | null; userEmail: string | null; userName: string }> {
  try {
    const session = await auth();
    const user = session?.user as { id?: string; email?: string | null; name?: string | null } | undefined;
    const email = user?.email ?? null;
    return {
      userId: user?.id ? Number(user.id) : null,
      userEmail: email,
      // Display name, falling back to the local part of the email — "John Smith
      // changed…" is the requirement, and "akamuju" beats a blank.
      userName: user?.name?.trim() || email?.split("@")[0] || "Unknown user",
    };
  } catch {
    // No request scope: the 6-hour sync pass runs on a timer and auth() throws
    // there (see logAudit for the incident this cost). An unattended change is a
    // fact to record, not an error.
    return { userId: null, userEmail: "system@auto-sync", userName: "Automatic sync" };
  }
}

// ── added / edited / removed, decided in ONE place ──────────────────────────
//
// The banner's wording depends on this (§33.9: "Abhi changed New ETC from 60 to 55"
// vs "Abhi removed the New ETC value of 60"), so every caller must classify the same
// way or the same kind of edit reads differently depending on which tab it came from.
//
// `emptyIsBlank` is for columns where 0 and blank are the same thing — Projects'
// quoted hours treats an unquoted section as 0, so clearing such a cell is a REMOVAL,
// not an edit to zero. On columns where 0 is a real figure distinct from blank (a
// deliberate zero New ETC, which this app is careful about elsewhere), leave it off
// and a 0 classifies as an ordinary edit.
export function classifyChange(
  previousValue: string | null,
  newValue: string | null,
  opts: { emptyIsBlank?: boolean } = {},
): ChangeType {
  const blank = (v: string | null) => v === null || v === "" || (opts.emptyIsBlank === true && v === "0");
  const had = !blank(previousValue);
  const has = !blank(newValue);
  if (!had && has) return "added";
  if (had && !has) return "removed";
  return "edited";
}

// One human-readable line per change, the same wording the banner shows. Built
// here so the audit summary and the notification cannot describe the same event
// differently.
export function describeChange(c: CellChange, userName: string): string {
  const from = c.previousValue === null || c.previousValue === "" ? "(blank)" : c.previousValue;
  const to = c.newValue === null || c.newValue === "" ? "(blank)" : c.newValue;
  switch (c.changeType) {
    case "added":
      return `${userName} set ${c.columnName} to ${to} for ${c.rowRef} in ${c.tab}`;
    // Phrased to name the figure that went, because after a removal there is
    // nothing left on screen to say what it was — this line is the only record a
    // reader gets. Wording taken from the requirement: "Abhi removed New ETC value
    // 60 for Job 1165 in the Monthly ETC tab."
    case "removed":
      return `${userName} removed ${c.columnName} value ${from} for ${c.rowRef} in ${c.tab}`;
    case "rejected":
      return `${userName}'s change to ${c.columnName} for ${c.rowRef} in ${c.tab} was refused — it is now ${to}`;
    case "recalculated":
      return `${c.columnName} for ${c.rowRef} in ${c.tab} recalculated from ${from} to ${to}`;
    default:
      return `${userName} changed ${c.columnName} from ${from} to ${to} for ${c.rowRef} in ${c.tab}`;
  }
}

const SUMMARY_MAX = 191; // VARCHAR(191) — see the note in lib/audit.ts

// Records a batch of cell changes and announces them. Returns the shared change id
// so the caller can reference it (and so a duplicate submission is detectable).
//
// Best-effort by the same rule as logAudit: recording a change must never be able
// to fail the change itself. A logging outage is a gap in the record; a logging
// outage that rolls back a manager's save is a data-loss incident.
export async function recordChanges(
  changes: CellChange[],
  opts: { action: string } = { action: "cell.change" },
): Promise<string | null> {
  if (changes.length === 0) return null;
  const changeId = randomUUID();
  const actor = await currentActor();

  try {
    for (const c of changes) {
      const summaryRaw = describeChange(c, actor.userName);
      const summary = summaryRaw.length > SUMMARY_MAX ? `${summaryRaw.slice(0, SUMMARY_MAX - 1)}…` : summaryRaw;
      await prisma.$executeRaw`
        INSERT INTO AuditLog
          (userId, userEmail, userName, action, entityType, entityId, summary, metadata, createdAt,
           tab, rowRef, columnName, previousValue, newValue, changeType, appVersion, changeId)
        VALUES
          (${actor.userId}, ${actor.userEmail}, ${actor.userName}, ${opts.action},
           ${c.entityType ?? null}, ${c.entityId !== undefined ? String(c.entityId) : null},
           ${summary}, NULL, ${new Date()},
           ${c.tab}, ${c.rowRef}, ${c.columnName}, ${c.previousValue}, ${c.newValue},
           ${c.changeType}, ${APP_VERSION}, ${changeId})`;
    }
  } catch (err) {
    console.error("[change-log] failed to write audit rows", opts.action, err);
  }

  // Announced even if the audit write failed: the value IS saved, and other users
  // seeing it is more important than the record of it being complete. The console
  // error above is the trail for the missing rows.
  try {
    publishChanges(
      changes.map((c) => ({
        changeId,
        userName: actor.userName,
        tab: c.tab,
        rowRef: c.rowRef,
        columnName: c.columnName,
        previousValue: c.previousValue,
        newValue: c.newValue,
        changeType: c.changeType,
        at: new Date().toISOString(),
        message: describeChange(c, actor.userName),
        // Carried so the receiving browser can update the ONE cell instead of
        // refetching the route. Omitted when the change isn't a single cell.
        ...(c.cellKey ? { cellKey: c.cellKey } : {}),
        ...(c.altCellKey ? { altCellKey: c.altCellKey } : {}),
        // Carried to the browser so the receiver can sync without narrating.
        ...(c.system ? { system: true } : {}),
      })),
    );
  } catch (err) {
    console.error("[change-log] failed to publish change events", err);
  }

  return changeId;
}

// The history of ONE cell, which is what the queryable columns exist for.
// Newest first; `limit` keeps a hot cell's history bounded.
export async function readCellHistory(
  where: { tab: string; rowRef: string; columnName?: string },
  limit = 50,
): Promise<
  {
    at: Date;
    userName: string | null;
    columnName: string | null;
    previousValue: string | null;
    newValue: string | null;
    changeType: string | null;
    appVersion: string | null;
    changeId: string | null;
  }[]
> {
  const rows = where.columnName
    ? await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT createdAt, userName, columnName, previousValue, newValue, changeType, appVersion, changeId
        FROM AuditLog
        WHERE tab = ${where.tab} AND rowRef = ${where.rowRef} AND columnName = ${where.columnName}
        ORDER BY createdAt DESC, id DESC LIMIT ${limit}`
    : await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT createdAt, userName, columnName, previousValue, newValue, changeType, appVersion, changeId
        FROM AuditLog
        WHERE tab = ${where.tab} AND rowRef = ${where.rowRef}
        ORDER BY createdAt DESC, id DESC LIMIT ${limit}`;
  return rows.map((r) => ({
    at: r.createdAt as Date,
    userName: (r.userName as string | null) ?? null,
    columnName: (r.columnName as string | null) ?? null,
    previousValue: (r.previousValue as string | null) ?? null,
    newValue: (r.newValue as string | null) ?? null,
    changeType: (r.changeType as string | null) ?? null,
    appVersion: (r.appVersion as string | null) ?? null,
    changeId: (r.changeId as string | null) ?? null,
  }));
}
