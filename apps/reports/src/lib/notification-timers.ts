// ── Per-card dismiss timers that survive the stack changing under them ───────
//
// REPORTED 2026-09-14: the change-notification cards never expired while changes
// kept arriving. ChangeNotifications scheduled one setTimeout per visible card in
// an effect keyed on `[groups]`, and `groups` is rebuilt on EVERY incoming event —
// so each event cleared every timer and started them all again from zero. On a
// busy month a card's seven seconds never elapsed.
//
// The fix is a timer PER CARD, created once when the card first appears and left
// alone until the card goes. This is the pure reconciliation behind it: given the
// cards that currently have timers and the cards that should, say which to start
// and which to stop. Nothing about an existing card's timer is touched.

export function reconcileTimers(
  running: Iterable<string>,
  wanted: Iterable<string>,
): { start: string[]; stop: string[] } {
  const have = new Set(running);
  const want = new Set(wanted);
  const start: string[] = [];
  const stop: string[] = [];
  for (const k of want) if (!have.has(k)) start.push(k);
  for (const k of have) if (!want.has(k)) stop.push(k);
  return { start, stop };
}
