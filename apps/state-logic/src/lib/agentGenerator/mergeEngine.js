/**
 * mergeEngine.js — deterministic surgical merge of a JARVIS edit plan into an
 * SDC standard template L5X.
 *
 * v1.0.1 architecture: the model authors ONLY a JSON edit plan
 * (editPlanSchema.js); this engine owns the template bytes. Every operation
 * is a pure string/regex edit with exact-match assertions — an edit whose
 * anchor matches zero times or more than once is a hard error (MergeError)
 * that lists the mismatch, so the self-repair loop can hand it back to the
 * model verbatim.
 *
 * Engine-owned (deterministic, not model-authored) steps:
 *   1. Program rename: TargetName / Program Name / ParameterConnection paths
 *      (word-boundary global replace of the template program name).
 *   2. Station display-prefix rename inside string data ("S05 Servo PNP: " ->
 *      "S01 Servo PNP: ") with L5K LEN + $00 padding + Decorated kept in sync.
 *   3. Program Description = JARVIS version stamp (+ model-supplied extra).
 *   4. Rung renumbering per routine after all edits.
 *
 * Refused (the standard is law): any edit touching AOI definitions, UDT /
 * DataType definitions, MotionGroup / axis configuration, controller-scope
 * tags, or context programs. Model ops are scoped to the Target program only.
 *
 * Encoding: callers read the template with fs.readFileSync(path, 'utf8') —
 * the BOM survives as U+FEFF and CRLF line endings are preserved; all
 * inserted content uses \r\n. Writing the result back with 'utf8' restores
 * the exact BOM + CRLF envelope.
 *
 * CommonJS, plain Node, no dependencies.
 */

const CRLF = '\r\n';

class MergeError extends Error {
  constructor(errors) {
    const list = Array.isArray(errors) ? errors : [String(errors)];
    super(`Merge failed with ${list.length} error(s):\n` + list.map(e => `  - ${e}`).join('\n'));
    this.name = 'MergeError';
    this.errors = list;
  }
}

// ── Boilerplate / protected tag names (renameTag refuses these) ──────────────
const PROTECTED_TAG_NAMES = new Set([
  'Control', 'Status', 'StateEngine', 'StateHistory', 'ONS',
  'SS', 'SS_OK', 'LocalSSONS', 'DryRun', 'Lockout', 'Initialized',
  'CycleRunning', 'CycleStopped', 'CycleStopping', 'ManualMode', 'SafetyOK',
  'FaultReset', 'FaultState', 'RestartState', 'SafetyStopState', 'UseRestartLogic',
  'StaNum', 'StaNumPre', 'NestNumCurrent', 'NestNumIncoming',
  'CycleStationA', 'CycleStationB', 'PartStarted',
  'HMI_Toggle', 'HMI_Momentary', 'HMI_MomentaryOnPrevScan', 'HMI_LocalManualOverride',
  'Alarm', 'AlarmList', 'ServoAlarm', 'ProgramFaultHandler',
  'q_AlarmActive', 'q_WarningActive', 'q_ActuatorsSafe', 'q_Pause', 'q_StationComplete',
  'q_AutoMode', 'q_AutoStopped', 'q_StartOK',
]);
const PROTECTED_TAG_PATTERNS = [/^iq_/, /^HMI_/, /^a\d\d_/i, /^g_/];

function isProtectedTagName(name) {
  return PROTECTED_TAG_NAMES.has(name) || PROTECTED_TAG_PATTERNS.some(p => p.test(name));
}

// ── Range helpers ─────────────────────────────────────────────────────────────

function findBlock(xml, openRe, closeTag, from = 0, errors, what) {
  openRe.lastIndex = from;
  const m = openRe.exec(xml);
  if (!m) { if (errors) errors.push(`${what} not found`); return null; }
  const end = xml.indexOf(closeTag, m.index);
  if (end === -1) { if (errors) errors.push(`${what}: closing ${closeTag} not found`); return null; }
  return { start: m.index, contentStart: m.index + m[0].length, contentEnd: end, end: end + closeTag.length, open: m[0] };
}

function targetProgramRange(xml) {
  return findBlock(xml, /<Program Use="Target"[^>]*>/g, '</Program>', 0, null, 'Target program');
}

/** <Tags>...</Tags> of the target program. */
function targetTagsRange(xml, prog) {
  const open = xml.indexOf('<Tags>', prog.start);
  if (open === -1 || open > prog.end) return null;
  const close = xml.indexOf('</Tags>', open);
  if (close === -1 || close > prog.end) return null;
  return { start: open, contentStart: open + '<Tags>'.length, contentEnd: close, end: close + '</Tags>'.length };
}

