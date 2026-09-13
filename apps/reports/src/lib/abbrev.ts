// Display-only abbreviations for long domain words in fixed UI band labels
// (per the SDC brand guide's short-form convention). This runs at RENDER time
// on group/phase header labels ONLY — the underlying values (e.g. "Engineering"
// / "General Engineering" / "Shop") stay intact as logic keys (billing-group
// comparisons, color maps, filter params). Never run this on data-driven text
// (job names, part/BOM descriptions, supplier/customer values).
const RULES: readonly [RegExp, string][] = [
  [/\bGeneral Engineering\b/gi, "Gen Eng"],
  [/\bEngineering\b/gi, "Eng"],
  [/\bMechanical\b/gi, "Mech"],
  [/\bElectrical\b/gi, "Elec"],
  [/\bManufacturing\b/gi, "Mfg"],
  // BEFORE the bare-Management rule, and before \bGeneral\b, so the full
  // canonical label collapses to the initialism rather than to "Project Mgmt
  // (PM)" — which is both longer and says PM twice.
  [/\bProject Management \(PM\)/gi, "PM"],
  [/\bManagement\b/gi, "Mgmt"],
  [/\bGeneral\b/gi, "Gen"],
  // Added 2026-08-24. "Programming" is the only word in SECTIONS long enough to
  // overflow the Projects grid's fixed 72px column — HMI/Robot/Vision/Device
  // Programming all did, and globals.css deliberately refuses to break a word in
  // a label ("the fix is always a wider column, a shorter label or a smaller
  // font"), so those four headers overflowed into each other instead. This is the
  // shorter label. After it the longest single word left in any section name is
  // "Software"/"Drawings" at 8 characters — exactly what that column width was
  // measured against, so nothing overflows.
  [/\bProgramming\b/gi, "Prog"],
];

export function abbreviateLabel(s: string): string {
  let out = s;
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}
