/**
 * validator.js — post-generation checks for AI-generated L5X.
 *
 * Pure functions, no API access needed. Reusable from the self-repair loop
 * (client.js), the /api/generate endpoint, and the CLI test harness.
 *
 * Checks:
 *   1. XML well-formedness (fast-xml-parser XMLValidator — real parser,
 *      not regex tag balancing)
 *   2. Every rung-text root identifier resolves against: declared tags
 *      (controller + program scope), AOI names, instruction mnemonics,
 *      context \Program references, or S: system tags
 *   3. MOVE(n, Control.StateReg) targets are within the legal SDC state set
 *   4. L5K string data LEN consistency ([LEN,'text'] pairs)
 *
 * Report shape: { ok: boolean, errors: string[], warnings: string[] }
 */

const { XMLValidator } = require('fast-xml-parser');

// ── Instruction mnemonics (standard Logix RLL) ──────────────────────────────
const MNEMONICS = new Set([
  'XIC', 'XIO', 'OTE', 'OTL', 'OTU', 'ONS', 'OSR', 'OSF',
  'TON', 'TOF', 'RTO', 'RES', 'CTU', 'CTD',
  'MOV', 'MOVE', 'MVM', 'COP', 'CPS', 'FLL', 'CLR', 'SWPB',
  'ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'NEG', 'ABS', 'SQR', 'CPT',
  'EQU', 'NEQ', 'GRT', 'GEQ', 'LES', 'LEQ', 'LIM', 'MEQ', 'CMP',
  // Neutral-text forms emitted by Studio 5000 exports
  'EQ', 'NE', 'GT', 'GE', 'LT', 'LE', 'LIMIT',
  'AND', 'OR', 'XOR', 'NOT',
  'JSR', 'RET', 'SBR', 'JMP', 'LBL', 'NOP', 'AFI', 'TND', 'UID', 'UIE',
  'GSV', 'SSV', 'MSG', 'IOT', 'EVENT',
  'BTD', 'DTOS', 'STOD', 'RTOS', 'STOR', 'CONCAT', 'FIND', 'MID', 'DELETE', 'INSERT',
  // Motion
  'MSO', 'MSF', 'MASD', 'MASR', 'MAFR', 'MAS', 'MAH', 'MAJ', 'MAM', 'MAG',
  'MCD', 'MRP', 'MAOC', 'MDOC', 'MGS', 'MGSD', 'MGSR', 'MGSP',
]);

// Instructions whose leading operands are not tag references.
// value = set of argument indices to SKIP root-identifier resolution for.
const SKIP_ARGS = {
  JSR: 'routine-first',       // arg0 is a routine name; rest are param counts/params
  SBR: 'all',
  RET: 'all',
  JMP: 'all',                 // label name
  LBL: 'all',                 // label name
  GSV: new Set([0, 2]),       // ClassName, AttributeName (InstanceName may be a tag)
  SSV: new Set([0, 2]),
  MSG: new Set(),
};

// Motion instructions carry enumerated keyword operands ("Trapezoidal",
// "Units per sec", "Jog", ...) that are not tag references.
const MOTION_INSTRUCTIONS = new Set([
  'MSO', 'MSF', 'MASD', 'MASR', 'MAFR', 'MAS', 'MAH', 'MAJ', 'MAM', 'MAG',
  'MCD', 'MRP', 'MAOC', 'MDOC', 'MGS', 'MGSD', 'MGSR', 'MGSP',
]);
const MOTION_ENUM_WORDS = new Set([
  'Forward', 'Reverse', 'Trapezoidal', 'S-Curve', 'Disabled', 'Enabled',
  'None', 'Jog', 'Yes', 'No', 'All', 'Move', 'Gear', 'Home', 'Tune', 'Test',
  'Absolute', 'Incremental', 'Actual', 'Command', 'Programmed', 'Immediate',
  'Fast', 'Slow', 'Coarse', 'Fine', 'Unidirectional', 'Bidirectional',
  'Rotary', 'Linear', 'DEC',
]);