function findTagBlock(xml, prog, tagName, errors) {
  const tags = targetTagsRange(xml, prog);
  if (!tags) { errors.push('Target program <Tags> section not found'); return null; }
  const re = new RegExp(`<Tag Name="${escapeRe(tagName)}"[^>]*?(/>|>)`, 'g');
  re.lastIndex = tags.contentStart;
  const m = re.exec(xml);
  if (!m || m.index > tags.contentEnd) {
    errors.push(`Tag "${tagName}" is not declared in the target program`);
    return null;
  }
  if (m[1] === '/>') {
    return { start: m.index, contentStart: m.index + m[0].length, contentEnd: m.index + m[0].length, end: m.index + m[0].length, selfClosed: true };
  }
  const end = xml.indexOf('</Tag>', m.index);
  return { start: m.index, contentStart: m.index + m[0].length, contentEnd: end, end: end + '</Tag>'.length };
}

function findRoutineRllRange(xml, prog, routineName, errors) {
  const r = findBlock(xml, new RegExp(`<Routine Name="${escapeRe(routineName)}"[^>]*>`, 'g'), '</Routine>', prog.start, null, `Routine ${routineName}`);
  if (!r || r.start > prog.end) {
    errors.push(`Routine "${routineName}" not found in the target program`);
    return null;
  }
  const open = xml.indexOf('<RLLContent>', r.start);
  if (open === -1 || open > r.end) { errors.push(`Routine "${routineName}" has no <RLLContent>`); return null; }
  const close = xml.indexOf('</RLLContent>', open);
  return { start: open + '<RLLContent>'.length, end: close };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ── Rung parsing / building ──────────────────────────────────────────────────

function parseRungs(section) {
  const rungs = [];
  const re = /<Rung\b[^>]*>([\s\S]*?)<\/Rung>/g;
  let m;
  while ((m = re.exec(section)) !== null) {
    const body = m[1];
    const cm = /<Comment>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/Comment>/.exec(body);
    const tm = /<Text>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/Text>/.exec(body);
    rungs.push({ comment: cm ? cm[1] : null, text: tm ? tm[1] : '' });
  }
  return rungs;
}

function buildRungXml(rung, number) {
  const parts = [`<Rung Number="${number}" Type="N">`];
  if (rung.comment != null && rung.comment !== '') {
    parts.push('<Comment>', `<![CDATA[${rung.comment}]]>`, '</Comment>');
  }
  parts.push('<Text>', `<![CDATA[${rung.text}]]>`, '</Text>', '</Rung>');
  return parts.join(CRLF);
}

function buildRungsSection(rungs) {
  return CRLF + rungs.map((r, i) => buildRungXml(r, i)).join(CRLF) + CRLF;
}

/** Normalize rung text: model rungs may use \n — keep as-is inside CDATA but
 *  convert to CRLF to match the file's line endings. */
function normalizeText(t) {
  return t == null ? t : t.replace(/\r?\n/g, CRLF);
}

// ── L5K / Decorated string machinery ─────────────────────────────────────────

/** Decode an L5K/Decorated string body ($-escapes) to { text, bufferSize }.
 *  bufferSize = decoded char count including trailing $00 padding. */
function decodeStringBody(body) {
  const chars = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '$') {
      const two = body.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(two)) { chars.push(String.fromCharCode(parseInt(two, 16))); i += 2; }
      else {
        const n = body[i + 1]; i += 1;
        if (n === '$') chars.push('$');
        else if (n === "'") chars.push("'");
        else if (n === 'T' || n === 't') chars.push('\t');
        else if (n === 'L' || n === 'l') chars.push('\n');
        else if (n === 'R' || n === 'r') chars.push('\r');
        else if (n === 'N' || n === 'n') chars.push('\r\n');
        else chars.push('$' + (n || ''));
      }
    } else chars.push(c);
  }
  let end = chars.length;
  while (end > 0 && chars[end - 1] === ' ') end--;
  return { text: chars.slice(0, end).join(''), bufferSize: chars.length };
}

function encodeStringChar(ch) {
  if (ch === '$') return '$$';
  if (ch === "'") return "$'";
  const code = ch.charCodeAt(0);
  if (code < 32 || code > 126) return '$' + code.toString(16).toUpperCase().padStart(2, '0');
  return ch;
}

function encodeStringBody(text, padTo) {
  let out = '';
  for (const ch of text) out += encodeStringChar(ch);
  const pad = Math.max(0, (padTo ?? text.length) - text.length);
  return out + '$00'.repeat(pad);
}

/**
 * Transform every string value in xml[start..end) via transform(text) ->
 * newText | null. Handles the three representations (L5K [LEN,'body'],
 * Decorated LEN+DATA member pair, <Data Format="String" Length=..>) keeping
 * LEN, Length, and $00 padding consistent. Returns { xml, count, errors }.
 */
