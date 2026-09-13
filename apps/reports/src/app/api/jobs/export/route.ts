import { auth } from "@/lib/auth";

// ── Retired: use /api/export/projects instead (§24, 2026-08-04) ──────────────
//
// This URL used to return the whole job list as a seven-column CSV, and it had NO
// authentication check of its own — the entire project list was one unauthenticated
// request away, and it ignored the Projects page's filters entirely.
//
// It is a 410 rather than a deletion because the URL has been shipping in the Jobs
// page's "Export CSV" link for months: a bookmark or a script pointed at it deserves a
// sentence explaining where the data went, not a bare 404. (It is also what keeps the
// generated route-type validator honest while a dev server holds its build output open.)
//
// The replacement exports the FILTERED view of either grid, as .xlsx or .csv, checks the
// session, and writes an audit row:
//
//     /api/export/projects?format=xlsx&<the Projects page's query string>
//     /api/export/etc?format=csv&month=2026-07
export async function GET() {
  // Authenticated even though it returns no data: an unauthenticated endpoint that
  // answers questions about the app's shape is the habit worth not keeping.
  const session = await auth();
  if (!session?.user) return new Response("Not signed in.", { status: 401 });
  return new Response(
    "This export endpoint has been replaced. Use /api/export/projects?format=xlsx (or format=csv), " +
      "which exports the Projects grid as currently filtered — the Export button on the Projects page does this for you.",
    { status: 410, headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
}
