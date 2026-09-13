import type { Session } from "next-auth";
import { requirePagePermission, assertActionPermission } from "@/lib/require-permission";

// Cash Flow Forecast used to check `session.user.role !== "ELT"` directly,
// deliberately bypassing hasPermission() so that no Role Permissions checkbox
// could widen access to it — the page was ELT-only by explicit request.
//
// It is a normal permission now (2026-09-01, by request): `cash-flow:view`, a
// real row in the matrix. Access is UNCHANGED — the migration seeds that row
// FALSE for ALL/MANAGER/PM/SALES, and ELT passes through hasPermission()'s
// wildcard exactly as it passed the role comparison before — but widening it
// is now a deliberate click by someone with permissions:manage rather than an
// edit to this file.
//
// These two wrappers stay rather than being inlined at the call sites: the page
// and its server actions must be gated on the SAME permission, and a named pair
// is harder to get half-right than two loose hasPermission() calls would be.

export async function requireEltOnly(): Promise<Session> {
  return requirePagePermission("cash-flow:view");
}

export async function assertEltOnlyAction(): Promise<Session> {
  return assertActionPermission("cash-flow:view");
}
