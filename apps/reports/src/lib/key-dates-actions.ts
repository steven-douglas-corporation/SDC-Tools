"use server";

import { auth } from "@/lib/auth";
import { getKeyDates, KEY_DATE_ANCHORS, type KeyDatesResult } from "@/lib/dashboard-key-dates";

// Re-queries the Key Dates timeline when the chips or the month range change.
//
// Fetched on demand rather than shipped with the page: the Dashboard re-renders
// often (month arrows, realtime events), and the timeline's inputs are browser
// state. Sending all eight anchors across three months with every render would
// pay for a query nobody asked for.

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function loadKeyDates(from: string, to: string, anchors: string[]): Promise<KeyDatesResult> {
  // A server action is a public endpoint of its own, whatever calls it.
  const session = await auth();
  if (!session?.user) throw new Error("Not signed in.");
  if (!MONTH.test(from) || !MONTH.test(to)) throw new Error("Invalid month range.");
  // Inverted range read in the order that can match something, rather than
  // returning an empty timeline that looks like "no milestones".
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  // Bounded: an unbounded span would ask the Scheduler for every task it has.
  const months = (Number(hi.slice(0, 4)) - Number(lo.slice(0, 4))) * 12 + (Number(hi.slice(5)) - Number(lo.slice(5)));
  if (months > 23) throw new Error("Pick a range of two years or less.");

  const known = new Set(KEY_DATE_ANCHORS.map((a) => a.key as string));
  const wanted = [...new Set(anchors)].filter((a) => known.has(a));

  // The server decides "today", not the browser: a client clock that is days out
  // would paint done/late states that nobody else sees.
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return getKeyDates({ from: lo, to: hi, anchors: wanted, today });
}
