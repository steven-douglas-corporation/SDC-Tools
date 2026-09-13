"use server";

import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { PROJECTS_EDIT_COOKIE as COOKIE_NAME } from "@/lib/projects-edit-cookie";

// The Projects grid (/quoted) is a REPORT first and an editor second: most
// visits are someone reading quoted-vs-actual hours, yet every cell in it used
// to be a live input wired to Save. A stray click into a job-name field and a
// keystroke was a silent edit to production data.
//
// So the page now opens read-only and editing is an explicit, deliberate gesture
// — the same shape as the Monthly ETC grid's unlock (etc-edit-gate.ts). The
// boundary is the ROLE the signed-in user holds (projects:edit — Sales/ELT
// only, see lib/permissions.ts), re-checked on every write by
// assertProjectsEditable() below; the toggle is a mode switch on TOP of that
// boundary, not a second one — anyone with the permission can flip it without
// a password, and anyone without it never sees a usable switch at all.
//
// The mode lives in a session cookie rather than the URL, deliberately. The URL
// on this page is the shareable view (filters, columns, sort — see
// QUOTED_VIEW_PARAMS), and ProjectViewsMenu snapshots the whole query string
// into saved views; an `edit=1` in there would travel to everyone who opened
// that view. A cookie keeps "am I editing" personal to the browser, and being
// session-scoped (no maxAge) it drops back to read-only when the browser closes.
//
// ── The browser writes this cookie, not a server action ─────────────────────
// It's deliberately NOT httpOnly, and there is no setProjectsEditMode() here.
// Nothing is given away by letting the browser write it: assertProjectsEditable()
// below demands the real ROLE as well, and the cookie only says "this browser is
// in edit mode", which anyone with projects:edit gets by clicking the switch
// once. Forging it grants nothing a click wouldn't.
// The name itself lives in projects-edit-cookie.ts — a "use server" module may
// only export async functions, so it can't be shared from here.

// Everything the page needs to render the switch, in ONE auth() call. The page
// used to ask two separate questions ("is edit mode on", "may this user edit at
// all") and pay for the session lookup twice on every render.
export async function getProjectsEditState(): Promise<{ editing: boolean; mayEdit: boolean }> {
  const session = await auth();
  const mayEdit = hasPermission(session?.user?.role, "projects:edit");
  if (!mayEdit) return { editing: false, mayEdit: false };
  const cookieStore = await cookies();
  return { editing: cookieStore.get(COOKIE_NAME)?.value === "1", mayEdit: true };
}

// The write-side guard. Every server action that mutates something from this
// page calls it FIRST, before touching the database.
//
// This is the part that actually makes the page read-only: a disabled fieldset
// is a UI affordance, not a control — the grid's Save posts a plain FormData, so
// anything that can craft one can reach saveQuotedHours regardless of what the
// browser rendered. Throws rather than returning a flag so a missed call site
// can't silently fall through to the write; the message is written for a manager
// to read, since saveQuotedHours surfaces it verbatim.
export async function assertProjectsEditable(): Promise<void> {
  const session = await auth();
  if (!session?.user) throw new Error("You need to be signed in to change anything here.");
  if (!hasPermission(session.user.role, "projects:edit")) {
    throw new Error("You don't have permission to edit Projects.");
  }
}
