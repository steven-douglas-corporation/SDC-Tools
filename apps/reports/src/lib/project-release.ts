import zlib from "node:zlib";

// Parser for the SDC "Project Release" document. Real releases are PDFs (see
// e.g. N:\...\1059 Project Release (New Version).pdf) with every field in clean
// text; older/alt copies may be .docx. We detect the format by magic bytes,
// extract plain text (PDF via unpdf, .docx by unzipping word/document.xml), then
// pull the same structured fields from either.
//
// Extracted: Job number / title / buyer(customer), quote, PO #, customer
// contact, order date, delivery, financial milestones, penalty, warranty
// months, and the Project Budget line items (hours by discipline + commercial
// cost). A .docx with an embedded budget picture also yields budgetImage.

export type ReleaseMilestone = { pct: number; label: string };
export type ReleaseBudgetLine = { label: string; value: number; isCost: boolean };

export type ParsedProjectRelease = {
  fileName: string;
  uploadedAt: string;
  jobNumber: string | null;
  jobTitle: string | null;
  buyer: string | null; // customer
  quote: string | null;
  poNumber: string | null;
  customerContact: string | null;
  receiptOfPo: string | null; // ISO YYYY-MM-DD
  deliveryText: string | null; // as written, e.g. "10-12 Weeks"
  deliveryWeeks: number | null; // upper bound of any range
  milestones: ReleaseMilestone[];
  penalty: boolean;
  penaltyWeeks: number | null;
  warrantyMonths: number | null;
  budget: ReleaseBudgetLine[];
  commercialCost: number | null; // the $ "Commercial" budget line, if present
  budgetImage: string | null; // data URL — only when a .docx embeds one
};

// ── .docx text extraction (ZIP + inflate), kept for non-PDF copies ──────────
type ZipEntry = { method: number; compSize: number; localOff: number };
function zipOpen(buf: Buffer) {
  let eocd = -1;
  const minStart = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a valid .docx file.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const dir: Record<string, ZipEntry> = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    dir[name] = { method, compSize, localOff };
    p += 46 + nameLen + extraLen + commentLen;
  }
  const extract = (name: string): Buffer | null => {
    const e = dir[name];
    if (!e) return null;
    if (buf.readUInt32LE(e.localOff) !== 0x04034b50) return null;
    const nameLen = buf.readUInt16LE(e.localOff + 26);
    const extraLen = buf.readUInt16LE(e.localOff + 28);
    const start = e.localOff + 30 + nameLen + extraLen;
    const comp = buf.subarray(start, start + e.compSize);
    if (e.method === 0) return Buffer.from(comp);
    if (e.method === 8) return zlib.inflateRawSync(comp);
    return null;
  };
  return { extract };
}
function docxXmlToText(xml: string): string {
  let t = xml.replace(/<\/w:p>/g, "\n").replace(/<\/w:tc>/g, " | ").replace(/<\/w:tr>/g, "\n");
  t = t.replace(/<[^>]+>/g, "");
  t = t
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#xA;/g, " ");
  return t.split("\n").map((s) => s.trim()).filter(Boolean).join("\n");
}
function docxBudgetImage(zip: { extract: (n: string) => Buffer | null }, xml: string): string | null {
  try {
    const relsBytes = zip.extract("word/_rels/document.xml.rels");
    const rels = relsBytes ? relsBytes.toString("utf8") : "";
    const ridToTarget: Record<string, string> = {};
    for (const rm of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = (rm[0].match(/Id="([^"]+)"/) || [])[1];
      const tgt = (rm[0].match(/Target="([^"]+)"/) || [])[1];
      if (id && tgt) ridToTarget[id] = tgt;
    }
    const rid = (xml.match(/r:embed="(rId\d+)"/) || [])[1];
    const target = rid ? ridToTarget[rid] : null;
    if (!target) return null;
    const path = ("word/" + target.replace(/^\/?word\//, "").replace(/^\//, "")).replace(/\\/g, "/");
    const bytes = zip.extract(path);
    if (!bytes) return null;
    const ext = (path.split(".").pop() || "png").toLowerCase();
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "png" ? "image/png" : "image/" + ext;
    return `data:${mime};base64,` + bytes.toString("base64");
  } catch { return null; }
}

// ── date parsing — handles "1/10/2024" and "June 19, 2026" ──────────────────
const REL_MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};
function dateToISO(s: string): string | null {
  if (!s) return null;
  s = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // M/D/YYYY
  if (m) return `${m[3]}-${String(Number(m[1])).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`;
  m = s.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/); // Month D, YYYY
  if (m) {
    const mo = REL_MONTHS[m[1].toLowerCase()];
    if (mo != null) return `${m[3]}-${String(mo + 1).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`;
  }
  return null;
}

const grab = (re: RegExp, t: string): string | null => {
  const m = t.match(re);
  return m ? m[1].trim() : null;
};

