"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

// The Standard Sheet used to sit behind a shared team password (the same
// "SDC" phrase every protected button in this app used, see
// button-password.ts). Retired 2026-08-18: Sales and ELT now see it because
// their ROLE grants standards:view/standards:edit, not because they typed a
// phrase anyone signed in could type. The function names stay the same on
// purpose — every call site (the /etc page, exports, execution-rate edits,
// month submission) already asked exactly the right question ("may this
// request see/change Standard Sheet data"), so only the answer's source
// changes, not the ~10 places that ask it.

/** May the signed-in user see the Standard Sheet columns and the Standard Fees card at all. */
export async function isStandardSheetUnlocked(): Promise<boolean> {
  const session = await auth();
  return hasPermission(session?.user?.role, "standards:view");
}

// Guard for every Standard Sheet mutation action — rendering hiding the grid
// is not enough, since server actions are directly callable by any signed-in
// user who captures the action IDs.
export async function assertStandardSheetUnlocked(): Promise<void> {
  const session = await auth();
  if (!hasPermission(session?.user?.role, "standards:edit")) {
    throw new Error("You don't have permission to edit the Standard Sheet.");
  }
}

// The "Standards" toggle's no-JavaScript fallback (StandardsVisibilityToggle)
// still posts to a real form action. There is no cookie to clear any more —
// visibility is role-derived and doesn't change per click — so this only
// exists so that submission doesn't error for a client that never hydrated;
// the JS path (hideStandardSheet/revealStandardSheet) never calls it.
export async function lockStandardSheet(): Promise<void> {
  revalidatePath("/etc");
}