const LEGAL_EXTRA_STATES = new Set([0, 1, 2, 3, 99]);
/** 'ok' = on the SDC grid; 'offgrid' = in sequence range but not on the
 *  4/7/10... grid (the standard's own indexer templates do this — warning);
 *  'illegal' = outside every legal range (hard error). */
function classifyState(n) {
  if (LEGAL_EXTRA_STATES.has(n)) return 'ok';
  if (n >= 100 && n <= 127) return 'ok';                       // init block + cycle-ready
  if (n >= 4 && n <= 97) return (n - 4) % 3 === 0 ? 'ok' : 'offgrid'; // 4, 7, 10 ... 97
  return 'illegal';
}
function isLegalState(n) { return classifyState(n) !== 'illegal'; }

// ── Declaration harvesting (regex over raw XML — attribute-order safe) ──────

function collectAll(re, text, group = 1) {
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[group]);
  return out;
}

/** Strip AOI definitions so their local rungs/params don't pollute scope. */
function sliceOut(xml, openTag, closeTag) {
  const start = xml.indexOf(openTag);
  if (start === -1) return xml;
  const end = xml.indexOf(closeTag, start);
  if (end === -1) return xml;
  return xml.slice(0, start) + xml.slice(end + closeTag.length);
}

function harvestDeclarations(xml) {
  const aoiNames = new Set(collectAll(
    /<AddOnInstructionDefinition\b[^>]*\bName="([^"]+)"/g, xml));

  // Remove the AOI definitions section before harvesting tags/programs,
  // so AOI-local tags and logic are not treated as globally declared.
  const aoiStart = xml.indexOf('<AddOnInstructionDefinitions');
  const aoiEnd = xml.indexOf('</AddOnInstructionDefinitions>');
  const scopeXml = (aoiStart !== -1 && aoiEnd !== -1)
    ? xml.slice(0, aoiStart) + xml.slice(aoiEnd + '</AddOnInstructionDefinitions>'.length)
    : xml;

  const tags = new Set(collectAll(/<Tag\b[^>]*\bName="([^"]+)"/g, scopeXml));
  const programs = new Set(collectAll(/<Program\b[^>]*\bName="([^"]+)"/g, scopeXml));
  const routines = new Set(collectAll(/<Routine\b[^>]*\bName="([^"]+)"/g, scopeXml));

  return { tags, aoiNames, programs, routines };
}

// ── Rung extraction (Programs section only — never AOI logic) ───────────────

function extractRungs(xml) {
  const progStart = xml.indexOf('<Programs');
  const progEnd = xml.lastIndexOf('</Programs>');
  const section = progStart !== -1 && progEnd !== -1
    ? xml.slice(progStart, progEnd)
    : xml;

  const rungs = [];
  // Track routine context for readable error messages.
  const routineRe = /<Routine\b[^>]*\bName="([^"]+)"|<Text>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/Text>/g;
  let currentRoutine = '(unknown routine)';
  let m;
  while ((m = routineRe.exec(section)) !== null) {
    if (m[1] !== undefined) currentRoutine = m[1];
    else if (m[2] !== undefined) rungs.push({ routine: currentRoutine, text: m[2].trim() });
  }
  return rungs;
}

// ── Rung-text parsing ────────────────────────────────────────────────────────

