import "server-only";

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireApiPermission } from "@/lib/require-permission";
import { trackerConfigured } from "./db";
import { trackerActor } from "./current-actor";
import { TrackerError, type Actor } from "./service/database";

// Shared by the tracker's route handlers (src/app/api/tracker). This is the second "door" in
// docs/MODULES.md: the same service functions the screens call, answered as JSON, under the
// signed-in person's own permissions. Read-only for now.
//
// It uses the browser session. A service token for callers that are not a signed-in person
// (an AI tool running on a server, another system) is not built yet.

const STATUS: Record<string, number> = { not_found: 404, forbidden: 403, invalid: 400, conflict: 409 };

/** Checks the caller, runs `read` as them, and turns the tracker's refusals into HTTP statuses. */
export async function trackerApi<T>(read: (actor: Actor) => Promise<T>): Promise<Response> {
  const session = await auth();
  const denied = requireApiPermission(session, "tracker:view");
  if (denied) return denied;
  if (!trackerConfigured()) {
    return NextResponse.json({ error: "The Project Tracker is not set up on this server." }, { status: 503 });
  }
  try {
    // requireApiPermission returned nothing, so there is a signed-in user.
    return NextResponse.json(await read(await trackerActor(session!)));
  } catch (e) {
    if (e instanceof TrackerError) {
      return NextResponse.json({ error: e.message }, { status: STATUS[e.code] ?? 400 });
    }
    throw e;
  }
}
