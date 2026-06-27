const express    = require('express');
const multer     = require('multer');
const nodemailer = require('nodemailer');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const pdfParse   = require('pdf-parse');
const fs         = require('fs');
const path       = require('path');
const { parse: csvParse }  = require('csv-parse/sync');
const { createCanvas, ImageData }     = require('canvas');
const { createWorker }     = require('tesseract.js');

// ── Polyfill browser globals needed by pdfjs-dist in Node.js ──
if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class DOMMatrix {
    constructor(init) {
      const v = init && Array.isArray(init) ? init : [1,0,0,1,0,0];
      this.a=v[0]; this.b=v[1]; this.c=v[2]; this.d=v[3]; this.e=v[4]; this.f=v[5];
      this.m11=v[0]; this.m12=v[1]; this.m21=v[2]; this.m22=v[3]; this.m41=v[4]; this.m42=v[5];
      this.m13=0; this.m14=0; this.m23=0; this.m24=0;
      this.m31=0; this.m32=0; this.m33=1; this.m34=0;
      this.m43=0; this.m44=1; this.is2D=true; this.isIdentity=(v[0]===1&&v[1]===0&&v[2]===0&&v[3]===1&&v[4]===0&&v[5]===0);
    }
    static fromMatrix(o) { return new DOMMatrix([o.a||o.m11||1,o.b||o.m12||0,o.c||o.m21||0,o.d||o.m22||1,o.e||o.m41||0,o.f||o.m42||0]); }
    static fromFloat32Array(a) { return new DOMMatrix(Array.from(a)); }
    static fromFloat64Array(a) { return new DOMMatrix(Array.from(a)); }
    multiply(o) { const a=this,b=o; return new DOMMatrix([a.a*b.a+a.c*b.b, a.b*b.a+a.d*b.b, a.a*b.c+a.c*b.d, a.b*b.c+a.d*b.d, a.a*b.e+a.c*b.f+a.e, a.b*b.e+a.d*b.f+a.f]); }
    translate(tx,ty) { return this.multiply(new DOMMatrix([1,0,0,1,tx||0,ty||0])); }
    scale(sx,sy) { return this.multiply(new DOMMatrix([sx||1,0,0,sy||sx||1,0,0])); }
    inverse() { const {a,b,c,d,e,f}=this, det=a*d-b*c; if(!det) return new DOMMatrix([0,0,0,0,0,0]); const id=1/det; return new DOMMatrix([d*id,-b*id,-c*id,a*id,(c*f-d*e)*id,(b*e-a*f)*id]); }
    transformPoint(p) { return { x: this.a*(p.x||0)+this.c*(p.y||0)+this.e, y: this.b*(p.x||0)+this.d*(p.y||0)+this.f }; }
    toString() { return `matrix(${this.a},${this.b},${this.c},${this.d},${this.e},${this.f})`; }
  };
}
if (typeof globalThis.ImageData === 'undefined') { globalThis.ImageData = ImageData; }
if (typeof globalThis.Path2D === 'undefined') {
  globalThis.Path2D = class Path2D { constructor(){} addPath(){} closePath(){} moveTo(){} lineTo(){} bezierCurveTo(){} quadraticCurveTo(){} arc(){} arcTo(){} ellipse(){} rect(){} };
}

const app = express();
app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const UPLOAD_DIR   = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const EMAIL_DOMAIN = 'qssguards.com';
const COMPANY_NAME = 'Quest Security Services';

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => cb(null, `payslips-${Date.now()}.pdf`),
});
const pdfUpload = multer({
  storage,
  fileFilter: (req, file, cb) =>
    file.mimetype === 'application/pdf' ? cb(null, true) : cb(new Error('PDF only')),
  limits: { fileSize: 50 * 1024 * 1024 },
});
const csvUpload = multer({ storage: multer.memoryStorage() });

let session = null;

// ═══════════════════════════════════════════════════════════════
//  PARSING — specifically for the Quest Security Services layout
// ═══════════════════════════════════════════════════════════════

/**
 * Remove bleed-over from previous payslip section.
 *
 * When a page is cropped into thirds, the bottom rows of the payslip above
 * can appear at the very top of the next section.  Each payslip's real
 * content begins with the company name + date line, immediately followed by
 * the "From X To Y  SLIP#: …" line.  We find that anchor and discard
 * everything above it.
 */
function cleanPayslipText(rawText) {
  const lines = rawText.replace(/\r/g, '\n').split('\n');

  // Anchor pattern: line contains "From DD/MM/YYYY To DD/MM/YYYY"
  const PERIOD_RE = /From\s+\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\s+To\s+\d{1,2}[\/\-]/i;

  const periodIdx = lines.findIndex(l => PERIOD_RE.test(l));
  if (periodIdx <= 0) return rawText; // nothing to strip

  // Keep the line immediately above "From…To" (= company name + Date: line)
  // unless that line looks like bleed content (contains numbers that look like YTD figures)
  const lineAbove = lines[periodIdx - 1] || '';
  const isBleed   = /\d{1,3},\d{3}\.\d{2}/.test(lineAbove); // has money figures → bleed
  const startIdx  = isBleed ? periodIdx : Math.max(0, periodIdx - 1);

  return lines.slice(startIdx).join('\n');
}

/**
 * Parse one payslip section's OCR text into a structured object.
 * Format:
 *   Quest Security Services                      Date: 8 Jul 2025
 *   From 9/6/2025 To 22/6/2025  SLIP#: 212573  TRN: 108077128  NIS: G764258
 *   ID: 240822  NAME: Pamella Powell-Richards
 *   [PAYMENTS table + DEDUCTIONS table side-by-side]
 *   Gross  $77,657.96   TOTAL  7,102.15
 *   Year to Date                                Net  $70,555.81
 *   NIS   NHT   Income Tax   ED. Tax   Gross
 *   14,124.27  9,416.18  1,524.36  10,275.41  470,809.02
 */