/** Split an instruction argument list on top-level commas. */
function splitArgs(argText) {
  const args = [];
  let depth = 0, cur = '', inStr = false;
  for (let i = 0; i < argText.length; i++) {
    const c = argText[i];
    if (inStr) {
      cur += c;
      if (c === '$') { cur += argText[++i] || ''; continue; }
      if (c === "'") inStr = false;
      continue;
    }
    if (c === "'") { inStr = true; cur += c; continue; }
    if (c === '[' || c === '(') depth++;
    if (c === ']' || c === ')') depth--;
    if (c === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '') args.push(cur.trim());
  return args;
}

/** Extract instruction calls NAME(args) from a rung, ignoring branch brackets. */
function extractInstructions(rungText) {
  const calls = [];
  const re = /([A-Za-z_][A-Za-z0-9_]*)\(/g;
  let m;
  while ((m = re.exec(rungText)) !== null) {
    // find matching close paren
    let depth = 1, i = re.lastIndex, inStr = false;
    while (i < rungText.length && depth > 0) {
      const c = rungText[i];
      if (inStr) { if (c === '$') i++; else if (c === "'") inStr = false; }
      else if (c === "'") inStr = true;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    calls.push({ name: m[1], args: splitArgs(rungText.slice(re.lastIndex, i - 1)) });
    re.lastIndex = i;
  }
  return calls;
}

/**
 * Extract root identifiers from one operand.
 * Roots = identifiers at path starts: the leading identifier, and any
 * identifier immediately following '[' or an arithmetic operator.
 * Identifiers after '.' are structure members and are not resolved.
 * Returns { roots: [...], programs: [...] } where programs are \Name refs.
 */
function operandRoots(operand) {
  const roots = [], programRefs = [];
  let expectRoot = true;
  // eslint-disable-next-line no-useless-escape -- upstream tokenizer regex; escaped / and [ inside character classes are harmless
  const re = /(S:[A-Za-z0-9\/]+)|(\\)?([A-Za-z_][A-Za-z0-9_]*)|(\d[#\w.]*|\.\d+)|([.\[\]()+\-*\/%<>=, ])|('(?:\$.|[^'$])*')/g;
  let m;
  while ((m = re.exec(operand)) !== null) {
    if (m[1] !== undefined) { expectRoot = false; continue; }       // S: system tag
    if (m[6] !== undefined) { expectRoot = false; continue; }       // string literal
    if (m[4] !== undefined) { expectRoot = false; continue; }       // numeric literal
    if (m[5] !== undefined) {
      const c = m[5];
      if (c === '.') expectRoot = false;
      else if (c !== ']' && c !== ')') expectRoot = true;            // '[', ops, space, comma
      continue;
    }
    // identifier
    if (m[2]) { programRefs.push(m[3]); expectRoot = false; continue; }
    if (expectRoot) roots.push(m[3]);
    expectRoot = false;
  }
  return { roots, programRefs };
}

// ── L5K string LEN check ─────────────────────────────────────────────────────

/** Decoded character count of an L5K string body ('$' escapes = 1 char). */
function l5kDecodedInfo(body) {
  let count = 0;
  const chars = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '$') {
      const next2 = body.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(next2)) { chars.push(next2.toUpperCase()); i += 2; }
      else { chars.push('ESC' + body[i + 1]); i += 1; }
    } else chars.push(body[i]);
    count++;
  }
  return { count, chars };
}

function checkL5kStrings(xml, errors) {
  // [LEN,'body'] pairs — the L5K serialization of STRING-family values.
  const re = /\[(\d+),'((?:\$.|[^'$])*)'\]/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const len = parseInt(m[1], 10);
    const { count, chars } = l5kDecodedInfo(m[2]);
    if (count === len) continue;
    // Allow zero padding past LEN (exports pad STRING buffers with $00)
    if (count > len && chars.slice(len).every(c => c === '00')) continue;
    errors.push(
      `L5K string LEN mismatch: declared LEN=${len} but content decodes to ` +
      `${count} chars — [${m[1]},'${m[2].length > 60 ? m[2].slice(0, 60) + '…' : m[2]}']`);
  }
}

// ── Exitless-wait check (Rule 11) ────────────────────────────────────────────
//
// A "wait-style" transition is an R02 rung that MOVEs to a new state but is
// conditioned on something beyond the current state + always-available gates
// (SS_OK, DryRun, FaultReset, mode bits). If nothing can force that condition
// (no alarm/fault-timer rung in R20 references the waiting state), the machine
// can hang there silently — the exact defect the Machine Spec rule forbids.

const WAIT_EXEMPT_IDENTS = new Set([
  'SS_OK', 'DryRun', 'Lockout', 'FaultReset', 'Initialized', 'CycleRunning',
  'PartStarted', 'AutoMode', 'ManualMode',
]);

