# Payslip Audit / Reconciliation — Design Spec

**Date:** 2026-07-30
**Project:** Payslip Sender (`/WEB/Payslip`)
**Status:** Approved design, pending implementation plan

---

## Problem

The app does **not** email the uploaded PDF. On upload it parses each payslip into
structured fields (`parsePayslip`) and **regenerates a clean PDF from those fields**
(`generatePayslipPDF`). That regenerated PDF is the "clone" emailed to each guard.

Consequence: any parsing error — a dropped line item, a misread digit — silently
produces a payslip with **wrong or missing money**, and nothing currently catches it
before it reaches an employee. The most recent bug fix in this repo was literally
"Fix dropped line items in payslip parsing," confirming this is a live, recurring class
of failure.

## Goal

Add an audit layer that verifies each parsed/regenerated payslip reconciles against the
source it was extracted from, and **blocks** any payslip that fails from being emailed
until a human explicitly reviews and overrides it.

Non-goals:
- No change to `parsePayslip` or `generatePayslipPDF` logic. The audit is purely
  additive — it observes and gates, it does not alter parsing.
- No visual/pixel comparison of PDFs. Reconciliation is arithmetic + completeness on the
  extracted values.

## Decisions (locked)

- **Check type:** Arithmetic + completeness reconciliation.
- **On mismatch:** Block sending until reviewed (explicit per-row override available).
- **When:** After upload (visible immediately) AND before send (hard gate). Two nets.

---

## Component 1 — `auditPayslip(fields, rawText)`

Pure function added to `server.js`. Takes the parsed `fields` object (the same object
`parsePayslip` returns) and the `rawText` it was parsed from. Returns:

```js
{
  ok:     boolean,        // false if any check has status 'fail'
  checks: [ { name, status: 'pass' | 'fail' | 'warn', detail } ],
  fails:  [ ...checks with status 'fail' ],
  warns:  [ ...checks with status 'warn' ],
}
```

**Must never throw.** All number parsing is wrapped defensively; any internal error
resolves to a single `fail` check `{ name: 'audit-error', status: 'fail', detail }` so a
broken audit blocks the send rather than silently passing.

### Number handling

Field values are formatted strings with commas and 2 decimals (e.g. `"77,657.96"`).
A helper `money(str) -> number|null` strips commas, `parseFloat`s, and returns `null` for
non-numeric/empty. Comparisons are done in **integer cents** to avoid floating-point
accumulation error (e.g. `2329.74 + 1553.16 + 3219.24 = 7102.139999999999`, which a naive
`Math.abs(a-b) <= 0.01` wrongly rejects). Tolerance is **5 cents**
(`TOLERANCE_CENTS = 5`): `eq(a, b) = Math.abs(round(a*100) - round(b*100)) <= 5`.

Rationale for 5¢: measured against the real Period-14 PDF (397 payslips), genuine parse
errors are off by *dollars*, while accumulated per-line rounding drifts 1–2¢. A 5¢
tolerance clears the rounding noise (84 → 17 flagged) without letting a single real error
through.

### Checks

| # | name | Rule | Result |
|---|------|------|--------|
| 1 | `required-fields` | `fields.name` non-empty AND `fields.id` non-empty | **fail** if either missing |
| 2 | `has-payments` | `fields.payments.length >= 1` | **fail** if zero |
| 3 | `gross-reconciles` | `sum(payments[].amount)` eq `gross` (±5¢) | **fail** on mismatch; if `gross` is empty/null → **fail** `detail: 'no gross detected'` |
| 4 | `deductions-reconciles` | `sum(deductions[].amount)` eq `totalDeductions` (±5¢) | **fail** on mismatch. Special case: if there are zero deductions AND `totalDeductions` is empty → **pass** (`detail: 'no deductions'`) |
| 5 | `net-reconciles` | `gross - totalDeductions` eq `net` (±5¢) | **fail** on mismatch; if `net` empty → **fail** `detail: 'no net detected'` |
| 6 | `no-dropped-amounts` | every money token `\d{1,3}(,\d{3})*\.\d{2}` in `rawText` with value `> 1.00` appears in the captured field set | **warn** per missing amount (never fail — inherently noisy) |

Check 6's "captured field set" = the multiset of all money values present in
`payments` (hrs, rate, amount), `deductions` (amount), plus `gross`, `totalDeductions`,
`net`, and every `ytd` value. A source token counts as "captured" if it equals (±0.01)
any captured value. This is a soft backstop for cases the arithmetic checks miss.