// Extract all fields from the flattened document text (whitespace collapsed to
// single spaces so PDF and .docx read the same).
function extractFields(rawText: string) {
  const t = rawText.replace(/\s+/g, " ").trim();

  const jobNumber = grab(/SDC Project Number:\s*(\d+)/i, t);
  const jobTitle = grab(/SDC Project Title:\s*(.+?)\s+(?:SDC Quote:|Prev\.|Quantity:|Buyer)/i, t);
  const buyer = grab(/\bBuyer:\s*(.+?)\s+(?:SDC Project Number:|SDC Project|Prepared)/i, t);
  const quote = grab(/SDC Quote:\s*([\w-]+)/i, t);
  const poNumber = grab(/PO\s*#?:\s*([A-Za-z0-9-]+)/i, t);
  const customerContact = grab(/Customer Contact:\s*(.+?)\s+Date of Order:/i, t);

  const orderRaw = grab(/Date of Order:\s*(\d{1,2}\/\d{1,2}\/\d{4}|[A-Za-z]+ \d{1,2},? \d{4})/i, t);
  const receiptOfPo = orderRaw ? dateToISO(orderRaw) : null;

  const deliveryText = grab(/Delivery:\s*(.+?)\s+(?:Sold To:|Ship to:|Prepared|$)/i, t);
  let deliveryWeeks: number | null = null;
  if (deliveryText) {
    const wm = deliveryText.match(/(\d+)(?:\s*-\s*(\d+))?\s*W(?:eek|k)/i);
    if (wm) deliveryWeeks = Number(wm[2] || wm[1]);
  }

  // Financial milestones — bounded region, then inline "50% Down Payment".
  const milestones: ReleaseMilestone[] = [];
  const msRegion = (t.match(/Milestones:(.+?)(?:Customer Contact:|Sold To:|Prepared For:|$)/i) || [])[1] || "";
  const msRe = /(\d{1,3})\s*%\s*([A-Za-z][^%]*?)(?=\s+\d{1,3}\s*%|\s+Customer Contact:|\s+Sold To:|$)/g;
  let mr: RegExpExecArray | null;
  while ((mr = msRe.exec(msRegion)) && milestones.length < 8) {
    const pct = Number(mr[1]);
    const label = mr[2].replace(/\s*\|\s*$/, "").trim();
    if (pct > 0 && pct <= 100 && label) milestones.push({ pct, label });
  }

  const penalty = /penalt/i.test(t);
  const penaltyWeeks = (() => { const m = t.match(/penalt[^.]*?(\d+)\s*weeks/i); return m ? Number(m[1]) : null; })();
  const warrantyMonths = (() => { const m = t.match(/\((\d+)\)\s*months/i); return m ? Number(m[1]) : null; })();

  // Project Budget — bounded region, then "<label> <number|$amount>" pairs.
  const budget: ReleaseBudgetLine[] = [];
  let commercialCost: number | null = null;
  const bRegion = (t.match(/Project Budget\s+(.+?)(?:Hello|This proposal|Equipment Overview|$)/i) || [])[1] || "";
  const bRe = /([A-Za-z][A-Za-z&/ ]*?)\s+(\$?[\d,]+(?:\.\d{1,2})?)(?=\s+[A-Za-z]|\s*$)/g;
  let br: RegExpExecArray | null;
  while ((br = bRe.exec(bRegion)) && budget.length < 20) {
    const label = br[1].trim();
    const isCost = br[2].includes("$");
    const value = Number(br[2].replace(/[$,]/g, ""));
    if (!label || !Number.isFinite(value)) continue;
    budget.push({ label, value, isCost });
    if (isCost && /commercial/i.test(label)) commercialCost = value;
  }

  return {
    jobNumber, jobTitle, buyer, quote, poNumber, customerContact,
    receiptOfPo, deliveryText, deliveryWeeks,
    milestones, penalty, penaltyWeeks, warrantyMonths, budget, commercialCost,
  };
}

// Parse a Project Release (.pdf or .docx) into structured fields.
export async function parseProjectRelease(buffer: Buffer, fileName: string): Promise<ParsedProjectRelease> {
  let text = "";
  let budgetImage: string | null = null;

  const isPdf = buffer.length >= 4 && buffer.toString("latin1", 0, 4) === "%PDF";
  const isZip = buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b; // "PK"

  if (isPdf) {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const res = await extractText(pdf, { mergePages: true });
    text = Array.isArray(res.text) ? res.text.join("\n") : res.text;
  } else if (isZip) {
    const zip = zipOpen(buffer);
    const docBytes = zip.extract("word/document.xml");
    if (!docBytes) throw new Error("Couldn't read the document — is this a .docx?");
    const xml = docBytes.toString("utf8");
    text = docxXmlToText(xml);
    budgetImage = docxBudgetImage(zip, xml);
  } else {
    throw new Error("Unsupported file — upload a Project Release .pdf or .docx.");
  }

  const f = extractFields(text);
  return {
    fileName: fileName || "Project Release",
    uploadedAt: new Date().toISOString(),
    ...f,
    budgetImage,
  };
}
