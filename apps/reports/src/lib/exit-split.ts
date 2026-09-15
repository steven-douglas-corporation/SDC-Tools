import { closePaneHref, type SplitState } from "@/lib/split-view";
import { exitSplit, type Workspace } from "@/lib/workspace";

// ── What "Exit Split View" should do, for either layout ──────────────────────
//
// REPORTED 2026-09-14: the sidebar's Exit Split View button threw a TypeError in
// the workspace. It always did `closePaneHref(splitNav.state!, …)`, but
// useSplitNav sets `state` only on /split, while `isSplit` — which is what showed
// the button — is also true for a /w workspace split. So on /w the button rendered,
// and clicking it dereferenced null.
//
// The two layouts end a split differently: /split is a URL (the surviving pane's
// own route), /w is a state change (exitSplit, applied to the live workspace with
// no navigation at all). One pure decision, so the sidebar cannot pick the wrong
// mechanism again, and so the rule is testable without a click.
//
// The ACTIVE pane survives in both cases — "the pane you are working in is the one
// that survives", which is also what Ctrl+\ does in WorkspaceShell.

export type ExitSplitPlan =
  | { kind: "workspace"; next: Workspace }
  | { kind: "split"; href: string }
  | null;

export function exitSplitPlan(workspace: Workspace | null | undefined, split: SplitState | null | undefined): ExitSplitPlan {
  // The workspace is checked first: useSplitNav resolves the two by pathname, so
  // they are never both present, but if they ever were the live one is the truth.
  if (workspace?.split) return { kind: "workspace", next: exitSplit(workspace, workspace.active) };
  if (split?.r) return { kind: "split", href: closePaneHref(split, split.active === "l" ? "r" : "l") };
  return null;
}
