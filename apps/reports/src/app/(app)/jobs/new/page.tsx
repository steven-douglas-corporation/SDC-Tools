import { redirect } from "next/navigation";

// The standalone New Job form was removed (job creation now happens inline
// from the Projects tab's "+ Add Project"). Kept as a redirect rather than
// just letting this fall through to the [id] dynamic route — that route's
// notFound() bubbles past this segment's layout (no not-found.tsx here),
// rendering outside the app shell as a blank page instead of a real 404.
export default function NewJobRedirectPage() {
  redirect("/jobs");
}
