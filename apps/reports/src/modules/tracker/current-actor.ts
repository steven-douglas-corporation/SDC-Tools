import "server-only";

import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { trackerDb } from "./db";
import type { Actor } from "./service/database";
import { ensurePeople, ensurePerson } from "./service/projects";

// The bridge between this app's signed-in user and the tracker's own record of a person.
// The two are matched by email, which is the one thing every sign-in path agrees on.

/**
 * The tracker person for a signed-in user, created on first use. ELT is all-access in this
 * app, so it is all-access in the tracker too: that is decided here, from the session's role,
 * and nowhere else.
 */
export async function trackerActor(session: Session): Promise<Actor> {
  const email = session.user.email?.trim().toLowerCase();
  if (!email) throw new Error("We couldn't tell who you are — sign in again.");
  const personId = await ensurePerson(trackerDb, { email, displayName: session.user.name?.trim() || email });
  return { personId, admin: session.user.role === "ELT" };
}

/**
 * Copies this app's active users into the tracker's list of people, so a task can be assigned
 * to someone who has never opened the tracker. Cheap (one read, one statement), and it only
 * ever adds people or corrects a name.
 */
export async function syncPeopleFromUsers(): Promise<void> {
  const users = await prisma.user.findMany({ where: { active: true }, select: { email: true, name: true } });
  await ensurePeople(
    trackerDb,
    users.map((u) => ({ email: u.email, displayName: u.name })),
  );
}
