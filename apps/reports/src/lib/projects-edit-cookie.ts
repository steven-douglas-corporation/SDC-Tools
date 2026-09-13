// The name of the Projects Edit Mode cookie, in a plain module so both sides can
// import it: the toolbar switch writes it in the browser, and the server-side
// guard in projects-edit-mode.ts reads it. It can't live in that file — a
// "use server" module may only export async functions, so a shared constant
// there is a build error.
//
// See projects-edit-mode.ts for what this cookie does and does not mean.
export const PROJECTS_EDIT_COOKIE = "projects-edit-mode";

// Session cookie (no Max-Age/Expires): closing the browser returns you to
// read-only. SameSite=Lax matches the httpOnly cookies the app sets elsewhere.
export function writeProjectsEditCookie(on: boolean): void {
  document.cookie = on
    ? `${PROJECTS_EDIT_COOKIE}=1; path=/; samesite=lax`
    : `${PROJECTS_EDIT_COOKIE}=; path=/; samesite=lax; max-age=0`;
}