function checkExitlessWaits(rungs, warnings) {
  const r02Rungs = rungs.filter(r => /R02/i.test(r.routine));
  const alarmBlob = rungs.filter(r => /R20|Alarm/i.test(r.routine)).map(r => r.text).join('\n');
  if (r02Rungs.length === 0) return;

  // Conditions that are timer-derived self-complete (sensorless motions
  // confirmed by delay timers): a rung that OTEs the bit gated by a .DN
  // means the wait always resolves — not exitless.
  const timerDerived = new Set();
  for (const r of rungs) {
    if (!/\.DN\)/.test(r.text)) continue;
    for (const m of r.text.matchAll(/OTE\(([A-Za-z_][A-Za-z0-9_]*)\)/g)) timerDerived.add(m[1]);
  }

  const alarmCoveredStates = new Set(
    [...alarmBlob.matchAll(/Status\.State\[(\d+)\]/g)].map(m => parseInt(m[1], 10)));

  for (const rung of r02Rungs) {
    if (!/MOVE?\(\d+,\s*Control\.StateReg\)/.test(rung.text)) continue;

    // Source states this rung waits in (flowchart range only — init/mode
    // states are template law and have their own recovery paths).
    const srcStates = [...rung.text.matchAll(/XIC\(Status\.State\[(\d+)\]\)/g)]
      .map(m => parseInt(m[1], 10))
      .filter(n => n >= 4 && n <= 97);
    if (srcStates.length === 0) continue;

    // Wait-style = conditioned on identifiers beyond state refs + exempt gates.
    const conditions = [...rung.text.matchAll(/XI[CO]\(([^)]+)\)/g)]
      .map(m => m[1])
      .filter(op => !/^Status\.State\[/.test(op))
      .filter(op => {
        // eslint-disable-next-line no-useless-escape -- upstream regex; escaped [ inside a character class is harmless
        const root = op.split(/[.\[]/)[0];
        return !WAIT_EXEMPT_IDENTS.has(root) && !WAIT_EXEMPT_IDENTS.has(op);
      });
    if (conditions.length === 0) continue; // pure sequencing rung, not a wait

    // Coverage, either idiom the standard uses:
    //  (a) a state-referenced fault-timer alarm rung (Control.FaultTime), or
    //  (b) a condition-mismatch alarm mentioning the waited identifier
    //      (e.g. XIC(q_ExtendXAxis) XIO(XAxisExtended) TON(...) rungs).
    if (srcStates.some(n => alarmCoveredStates.has(n))) continue;
    const uncovered = conditions.filter(op => {
      // eslint-disable-next-line no-useless-escape -- upstream regex; escaped [ inside a character class is harmless
      const root = op.split(/[.\[]/)[0];
      if (timerDerived.has(root)) return false;
      return !alarmBlob.includes(root);
    });
    if (uncovered.length > 0) {
      warnings.push(
        `Exitless wait: transition out of state ${srcStates.join('/')} waits on ` +
        `${uncovered.slice(0, 3).join(', ')}${uncovered.length > 3 ? ', …' : ''} ` +
        `with no fault/timeout path — no R20_Alarms rung references Status.State[${srcStates[0]}] ` +
        'or the waited condition (Rule 11: no exitless waits)');
    }
  }
}

// ── Main entry points ────────────────────────────────────────────────────────

/**
 * Validate an L5X document string.
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
function validateL5X(xml) {
  const errors = [];
  const warnings = [];

  if (typeof xml !== 'string' || xml.trim() === '') {
    return { ok: false, errors: ['Empty document'], warnings };
  }

  // 1. XML well-formedness
  const wf = XMLValidator.validate(xml);
  if (wf !== true) {
    errors.push(`XML not well-formed: ${wf.err.msg} (line ${wf.err.line}, col ${wf.err.col})`);
    return { ok: false, errors, warnings }; // structural checks are meaningless past this
  }

  if (!/<RSLogix5000Content\b/.test(xml)) {
    errors.push('Not an L5X document: missing <RSLogix5000Content> root');
    return { ok: false, errors, warnings };
  }

  // 2. Declarations
  const decl = harvestDeclarations(xml);

  // 3. Rung-by-rung resolution
  const rungs = extractRungs(xml);
  if (rungs.length === 0) warnings.push('No rung logic found in Programs section');

  const unresolved = new Map();   // identifier -> first location
  const badPrograms = new Map();  // \Program  -> first location
  const seenStateMoves = [];

  for (const rung of rungs) {
    for (const call of extractInstructions(rung.text)) {
      const isAoi = decl.aoiNames.has(call.name);
      if (!MNEMONICS.has(call.name) && !isAoi) {
        errors.push(`Unknown instruction "${call.name}" in ${rung.routine} — not a Logix mnemonic or declared AOI`);
        continue;
      }

      const skip = SKIP_ARGS[call.name];
      call.args.forEach((arg, idx) => {
        if (arg === '' || arg === '?' || arg === '??') return;
        if (skip === 'all') return;
        if (skip === 'routine-first') {
          if (idx === 0) {
            if (!decl.routines.has(arg)) {
              errors.push(`JSR target routine "${arg}" is not declared (in ${rung.routine})`);
            }
            return;
          }
          if (/^\d/.test(arg)) return;
        }
        if (skip instanceof Set && skip.has(idx)) return;
        // Motion instruction enum operands are keywords, not tags
        if (MOTION_INSTRUCTIONS.has(call.name) && idx >= 2 &&
            (arg.includes(' ') || MOTION_ENUM_WORDS.has(arg))) return;

        const { roots, programRefs } = operandRoots(arg);
        for (const p of programRefs) {
          if (!decl.programs.has(p) && !badPrograms.has('\\' + p)) {
            badPrograms.set('\\' + p, `${rung.routine}: ${call.name}(...${arg}...)`);
          }
        }
        for (const r of roots) {
          if (decl.tags.has(r) || decl.aoiNames.has(r) || decl.routines.has(r)) continue;
          if (!unresolved.has(r)) unresolved.set(r, `${rung.routine}: ${call.name}(${arg})`);
        }
      });

      // 4. Legal-state check on MOVE/MOV into Control.StateReg
      if ((call.name === 'MOVE' || call.name === 'MOV') && call.args.length >= 2) {
        const dest = call.args[1];
        if (/(^|\.)Control\.StateReg$/.test(dest) || dest === 'Control.StateReg') {
          const src = call.args[0];
          if (/^-?\d+$/.test(src)) {
            const n = parseInt(src, 10);
            seenStateMoves.push(n);
            const cls = classifyState(n);
            if (cls === 'illegal') {
              errors.push(
                `Illegal state number ${n} in ${rung.routine}: MOVE(${n},${dest}) — ` +
                'legal states are 0-3, 4/7/10...97, 99, 100-127');
            } else if (cls === 'offgrid') {
              warnings.push(
                `State ${n} in ${rung.routine} is off the 4/7/10... grid (MOVE(${n},${dest}))`);
            }
          }
        }
      }
    }
  }

  for (const [prog, loc] of badPrograms) {
    errors.push(`Program reference ${prog} does not resolve — no <Program Name="${prog.slice(1)}"> declared (first seen in ${loc})`);
  }
  for (const [id, loc] of unresolved) {
    errors.push(`Undeclared identifier "${id}" — not a declared tag, AOI, or routine (first seen in ${loc})`);
  }

  // 5. L5K string LEN consistency
  checkL5kStrings(xml, errors);

  // 6. No exitless waits (Rule 11): every wait-style R02 transition — one
  //    that holds a flowchart state until an external condition comes true —
  //    must be forceable by a fault/timeout path. Heuristic: the waiting
  //    state must be referenced by some R20_Alarms rung (Control.FaultTime /
  //    ProgramAlarmHandler coverage). Warning, not error — the heuristic
  //    can't see cross-program recovery paths.
  checkExitlessWaits(rungs, warnings);

  if (seenStateMoves.length === 0 && rungs.length > 0) {
    warnings.push('No MOVE(n, Control.StateReg) state transitions found');
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ── Diagram cross-validation ─────────────────────────────────────────────────
//
// validateAgainstDiagram(projectJson, smId, l5x) cross-checks the generated
// program against the flowchart it was compiled from:
//   (a) every diagram state has its MOVE(n,Control.StateReg) transition in
//       R02, and every diagram action's device is evidenced in some rung
//       referencing that state number;
//   (b) no motion/output command references a flowchart state whose diagram
//       node has NO action for that device (the "Z axis commanded in the
//       gripper-close state" defect class).
// State numbers come from the same DFS as the IR/prompt (ir.js), so the
// check and the generation always agree on numbering.

const { buildIR } = require('./ir');

function normIdent(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Split "PNPZAxis" / "Vertical_Shuttle" into lowercase words. */
function splitWords(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(w => w.toLowerCase());
}

/** Name variants for a device: every word-suffix (>=4 chars) of name and
 *  displayName. Variants shared by two devices are dropped (ambiguous). */
function deviceVariants(devices) {
  const raw = new Map(); // deviceId -> Set(variants)
  for (const d of devices) {
    const set = new Set();
    for (const source of [d.name, d.displayName]) {
      const words = splitWords(source);
      for (let k = 0; k < words.length; k++) {
        const v = words.slice(k).join('');
        if (k === 0 || v.length >= 4) set.add(v);
      }
    }
    raw.set(d.id, set);
  }
  // drop ambiguous variants
  const owners = new Map();
  for (const [id, set] of raw) for (const v of set) owners.set(v, (owners.get(v) || 0) + 1);
  for (const [, set] of raw) for (const v of [...set]) {
    if (owners.get(v) > 1) set.delete(v);
  }
  return raw;
}

function rungMentionsDevice(rungBlob, variants) {
  for (const v of variants) if (rungBlob.includes(v)) return true;
  return false;
}

/** Target-program slice of an L5X document. */
function targetProgramXml(xml) {
  const m = /<Program Use="Target"[^>]*>/.exec(xml);
  if (!m) return null;
  const end = xml.indexOf('</Program>', m.index);
  return end === -1 ? null : xml.slice(m.index, end);
}

/** Rungs with routine + comment (target program only). */
function extractRungsWithComments(programXml) {
  const rungs = [];
  const re = /<Routine\b[^>]*\bName="([^"]+)"|<Rung\b[^>]*>([\s\S]*?)<\/Rung>/g;
  let routine = '(unknown)';
  let m;
  while ((m = re.exec(programXml)) !== null) {
    if (m[1] !== undefined) { routine = m[1]; continue; }
    const body = m[2];
    const cm = /<Comment>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/Comment>/.exec(body);
    const tm = /<Text>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/Text>/.exec(body);
    rungs.push({ routine, comment: cm ? cm[1] : '', text: tm ? tm[1] : '' });
  }
  return rungs;
}

