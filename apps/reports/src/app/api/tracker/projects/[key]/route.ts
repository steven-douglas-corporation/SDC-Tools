import type { NextRequest } from "next/server";
import { trackerApi } from "@/modules/tracker/api";
import { trackerDb } from "@/modules/tracker/db";
import { getBoard } from "@/modules/tracker/service/queries";

// GET /api/tracker/projects/BIN — one project: its statuses and its tasks, each task with its
// forecast dates and the reason behind them. A project the caller is not on answers 404, the
// same as one that does not exist.
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/tracker/projects/[key]">) {
  const { key } = await ctx.params;
  return trackerApi(async (actor) => {
    const board = await getBoard(trackerDb, actor, key);
    // The people and size lists exist for the screen's forms; an API caller asked for the project.
    return { project: board.project, forecastAsOf: board.forecastAsOf, statuses: board.statuses, tasks: board.tasks };
  });
}
