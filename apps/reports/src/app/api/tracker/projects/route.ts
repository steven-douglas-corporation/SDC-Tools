import { trackerApi } from "@/modules/tracker/api";
import { trackerDb } from "@/modules/tracker/db";
import { listProjects } from "@/modules/tracker/service/queries";

// GET /api/tracker/projects — the projects the caller may see, in stack-rank order, each with
// its target, forecast, P80, at-risk flag and the work the forecast leaves out.
export async function GET() {
  return trackerApi(async (actor) => ({ projects: await listProjects(trackerDb, actor) }));
}