function transformStrings(xml, start, end, transform) {
  const errors = [];
  let count = 0;

  // Work on a slice, then reassemble (all three passes on the same slice).
  let slice = xml.slice(start, end);

  // 1. L5K [LEN,'body'] tokens
  slice = slice.replace(/\[(\d+),'((?:\$.|[^'$])*)'/g, (whole, lenStr, body) => {
    const { text, bufferSize } = decodeStringBody(body);
    const next = transform(text);
    if (next == null || next === text) return whole;
    if (next.length > bufferSize) {
      errors.push(`String too long for buffer (${next.length} > ${bufferSize}): "${next}"`);
      return whole;
    }
    count++;
    return `[${next.length},'${encodeStringBody(next, bufferSize)}'`;
  });

  // 2. Decorated LEN + DATA pairs
  slice = slice.replace(
    /(<DataValueMember Name="LEN"[^>]*Value=")(\d+)("\/>\s*<DataValueMember Name="DATA"[^>]*>\s*<!\[CDATA\[')((?:\$.|[^'$])*)('\]\]>)/g,
    (whole, p1, lenStr, p2, body, p5) => {
      const { text } = decodeStringBody(body);
      const next = transform(text);
      if (next == null || next === text) return whole;
      count++;
      return `${p1}${next.length}${p2}${encodeStringBody(next)}${p5}`;
    });

  // 3. <Data Format="String" Length="N"> <![CDATA['...']]>
  slice = slice.replace(
    /(<Data Format="String" Length=")(\d+)("\s*>\s*<!\[CDATA\[')((?:\$.|[^'$])*)('\]\]>)/g,
    (whole, p1, lenStr, p2, body, p5) => {
      const { text } = decodeStringBody(body);
      const next = transform(text);
      if (next == null || next === text) return whole;
      count++;
      return `${p1}${next.length}${p2}${encodeStringBody(next)}${p5}`;
    });

  return { xml: xml.slice(0, start) + slice + xml.slice(end), count, errors };
}

/** Mask string bodies so a global identifier rename cannot corrupt LEN data. */
function maskStrings(xml) {
  const store = [];
  const masked = xml
    .replace(/\[(\d+),'((?:\$.|[^'$])*)'/g, m => { store.push(m); return `${store.length - 1}`; })
    .replace(/<!\[CDATA\['((?:\$.|[^'$])*)'\]\]>/g, m => { store.push(m); return `${store.length - 1}`; });
  return { masked, store };
}
function unmaskStrings(xml, store) {
  // eslint-disable-next-line no-control-regex -- \x01 is the deliberate placeholder sentinel written by maskStrings() above
  return xml.replace(/(\d+)/g, (_m, i) => store[Number(i)]);
}

// ── Aligned-leaf numeric tag data editing ────────────────────────────────────

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function numEq(a, b) {
  if (a === null || b === null) return false;
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / scale < 1e-9;
}

/** Ordered leaves of a Decorated data block: numbers (Value="..") + strings. */
function decoratedLeaves(section) {
  const leaves = [];
  const re = /<(?:DataValueMember|DataValue|Element)\b[^>]*\bValue="([^"]*)"|<!\[CDATA\['((?:\$.|[^'$])*)'\]\]>/g;
  let m;
  while ((m = re.exec(section)) !== null) {
    if (m[1] !== undefined) leaves.push({ kind: 'num', raw: m[1], index: m.index, match: m[0] });
    else leaves.push({ kind: 'str', raw: m[2], index: m.index, match: m[0] });
  }
  return leaves;
}

/** Ordered tokens of an L5K CDATA blob: numbers + 'strings'. */
function l5kTokens(blob) {
  const tokens = [];
  const re = /'((?:\$.|[^'$])*)'|(-?\d+\.\d+e[+-]\d+|-?\d+\.\d+|-?\d+)/g;
  let m;
  while ((m = re.exec(blob)) !== null) {
    if (m[1] !== undefined) tokens.push({ kind: 'str', raw: m[1], index: m.index, len: m[0].length });
    else tokens.push({ kind: 'num', raw: m[2], index: m.index, len: m[0].length });
  }
  return tokens;
}

function formatL5kNumberLike(oldRaw, value) {
  if (/e[+-]\d+/i.test(oldRaw)) {
    const s = Number(value).toExponential(8);           // "2.50000000e+4"
    return s.replace(/e([+-])(\d+)/, (_m, sign, d) => `e${sign}${d.padStart(3, '0')}`);
  }
  if (/\./.test(oldRaw)) {
    return Number.isInteger(Number(value)) ? `${value}.0` : String(value);
  }
  return String(Math.trunc(Number(value)));
}

function formatDecoratedNumberLike(oldRaw, value) {
  if (/\./.test(oldRaw)) return Number.isInteger(Number(value)) ? `${value}.0` : String(value);
  return String(Math.trunc(Number(value)));
}

/**
 * setTagData core: edit one numeric member of a tag, updating Decorated AND
 * L5K in lockstep. Uses flat leaf alignment with numeric verification;
 * TIMER tags get a fixed [status, PRE, ACC] mapping.
 */
