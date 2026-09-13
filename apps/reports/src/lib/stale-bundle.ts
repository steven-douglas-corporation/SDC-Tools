// ── "Failed to load chunk …" is a STALE TAB, not an application fault (§70) ──
//
// Reported 2026-08-06 as a red "Submission rejected" panel reading:
//
//     Failed to load chunk /_next/static/chunks/3q20900fw39rz.js from module 964893
//     Nothing was saved — fix the value above and submit again.
//
// Every part of that advice was wrong. Nothing had been submitted, there was no "value
// above" (the grid had not rendered), and pressing the button — which called `reset()`,
// re-rendering the same segment — asked the browser for the same missing file again.
//
// ── What actually happens ────────────────────────────────────────────────────
//
// The app splits its JavaScript into content-hashed chunks. A tab that has been open
// across a deploy (or, in development, across a rebuild) is holding a build manifest
// naming chunks the server has since replaced. The moment that tab needs a chunk it has
// not already downloaded — opening a drill, a menu, any lazily-loaded component — it
// requests a filename that no longer exists and gets a 404.
//
// So it is not a data error, an upstream outage or a rejected write. It is one tab
// running a build the server no longer serves, and the only fix is a document reload:
// that re-fetches the manifest and the tab is current again. `reset()` cannot fix it,
// which is why a boundary that only offers `reset()` leaves the user stuck.
//
// ── Why this is a matcher on strings ────────────────────────────────────────
//
// There is no stable error CODE for it. The wording comes from whichever bundler and
// browser are in play, and this app has already seen two of them (Turbopack's "Failed to
// load chunk … from module", webpack's "Loading chunk N failed"). Matching a list of
// phrasings is unlovely but it is the only signal available, so the list is explicit,
// case-insensitive, and tested — rather than one regex nobody can audit.
//
// Deliberately dependency-free: the error boundaries that use it are client components,
// and `tsx --test` has to be able to load it.

/**
 * The phrasings a missing/failed JS or CSS chunk arrives as. Kept as separate entries
 * with the source named, so adding one later is obviously safe and removing one is
 * obviously a decision.
 */
const STALE_BUNDLE_SIGNS: readonly string[] = [
  "failed to load chunk", // Turbopack / Next 16 — the reported case
  "loading chunk", // webpack: "Loading chunk 437 failed"
  "loading css chunk", // webpack, stylesheets
  "failed to fetch dynamically imported module", // native ESM (Chrome, Firefox)
  "error loading dynamically imported module", // native ESM, alternate wording
  "importing a module script failed", // Safari
  "unable to preload css", // Next/Vite stylesheet preload
  // 2026-08-19: a Server Action is a different kind of "stale tab" than a
  // missing chunk, but the same root cause — a tab open across a dev-server
  // recompile (or a prod deploy) holds an action reference ID the server no
  // longer registers, and calling it throws this exact wording rather than a
  // chunk-load failure. Reported live: T&M's "Detail" drill-throughs (whose
  // server actions had just been edited repeatedly this session) crashing the
  // whole page instead of showing the drill-scoped error they should. Same
  // fix as a stale chunk: only a reload re-fetches a build that HAS the
  // action registered — reset() calls the identical stale reference again.
  "failed to find server action",
  "this request might be from an older or newer deployment",
];

/** `ChunkLoadError` is webpack's own error NAME, which survives message rewording. */
const STALE_BUNDLE_NAMES: readonly string[] = ["chunkloaderror"];

/**
 * True when this error means "your tab is running an old build", rather than anything
 * about the data or the request.
 *
 * Takes `unknown` because an error boundary's `error` is only typed as `Error` by
 * convention — a thrown string or a rejected non-Error reaches it just as easily, and a
 * detector that assumed `.message` existed would itself throw inside the boundary.
 */
export function isStaleBundleError(error: unknown): boolean {
  const name = typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : "";
  if (STALE_BUNDLE_NAMES.includes(name.toLowerCase())) return true;

  const message =
    typeof error === "string"
      ? error
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : "";
  const haystack = message.toLowerCase();
  return STALE_BUNDLE_SIGNS.some((sign) => haystack.includes(sign));
}

/** What to tell someone whose tab is out of date. One wording, both boundaries. */
export const STALE_BUNDLE_TITLE = "This tab is running an older version";
export const STALE_BUNDLE_BODY =
  "The application was updated while this tab was open, so part of it could no longer be downloaded. " +
  "Nothing was saved or changed. Reload to pick up the current version.";
