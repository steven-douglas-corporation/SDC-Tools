// A project's key: the short code in its address and in every card number (VISION-5). These
// are the rules for one, and a plain way to make one from a name. No imports, so the browser
// and the server use the same code.

export const KEY_MAX = 8;

/** Words that carry no meaning in a name, left out when a key is made from initials. */
const FILLER = new Set(["a", "an", "the", "of", "for", "and", "to", "in", "on", "with", "from", "by", "sdc"]);

/** Anything typed, made into what a key may hold: capitals and digits, 8 at most. */
export function cleanKey(text: string): string {
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, KEY_MAX);
}

/** Whether a key is well formed: 2 to 8 capitals or digits, starting with a letter. */
export function isKey(key: string): boolean {
  return /^[A-Z][A-Z0-9]{1,7}$/.test(key);
}

/**
 * `base` if nobody has it, otherwise `base` with the lowest number that makes it free
 * (VISION, VISION2, VISION3). The number takes the place of the last letters when there is no
 * room for it.
 */
export function freeKey(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((k) => k.toUpperCase()));
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const tail = String(n);
    const candidate = base.slice(0, KEY_MAX - tail.length) + tail;
    if (!used.has(candidate)) return candidate;
  }
  return base;
}

/**
 * A key made from a project's name by rule, or "" when the name gives nothing to work with.
 * A one-word name is that word; a longer one is its initials, or its first word when the
 * initials would be too short to mean anything. It is a starting point: the person can type
 * over it, and where an AI suggestion is available that replaces it.
 */
export function keyFromName(name: string, taken: Iterable<string> = []): string {
  const all = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const meaningful = all.filter((w) => !FILLER.has(w.toLowerCase()));
  // A name made only of filler words still gets a key from them.
  const words = meaningful.length > 0 ? meaningful : all;
  if (words.length === 0) return "";
  const first = cleanKey(words[0]!);
  const initials = cleanKey(words.map((w) => w[0]).join(""));
  let base = words.length === 1 ? first : initials.length >= 3 ? initials : first;
  base = base.replace(/^[0-9]+/, "");
  if (base.length < 2) base = (base + first.replace(/^[0-9]+/, "")).slice(0, KEY_MAX);
  if (!isKey(base)) return "";
  return freeKey(base, taken);
}