function setTagDataOp(xml, prog, op, errors) {
  const tag = findTagBlock(xml, prog, op.tag, errors);
  if (!tag) return xml;
  const tagXml = xml.slice(tag.start, tag.end);

  const dec = findBlock(tagXml, /<Data Format="Decorated">/g, '</Data>', 0, errors, `Tag ${op.tag} Decorated data`);
  const l5k = findBlock(tagXml, /<Data Format="L5K">\s*<!\[CDATA\[/g, ']]>', 0, errors, `Tag ${op.tag} L5K data`);
  if (!dec || !l5k) return xml;

  // Resolve the member path inside the Decorated block.
  const decSection = tagXml.slice(dec.contentStart, dec.contentEnd);
  const target = resolveMemberPath(decSection, op.member, errors, op.tag);
  if (!target) return xml;

  if (op.oldValue !== undefined && !numEq(num(target.raw), num(op.oldValue))) {
    errors.push(`setTagData ${op.tag}.${op.member}: current value is ${target.raw}, expected oldValue ${op.oldValue}`);
    return xml;
  }

  const leaves = decoratedLeaves(decSection);
  const leafIdx = leaves.findIndex(l => l.kind === 'num' && l.index <= target.valueIndex && target.valueIndex < l.index + l.match.length);
  if (leafIdx === -1) { errors.push(`setTagData ${op.tag}.${op.member}: internal leaf resolution failed`); return xml; }

  const blob = tagXml.slice(l5k.contentStart, l5k.contentEnd);
  const tokens = l5kTokens(blob);

  const isTimer = /DataType="TIMER"/.test(tagXml.slice(tag.start - tag.start, dec.start)) || /<Structure DataType="TIMER">/.test(decSection);
  let tokenIdx = -1;
  if (isTimer && tokens.length === 3 && tokens.every(t => t.kind === 'num')) {
    const memberName = op.member.split('.').pop();
    if (memberName === 'PRE') tokenIdx = 1;
    else if (memberName === 'ACC') tokenIdx = 2;
    else { errors.push(`setTagData ${op.tag}: only PRE and ACC are editable on TIMER tags`); return xml; }
  } else {
    // General alignment: every leaf must match every token numerically/textually.
    if (leaves.length !== tokens.length) {
      errors.push(`setTagData ${op.tag}.${op.member}: cannot safely edit — Decorated has ${leaves.length} leaves but L5K has ${tokens.length} tokens (packed BOOLs or unsupported layout). Leave this member at its template value.`);
      return xml;
    }
    for (let i = 0; i < leaves.length; i++) {
      const L = leaves[i], T = tokens[i];
      const ok = L.kind === T.kind && (L.kind === 'str'
        ? decodeStringBody(L.raw).text === decodeStringBody(T.raw).text
        : numEq(num(L.raw), num(T.raw)));
      if (!ok) {
        errors.push(`setTagData ${op.tag}.${op.member}: L5K/Decorated alignment mismatch at leaf ${i} (${L.raw} vs ${T.raw}) — edit refused.`);
        return xml;
      }
    }
    tokenIdx = leafIdx;
  }

  const tok = tokens[tokenIdx];
  const newBlob = blob.slice(0, tok.index) + formatL5kNumberLike(tok.raw, op.value) + blob.slice(tok.index + tok.len);

  // Rebuild: replace L5K blob and the Decorated Value attribute.
  const newDecSection = decSection.slice(0, target.valueIndex) +
    decSection.slice(target.valueIndex).replace(/Value="[^"]*"/, `Value="${formatDecoratedNumberLike(target.raw, op.value)}"`);

  let newTagXml = tagXml.slice(0, l5k.contentStart) + newBlob + tagXml.slice(l5k.contentEnd);
  // dec offsets shift if l5k precedes dec — recompute dec block in newTagXml
  const dec2 = findBlock(newTagXml, /<Data Format="Decorated">/g, '</Data>', 0, errors, `Tag ${op.tag} Decorated data`);
  newTagXml = newTagXml.slice(0, dec2.contentStart) + newDecSection + newTagXml.slice(dec2.contentEnd);

  return xml.slice(0, tag.start) + newTagXml + xml.slice(tag.end);
}

/**
 * Resolve "Parameters.AutoSpeed[0]" / "PRE" inside a Decorated section.
 * Returns { valueIndex (offset of the element open tag), raw } or null.
 */
function resolveMemberPath(section, path, errors, tagName) {
  const segs = [];
  for (const part of path.split('.')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(\[(\d+)\])?$/.exec(part.trim());
    if (!m) { errors.push(`setTagData ${tagName}: bad member path segment "${part}"`); return null; }
    segs.push({ name: m[1], index: m[3] !== undefined ? Number(m[3]) : null });
  }

  let lo = 0, hi = section.length;
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s];
    const last = s === segs.length - 1;
    const re = new RegExp(`<(StructureMember|ArrayMember|DataValueMember|ArrayValueMember) Name="${escapeRe(seg.name)}"[^>]*?(/>|>)`, 'g');
    re.lastIndex = lo;
    const matches = [];
    let m;
    while ((m = re.exec(section)) !== null && m.index < hi) matches.push(m);
    if (matches.length === 0) { errors.push(`setTagData ${tagName}: member "${seg.name}" not found under "${path}"`); return null; }
    if (matches.length > 1 && s === 0) { errors.push(`setTagData ${tagName}: member "${seg.name}" is ambiguous (${matches.length} matches) — use a fuller path`); return null; }
    m = matches[0];
    const kind = m[1];
    if (kind === 'DataValueMember' && seg.index === null) {
      if (!last) { errors.push(`setTagData ${tagName}: "${seg.name}" is a scalar — path continues past it`); return null; }
      const vm = /Value="([^"]*)"/.exec(m[0]);
      if (!vm) { errors.push(`setTagData ${tagName}: "${seg.name}" has no Value attribute`); return null; }
      return { valueIndex: m.index, raw: vm[1] };
    }
    // Block member: narrow the window.
    let blockEnd = hi;
    if (m[2] === '>') {
      const close = `</${kind}>`;
      // depth-aware scan for the matching close
      let depth = 1, i = m.index + m[0].length;
      const openRe = new RegExp(`<${kind}\\b`, 'g');
      while (depth > 0 && i < hi) {
        const nextOpen = section.indexOf(`<${kind} `, i);
        const nextClose = section.indexOf(close, i);
        if (nextClose === -1) break;
        if (nextOpen !== -1 && nextOpen < nextClose) { depth++; i = nextOpen + 1; }
        else { depth--; i = nextClose + close.length; }
      }
      blockEnd = i;
    }
    lo = m.index + m[0].length;
    hi = blockEnd;
    if (seg.index !== null) {
      const er = new RegExp(`<Element Index="\\[${seg.index}\\]"[^>]*?(/>|>)`, 'g');
      er.lastIndex = lo;
      const em = er.exec(section);
      if (!em || em.index >= hi) { errors.push(`setTagData ${tagName}: element [${seg.index}] of "${seg.name}" not found`); return null; }
      if (em[1] === '/>') {
        if (!last) { errors.push(`setTagData ${tagName}: "${seg.name}[${seg.index}]" is a scalar element — path continues past it`); return null; }
        const vm = /Value="([^"]*)"/.exec(em[0]);
        if (!vm) { errors.push(`setTagData ${tagName}: element [${seg.index}] has no Value`); return null; }
        return { valueIndex: em.index, raw: vm[1] };
      }
      lo = em.index + em[0].length;
      const ce = section.indexOf('</Element>', lo);
      hi = ce === -1 ? hi : ce;
    }
  }
  errors.push(`setTagData ${tagName}: path "${path}" did not resolve to a scalar value`);
  return null;
}

