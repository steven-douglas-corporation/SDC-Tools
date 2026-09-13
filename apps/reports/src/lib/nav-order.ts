// The sidebar's user-chosen link order, per group, kept in localStorage.
//
// Stored as hrefs rather than indexes: an index-based order silently points at
// the wrong link the moment a nav item is added or removed, and this list does
// change (Audit Log appears for admins, the Scheduler link depends on config).
// Hrefs are stable, and anything unrecognised is simply ignored.
//
// Reordering is WITHIN a group. The group headings — Overview, Work, Planning,
// Admin — are claims about what the links are, so moving "Projects" under "Work"
// would make the heading lie. If cross-group ordering is ever wanted, the groups
// themselves have to become the user's to name.

export type NavOrder = Record<string, string[]>; // group label -> ordered hrefs

const KEY = "sdc-nav-order-v1";
const EVENT = "sdc-nav-order-change";

// Stable empty value, so the server snapshot and the "nothing stored" case are
// referentially constant — useSyncExternalStore compares with Object.is and would
// re-render forever on a fresh object each read.
export const NO_NAV_ORDER: NavOrder = Object.freeze({}) as NavOrder;

// Parsed value cached against the raw string it came from, for the same reason.
let cachedRaw: string | null = null;
let cachedValue: NavOrder = NO_NAV_ORDER;

export function readNavOrder(): NavOrder {
  if (typeof window === "undefined") return NO_NAV_ORDER;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    return NO_NAV_ORDER; // storage blocked — fall back to the built-in order
  }
  if (raw === cachedRaw) return cachedValue;
  cachedRaw = raw;
  cachedValue = NO_NAV_ORDER;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      // Shape-checked rather than trusted: this is user-writable storage, and a
      // malformed value must degrade to the default order, not throw in render.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const clean: NavOrder = {};
        for (const [group, hrefs] of Object.entries(parsed as Record<string, unknown>)) {
          if (Array.isArray(hrefs) && hrefs.every((h) => typeof h === "string")) clean[group] = hrefs as string[];
        }
        cachedValue = clean;
      }
    } catch {
      /* keep the default */
    }
  }
  return cachedValue;
}

export function writeNavOrder(next: NavOrder): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    return; // nothing to do; the sidebar keeps working on the default order
  }
  // localStorage doesn't notify the tab that wrote it, hence the explicit event.
  window.dispatchEvent(new Event(EVENT));
}

export function clearNavOrder(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    return;
  }
  window.dispatchEvent(new Event(EVENT));
}

// `storage` covers the same app open in another tab.
export function subscribeNavOrder(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

// Order `items` by the stored hrefs for `group`.
//
// Two rules that matter more than the sorting itself:
//   • an href in the stored order that no longer exists is skipped, so a removed
//     page can't leave a hole or throw;
//   • an item NOT in the stored order is appended rather than dropped, so a nav
//     item added in a later release still appears for someone who reordered
//     months ago. Losing a link would be much worse than showing it last.
export function applyNavOrder<T extends { href: string }>(group: string, items: T[], order: NavOrder): T[] {
  const wanted = order[group];
  if (!wanted || wanted.length === 0) return items;
  const byHref = new Map(items.map((i) => [i.href, i]));
  const ordered: T[] = [];
  for (const href of wanted) {
    const item = byHref.get(href);
    if (item) {
      ordered.push(item);
      byHref.delete(href);
    }
  }
  for (const item of items) if (byHref.has(item.href)) ordered.push(item);
  return ordered;
}

// Move one item within a list, returning the new href order. Used by both the
// drag drop and the keyboard (Alt+Arrow) path so they cannot disagree.
export function moveItem<T extends { href: string }>(items: T[], from: number, to: number): string[] {
  const hrefs = items.map((i) => i.href);
  if (from === to || from < 0 || to < 0 || from >= hrefs.length || to >= hrefs.length) return hrefs;
  const [moved] = hrefs.splice(from, 1);
  hrefs.splice(to, 0, moved);
  return hrefs;
}
