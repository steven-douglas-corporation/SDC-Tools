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
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  const prev = document.activeElement as HTMLElement | null;
  document.body.appendChild(ta);
  try {
    ta.select();
    ta.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
    prev?.focus?.();
  }
}
