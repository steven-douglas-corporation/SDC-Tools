import { test } from "node:test";
import assert from "node:assert/strict";
import { randomId } from "../src/lib/client-uuid";

// ── The bug these pin ───────────────────────────────────────────────────────
//
// `Submit {Month} Report` minted its idempotency key with a bare
// `crypto.randomUUID()`. That method is gated to SECURE CONTEXTS, and this app is
// served over plain HTTP on a LAN hostname (http://server-app1:4006) — where it is
// undefined, not merely different. It threw inside the confirmation dialog's click
// handler, above the "Submitting…" state and above the server call, so the button
// did nothing at all: no request, no message, no server log.
//
// It never reproduced on localhost (a secure context), and Node has
// `crypto.randomUUID`, so neither local verification nor the test suite could see
// it. THAT is why these tests take the platform's crypto away rather than trusting
// the one the runner happens to provide — the whole failure was an environment
// this app runs in and its tests did not.

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Swap `globalThis.crypto` for the duration of one test and always put it back,
// so a failure cannot leak a crippled crypto into every test that follows.
function withCrypto(replacement: unknown, run: () => void): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: replacement, configurable: true, writable: true });
  try {
    run();
  } finally {
    if (original) Object.defineProperty(globalThis, "crypto", original);
    else delete (globalThis as { crypto?: unknown }).crypto;
  }
}

// Real randomness, minus the secure-context-only method — i.e. exactly what a
// browser exposes on http://server-app1:4006.
const insecureContextCrypto = {
  getRandomValues: <T extends ArrayBufferView>(a: T): T => {
    const view = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    for (let i = 0; i < view.length; i++) view[i] = Math.floor(Math.random() * 256);
    return a;
  },
};

test("returns a well-formed v4 UUID on the platform's own crypto", () => {
  assert.match(randomId(), V4);
});

test("still returns a v4 UUID when randomUUID is missing — the production origin", () => {
  // The exact reported environment. This is the case that used to throw.
  withCrypto(insecureContextCrypto, () => {
    assert.equal(typeof (globalThis.crypto as Partial<Crypto>).randomUUID, "undefined");
    assert.match(randomId(), V4);
  });
});

test("the click handler's call cannot throw, whatever crypto is", () => {
  // The property that actually mattered: a throw here is invisible, because it
  // happens in an event handler before any state is set.
  for (const c of [insecureContextCrypto, {}, undefined, null]) {
    withCrypto(c, () => {
      assert.doesNotThrow(() => randomId(), `crypto = ${JSON.stringify(c)}`);
      assert.match(randomId(), V4);
    });
  }
});

test("a crypto that EXPOSES randomUUID but rejects it falls through instead of failing", () => {
  // Some embedded engines advertise the method and then refuse it. The whole point
  // of this module is that no crypto shape can produce a dead button.
  withCrypto(
    {
      randomUUID: () => {
        throw new Error("not available in this context");
      },
      ...insecureContextCrypto,
    },
    () => {
      assert.match(randomId(), V4);
    },
  );
});

test("a getRandomValues that throws still yields a usable id", () => {
  withCrypto(
    {
      getRandomValues: () => {
        throw new Error("nope");
      },
    },
    () => {
      assert.match(randomId(), V4);
    },
  );
});

test("ids are unique — it is a UNIQUE database key and the idempotency key", () => {
  // Across every path, not just the preferred one: a fallback that returned a
  // constant would turn the idempotency guard into "every month is a duplicate".
  for (const c of [undefined, insecureContextCrypto]) {
    withCrypto(c, () => {
      const seen = new Set<string>();
      for (let i = 0; i < 5000; i++) seen.add(randomId());
      assert.equal(seen.size, 5000);
    });
  }
});

test("the id fits the column it is stored in", () => {
  // MonthlyReportSubmission.submissionId is VARCHAR(64); a 36-char UUID clears it,
  // but a fallback that grew unbounded would be truncated into a collision.
  withCrypto(insecureContextCrypto, () => {
    assert.equal(randomId().length, 36);
  });
});
