import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";

type AuditEntry = {
  action: string;
  entityType?: string;
  entityId?: string | number;
  summary: string;
  metadata?: Record<string, unknown>;
};

// `summary` has no explicit @db type in schema.prisma, so Prisma's MySQL
// default (VARCHAR(191)) applies. Found live 2026-07-17: syncEtcHistory's
// reconciliation note (lists every reconciled month + field counts) can
// exceed that and the whole audit record silently fails to write (P2000) —
// defeating the exact record the reconciliation added this summary to
// create. Truncate defensively so a long summary still leaves a real,
// searchable log entry instead of no entry at all.
const SUMMARY_MAX = 191;

// Best-effort by design: a logging failure must never break the action it's
// recording (e.g. a locked audit table shouldn't block an ETC submission).
async function writeAuditLog(entry: AuditEntry & { userId: number | null; userEmail: string | null }) {
  try {
    const summary = entry.summary.length > SUMMARY_MAX ? `${entry.summary.slice(0, SUMMARY_MAX - 1)}…` : entry.summary;
    await prisma.auditLog.create({
      data: {
        userId: entry.userId,
        userEmail: entry.userEmail,
        action: entry.action,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId !== undefined ? String(entry.entityId) : null,
        summary,
        metadata: entry.metadata as never,
      },
    });
  } catch (err) {
    console.error("[audit] failed to write log", entry.action, err);
  }
}

// Call from inside a server action / page action — reads the signed-in user from
// the current session.
//
// Also safe to call with NO request at all, which is not a hypothetical: the
// 6-hour pass in auto-sync.ts runs on a timer, and `auth()` there reads
// `headers()` and throws "`headers` was called outside a request scope". That
// threw straight out of the sync step that was only trying to record what it
// did — proven live 2026-07-31, the Scheduler roster step failing AFTER it had
// already written its updates. An audit entry is a record OF an operation and
// must never be able to fail one; an unattended run simply has no user, which
// is a fact to record rather than an error.
export async function logAudit(entry: AuditEntry): Promise<void> {
  let userId: string | undefined;
  let userEmail: string | null = null;
  try {
    const session = await auth();
    userId = session?.user?.id;
    userEmail = session?.user?.email ?? null;
  } catch {
    // No request scope (scheduled/background work). Attributed to the system
    // below rather than left blank, so the audit log distinguishes "nobody was
    // signed in" from "we could not tell".
    userEmail = "system@auto-sync";
  }
  await writeAuditLog({
    ...entry,
    userId: userId ? Number(userId) : null,
    userEmail,
  });
}

// Call from within auth.ts's callbacks, where `auth()` can't be used (no
// session exists yet during sign-in) — the caller already has the user.
export async function logAuditFor(
  userId: number | null,
  userEmail: string | null,
  entry: AuditEntry,
): Promise<void> {
  await writeAuditLog({ ...entry, userId, userEmail });
}
