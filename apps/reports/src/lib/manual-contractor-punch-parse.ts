import { normalizeFunctionId } from "@/lib/paylocity-canonical";
import { normalizeSectionId } from "@/lib/paylocity-standard-rules";
import { normalizeJobNumber } from "@/lib/job-filters";

// ── Paylocity transfer codes, parsed the way the workbook's are ─────────────
//
// A timecard's Transfer column reads like `211/1158/10/Concord`. The parts are:
//
//   FUNCTION / JOB / PHASE [/ LOCATION]
//     211      1158    10      Concord
//
// which the app already knows as section code `10-211` — phase-function, the
// same string paylocity-workbook.ts builds from its own MachineSec/Function
// columns. Confirmed against the app's existing code sets rather than assumed:
// `211/1145/40` -> 40-211 (Machine Testing ME & CE, a real SECTIONS row),
// `211/7000/80` -> 80-211 (a member of SERVICE_AND_SPARE_PARTS_CODES),
// `312/1160/10` -> 10-312 (System Design & Drawings). Every transfer in the
// supplied July/August timecards lands on a code the app already models.
//
// The JOB is the SECOND part, never the whole value and never the first — the
// leading 211/312 is the function. Getting that backwards would attribute every
// contractor hour to a job number that does not exist.
//
// ── Deliberately no contractor-specific mapping ─────────────────────────────
//
// The three ids come straight back out through normalizeSectionId /
// normalizeFunctionId / normalizeJobNumber — the identical functions the
// workbook reader uses — so a manual punch and a real one that describe the same
// work produce the same section, the same job and therefore the same department.
// There is no second mapping table anywhere, which is the point: this file
// translates a transfer STRING into the three fields the pipeline already takes,
// and then gets out of the way.
//
// Pure and dependency-light on purpose (no Prisma, no "server-only") so the seed
// script and a plain node:test can both load it.

export type ParsedTransfer = {
  /** Normalized job number, e.g. "1158". */
  jobNumber: string;
  /** Normalized phase / MachineSec, e.g. "10". */
  machineSec: string;
  /** Normalized function id, e.g. "211". */
  functionId: string;
  /** The 4th part when present ("Concord"), else "". */
  location: string;
  /** `${machineSec}-${functionId}` — the app's section code. */
  section: string;
};

/**
 * Parses one transfer value. Returns null when it does not have at least the
 * three required parts, so a malformed cell is REPORTED by the caller rather
 * than silently becoming a punch against job "" — the same "surface it, never
 * guess" rule the workbook reader follows for its own bad rows.
 */
export function parseTransferCode(raw: string): ParsedTransfer | null {
  const parts = raw
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length < 3) return null;

  const [fnRaw, jobRaw, phaseRaw, ...rest] = parts;
  const functionId = normalizeFunctionId(fnRaw);
  const machineSec = normalizeSectionId(phaseRaw);
  const jobNumber = normalizeJobNumber(jobRaw);
  // A blank on any of the three is not something to paper over: it would produce
  // a section like "-211" or a punch against no job, both of which the pipeline
  // would then have to classify as Undefined. Refuse and let the caller say so.
  if (!functionId || !machineSec || !jobNumber) return null;

  return {
    jobNumber,
    machineSec,
    functionId,
    location: rest.join("/"),
    section: `${machineSec}-${functionId}`,
  };
}
