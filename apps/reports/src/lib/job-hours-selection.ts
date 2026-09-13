// ── The remembered Job Hour Details selection (2026-09-02) ──────────────────
//
// This is a COOKIE, and that is the whole point of the file.
//
// It used to be localStorage, read in a mount effect in JobSelect that then did
// `router.replace("?jobs=…")`. The server cannot read localStorage, so a bare
// landing on /job-hours rendered the server's data-richest default first —
// measured: job 1130 — and only then swapped to the job the user actually
// wanted. That is two full server renders, two sets of live Total ETO calls, and
// a visible frame of ANOTHER JOB'S hours, parts and procurement under a header
// that was about to say something else. On a page whose entire purpose is "how
// many hours has this job burned", showing a different job's figures for a
// moment is not a cosmetic problem.
//
// A cookie is sent with the document request, so the SAME resolution the client
// used to do after hydration now happens before the first byte is rendered. The
// first job-specific frame is the right job, and the wrong-job request does not
// happen at all — there is nothing to hide with a skeleton or a fade.
//
// Deliberately NOT a database column: this is a per-browser convenience, not a
// user preference the app owes durability to, and it must be readable during the
// render of a page that already resolves its selection from the URL.

/** Both halves of the app read this one name. */
export const JOB_HOURS_SELECTION_COOKIE = "jobhours-last-jobs";

/** The old localStorage key, kept only for the one-time migration in JobSelect. */
export const JOB_HOURS_SELECTION_LEGACY_KEY = "jobhours-last-jobs";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * Job ids out of a stored value. Total ETO job ids are short alphanumerics, so
 * anything else is treated as absent rather than trusted: this string arrives
 * from the browser, and the page uses it to pick which job's figures to show.
 * The caller still checks each id against the real job list — this only rejects
 * what could never be an id.
 */
export function parseSelectionCookie(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 32 && /^[A-Za-z0-9._-]+$/.test(s))
    .slice(0, 100); // The page's own PARTS_MAX_JOBS ceiling; a longer cookie is junk.
}

/**
 * A `document.cookie` assignment that remembers `jobIds` — or forgets them when
 * the selection is empty.
 *
 * Forgetting matters: clearing the picker means "deliberately nothing", and a
 * cookie that survived that would silently re-select the job the user just
 * removed on their next landing — the exact bug that got multi-select reverted
 * the first time (see JobSelect's header).
 */
export function selectionCookieAssignment(jobIds: string[]): string {
  const base = `${JOB_HOURS_SELECTION_COOKIE}=`;
  const attrs = "path=/; samesite=lax";
  if (jobIds.length === 0) return `${base}; ${attrs}; max-age=0`;
  return `${base}${encodeURIComponent(jobIds.join(","))}; ${attrs}; max-age=${ONE_YEAR_SECONDS}`;
}

/**
 * Browser-side: remember (or forget) this selection for the next landing.
 *
 * A function rather than an inline `document.cookie = …` at the call site
 * because the React Compiler's immutability rule refuses an assignment to a
 * global from inside a component — reasonably, since a render-phase write to
 * one would be a side effect. This is called from an event handler, where the
 * write is exactly what is wanted.
 */
export function rememberJobHoursSelection(jobIds: string[]): void {
  try {
    document.cookie = selectionCookieAssignment(jobIds);
  } catch {
    /* A browser refusing cookies loses the memory, not the page. */
  }
}
