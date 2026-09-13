import { auth } from "@/lib/auth";
import { subscribe } from "@/lib/realtime-hub";

// The server → browser event stream: presence updates and change notifications.
//
// force-dynamic and no caching: a stream that any layer decided to cache would
// serve one user's events to another, or replay them.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Signed in only. Presence names WHO is editing, and the change feed carries
  // real figures — neither is anonymous-safe.
  const session = await auth();
  if (!session?.user) return new Response("Unauthorized", { status: 401 });

  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return new Response("sessionId required", { status: 400 });

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      unsubscribe = subscribe(sessionId, send);

      // A comment line every 20s. Two reasons, both practical rather than
      // theoretical: proxies and antivirus web shields on this network will close
      // an idle connection, and without traffic the browser's own EventSource can
      // sit in a half-open state for minutes. A comment is not delivered to
      // onmessage, so it costs the client nothing.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          // Already closed; cancel() below does the cleanup.
        }
      }, 20_000);
    },
    cancel() {
      // Fires when the browser navigates away, closes the tab, or the connection
      // drops. Releasing the subscription here is what makes a disconnect clear
      // that user's editing indicators immediately rather than after the TTL.
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform, must-revalidate",
      Connection: "keep-alive",
      // Tells nginx (and other reverse proxies that honour it) not to buffer the
      // stream. Without it a proxy can hold events until its buffer fills, which
      // presents exactly as "realtime doesn't work".
      "X-Accel-Buffering": "no",
    },
  });
}
