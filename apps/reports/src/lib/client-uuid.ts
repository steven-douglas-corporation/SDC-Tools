// ── A UUID the BROWSER can generate, on this app's actual origin ────────────
//
// `crypto.randomUUID()` is gated to SECURE CONTEXTS. That is HTTPS or `localhost`
// — and this app is served over plain HTTP on a LAN hostname
// (AUTH_URL="http://server-app1:4006"), which is neither. On that origin the
// method does not merely misbehave, it is UNDEFINED:
//
//     isSecureContext            false
//     typeof crypto.randomUUID   "undefined"
//     crypto.randomUUID()        TypeError: crypto.randomUUID is not a function
//
// (Measured 2026-08-09 in a browser on http://10.0.0.7:3021, the same shape of
// origin as production. `crypto.getRandomValues` is NOT gated and is still a
// function there, which is what this module is built on. `crypto.subtle` is
// gated too — do not reach for it in client code.)
//
// ── The bug this exists to end ──────────────────────────────────────────────
//
// `Submit {Month} Report` called `crypto.randomUUID()` directly, in the
// confirmation dialog's click handler, to mint the submission's idempotency key.
// On the real deployment that threw synchronously — before the "Submitting…"
// state was set and before the server action was called — so the one
// irreversible button in the app did NOTHING AT ALL when clicked. No request, no
// error on screen, no server log; just an uncaught TypeError in the console and a
// dialog sitting there looking functional.
//
// It never reproduced on `localhost`, which is a secure context, so it survived
// local verification and a full test suite (Node has `crypto.randomUUID`).
//
// ── Why not just let the server mint the id ─────────────────────────────────
//
// Because the id has to survive a RETRY. The client generates it once per attempt
// and re-sends the same one, which is exactly what makes a double-click or a
// retried request idempotent instead of a second submission (§26.9, §26.16 #17).
// A server-minted id would be new on every request and would throw that away.
//
// Dependency-free on purpose, so `tsx --test` can load it directly, and so it
// costs the client bundle nothing but these few lines.

// Byte -> two lowercase hex chars, built once. Avoids a per-byte
// `toString(16).padStart(2, "0")` and keeps the formatting in one place.
const HEX: readonly string[] = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1));

// 16 bytes -> canonical 8-4-4-4-12. The caller must already have stamped the
// version and variant bits; this only formats.
function formatUuid(b: Uint8Array): string {
  return (
    HEX[b[0]] + HEX[b[1]] + HEX[b[2]] + HEX[b[3]] + "-" +
    HEX[b[4]] + HEX[b[5]] + "-" +
    HEX[b[6]] + HEX[b[7]] + "-" +
    HEX[b[8]] + HEX[b[9]] + "-" +
    HEX[b[10]] + HEX[b[11]] + HEX[b[12]] + HEX[b[13]] + HEX[b[14]] + HEX[b[15]]
  );
}

// RFC 4122 §4.4: version 4 in the high nibble of byte 6, variant 10xx in the
// top bits of byte 8. Applied identically whichever source filled the bytes, so
// every path below returns a well-formed v4 UUID and the database cannot tell
// which one produced it.
function stampV4(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}

/**
 * A v4 UUID, on any origin, in any browser this app runs in.
 *
 * THIS FUNCTION MUST NEVER THROW. It is called from a click handler on the one
 * irreversible action in the app, and a throw there is invisible — see the note
 * at the top of this file. Every step degrades to the next instead of failing.
 *
 * Quality, in order of preference:
 *   1. `crypto.randomUUID()`      — secure contexts, and Node (so tests and any
 *                                   server caller get the platform's own).
 *   2. `crypto.getRandomValues()` — NOT secure-context gated, so this is the path
 *                                   the real deployment takes. Cryptographically
 *                                   strong; identical output shape.
 *   3. `Math.random()`            — last resort, should be unreachable in any
 *                                   browser this app supports (Chrome 111+ per
 *                                   Next 16's baseline). Present so that "we
 *                                   could not find an RNG" degrades to a working
 *                                   button rather than a dead one.
 *
 * Collision risk at step 3 is irrelevant in practice here: the id keys ONE
 * submission attempt, of which this app performs a handful a month, and the
 * column is UNIQUE so a collision would be refused rather than silently merged.
 */
export function randomId(): string {
  const c: Crypto | undefined =
    typeof globalThis !== "undefined" ? (globalThis.crypto as Crypto | undefined) : undefined;

  if (c && typeof c.randomUUID === "function") {
    try {
      return c.randomUUID();
    } catch {
      // Some embedded/older engines expose it and reject it. Fall through.
    }
  }

  if (c && typeof c.getRandomValues === "function") {
    try {
      return stampV4(c.getRandomValues(new Uint8Array(16)));
    } catch {
      // Fall through.
    }
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return stampV4(bytes);
}
