const { test } = require('node:test');
const assert = require('node:assert');
const { auditPayslip } = require('../audit');

// A clean, fully-reconciling payslip:
//   payments 40,000.00 + 37,657.96 = gross 77,657.96
//   deductions 2,000.00 + 1,000.00 = total 3,000.00
//   net = 77,657.96 - 3,000.00 = 74,657.96
function cleanFields() {
  return {
    name: 'John Brown',
    id: '240822',
    payments: [
      { description: 'Base Pay', hrs: '80.00', rate: '500.00', amount: '40,000.00' },
      { description: 'Overtime', hrs: '', rate: '', amount: '37,657.96' },
    ],
    deductions: [
      { description: 'NIS', amount: '2,000.00' },
      { description: 'NHT', amount: '1,000.00' },
    ],
    gross: '77,657.96',
    totalDeductions: '3,000.00',
    net: '74,657.96',
    ytd: { nis: '2,000.00', nht: '1,000.00', incomeTax: '', edTax: '', gross: '77,657.96' },
  };
}

const cleanRaw = [
  'Quest Security Services',
  'ID: 240822  NAME: John Brown',
  'Base Pay 80.00 500.00 40,000.00 NIS 2,000.00',
  'Overtime 37,657.96 NHT 1,000.00',
  'Gross 77,657.96 TOTAL 3,000.00',
  'Net 74,657.96',
].join('\n');

test('clean payslip passes with no failures', () => {
  const audit = auditPayslip(cleanFields(), cleanRaw);
  assert.strictEqual(audit.ok, true);
  assert.deepStrictEqual(audit.fails, []);
});

test('dropped pay line fails gross reconciliation', () => {
  const f = cleanFields();
  f.payments.pop(); // drop Overtime 37,657.96; gross still says 77,657.96
  const audit = auditPayslip(f, cleanRaw);
  assert.strictEqual(audit.ok, false);
  assert.ok(audit.fails.some(c => c.name === 'gross-reconciles'),
    'expected a gross-reconciles failure');
});

test('missing name fails required-fields even when math is consistent', () => {
  const f = cleanFields();
  f.name = ''; // math still balances, but the person is unidentified
  const audit = auditPayslip(f, cleanRaw);
  assert.strictEqual(audit.ok, false);
  assert.ok(audit.fails.some(c => c.name === 'required-fields'),
    'expected a required-fields failure');
});

test('wrong net fails net reconciliation', () => {
  const f = cleanFields();
  f.net = '70,000.00'; // should be 74,657.96 (gross - deductions)
  const audit = auditPayslip(f, cleanRaw);
  assert.strictEqual(audit.ok, false);
  assert.ok(audit.fails.some(c => c.name === 'net-reconciles'),
    'expected a net-reconciles failure');
});

test('mismatched deductions total fails deductions reconciliation', () => {
  const f = cleanFields();
  f.totalDeductions = '5,000.00'; // deductions sum to 3,000.00
  const audit = auditPayslip(f, cleanRaw);
  assert.strictEqual(audit.ok, false);
  assert.ok(audit.fails.some(c => c.name === 'deductions-reconciles'),
    'expected a deductions-reconciles failure');
});

test('no deductions with no total passes deductions reconciliation', () => {
  const f = cleanFields();
  f.deductions = [];
  f.totalDeductions = '';
  f.net = '77,657.96'; // net now equals gross
  const audit = auditPayslip(f, cleanRaw);
  assert.ok(audit.checks.some(c => c.name === 'deductions-reconciles' && c.status === 'pass'),
    'expected deductions-reconciles to pass');
  assert.ok(!audit.fails.some(c => c.name === 'deductions-reconciles'));
});

test('amount in source but not on payslip raises a warning, not a failure', () => {
  // Arithmetic still balances, but the raw text holds an extra 5,555.55
  // that never made it into any parsed field.
  const raw = cleanRaw + '\nMeal Allowance 5,555.55';
  const audit = auditPayslip(cleanFields(), raw);
  assert.strictEqual(audit.ok, true); // warning does not block
  assert.ok(audit.warns.some(c => c.name === 'no-dropped-amounts'),
    'expected a no-dropped-amounts warning');
});

test('one-cent rounding between line items and stated total still reconciles', () => {
  // Real case from PERIOD 14: deductions sum to 7,102.14 but the stated
  // total is 7,102.15 — a 1-cent rounding difference must NOT fail.
  const f = cleanFields();
  f.deductions = [
    { description: 'NIS',        amount: '2,329.74' },
    { description: 'NHT',        amount: '1,553.16' },
    { description: 'Income Tax', amount: '3,219.24' },
  ]; // float sum = 7102.139999999999, stated total 1 cent higher
  f.totalDeductions = '7,102.15';
  f.gross = '77,657.96';
  f.net = '70,555.81'; // 77,657.96 - 7,102.15
  const audit = auditPayslip(f, cleanRaw);
  assert.ok(!audit.fails.some(c => c.name === 'deductions-reconciles'),
    'a 1-cent rounding gap should not fail deductions reconciliation');
});

test('rounding drift up to 5 cents reconciles, beyond it fails', () => {
  const within = cleanFields();
  within.totalDeductions = '3,000.05'; // deductions sum to 3,000.00 → 5c drift
  within.net = '74,657.91';            // 77,657.96 - 3,000.05
  assert.ok(!auditPayslip(within, cleanRaw).fails.some(c => c.name === 'deductions-reconciles'),
    '5-cent drift should be tolerated');

  const beyond = cleanFields();
  beyond.totalDeductions = '3,000.06'; // 6c drift → over tolerance
  beyond.net = '74,657.90';
  assert.ok(auditPayslip(beyond, cleanRaw).fails.some(c => c.name === 'deductions-reconciles'),
    '6-cent drift should fail');
});

test('internal error never throws and blocks with audit-error', () => {
  const evil = { payments: [], get name() { throw new Error('boom'); } };
  let audit;
  assert.doesNotThrow(() => { audit = auditPayslip(evil, ''); });
  assert.strictEqual(audit.ok, false);
  assert.ok(audit.fails.some(c => c.name === 'audit-error'),
    'expected an audit-error failure');
});
