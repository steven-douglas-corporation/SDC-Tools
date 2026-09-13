import { auth } from "@/lib/auth";
import { enterCell, leaveAll, leaveCell } from "@/lib/realtime-hub";

// Browser → server presence signals. Three verbs, matching spec 3's clearing rule:
//
//   enter — focused a cell, or still in it (heartbeat)
//   leave — blurred, saved, or cancelled that one cell
//   leaveAll — tab hidden or unloading, release everything this session holds
//
// A POST rather than riding the SSE stream, which is server → client only. Small,
// frequent and fire-and-forget, so it is sent with navigator.sendBeacon where the
// page may be going away (see useRealtime).
export const dynamic = "force-dynamic";

type Body = {
  sessionId?: unknown;
  action?: unknown;
  tab?: unknown;
  rowRef?: unknown;
  columnName?: unknown;
  cellKey?: unknown;
};

const str = (v: unknown, max = 120): string => (typeof v === "string" ? v.slice(0, max) : "");

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return new Response("Unauthorized", { status: 401 });

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const sessionId = str(body.sessionId, 64);
  const action = str(body.action, 16);
  if (!sessionId) return new Response("sessionId required", { status: 400 });

  // The display name comes from the SESSION, never from the request body — a
  // client must not be able to claim it is somebody else in a presence indicator.
  const user = session.user as { email?: string | null; name?: string | null };
  const userName = user.name?.trim() || user.email?.split("@")[0] || "Unknown user";

  if (action === "leaveAll") {
    leaveAll(sessionId);
    return new Response(null, { status: 204 });
  }

  const cellKey = str(body.cellKey, 160);
  if (!cellKey) return new Response("cellKey required", { status: 400 });

  if (action === "leave") {
    leaveCell(sessionId, cellKey);
    return new Response(null, { status: 204 });
  }

  if (action === "enter") {
    enterCell({
      sessionId,
      userName,
      tab: str(body.tab, 40),
      rowRef: str(body.rowRef, 80),
      columnName: str(body.columnName, 60),
      cellKey,
    });
    return new Response(null, { status: 204 });
  }

  return new Response("Unknown action", { status: 400 });
}