Checks 3–5 are the primary defense: a dropped pay line breaks `gross-reconciles`; a
dropped or misread deduction breaks `deductions-reconciles`; either breaks
`net-reconciles`. This is exactly the "dropped line item" failure class, caught by math.

`period` is informational only and is **not** an audit check (a missing period does not
make the money wrong).

---

## Component 2 — Gate A: after upload (`/api/upload`)

After `const fields = parsePayslip(rawText);` (server.js ~line 796):

1. `const audit = auditPayslip(fields, rawText);`
2. Store the full audit on the server-side payslip object:
   `payslips.push({ ..., audit })`.
3. Return a compact summary to the client in the mapped response
   (server.js ~line 837), alongside the existing fields:
   `audit: { ok: audit.ok, fails: audit.fails, warns: audit.warns }`.

No change to parsing or PDF generation. The `audit` object rides along with each payslip.

The re-OCR endpoint (`/api/ocr/:id`) recomputes fields for a single payslip; it must
**also recompute and update `p.audit`** so a corrected re-OCR clears/updates its status.

---

## Component 3 — Gate B: before send (`/api/send`)

Inside the recipient loop (server.js ~line 920), after resolving
`const p = session.payslips[r.pageId]`:

```js
if (p.audit && !p.audit.ok && r.override !== true) {
  results.push({
    pageId: r.pageId, name, email: r.email,
    status: 'blocked',
    message: p.audit.fails.map(f => f.detail).join('; '),
  });
  continue;   // do NOT send
}
```

- Blocked payslips are never emailed unless the recipient row carries `override: true`.
- Response gains a `blocked` count next to `sent` / `failed`:
  ```js
  res.json({
    results,
    sent:    results.filter(r => r.status === 'sent').length,
    failed:  results.filter(r => r.status === 'failed').length,
    blocked: results.filter(r => r.status === 'blocked').length,
  });
  ```

---

## Component 4 — UI (`public/app.js`, `public/index.html`, `public/style.css`)

- **Per-row audit badge** in the review list:
  - `audit.ok === true` → ✅ green "Verified".
  - `audit.ok === false` → ⛔ red "Check failed" with the fail `detail`s shown
    (expandable / on the row), e.g. "Payments total $72,000.00 ≠ Gross $77,657.96".
  - `audit.warns.length > 0` → ⚠️ amber note listing warnings; does **not** block.
- **Failing rows** render an explicit, **off-by-default** "Send anyway (override)"
  checkbox. When checked, that recipient's payload includes `override: true`. Default
  (unchecked) means the server blocks it. This respects "block until reviewed" while
  never trapping the user — they review via the existing "view original" source preview,
  then deliberately override.
- **Send summary** surfaces blocked count, e.g.
  "18 sent, 0 failed, 2 blocked (audit) — review and override to send."

---

## Error handling

- `auditPayslip` never throws; internal failure → `audit-error` fail check (blocks).
- Gate B treats a missing `p.audit` (defensive) as "no audit info" and, to stay safe,
  allows send only if audit is absent for legacy reasons — but since Gate A always sets
  it, absence should not occur. If `p.audit` is undefined, log a warning and send
  (backward-compatible), because a missing audit is an app bug, not a payslip failure.

---

## Testing

Project has no test framework today. Add Node's built-in `node:test` (zero deps).

`test/audit.test.js` covering `auditPayslip`:

1. **Clean payslip** — payments sum to gross, deductions sum to total, net checks out,
   name/id present → `ok === true`, no fails.
2. **Dropped pay line** — a payment removed so `sum(payments) < gross` → `ok === false`,
   `gross-reconciles` fails.
3. **Missing required field** — `name` empty but math consistent → `ok === false`,
   `required-fields` fails.
4. **Dropped-token warning** — a money value present in `rawText` but absent from fields,
   while arithmetic still balances → `ok === true`, one `no-dropped-amounts` warn.
5. **No deductions** — empty deductions and empty `totalDeductions` →
   `deductions-reconciles` passes.

Add `"test": "node --test"` to `package.json` scripts.

---

## Files touched

- `server.js` — add `auditPayslip` + `money`/`eq` helpers; call in `/api/upload`,
  `/api/ocr/:id`; gate in `/api/send`.
- `public/app.js` — render badges, override checkbox, blocked summary; include
  `override` in send payload.
- `public/index.html`, `public/style.css` — badge + override checkbox markup/styles.
- `test/audit.test.js` — new.
- `package.json` — add `test` script.

All additive. Existing parse/generate/send-happy-path behavior is unchanged for payslips
that pass the audit.
