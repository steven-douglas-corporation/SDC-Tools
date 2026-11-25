import type { NextRequest } from "next/server";
import { trackerApi } from "@/modules/tracker/api";
import { trackerDb } from "@/modules/tracker/db";
import { getTaskDetail } from "@/modules/tracker/service/task-detail";

// GET /api/tracker/projects/BIN/tasks/42 — one task in full: fields, forecast, what it waits on
// and what waits on it, comments and history.
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/tracker/projects/[key]/tasks/[number]">) {
  const { key, number } = await ctx.params;
  return trackerApi(async (actor) => {
    const t = await getTaskDetail(trackerDb, actor, key, /^\d+$/.test(number) ? Number(number) : NaN);
    // As above: leave out the lists that only the screen's forms need.
    const { statuses: _statuses, people: _people, buckets: _buckets, candidates: _candidates, ...task } = t;
    return { task };
  });
}