const CONDITION_OPS = /^(wait|decide|waitinput|waitrefpos|waitsmoutput|verify|check)$/i;

/**
 * Cross-check generated L5X against the source flowchart.
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
function validateAgainstDiagram(projectJson, smId, l5x) {
  const errors = [];
  const warnings = [];

  let ir;
  try { ir = buildIR(projectJson, smId); }
  catch (e) { return { ok: false, errors: [`Diagram cross-check failed: ${e.message}`], warnings }; }

  const progXml = targetProgramXml(l5x);
  if (!progXml) return { ok: false, errors: ['Diagram cross-check: no <Program Use="Target"> in generated L5X'], warnings };

  const rungs = extractRungsWithComments(progXml);
  const flowStates = ir.states.filter(s =>
    s.stateNumber != null && s.stateNumber >= 4 && s.stateNumber <= 97 && (s.stateNumber - 4) % 3 === 0);
  const stateByNumber = new Map(flowStates.map(s => [s.stateNumber, s]));
  const variants = deviceVariants(ir.devices);

  const hasVision = ir.states.some(s => s.actions.some(a => /vision/i.test(a.operation || '')));
  if (hasVision) warnings.push('Diagram cross-check: vision sub-states are not checked (not yet implemented)');

  // (a1) every flowchart state has a MOVE(n,Control.StateReg) in R02
  const r02Blob = rungs.filter(r => /R02/i.test(r.routine)).map(r => r.text).join('\n');
  for (const s of flowStates) {
    if (!new RegExp(`MOVE?\\(${s.stateNumber},\\s*Control\\.StateReg\\)`).test(r02Blob) &&
        !r02Blob.includes(`MOVE(${s.stateNumber},Control.StateReg)`)) {
      errors.push(`Diagram state ${s.stateNumber} ("${s.label}") has no MOVE(${s.stateNumber},Control.StateReg) transition in R02_StateTransitions`);
    }
  }

  // Pre-normalize rung blobs
  const normRungs = rungs.map(r => ({
    ...r,
    blob: normIdent(r.text + ' ' + r.comment),
    stateRefs: [...r.text.matchAll(/XIC\(Status\.State\[(\d+)\]\)/g)].map(m => parseInt(m[1], 10)),
  }));

  // (a2) every diagram action's device is evidenced at its state
  for (const s of flowStates) {
    for (const a of s.actions) {
      if (!a.deviceId || !a.deviceName) continue;
      const v = variants.get(a.deviceId);
      if (!v || v.size === 0) continue;
      const evidenced = normRungs.some(r =>
        (r.stateRefs.includes(s.stateNumber) || r.text.includes(`State[${s.stateNumber}]`)) &&
        rungMentionsDevice(r.blob, v));
      if (!evidenced) {
        errors.push(`Diagram action "${a.operation} -> ${a.deviceName}" at state ${s.stateNumber} ("${s.label}") ` +
          `has no rung referencing Status.State[${s.stateNumber}] together with device "${a.deviceName}"`);
      }
    }
  }

  // (b) no command references a flowchart state whose node lacks an action
  //     for that device. Commands: OTE/OTL of q_*, MAM(iq_*, motion staging
  //     MOVE(HMI_*.
  const deviceForIdent = ident => {
    const n = normIdent(ident);
    let best = null, bestLen = 0;
    for (const [id, set] of variants) {
      for (const v of set) {
        if (n.includes(v) && v.length > bestLen) { best = id; bestLen = v.length; }
      }
    }
    return best;
  };
  const deviceName = id => ir.devices.find(d => d.id === id)?.name || id;
  const nodeHasDeviceAction = (s, devId) =>
    s.actions.some(a => a.deviceId === devId && !CONDITION_OPS.test(a.operation || ''));

  for (const r of normRungs) {
    const commands = [
      ...[...r.text.matchAll(/OT[EL]\((q_[A-Za-z0-9_]+)\)/g)].map(m => m[1]),
      ...[...r.text.matchAll(/MAM\((iq_[A-Za-z0-9_]+)/g)].map(m => m[1]),
      ...[...r.text.matchAll(/MOVE\(HMI_([A-Za-z0-9_]+)\.Parameters\.Positions/g)].map(m => m[1]),
    ];
    if (!commands.length) continue;
    const cmdDevices = new Set(commands.map(deviceForIdent).filter(Boolean));
    if (!cmdDevices.size) continue;
    for (const n of r.stateRefs) {
      if (n < 4 || n > 97 || (n - 4) % 3 !== 0) continue; // init/mode/fault states are template law
      const node = stateByNumber.get(n);
      if (!node) {
        errors.push(`Generated logic commands a device at state ${n} (${r.routine}) but the diagram has no state ${n}`);
        continue;
      }
      for (const devId of cmdDevices) {
        if (!nodeHasDeviceAction(node, devId)) {
          errors.push(`Device "${deviceName(devId)}" is commanded at state ${n} ("${node.label}") in ${r.routine}, ` +
            `but that diagram state has no ${deviceName(devId)} action — wrong-state command defect`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Render a validation report as text (for repair prompts / CLI output). */
function formatReport(report) {
  const lines = [report.ok ? 'VALIDATION PASSED' : 'VALIDATION FAILED'];
  report.errors.forEach(e => lines.push(`  ERROR: ${e}`));
  report.warnings.forEach(w => lines.push(`  warning: ${w}`));
  return lines.join('\n');
}

module.exports = { validateL5X, validateAgainstDiagram, formatReport, isLegalState };