// ── Individual operations ────────────────────────────────────────────────────

function opRenameTag(xml, prog, op, errors) {
  if (isProtectedTagName(op.from)) { errors.push(`renameTag: "${op.from}" is a protected boilerplate/servo/controller tag — refused`); return xml; }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(op.from) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(op.to)) {
    errors.push(`renameTag: names must be plain identifiers ("${op.from}" -> "${op.to}")`); return xml;
  }
  const probe = [];
  if (!findTagBlock(xml, prog, op.from, probe)) { errors.push(`renameTag: tag "${op.from}" is not declared in the target program`); return xml; }
  const dupProbe = [];
  if (findTagBlock(xml, prog, op.to, dupProbe)) { errors.push(`renameTag: target name "${op.to}" already exists`); return xml; }

  const before = xml.slice(0, prog.start);
  const after = xml.slice(prog.end);
  let segment = xml.slice(prog.start, prog.end);
  const { masked, store } = maskStrings(segment);
  const renamed = masked.replace(new RegExp(`\\b${escapeRe(op.from)}\\b`, 'g'), op.to);
  segment = unmaskStrings(renamed, store);
  return before + segment + after;
}

/** "rung 14 (comment: "State 22: ...")" — first comment line, capped at 90 chars. */
function describeRungHit(h) {
  const c = (h.r.comment || '').split(/\r?\n/)[0].trim();
  return `rung ${h.i}${c ? ` (comment: "${c.slice(0, 90)}")` : ' (no comment)'}`;
}

function locateRung(rungs, needle, routine, errors, opName, opts = {}) {
  let hits = rungs.map((r, i) => ({ r, i })).filter(x => x.r.text.includes(needle));
  if (hits.length === 0) hits = rungs.map((r, i) => ({ r, i })).filter(x => (x.r.comment || '').includes(needle));
  if (hits.length === 0) { errors.push(`${opName} in ${routine}: no rung matches "${needle}"`); return -1; }

  // Optional disambiguators (editPlanSchema): "nearComment" narrows to rungs
  // whose comment contains the substring; "occurrence" (1-based) then picks
  // among the remaining matches in rung order.
  if (hits.length > 1 && opts.nearComment !== undefined) {
    const narrowed = hits.filter(h => (h.r.comment || '').includes(opts.nearComment));
    if (narrowed.length === 0) {
      errors.push(`${opName} in ${routine}: "${needle}" matches ${hits.length} rungs but none has a comment containing "${opts.nearComment}". Matches: ${hits.map(describeRungHit).join('; ')}`);
      return -1;
    }
    hits = narrowed;
  }
  if (opts.occurrence !== undefined) {
    const n = opts.occurrence;
    if (!Number.isInteger(n) || n < 1 || n > hits.length) {
      errors.push(`${opName} in ${routine}: occurrence ${n} is out of range — "${needle}" matches ${hits.length} rung(s): ${hits.map(describeRungHit).join('; ')}`);
      return -1;
    }
    return hits[n - 1].i;
  }
  if (hits.length > 1) {
    errors.push(`${opName} in ${routine}: "${needle}" matches ${hits.length} rungs — add "occurrence" (1-based) or "nearComment" (substring of the rung's comment) to disambiguate, or use a longer unique anchor. Matches: ${hits.map(describeRungHit).join('; ')}`);
    return -1;
  }
  return hits[0].i;
}

