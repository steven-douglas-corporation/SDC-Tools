/**
 * Copy text to the clipboard. `navigator.clipboard` only exists in secure
 * contexts (https / localhost); the deployment is served over plain http, so
 * fall back to a hidden textarea + `execCommand("copy")`. Resolves true when
 * the text was copied.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* permission denied / blocked — try the legacy path */
  }
  if (typeof document === "undefined") return false;
  const prev = document.activeElement as HTMLElement | null;
  // Mount inside the open modal (if any) so a focus trap or inert backdrop on
  // <body> can't stop the selection; fall back to <body>.
  const host = prev?.closest<HTMLElement>('[role="dialog"], dialog') ?? document.body;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("aria-hidden", "true");
  ta.tabIndex = -1;
  ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;font-size:16px";
  host.appendChild(ta);
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    host.removeChild(ta);
    prev?.focus?.({ preventScroll: true });
  }
}
