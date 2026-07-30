'use strict';

/** Parse a formatted money string ("77,657.96") to a number, or null if not numeric. */
function money(str) {
  if (str === null || str === undefined) return null;
  const f = parseFloat(String(str).replace(/,/g, ''));
  return isNaN(f) ? null : f;
}

/** Format a number as a 2-decimal money string for human-readable check details. */
function fmtNum(n) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** How many cents of difference is tolerated when reconciling totals.
 *  Set to 5 to absorb accumulated per-line rounding drift while still
 *  catching real dropped-line / misread errors (which are off by dollars). */
const TOLERANCE_CENTS = 5;

/**
 * Equal within the tolerance, compared in integer cents so floating-point
 * accumulation error (e.g. 2329.74 + 1553.16 + 3219.24 = 7102.139999999999)
 * never turns a genuine 1-cent rounding gap into a false failure.
 */
function eq(a, b) {
  return Math.abs(Math.round(a * 100) - Math.round(b * 100)) <= TOLERANCE_CENTS;
}

function auditPayslip(fields, rawText = '') {
  try {
    return runChecks(fields, rawText);
  } catch (e) {
    const err = { name: 'audit-error', status: 'fail', detail: `audit failed: ${e.message}` };
    return { ok: false, checks: [err], fails: [err], warns: [] };
  }
}

function runChecks(fields, rawText) {
  const checks = [];
  const f = fields || {};
  const payments = Array.isArray(f.payments) ? f.payments : [];

  // ── required fields: name and ID must be present ──
  const hasName = !!(f.name && String(f.name).trim());
  const hasId = !!(f.id && String(f.id).trim());
  if (hasName && hasId) {
    checks.push({ name: 'required-fields', status: 'pass', detail: 'name and ID present' });
  } else {
    const missing = [!hasName && 'name', !hasId && 'ID'].filter(Boolean).join(' and ');
    checks.push({ name: 'required-fields', status: 'fail', detail: `${missing} missing` });
  }

  // ── has payments: at least one payment row ──
  if (payments.length >= 1) {
    checks.push({ name: 'has-payments', status: 'pass', detail: `${payments.length} payment row(s)` });
  } else {
    checks.push({ name: 'has-payments', status: 'fail', detail: 'no payment rows detected' });
  }

  // ── gross reconciles: sum(payments.amount) == gross ──
  const gross = money(f.gross);
  const payTotal = payments.reduce((s, p) => s + (money(p.amount) || 0), 0);
  if (gross === null) {
    checks.push({ name: 'gross-reconciles', status: 'fail', detail: 'no gross detected' });
  } else if (eq(payTotal, gross)) {
    checks.push({ name: 'gross-reconciles', status: 'pass',
      detail: `payments $${fmtNum(payTotal)} = gross $${fmtNum(gross)}` });
  } else {
    checks.push({ name: 'gross-reconciles', status: 'fail',
      detail: `payments total $${fmtNum(payTotal)} != gross $${fmtNum(gross)}` });
  }

  // ── deductions reconcile: sum(deductions.amount) == totalDeductions ──
  const deductions = Array.isArray(f.deductions) ? f.deductions : [];
  const totalDed = money(f.totalDeductions);
  const dedTotal = deductions.reduce((s, d) => s + (money(d.amount) || 0), 0);
  if (deductions.length === 0 && totalDed === null) {
    checks.push({ name: 'deductions-reconciles', status: 'pass', detail: 'no deductions' });
  } else if (totalDed === null) {
    checks.push({ name: 'deductions-reconciles', status: 'fail',
      detail: `deductions total $${fmtNum(dedTotal)} but no total-deductions detected` });
  } else if (eq(dedTotal, totalDed)) {
    checks.push({ name: 'deductions-reconciles', status: 'pass',
      detail: `deductions $${fmtNum(dedTotal)} = total $${fmtNum(totalDed)}` });
  } else {
    checks.push({ name: 'deductions-reconciles', status: 'fail',
      detail: `deductions total $${fmtNum(dedTotal)} != total deductions $${fmtNum(totalDed)}` });
  }

  // ── net reconciles: gross - totalDeductions == net ──
  const net = money(f.net);
  if (net === null) {
    checks.push({ name: 'net-reconciles', status: 'fail', detail: 'no net detected' });
  } else if (gross === null) {
    checks.push({ name: 'net-reconciles', status: 'fail', detail: 'no gross to compute net' });
  } else {
    const expected = gross - (totalDed || 0);
    if (eq(expected, net)) {
      checks.push({ name: 'net-reconciles', status: 'pass',
        detail: `gross - deductions = net $${fmtNum(net)}` });
    } else {
      checks.push({ name: 'net-reconciles', status: 'fail',
        detail: `gross - deductions $${fmtNum(expected)} != net $${fmtNum(net)}` });
    }
  }

  // ── no dropped amounts: every money token in the source text (> $1) ──
  // ── should appear somewhere in the captured fields (warn only) ──
  const captured = [];
  const add = v => { const m = money(v); if (m !== null) captured.push(m); };
  payments.forEach(p => { add(p.hrs); add(p.rate); add(p.amount); });
  deductions.forEach(d => add(d.amount));
  add(f.gross); add(f.totalDeductions); add(f.net);
  if (f.ytd && typeof f.ytd === 'object') Object.values(f.ytd).forEach(add);

  const tokens = String(rawText || '').match(/\d{1,3}(?:,\d{3})*\.\d{2}/g) || [];
  const missing = [];
  for (const t of tokens) {
    const val = money(t);
    if (val === null || val <= 1) continue;
    if (!captured.some(c => eq(c, val)) && !missing.includes(t)) missing.push(t);
  }
  if (missing.length) {
    checks.push({ name: 'no-dropped-amounts', status: 'warn',
      detail: `amount(s) in source not on payslip: ${missing.map(m => '$' + m).join(', ')}` });
  } else {
    checks.push({ name: 'no-dropped-amounts', status: 'pass', detail: 'all source amounts accounted for' });
  }

  const fails = checks.filter(c => c.status === 'fail');
  const warns = checks.filter(c => c.status === 'warn');
  return { ok: fails.length === 0, checks, fails, warns };
}

module.exports = { auditPayslip };