function withRoutineRungs(xml, prog, routine, errors, fn) {
  const range = findRoutineRllRange(xml, prog, routine, errors);
  if (!range) return xml;
  const rungs = parseRungs(xml.slice(range.start, range.end));
  const next = fn(rungs);
  if (!next) return xml;
  return xml.slice(0, range.start) + buildRungsSection(next) + xml.slice(range.end);
}

function opUpdateRung(xml, prog, op, errors) {
  return withRoutineRungs(xml, prog, op.routine, errors, rungs => {
    const i = locateRung(rungs, op.match, op.routine, errors, 'updateRung',
      { occurrence: op.occurrence, nearComment: op.nearComment });
    if (i === -1) return null;
    if (op.newText !== undefined) rungs[i].text = normalizeText(op.newText);
    if (op.newComment !== undefined) rungs[i].comment = normalizeText(op.newComment);
    return rungs;
  });
}

function opSpliceRungs(xml, prog, op, errors) {
  return withRoutineRungs(xml, prog, op.routine, errors, rungs => {
    let at;
    if (op.after !== undefined) {
      const i = locateRung(rungs, op.after, op.routine, errors, 'spliceRungs',
        { occurrence: op.occurrence, nearComment: op.nearComment });
      if (i === -1) return null;
      at = i + 1;
    } else {
      at = op.atIndex;
      if (at < 0 || at > rungs.length) { errors.push(`spliceRungs in ${op.routine}: atIndex ${at} out of range (0..${rungs.length})`); return null; }
    }
    const remove = op.remove || 0;
    if (at + remove > rungs.length) { errors.push(`spliceRungs in ${op.routine}: remove ${remove} at ${at} exceeds ${rungs.length} rungs`); return null; }
    const insert = (op.insert || []).map(r => ({ comment: normalizeText(r.comment ?? null), text: normalizeText(r.text) }));
    rungs.splice(at, remove, ...insert);
    return rungs;
  });
}

function opReplaceRoutineRungs(xml, prog, op, errors) {
  return withRoutineRungs(xml, prog, op.routine, errors, () =>
    op.rungs.map(r => ({ comment: normalizeText(r.comment ?? null), text: normalizeText(r.text) })));
}

function opAddTag(xml, prog, op, errors) {
  const dup = [];
  if (findTagBlock(xml, prog, op.name, dup)) { errors.push(`addTag: tag "${op.name}" already exists`); return xml; }
  const tags = targetTagsRange(xml, prog);
  if (!tags) { errors.push('addTag: target program <Tags> section not found'); return xml; }

  const desc = op.description
    ? `<Description>${CRLF}<![CDATA[${op.description}]]>${CRLF}</Description>${CRLF}`
    : '';
  let block;
  if (op.dataType === 'TIMER') {
    const pre = Math.trunc(Number(op.value) || 0);
    block =
      `<Tag Name="${op.name}" TagType="Base" DataType="TIMER" Constant="false" ExternalAccess="Read/Write" OpcUaAccess="None">${CRLF}` +
      desc +
      `<Data Format="L5K">${CRLF}<![CDATA[[0,${pre},0]]]>${CRLF}</Data>${CRLF}` +
      `<Data Format="Decorated">${CRLF}<Structure DataType="TIMER">${CRLF}` +
      `<DataValueMember Name="PRE" DataType="DINT" Radix="Decimal" Value="${pre}"/>${CRLF}` +
      `<DataValueMember Name="ACC" DataType="DINT" Radix="Decimal" Value="0"/>${CRLF}` +
      `<DataValueMember Name="EN" DataType="BOOL" Value="0"/>${CRLF}` +
      `<DataValueMember Name="TT" DataType="BOOL" Value="0"/>${CRLF}` +
      `<DataValueMember Name="DN" DataType="BOOL" Value="0"/>${CRLF}` +
      `</Structure>${CRLF}</Data>${CRLF}</Tag>${CRLF}`;
  } else {
    const isReal = op.dataType === 'REAL';
    const raw = Number(op.value) || 0;
    const val = isReal ? (Number.isInteger(raw) ? `${raw}.0` : String(raw)) : String(Math.trunc(raw));
    const radix = isReal ? 'Float' : 'Decimal';
    block =
      `<Tag Name="${op.name}" TagType="Base" DataType="${op.dataType}" Radix="${radix}" Constant="false" ExternalAccess="Read/Write" OpcUaAccess="None">${CRLF}` +
      desc +
      `<Data Format="L5K">${CRLF}<![CDATA[${isReal ? formatL5kNumberLike('0.00000000e+000', raw) : val}]]>${CRLF}</Data>${CRLF}` +
      `<Data Format="Decorated">${CRLF}<DataValue DataType="${op.dataType}" Radix="${radix}" Value="${val}"/>${CRLF}</Data>${CRLF}</Tag>${CRLF}`;
  }
  return xml.slice(0, tags.contentEnd) + block + xml.slice(tags.contentEnd);
}

