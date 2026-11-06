// The audit log's "When" column, in SDC's local time.
//
// It used to be createdAt.toISOString().slice(0, 16), which is UTC with the
// trailing "Z" cut off — so it read like local time but ran 4-5 hours ahead, and
// an evening change showed under the next day's date. The zone is named
// explicitly rather than taken from the server, whose TZ is not guaranteed.
//
// Same "YYYY-MM-DD HH:mm" shape as before, so the grid's string sort still sorts
// by time.
const AUDIT_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function formatAuditWhen(d: Date): string {
  const p: Record<string, string> = {};
  for (const { type, value } of AUDIT_TIME.formatToParts(d)) p[type] = value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