function parsePayslip(rawText) {
  // Strip bleed-over from the previous section before parsing
  const text  = cleanPayslipText(rawText).replace(/\r/g, '\n');
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const result = {
    companyName: COMPANY_NAME,
    date:        '',
    periodFrom:  '',
    periodTo:    '',
    slipNumber:  '',
    trn:         '',
    nis:         '',
    id:          '',
    name:        '',
    email:       '',
    payments:    [],   // { description, hrs, rate, amount }
    deductions:  [],   // { description, amount }
    gross:       '',
    totalDeductions: '',
    net:         '',
    ytd:         {},   // { nis, nht, incomeTax, edTax, gross }
  };

  for (const line of lines) {
    // ── Date ──────────────────────────────────────────────────
    // Only pick up date from lines that also contain the company name
    // or a standalone "Date: D Mon YYYY" line — avoids capturing
    // "Date:" that appears inside the contaminated ID/NAME bleed line
    if (!result.date) {
      const onCompanyLine = /Quest Security/i.test(line) || /^Date\s*[:\-]/i.test(line);
      if (onCompanyLine) {
        const m = line.match(/Date\s*[:\-]\s*(\d{1,2}\s+\w+\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
        if (m) result.date = m[1].trim();
      }
    }

    // ── Period ────────────────────────────────────────────────
    if (!result.periodFrom) {
      const m = line.match(/From\s+([\d\/\-]+)\s+To\s+([\d\/\-]+)/i);
      if (m) { result.periodFrom = m[1]; result.periodTo = m[2]; }
    }

    // ── Slip # ───────────────────────────────────────────────
    if (!result.slipNumber) {
      const m = line.match(/SLIP\s*#?\s*[:\-]?\s*(\d+)/i);
      if (m) result.slipNumber = m[1];
    }

    // ── TRN ───────────────────────────────────────────────────
    if (!result.trn) {
      const m = line.match(/TRN\s*[:\-]?\s*([\d]+)/i);
      if (m) result.trn = m[1];
    }

    // ── NIS number ────────────────────────────────────────────
    if (!result.nis) {
      const m = line.match(/NIS\s*[:\-]?\s*([A-Z]\d+|\d{5,})/i);
      if (m) result.nis = m[1];
    }

    // ── ID + NAME (the most important line) ───────────────────
    // Pattern: "ID: 240822  NAME: Britany Anderson"
    // Name must stop before any date, company name, SLIP#, TRN, etc.
    // Stop anchors: "From \d", a bare date, "Quest", "SLIP", "TRN", "Date:"
    const NAME_STOP = /(?=\s+(?:From\s+\d|\d{1,2}[\/\-]\d{1,2}[\/\-]|Quest|SLIP|TRN\b|Date:|NIS\b|NHT\b|\d{2,3},\d{3}))/i;

    if (!result.id) {
      // Combined "ID: XXXX  NAME: Full Name" on one line
      const m = line.match(/ID\s*[:\-]?\s*(\d+)\s+NAME\s*[:\-]?\s*([A-Za-z][A-Za-z'\-\s\.]+?)(?:NAME_STOP|$)/i);
      if (m) {
        result.id   = m[1].trim();
        result.name = cleanName(m[2]);
      }
    }
    if (!result.id) {
      // Split "ID: XXXX  NAME: Full Name" using named anchor replacement
      const combined = /ID\s*[:\-]?\s*(\d+)\s+NAME\s*[:\-]?\s*([A-Za-z][A-Za-z'\-\s\.]+?)(?=\s+(?:From\s+\d|\d{1,2}[\/\-]|Quest|SLIP|TRN|Date:)|$)/i;
      const m = line.match(combined);
      if (m) {
        result.id   = m[1].trim();
        result.name = cleanName(m[2]);
      }
    }
    // Fallback: ID only
    if (!result.id) {
      const m = line.match(/\bID\s*[:\-]\s*(\d{3,10})/i);
      if (m) result.id = m[1];
    }
    // Fallback: NAME only
    if (!result.name) {
      const m = line.match(/\bNAME\s*[:\-]\s*([A-Za-z][A-Za-z'\-\s\.]+?)(?=\s+(?:From\s+\d|\d{1,2}[\/\-]|Quest|SLIP|TRN|Date:)|$)/i);
      if (m) result.name = cleanName(m[1]);
    }

    // ── Gross pay ────────────────────────────────────────────
    // Handles both "Gross  $77,657.96" standalone and
    // "Gross  $77,657.96  TOTAL  7,102.15" combined lines
    if (!result.gross) {
      const m = line.match(/(?:^|\s)Gross\s+\$?([\d,]+\.?\d*)/i);
      if (m) result.gross = m[1];
    }

    // ── Total deductions (from same line as Gross, or standalone) ─
    if (!result.totalDeductions) {
      const m = line.match(/TOTAL\s+\$?([\d,]+\.?\d*)/i);
      if (m) result.totalDeductions = m[1];
    }

    // ── Net pay ──────────────────────────────────────────────
    if (!result.net) {
      const m = line.match(/\bNet\b.*?\$?([\d,]+\.?\d*)/i);
      if (m) result.net = m[1];
    }
  }

  // ── Parse PAYMENTS and DEDUCTIONS ───────────────────────────
  //
  // Strategy:
  //   1. Line-by-line: handle well-formed rows on a single line
  //      "Base Pay  80.00  400.00  32,000.00  NIS  2,329.74"
  //   2. Multiline fallback: OCR sometimes puts numbers on separate lines;
  //      search the full text block for each known description + 3 numbers
  //   3. Deduction fallback: look for known deduction keywords + 1 amount

  const SKIP_TABLE = new Set(['description','hrs/dys/tsk','rate','amount',
    'payments','deductions','gross','total','year to date','net','ytd']);

  // ── Pass 1: single-line rows ────────────────────────────────
  for (const line of lines) {
    const lo = line.toLowerCase().trim();
    if (!lo || SKIP_TABLE.has(lo)) continue;
    if (/year to date|quest security|from\s+\d|^date\b|^slip|^trn\b|^id\b|^name\b/i.test(lo)) continue;

    // Pull every number (with or without decimals, with or without commas)
    const nums = [...line.matchAll(/([\d,]+(?:\.\d+)?)/g)]
      .map(m => m[1].replace(/,/g, ''))
      .filter(n => parseFloat(n) > 0);

    if (nums.length < 3) continue;  // payment rows need at least 3 numbers

    const firstNumPos = line.search(/\d/);
    if (firstNumPos < 2) continue;
    const desc = line.slice(0, firstNumPos).trim().replace(/\s{2,}/g, ' ');
    if (!desc || SKIP_TABLE.has(desc.toLowerCase())) continue;
    if (/^(from|to|date|slip|trn|id|name|quest)/i.test(desc)) continue;

    // Known deductions are handled separately — skip them here
    if (/\b(NIS|NHT|ED\.?\s*Tax|Income\s*Tax)\b/i.test(desc) && nums.length < 3) continue;

    // Payment row: first 3 nums = hrs, rate, amount
    const already = result.payments.some(p => p.description.toLowerCase() === desc.toLowerCase());
    if (!already) {
      result.payments.push({
        description: desc,
        hrs:    fmt2(nums[0]),
        rate:   fmt2(nums[1]),
        amount: fmt2(nums[2]),
      });
    }

    // ── Inline deduction: text after the 3rd number may be a deduction ──
    // e.g. "Base Pay  80.00  400.00  32,000.00  NIS  2,329.74"
    //       ^^^^^^^^^^^^^^ payment ^^^^^^^^^^^^^^  ^^^ deduction ^^^
    if (nums.length >= 4) {
      // Find the text between the 3rd and 4th number
      const thirdNumMatch = [...line.matchAll(/([\d,]+(?:\.\d+)?)/g)][2];
      if (thirdNumMatch) {
        const afterPayment = line.slice(thirdNumMatch.index + thirdNumMatch[0].length);
        const dedMatch = afterPayment.match(/\s*(NIS|NHT|ED\.?\s*Tax|Income\s*Tax)\s+([\d,]+\.?\d*)/i);
        if (dedMatch) {
          const dedDesc = dedMatch[1].trim();
          const dedAmt  = dedMatch[2].replace(/,/g, '');
          const dedAlready = result.deductions.some(d => d.description.toLowerCase() === dedDesc.toLowerCase());
          if (!dedAlready) {
            result.deductions.push({ description: dedDesc, amount: fmt2(dedAmt) });
          }
        }
      }
    }
  }

  // ── Pass 2: multiline fallback for payments ─────────────────
  // OCR can put the description and its numbers on separate lines.
  // Scan for any word-phrase followed (within ~120 chars) by 3 numbers.
  if (result.payments.length === 0) {
    // Build a flat version of the text (newlines → spaces) for pattern matching
    const flat = text.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ');

    // Generic: word-phrase NOT starting with a known deduction/header + 3 numbers
    const rowRe = /([A-Za-z][A-Za-z\s\-\.]{1,30}?)\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d*)/g;
    const headerWords = /^(Description|Hrs|Rate|Amount|PAYMENTS|DEDUCTIONS|From|To|Date|SLIP|TRN|ID|NAME|Quest|Year|Net|Gross|TOTAL|NIS|NHT|Income|ED\.?\s*Tax)/i;

    let m;
    while ((m = rowRe.exec(flat)) !== null) {
      const desc   = m[1].trim();
      const [h, r, a] = [m[2], m[3], m[4]].map(n => fmt2(n.replace(/,/g, '')));
      if (headerWords.test(desc)) continue;
      if (SKIP_TABLE.has(desc.toLowerCase())) continue;
      if (/\b(NIS|NHT|ED\.?\s*Tax|Income\s*Tax)\b/i.test(desc)) continue;
      const already = result.payments.some(p => p.description.toLowerCase() === desc.toLowerCase());
      if (!already) {
        result.payments.push({ description: desc, hrs: h, rate: r, amount: a });
      }
    }
  }

  // ── Pass 3: deduction fallback ───────────────────────────────
  // Only search lines ABOVE the YTD header to avoid matching YTD values
  if (result.deductions.length === 0) {
    const ytdHdrIdx = lines.findIndex(l =>
      /NIS.*NHT.*(?:Income Tax|ED\.?\s*Tax)/i.test(l));
    const searchLines = ytdHdrIdx > 0 ? lines.slice(0, ytdHdrIdx) : lines;
    const flat2 = searchLines.join(' ');
    const dedPatterns = [
      { key: 'NIS',        re: /\bNIS\b\s+([\d,]+\.\d{2})/i },
      { key: 'NHT',        re: /\bNHT\b\s+([\d,]+\.\d{2})/i },
      { key: 'Income Tax', re: /Income\s*Tax\s+([\d,]+\.\d{2})/i },
      { key: 'ED. Tax',    re: /ED\.?\s*Tax\s+([\d,]+\.\d{2})/i },
    ];
    for (const { key, re } of dedPatterns) {
      const dm = flat2.match(re);
      if (dm) result.deductions.push({ description: key, amount: dm[1] });
    }
  }

  // ── YTD row ──────────────────────────────────────────────────
  // Header varies: "NIS NHT Income Tax ED. Tax Gross" (5 cols)
  //            or: "NIS NHT ED. Tax Gross"            (4 cols)
  // Values on the next line must be mapped by the actual header columns.
  const ytdHeaderIdx = lines.findIndex(l =>
    /NIS.*NHT.*(?:Income\s*Tax|ED\.?\s*Tax)/i.test(l)
  );
  if (ytdHeaderIdx >= 0) {
    const hdr = lines[ytdHeaderIdx];
    // Detect which columns are present in the header
    const hasIncomeTax = /Income\s*Tax/i.test(hdr);
    const hasEdTax     = /ED\.?\s*Tax/i.test(hdr);
    const hasGross     = /Gross/i.test(hdr);

    // Build ordered column key list based on what's in the header
    const colKeys = ['nis', 'nht'];
    if (hasIncomeTax) colKeys.push('incomeTax');
    if (hasEdTax)     colKeys.push('edTax');
    if (hasGross)     colKeys.push('gross');

    for (let offset = 1; offset <= 2 && ytdHeaderIdx + offset < lines.length; offset++) {
      const ytdLine = lines[ytdHeaderIdx + offset];
      const ytdNums = ytdLine.match(/([\d,]+\.\d{2})/g);
      if (ytdNums && ytdNums.length >= colKeys.length) {
        result.ytd = { nis: '', nht: '', incomeTax: '', edTax: '', gross: '' };
        colKeys.forEach((key, i) => { result.ytd[key] = ytdNums[i] || ''; });
        break;
      }
    }
  }

  // ── Derive email ──────────────────────────────────────────────
  result.email = result.id ? `${result.id.toLowerCase()}@${EMAIL_DOMAIN}` : '';

  return result;
}

/** Format a plain number string with commas and 2 decimal places */
function fmt2(n) {
  const f = parseFloat(String(n).replace(/,/g, ''));
  if (isNaN(f)) return n;
  return f.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Split a full page text into per-payslip chunks using the company header as a marker */
function splitTextByPayslip(pageText) {
  // Each payslip starts with "Quest Security Services"
  const parts = pageText.split(/(?=Quest Security Services)/i);
  return parts.map(p => p.trim()).filter(p => p.length > 80);
}

function cleanName(str) {
  return (str || '')
    .replace(/^(?:from|to|for|dear|re|by|of|the)\s+/i, '')
    // Cut off at the first stop keyword or date pattern
    .replace(/\s+(?:From|To|Date:|SLIP|TRN|Quest|NIS|NHT|\d{1,2}[\/\-]\d{1,2}[\/\-]).*/i, '')
    .replace(/\s+(?:from|to|for|the)$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ═══════════════════════════════════════════════════════════════
//  PDF GENERATOR — matches the Quest Security Services layout
// ═══════════════════════════════════════════════════════════════

async function generatePayslipPDF(fields) {
  const doc  = await PDFDocument.create();
  const W    = 595, H = 842;  // A4 portrait
  const page = doc.addPage([W, H]);

  const fReg  = await doc.embedFont(StandardFonts.Helvetica);
  const fBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const M   = 30;
  const CW  = W - M * 2;

  // ── Helpers ─────────────────────────────────────────────────
  const rect = (x, y, w, h, fill, border) =>
    page.drawRectangle({ x, y, width: w, height: h,
      ...(fill   ? { color: fill }          : {}),
      ...(border ? { borderColor: border, borderWidth: 0.7 } : {}) });

  const hline = (y, x1 = M, x2 = M + CW, color = rgb(0.2,0.2,0.2), t = 0.8) =>
    page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: t, color });

  const vline = (x, y1, y2, color = rgb(0.5,0.5,0.5), t = 0.5) =>
    page.drawLine({ start: { x, y: y1 }, end: { x, y: y2 }, thickness: t, color });

  const T = (str, x, y, { sz = 9, f = fReg, c = rgb(0,0,0), mw } = {}) => {
    if (!str && str !== 0) return;
    let s = String(str);
    if (mw) while (s.length > 1 && f.widthOfTextAtSize(s, sz) > mw) s = s.slice(0, -1);
    page.drawText(s, { x, y, size: sz, font: f, color: c });
  };

  const TR = (str, rx, y, opts = {}) => {
    const { sz = 9, f = fReg, c = rgb(0,0,0) } = opts;
    const w = f.widthOfTextAtSize(String(str || ''), sz);
    T(str, rx - w, y, { sz, f, c });
  };

  const TC = (str, cx, y, opts = {}) => {
    const { sz = 9, f = fReg, c = rgb(0,0,0) } = opts;
    const w = f.widthOfTextAtSize(String(str || ''), sz);
    T(str, cx - w / 2, y, { sz, f, c });
  };

  // ── Colours ─────────────────────────────────────────────────
  const cHeader = rgb(0.86, 0.86, 0.86);
  const cBorder = rgb(0.3, 0.3, 0.3);
  const cBlack  = rgb(0, 0, 0);
  const cWhite  = rgb(1, 1, 1);

  let y = H - 30;  // current top y

  // ════════════════════════════════════════════════════════════
  //  ROW 1 — Company name + Date
  // ════════════════════════════════════════════════════════════
  T(fields.companyName || COMPANY_NAME, M, y, { sz: 13, f: fBold });
  if (fields.date) TR(`Date: ${fields.date}`, M + CW, y, { sz: 11, f: fBold });
  y -= 5;
  hline(y, M, M + CW, cBorder, 1.2);
  y -= 14;

  // ════════════════════════════════════════════════════════════
  //  ROW 2 — Period + SLIP# + TRN + NIS
  // ════════════════════════════════════════════════════════════
  const periodStr = fields.periodFrom && fields.periodTo
    ? `From ${fields.periodFrom} To ${fields.periodTo}`
    : (fields.periodFrom || '');
  T(periodStr, M, y, { sz: 9, f: fBold });

  const slipStr = fields.slipNumber ? `SLIP#: ${fields.slipNumber}` : '';
  const trnStr  = fields.trn  ? `TRN: ${fields.trn}` : '';
  const nisStr  = fields.nis  ? `NIS: ${fields.nis}` : '';
  const meta2   = [slipStr, trnStr, nisStr].filter(Boolean).join('    ');
  TR(meta2, M + CW, y, { sz: 9, f: fBold });
  y -= 4;
  hline(y, M, M + CW, cBorder, 0.8);
  y -= 14;

  // ════════════════════════════════════════════════════════════
  //  ROW 3 — ID + NAME
  // ════════════════════════════════════════════════════════════
  const idNameStr = `ID: ${fields.id || '—'}    NAME: ${fields.name || '—'}`;
  T(idNameStr, M, y, { sz: 10, f: fBold });
  y -= 4;
  hline(y, M, M + CW, cBorder, 0.8);
  y -= 3;

  // ════════════════════════════════════════════════════════════
  //  PAYMENTS / DEDUCTIONS TABLE
  // ════════════════════════════════════════════════════════════
  // Column layout (mirroring original):
  //  PAYMENTS side (left ~63%):  Desc | Hrs/Dys/Tsk | Rate | Amount
  //  DEDUCTIONS side (right ~37%): Desc | Amount
  const tableTop   = y;
  const ROW_H      = 16;
  const HEADER_H   = 18;

  // Column X positions
  const pLeft  = M;               // payments left edge
  const pSplit = M + CW * 0.63;   // split between payments/deductions
  const dRight = M + CW;          // right edge

  // Payment sub-columns
  const pDescW = CW * 0.63 * 0.38;
  const pHrsW  = CW * 0.63 * 0.18;
  const pRateW = CW * 0.63 * 0.18;
  const pAmtW  = CW * 0.63 * 0.26;

  const pDescX = pLeft;
  const pHrsX  = pDescX + pDescW;
  const pRateX = pHrsX  + pHrsW;
  const pAmtX  = pRateX + pRateW;

  // Deduction sub-columns
  const dDescW = (dRight - pSplit) * 0.62;
  const dAmtW  = (dRight - pSplit) * 0.38;
  const dDescX = pSplit;
  const dAmtX  = dDescX + dDescW;

  // ── Table header row ──────────────────────────────────────────
  rect(pLeft, y - HEADER_H, pSplit - pLeft, HEADER_H, cHeader, cBorder);
  rect(pSplit, y - HEADER_H, dRight - pSplit, HEADER_H, cHeader, cBorder);

  TC('PAYMENTS',   pLeft + (pSplit - pLeft) / 2,  y - 12, { sz: 9, f: fBold });
  TC('DEDUCTIONS', pSplit + (dRight - pSplit) / 2, y - 12, { sz: 9, f: fBold });
  y -= HEADER_H;

  // ── Column header row ──────────────────────────────────────────
  rect(pLeft, y - HEADER_H, pSplit - pLeft, HEADER_H, cHeader, cBorder);
  rect(pSplit, y - HEADER_H, dRight - pSplit, HEADER_H, cHeader, cBorder);

  T('Description',   pDescX + 3, y - 12, { sz: 8, f: fBold });
  TC('Hrs/Dys/Tsk',  pHrsX  + pHrsW / 2,  y - 12, { sz: 7.5, f: fBold });
  TC('Rate',         pRateX + pRateW / 2,  y - 12, { sz: 8, f: fBold });
  TR('Amount',       pAmtX  + pAmtW - 3,  y - 12, { sz: 8, f: fBold });
  T('Description',   dDescX + 3, y - 12, { sz: 8, f: fBold });
  TR('Amount',       dAmtX  + dAmtW - 3,  y - 12, { sz: 8, f: fBold });
  y -= HEADER_H;

  // ── Data rows ─────────────────────────────────────────────────
  const maxRows = Math.max(fields.payments.length, fields.deductions.length, 4);

  for (let i = 0; i < maxRows; i++) {
    rect(pLeft, y - ROW_H, pSplit - pLeft, ROW_H, cWhite, cBorder);
    rect(pSplit, y - ROW_H, dRight - pSplit, ROW_H, cWhite, cBorder);

    const pay = fields.payments[i];
    if (pay) {
      T(pay.description, pDescX + 3, y - 11, { sz: 8.5, mw: pDescW - 6 });
      TR(pay.hrs,    pHrsX  + pHrsW  - 3, y - 11, { sz: 8.5 });
      TR(pay.rate,   pRateX + pRateW - 3, y - 11, { sz: 8.5 });
      TR(pay.amount, pAmtX  + pAmtW  - 3, y - 11, { sz: 8.5 });
    }

    const ded = fields.deductions[i];
    if (ded) {
      T(ded.description, dDescX + 3, y - 11, { sz: 8.5, mw: dDescW - 6 });
      TR(ded.amount, dAmtX + dAmtW - 3, y - 11, { sz: 8.5 });
    }

    y -= ROW_H;
  }

  // ── Gross + Total row ─────────────────────────────────────────
  rect(pLeft, y - HEADER_H, pSplit - pLeft, HEADER_H, cHeader, cBorder);
  rect(pSplit, y - HEADER_H, dRight - pSplit, HEADER_H, cHeader, cBorder);

  TR('Gross', pAmtX - 6, y - 12, { sz: 9, f: fBold });
  TR(fields.gross ? `$${fields.gross}` : '', pAmtX + pAmtW - 3, y - 12, { sz: 9, f: fBold });
  TR('TOTAL', dAmtX - 6, y - 12, { sz: 9, f: fBold });
  TR(fields.totalDeductions || '', dAmtX + dAmtW - 3, y - 12, { sz: 9, f: fBold });
  y -= HEADER_H;

  // ── Year to Date + Net row ────────────────────────────────────
  rect(pLeft, y - HEADER_H, pSplit - pLeft, HEADER_H, cWhite, cBorder);
  rect(pSplit, y - HEADER_H, dRight - pSplit, HEADER_H, cWhite, cBorder);

  T('Year to Date', pDescX + 3, y - 12, { sz: 9, f: fBold });
  T('Net', dDescX + 3, y - 12, { sz: 9, f: fBold });
  TR(fields.net ? `$${fields.net}` : '', dAmtX + dAmtW - 3, y - 12, { sz: 9, f: fBold });
  y -= HEADER_H;

  // ── YTD figures ───────────────────────────────────────────────
  if (fields.ytd && Object.keys(fields.ytd).length > 0) {
    const ytd = fields.ytd;
    // Build columns dynamically based on which values are present
    const allCols = [
      { label: 'NIS',        key: 'nis' },
      { label: 'NHT',        key: 'nht' },
      { label: 'Income Tax', key: 'incomeTax' },
      { label: 'ED. Tax',    key: 'edTax' },
      { label: 'Gross',      key: 'gross' },
    ];
    const activeCols = allCols.filter(c => ytd[c.key]);
    const ytdW = CW / activeCols.length;

    // Header row — individual bordered cells
    activeCols.forEach((col, i) => {
      const cx = pLeft + i * ytdW;
      rect(cx, y - HEADER_H, ytdW, HEADER_H, cHeader, cBorder);
      T(col.label, cx + 4, y - 12, { sz: 8, f: fBold });
    });
    y -= HEADER_H;

    // Values row — individual bordered cells, values right-aligned in each cell
    activeCols.forEach((col, i) => {
      const cx = pLeft + i * ytdW;
      rect(cx, y - ROW_H, ytdW, ROW_H, cWhite, cBorder);
      TR(ytd[col.key], cx + ytdW - 4, y - 11, { sz: 8.5 });
    });
    y -= ROW_H;
  }

  y -= 10;

  // ── Divider ─────────────────────────────────────────────────
  hline(y, M, M + CW, cBorder, 1.5);
  y -= 16;

  // ── Footer ──────────────────────────────────────────────────
  T('Computer-generated payslip. No signature required.', M, 14,
    { sz: 7.5, c: rgb(0.45, 0.45, 0.45) });
  TR(`Generated ${new Date().toLocaleDateString('en-JM')}`, M + CW, 14,
    { sz: 7.5, c: rgb(0.45, 0.45, 0.45) });

  return doc.save();
}

// ═══════════════════════════════════════════════════════════════
//  OCR
// ═══════════════════════════════════════════════════════════════

let ocrWorker = null;
async function getOcrWorker() {
  if (!ocrWorker) {
    ocrWorker = await createWorker('eng', 1, {
      logger:    () => {},
      cachePath: path.join(__dirname, '.tesseract-cache'),
    });
    // Hint tesseract that this is mostly numbers + standard chars
    await ocrWorker.setParameters({ tessedit_char_whitelist: '' });
  }
  return ocrWorker;
}

async function renderPageToImage(pdfBytes, pageIndex, scale = 2.5) {
  const pdfjsLib   = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(pdfBytes) });
  const pdfDoc     = await loadingTask.promise;
  const page       = await pdfDoc.getPage(pageIndex + 1);
  const viewport   = page.getViewport({ scale });
  const canvas     = createCanvas(viewport.width, viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return { canvas, width: viewport.width, height: viewport.height };
}

async function ocrBuffer(buf) {
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(buf);
  return data.text || '';
}

async function ocrSection(pdfBytes, pageIndex, sectionIndex, numSections) {
  const { canvas, width, height } = await renderPageToImage(pdfBytes, pageIndex);
  const sH   = height / numSections;
  const yStart = sectionIndex * sH;
  const crop = createCanvas(width, sH);
  crop.getContext('2d').drawImage(canvas, 0, yStart, width, sH, 0, 0, width, sH);
  return ocrBuffer(crop.toBuffer('image/png'));
}

async function ocrFullPage(pdfBytes, pageIndex) {
  const { canvas } = await renderPageToImage(pdfBytes, pageIndex);
  return ocrBuffer(canvas.toBuffer('image/png'));
}

// ═══════════════════════════════════════════════════════════════
//  PDF SECTION CROPPER
// ═══════════════════════════════════════════════════════════════

async function cropPageSection(pdfDoc, pageIndex, sectionIndex, numSections) {
  const page = pdfDoc.getPage(pageIndex);
  const { width, height } = page.getSize();
  const sH      = height / numSections;
  const newPdf  = await PDFDocument.create();
  const [emb]   = await newPdf.embedPdf(pdfDoc, [pageIndex]);
  const newPage = newPdf.addPage([width, sH]);
  newPage.drawPage(emb, { x: 0, y: -((numSections - 1 - sectionIndex) * sH), width, height });
  return newPdf.save();
}

// ═══════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════

app.post('/api/upload', pdfUpload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });

    const sectionsPerPage = Math.max(1, parseInt(req.body.sectionsPerPage) || 1);
    const pdfBytes        = fs.readFileSync(req.file.path);

    // Try embedded text first — preserve line structure using Y-coordinates
    const pageTexts = [];
    await pdfParse(pdfBytes, {
      pagerender: (pd) => pd.getTextContent().then(tc => {
        // Group text items by Y position to preserve line breaks
        const lineMap = {};
        tc.items.forEach(item => {
          if (!item.str.trim()) return;
          const y = Math.round(item.transform[5]); // Y coordinate
          if (!lineMap[y]) lineMap[y] = [];
          lineMap[y].push({ x: item.transform[4], str: item.str });
        });
        // Sort Y descending (top→bottom), X ascending (left→right) within each line
        const sortedYs = Object.keys(lineMap).map(Number).sort((a, b) => b - a);
        const text = sortedYs.map(y =>
          lineMap[y].sort((a, b) => a.x - b.x).map(i => i.str).join(' ')
        ).join('\n');
        pageTexts.push(text);
        return '';
      }),
    });

    const pdfDoc    = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();
    const totalChars = pageTexts.reduce((s, t) => s + t.trim().length, 0);
    const isScanned  = totalChars < totalPages * 50;
    console.log(`PDF: ${isScanned ? 'scanned→OCR' : 'text'} | ${totalChars} chars across ${totalPages} pages`);

    const payslips = [];
    let id = 0;

    for (let pi = 0; pi < totalPages; pi++) {
      for (let si = 0; si < sectionsPerPage; si++) {
        // 1. Crop the physical section
        const croppedBytes = sectionsPerPage === 1
          ? await (async () => {
              const s = await PDFDocument.create();
              const [cp] = await s.copyPages(pdfDoc, [pi]);
              s.addPage(cp); return s.save();
            })()
          : await cropPageSection(pdfDoc, pi, si, sectionsPerPage);

        // 2. Extract raw text (OCR if needed)
        let rawText = '';
        if (sectionsPerPage === 1) {
          rawText = pageTexts[pi] || '';
          if (isScanned || rawText.trim().length < 40) {
            console.log(`  OCR page ${pi + 1}...`);
            rawText = await ocrFullPage(pdfBytes, pi);
          }
        } else {
          // For text-based PDFs: split the embedded text by payslip marker
          // (much more reliable than OCR for table content)
          if (!isScanned) {
            const sections = splitTextByPayslip(pageTexts[pi] || '');
            rawText = sections[si] || '';
            console.log(`  Embedded text page ${pi + 1} section ${si + 1}: ${rawText.length} chars`);
          }
          // Scanned PDF, or embedded text split failed / too short → OCR
          if (isScanned || rawText.trim().length < 60) {
            console.log(`  OCR page ${pi + 1} section ${si + 1}/${sectionsPerPage}...`);
            rawText = await ocrSection(pdfBytes, pi, si, sectionsPerPage);
          }
        }

        // 3. Parse fields
        const fields = parsePayslip(rawText);
        fields.rawText = rawText;

        // 4. Generate clean PDF
        let genBytes;
        try {
          genBytes = await generatePayslipPDF(fields);
        } catch (e) {
          console.warn('PDF gen failed:', e.message);
          genBytes = croppedBytes;
        }

        payslips.push({
          id:            id++,
          pageNumber:    pi + 1,
          section:       sectionsPerPage > 1 ? si + 1 : null,
          detectedName:  fields.name,
          detectedEmail: fields.email,
          idNumber:      fields.id,
          period:        fields.periodFrom && fields.periodTo
                           ? `${fields.periodFrom} – ${fields.periodTo}`
                           : fields.date || '',
          slipNumber:    fields.slipNumber,
          ocrText:       rawText.substring(0, 1200),
          pdfBase64:     Buffer.from(genBytes).toString('base64'),
          sourcePdfBase64: Buffer.from(croppedBytes).toString('base64'),
        });
      }
    }

    if (session?.filePath && fs.existsSync(session.filePath)) {
      try { fs.unlinkSync(session.filePath); } catch {}
    }
    session = { payslips, filePath: req.file.path };

    res.json({
      success:       true,
      totalPages,
      totalPayslips: payslips.length,
      sectionsPerPage,
      filename:      req.file.originalname,
      payslips:      payslips.map(({ pdfBase64, sourcePdfBase64, ...rest }) => rest),
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/preview/:id', (req, res) => {
  if (!session) return res.status(404).json({ error: 'No session' });
  const p = session.payslips[parseInt(req.params.id)];
  if (!p) return res.status(404).json({ error: 'Not found' });
  const pdf = req.query.source === '1' ? (p.sourcePdfBase64 || p.pdfBase64) : p.pdfBase64;
  res.json({ pdf, name: p.detectedName, ocrText: p.ocrText || '' });
});

app.post('/api/ocr/:id', async (req, res) => {
  if (!session) return res.status(404).json({ error: 'No session' });
  const p = session.payslips[parseInt(req.params.id)];
  if (!p) return res.status(404).json({ error: 'Not found' });
  try {
    const srcBytes = Buffer.from(p.sourcePdfBase64 || p.pdfBase64, 'base64');
    const rawText  = await ocrFullPage(srcBytes, 0);
    const fields   = parsePayslip(rawText);
    fields.rawText = rawText;
    const newBytes = await generatePayslipPDF(fields);

    p.ocrText       = rawText.substring(0, 1200);
    p.detectedName  = fields.name  || p.detectedName;
    p.idNumber      = fields.id    || p.idNumber;
    p.detectedEmail = fields.email || p.detectedEmail;
    p.period        = fields.periodFrom ? `${fields.periodFrom} – ${fields.periodTo}` : p.period;
    p.slipNumber    = fields.slipNumber || p.slipNumber;
    p.pdfBase64     = Buffer.from(newBytes).toString('base64');

    res.json({
      success:       true,
      ocrText:       p.ocrText,
      detectedName:  p.detectedName,
      detectedEmail: p.detectedEmail,
      idNumber:      p.idNumber,
      period:        p.period,
    });
  } catch (err) {
    res.status(500).json({ error: 'OCR error: ' + err.message });
  }
});

app.post('/api/import-csv', csvUpload.single('csv'), (req, res) => {
  try {
    const records = csvParse(req.file.buffer.toString('utf8'),
      { columns: true, skip_empty_lines: true, trim: true });
    const mapping = records.map(row => {
      const nk = Object.keys(row).find(k => /name/i.test(k));
      const ek = Object.keys(row).find(k => /email/i.test(k));
      return { name: nk ? row[nk] : '', email: ek ? row[ek] : '' };
    }).filter(r => r.name || r.email);
    res.json({ success: true, mapping });
  } catch (err) {
    res.status(400).json({ error: 'CSV error: ' + err.message });
  }
});

app.post('/api/send', async (req, res) => {
  const { smtp, recipients, emailTemplate } = req.body;
  if (!session)            return res.status(400).json({ error: 'No session. Upload a PDF first.' });
  if (!smtp?.host || !smtp?.user || !smtp?.pass)
    return res.status(400).json({ error: 'Incomplete SMTP config' });
  if (!recipients?.length) return res.status(400).json({ error: 'No recipients' });

  const mkTransport = () => nodemailer.createTransport({
    host: smtp.host, port: parseInt(smtp.port) || 587,
    secure: smtp.secure === true || parseInt(smtp.port) === 465,
    auth: { user: smtp.user, pass: smtp.pass },
    tls: { rejectUnauthorized: false },
    pool: false,  // one connection per message to avoid concurrency limits
  });

  try { const t = mkTransport(); await t.verify(); t.close(); }
  catch (err) { return res.status(400).json({ error: 'SMTP failed: ' + err.message }); }

  const delay = (ms) => new Promise(r => setTimeout(r, ms));
  const results = [];
  for (const r of recipients.filter(r => r.include && r.email)) {
    const p = session.payslips[r.pageId];
    if (!p) { results.push({ ...r, status: 'error', message: 'Not found' }); continue; }

    const name   = r.name   || p.detectedName || 'Employee';
    const period = p.period || '';
    const subject = (emailTemplate?.subject || 'Your Payslip {{period}}')
      .replace(/{{name}}/g, name).replace(/{{period}}/g, period).trim();
    const html = (emailTemplate?.body || defaultEmailBody())
      .replace(/{{name}}/g, name)
      .replace(/{{period_text}}/g, period ? ` for ${period}` : '')
      .replace(/{{period}}/g, period)
      .replace(/{{sender_name}}/g, smtp.senderName || 'HR Department');

    try {
      const transport = mkTransport();
      await transport.sendMail({
        from: `"${smtp.senderName || 'HR Department'}" <${smtp.from || smtp.user}>`,
        to:   r.email,
        subject, html,
        attachments: [{
          filename: `Payslip-${name.replace(/\s+/g, '-')}${period ? '-' + period.replace(/[\s\/]/g, '-') : ''}.pdf`,
          content:  Buffer.from(p.pdfBase64, 'base64'),
          contentType: 'application/pdf',
        }],
      });
      transport.close();
      results.push({ pageId: r.pageId, name, email: r.email, status: 'sent' });
      console.log(`  ✉ Sent to ${r.email} (${results.length}/${recipients.length})`);
    } catch (err) {
      results.push({ pageId: r.pageId, name, email: r.email, status: 'failed', message: err.message });
      console.warn(`  ✗ Failed ${r.email}: ${err.message}`);
    }
    // Throttle: wait 1.5s between sends to avoid SMTP rate limits
    await delay(1500);
  }

  res.json({
    results,
    sent:   results.filter(r => r.status === 'sent').length,
    failed: results.filter(r => r.status === 'failed').length,
  });
});

app.post('/api/test-smtp', async (req, res) => {
  try {
    const t = nodemailer.createTransport({
      host: req.body.smtp.host, port: parseInt(req.body.smtp.port) || 587,
      secure: req.body.smtp.secure === true || parseInt(req.body.smtp.port) === 465,
      auth: { user: req.body.smtp.user, pass: req.body.smtp.pass },
      tls: { rejectUnauthorized: false },
    });
    await t.verify();
    res.json({ success: true, message: 'SMTP connection successful!' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

function defaultEmailBody() {
  return `<p>Dear {{name}},</p>
<p>Please find attached your payslip{{period_text}}.</p>
<p>If you have any questions, please contact the HR department.</p>
<br><p>Regards,<br><strong>{{sender_name}}</strong></p>`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n✅ Payslip Sender  →  ${url}\n`);

  // Auto-open browser
  const { execFile } = require('child_process');
  const platform = process.platform;
  if (platform === 'win32')      execFile('cmd', ['/c', 'start', url], () => {});
  else if (platform === 'darwin') execFile('open', [url], () => {});
  else                            execFile('xdg-open', [url], () => {});
});