function opSetStringData(xml, prog, op, errors) {
  const tag = findTagBlock(xml, prog, op.tag, errors);
  if (!tag) return xml;
  const res = transformStrings(xml, tag.start, tag.end, t => (t === op.oldText ? op.newText : null));
  errors.push(...res.errors);
  if (res.count === 0 && res.errors.length === 0) {
    errors.push(`setStringData ${op.tag}: no string equals "${op.oldText}" — copy the exact current text from the template extracts`);
    return xml;
  }
  return res.xml;
}

function opSetTagComment(xml, prog, op, errors) {
  const tag = findTagBlock(xml, prog, op.tag, errors);
  if (!tag) return xml;
  let tagXml = xml.slice(tag.start, tag.end);
  const re = new RegExp(`<Comment Operand="${escapeRe(op.operand)}">\\s*<!\\[CDATA\\[[\\s\\S]*?\\]\\]>\\s*</Comment>(\\r?\\n)?`, 'g');
  const has = re.test(tagXml);
  re.lastIndex = 0;
  if (op.remove) {
    if (!has) { errors.push(`setTagComment ${op.tag}: no comment with operand "${op.operand}" to remove`); return xml; }
    tagXml = tagXml.replace(re, '');
  } else if (has) {
    tagXml = tagXml.replace(re, `<Comment Operand="${op.operand}">${CRLF}<![CDATA[${normalizeText(op.text)}]]>${CRLF}</Comment>${CRLF}`);
  } else {
    const block = `<Comment Operand="${op.operand}">${CRLF}<![CDATA[${normalizeText(op.text)}]]>${CRLF}</Comment>${CRLF}`;
    const cIdx = tagXml.indexOf('<Comments>');
    if (cIdx !== -1) {
      const insertAt = cIdx + '<Comments>'.length;
      tagXml = tagXml.slice(0, insertAt) + CRLF + block + tagXml.slice(insertAt).replace(/^\r?\n/, '');
    } else {
      // create a Comments section right after the opening tag / Description
      const descEnd = /<Description>[\s\S]*?<\/Description>\r?\n?/.exec(tagXml);
      const insertAt = descEnd ? descEnd.index + descEnd[0].length : (tagXml.indexOf('>') + 1);
      const section = `<Comments>${CRLF}${block}</Comments>${CRLF}`;
      tagXml = tagXml.slice(0, insertAt) + (descEnd ? '' : CRLF) + section + tagXml.slice(insertAt);
    }
  }
  return xml.slice(0, tag.start) + tagXml + xml.slice(tag.end);
}

// ── Engine-owned steps ───────────────────────────────────────────────────────

function renameProgram(xml, oldName, newName, errors) {
  if (oldName === newName) return xml;
  const re = new RegExp(`\\b${escapeRe(oldName)}\\b`, 'g');
  if (!re.test(xml)) { errors.push(`Template program name "${oldName}" not found`); return xml; }
  return xml.replace(new RegExp(`\\b${escapeRe(oldName)}\\b`, 'g'), newName);
}

/** "S05_ServoPNP" -> "S05 Servo PNP" (the display prefix used in strings). */
function displayPrefix(programName) {
  return programName
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

function renameStationPrefix(xml, oldName, newName) {
  const oldPrefix = displayPrefix(oldName);
  const newPrefix = displayPrefix(newName);
  if (oldPrefix === newPrefix) return { xml, errors: [] };

  // Skip AOI definitions + DataTypes (law) — transform everything else.
  const aoi = findBlock(xml, /<AddOnInstructionDefinitions>/g, '</AddOnInstructionDefinitions>', 0, null, 'AOIs');
  const ranges = [];
  if (aoi) { ranges.push([0, aoi.start]); ranges.push([aoi.end, xml.length]); }
  else ranges.push([0, xml.length]);

  let out = xml;
  const errors = [];
  // process from the end so earlier offsets stay valid
  for (const [s, e] of ranges.slice().reverse()) {
    const res = transformStrings(out, s, e, t => (t.includes(oldPrefix) ? t.split(oldPrefix).join(newPrefix) : null));
    errors.push(...res.errors);
    out = res.xml;
  }
  // Plain comment/description CDATA (no LEN bookkeeping needed) — handled by
  // transformStrings only when quote-framed; unquoted CDATA texts:
  out = out.split(`<![CDATA[${oldPrefix}`).join(`<![CDATA[${newPrefix}`);
  out = out.split(`${oldPrefix} - `).join(`${newPrefix} - `);
  return { xml: out, errors };
}

function setProgramDescriptionXml(xml, prog, text, errors) {
  const openEnd = prog.contentStart;
  const descBlock = `${CRLF}<Description>${CRLF}<![CDATA[${text}]]>${CRLF}</Description>`;
  const existing = /^\s*<Description>[\s\S]*?<\/Description>/.exec(xml.slice(openEnd, prog.contentEnd));
  if (existing) {
    return xml.slice(0, openEnd) + descBlock + xml.slice(openEnd + existing.index + existing[0].length);
  }
  return xml.slice(0, openEnd) + descBlock + xml.slice(openEnd);
}

function renumberAllRoutines(xml, prog) {
  // For every RLLContent in the target program, renumber rungs sequentially.
  let out = xml;
  let searchFrom = prog.start;
  for (;;) {
    const p = targetProgramRange(out); // recompute (offsets shift)
    const open = out.indexOf('<RLLContent>', searchFrom);
    if (open === -1 || open > p.end) break;
    const close = out.indexOf('</RLLContent>', open);
    let n = 0;
    const section = out.slice(open, close).replace(/<Rung Number="\d+"/g, () => `<Rung Number="${n++}"`);
    out = out.slice(0, open) + section + out.slice(close);
    searchFrom = open + section.length + '</RLLContent>'.length;
  }
  return out;
}

// ── Entry point ──────────────────────────────────────────────────────────────

const OP_HANDLERS = {
  renameTag: opRenameTag,
  updateRung: opUpdateRung,
  spliceRungs: opSpliceRungs,
  replaceRoutineRungs: opReplaceRoutineRungs,
  addTag: opAddTag,
  setTagData: setTagDataOp,
  setStringData: opSetStringData,
  setTagComment: opSetTagComment,
  setProgramDescription: (xml) => xml, // collected + applied in step 4
};

function deriveProgramName(smName, stationNumber) {
  const nn = String(stationNumber ?? 1).padStart(2, '0');
  const pascal = String(smName || 'Station')
    .replace(/^S\d+_/i, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join('');
  return `S${nn}_${pascal || 'Station'}`;
}

/**
 * Apply a validated edit plan to a template.
 *
 * @param {string} templateXml  Template file contents (utf8, BOM+CRLF intact)
 * @param {object} plan         Validated edit plan (editPlanSchema.validatePlan)
 * @param {object} opts         { smName, stationNumber, stamp }
 * @returns {{ xml: string, programName: string, log: string[] }}
 * @throws {MergeError} on any assertion failure (errors listed)
 */
function applyEditPlan(templateXml, plan, opts = {}) {
  const errors = [];
  const log = [];
  let xml = templateXml;

  const tn = /<RSLogix5000Content[^>]*\bTargetName="([^"]+)"/.exec(xml);
  if (!tn) throw new MergeError(['Template has no RSLogix5000Content TargetName']);
  const oldName = tn[1];
  const newName = plan.programName || deriveProgramName(opts.smName, opts.stationNumber);

  // 1. Model-authored operations, strictly in order. These run FIRST, against
  //    the template's original names/strings — exactly what the prompt
  //    extracts showed the model — so every match/oldText anchor lines up.
  for (let i = 0; i < (plan.operations || []).length; i++) {
    const op = plan.operations[i];
    const handler = OP_HANDLERS[op.op];
    if (!handler) { errors.push(`operations[${i}]: unknown op "${op.op}"`); continue; }
    const prog = targetProgramRange(xml);
    if (!prog) { errors.push('Target program block not found'); break; }
    const before = errors.length;
    xml = handler(xml, prog, op, errors);
    if (errors.length === before) log.push(`operations[${i}] ${op.op}: applied`);
    else for (let k = before; k < errors.length; k++) errors[k] = `operations[${i}]: ${errors[k]}`;
  }

  // 2. Program rename (global, word-boundary; string bodies use step 3)
  xml = renameProgram(xml, oldName, newName, errors);
  log.push(`renameProgram: ${oldName} -> ${newName}`);

  // 3. Station display-prefix rename inside string data
  const pre = renameStationPrefix(xml, oldName, newName);
  errors.push(...pre.errors);
  xml = pre.xml;

  // 4. Program description (stamp + optional model text)
  {
    const prog = targetProgramRange(xml);
    if (prog) {
      const extra = (plan.operations || [])
        .filter(o => o.op === 'setProgramDescription')
        .map(o => o.text).join('\n');
      const desc = [opts.stamp, extra].filter(Boolean).join('\n');
      if (desc) xml = setProgramDescriptionXml(xml, prog, desc.replace(/\r?\n/g, CRLF), errors);
    }
  }

  // 5. Renumber rungs in every target routine
  {
    const prog = targetProgramRange(xml);
    if (prog) xml = renumberAllRoutines(xml, prog);
  }

  if (errors.length) throw new MergeError(errors);
  return { xml, programName: newName, log };
}

module.exports = {
  applyEditPlan,
  deriveProgramName,
  MergeError,
  isProtectedTagName,
  // exported for tests
  _internal: { transformStrings, decodeStringBody, encodeStringBody, parseRungs, resolveMemberPath, l5kTokens, decoratedLeaves },
};
