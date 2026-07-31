'use strict';

// ─── State ───────────────────────────────────────────────────────────────────
let payslips      = [];           // raw list from server
let rowState      = {};           // { [id]: { name, idNumber, email, include } }
let currentPage   = 1;
let rowsPerPage   = 10;
let sectionsPerPage = 3;
let searchQuery   = '';
let smtpSettings  = JSON.parse(localStorage.getItem('smtpSettings')  || '{}');
let emailTemplate = JSON.parse(localStorage.getItem('emailTemplate') || '{}');

// ─── QSS Guards mail server ────────────────────────────────────────────────────
// Payslips are sent from the @qssguards.com mailbox. The SMTP host is the mail
// server mail.qssguards.com (Exim on server1.qssguards.com), NOT the qssguards.com
// website IP (159.198.67.228 is Namecheap web hosting and does not run SMTP —
// pointing at it causes "connect ETIMEDOUT 159.198.67.228:587" on send).
const QUEST_SMTP_HOST = 'mail.qssguards.com';
// Stale IPs / wrong hosts that must be auto-corrected to QUEST_SMTP_HOST on load.
// Includes the qssguards.com web IP and an earlier bad mail.questsec.com value.
const QUEST_STALE_HOSTS = ['159.198.67.228', '192.169.174.139', 'mail.questsec.com'];

// One-time migration: rewrite any stale mail host saved in a prior version
// so existing installs self-heal on auto-update instead of failing to send.
(function migrateQuestSmtpHost() {
  if (smtpSettings.host && QUEST_STALE_HOSTS.includes(smtpSettings.host.trim())) {
    console.warn(`Migrating stale SMTP host ${smtpSettings.host} → ${QUEST_SMTP_HOST}`);
    smtpSettings.host = QUEST_SMTP_HOST;
    smtpSettings.port = smtpSettings.port || 587;
    localStorage.setItem('smtpSettings', JSON.stringify(smtpSettings));
  }
  // Fresh install with no host yet: prefill the mail server so send works out of the box.
  if (!smtpSettings.host) smtpSettings.host = QUEST_SMTP_HOST;
})();

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const dropZone       = document.getElementById('dropZone');
const pdfInput       = document.getElementById('pdfInput');
const uploadProgress = document.getElementById('uploadProgress');
const progressFill   = document.getElementById('progressFill');
const progressText   = document.getElementById('progressText');
const mappingSection = document.getElementById('mappingSection');
const resultsSection = document.getElementById('resultsSection');
const tableBody      = document.getElementById('tableBody');
const sendBtn        = document.getElementById('sendBtn');
const selectedCount  = document.getElementById('selectedCount');
const fileInfo       = document.getElementById('fileInfo');
const masterCheck    = document.getElementById('masterCheck');
const smtpModal      = document.getElementById('smtpModal');
const previewModal   = document.getElementById('previewModal');
const sendingOverlay = document.getElementById('sendingOverlay');
const csvInput       = document.getElementById('csvInput');

// ─── Split buttons ───────────────────────────────────────────────────────────
document.querySelectorAll('.split-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.split-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    sectionsPerPage = parseInt(btn.dataset.val);
    const hint = document.getElementById('splitHint');
    hint.textContent = sectionsPerPage === 1
      ? 'Each page is one payslip'
      : `Each page will be split into ${sectionsPerPage} equal sections`;
  });
});

// ─── Upload ───────────────────────────────────────────────────────────────────
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file?.type === 'application/pdf') uploadPDF(file);
  else showToast('Please drop a PDF file.', 'error');
});
pdfInput.addEventListener('change', e => { if (e.target.files[0]) uploadPDF(e.target.files[0]); });

async function uploadPDF(file) {
  uploadProgress.classList.remove('hidden');
  progressFill.className = 'progress-fill indeterminate';
  progressText.textContent = 'Uploading and processing PDF…';
  sendBtn.disabled = true;

  const formData = new FormData();
  formData.append('pdf', file);
  formData.append('sectionsPerPage', sectionsPerPage);

  try {
    const res  = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');

    progressFill.className = 'progress-fill';
    progressFill.style.width = '100%';
    progressText.textContent =
      `Done! ${data.totalPayslips} payslip${data.totalPayslips !== 1 ? 's' : ''} extracted from ${data.totalPages} page${data.totalPages !== 1 ? 's' : ''}.`;

    initTable(data.payslips, file.name, data.totalPayslips, data.totalPages, data.sectionsPerPage);
    setTimeout(() => uploadProgress.classList.add('hidden'), 2000);
  } catch (err) {
    progressFill.className = 'progress-fill';
    progressFill.style.width = '100%';
    progressFill.style.background = '#ef4444';
    progressText.textContent = 'Error: ' + err.message;
  }
}

// ─── Table Init ───────────────────────────────────────────────────────────────
function initTable(data, filename, total, totalPages, sections) {
  payslips = data;
  currentPage = 1;
  rowState = {};

  // Seed state from server-detected values
  payslips.forEach(p => {
    rowState[p.id] = {
      name:     p.detectedName  || '',
      idNumber: p.idNumber      || '',
      email:    p.detectedEmail || '',
      include:  true,
      override: false,
    };
  });

  const splitInfo = sections > 1 ? ` · ${sections} per page` : '';
  fileInfo.textContent =
    `File: ${filename} — ${total} payslip${total !== 1 ? 's' : ''} extracted from ${totalPages} page${totalPages !== 1 ? 's' : ''}${splitInfo}`;
  fileInfo.classList.add('show');
  mappingSection.classList.remove('hidden');
  resultsSection.classList.add('hidden');

  renderTable();
}

// ─── Search ──────────────────────────────────────────────────────────────────
const searchInput = document.getElementById('searchInput');
const searchClear = document.getElementById('searchClear');

searchInput.addEventListener('input', e => {
  searchQuery = e.target.value.trim().toLowerCase();
  searchClear.classList.toggle('hidden', !searchQuery);
  currentPage = 1;
  renderTable();
});

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchQuery = '';
  searchClear.classList.add('hidden');
  currentPage = 1;
  renderTable();
});

function getFilteredPayslips() {
  if (!searchQuery) return payslips;
  return payslips.filter(p => {
    const st = rowState[p.id];
    return (st.name || '').toLowerCase().includes(searchQuery)
        || (st.idNumber || '').toLowerCase().includes(searchQuery)
        || (st.email || '').toLowerCase().includes(searchQuery);
  });
}

// ─── Audit badge ──────────────────────────────────────────────────────────────
// Renders the per-payslip audit result: green "Verified", amber warnings, or a
// red "Check failed" with reasons + an explicit off-by-default override checkbox.
function auditBadgeHtml(p, st) {
  const a = p.audit;
  if (!a) return '';
  if (a.ok) {
    const warns = a.warns || [];
    const warnHtml = warns.length
      ? `<div class="audit-warn" title="${escapeHtml(warns.map(w => w.detail).join('; '))}">⚠️ ${warns.length} warning${warns.length !== 1 ? 's' : ''}</div>`
      : '';
    return `<div class="audit-badge ok">✓ Verified</div>${warnHtml}`;
  }
  const reasons = (a.fails || []).map(f => escapeHtml(f.detail)).join('<br>');
  return `
    <div class="audit-badge fail">⛔ Check failed</div>
    <div class="audit-reasons">${reasons}</div>
    <label class="audit-override"><input type="checkbox" class="override-check" ${st.override ? 'checked' : ''} /> Send anyway</label>
  `;
}

// ─── Table Render (paginated) ─────────────────────────────────────────────────
function renderTable() {
  // Persist any unsaved edits in the DOM before re-rendering
  saveCurrentPageEdits();

  tableBody.innerHTML = '';

  const filtered = getFilteredPayslips();
  const start   = (currentPage - 1) * rowsPerPage;
  const end     = Math.min(start + rowsPerPage, filtered.length);
  const visible = filtered.slice(start, end);

  visible.forEach(p => {
    const st    = rowState[p.id];
    const label = p.section ? `${p.pageNumber}-${p.section}` : `${p.pageNumber}`;
    const tr    = document.createElement('tr');
    tr.dataset.id = p.id;
    if (!st.include) tr.classList.add('excluded');

    tr.innerHTML = `
      <td><input type="checkbox" class="row-check" ${st.include ? 'checked' : ''} /></td>
      <td><span class="page-badge" title="Page ${p.pageNumber}${p.section ? ', section ' + p.section : ''}">${label}</span></td>
      <td>
        <input type="text" class="name-input" value="${escapeHtml(st.name)}" placeholder="Employee name" />
        ${auditBadgeHtml(p, st)}
        ${p.ocrText ? `<div class="ocr-snippet">${escapeHtml(p.ocrText.substring(0, 80))}…</div>` : ''}
      </td>
      <td><input type="text" class="id-input" value="${escapeHtml(st.idNumber)}" placeholder="ID / Emp No" /></td>
      <td><input type="email" class="email-input" value="${escapeHtml(st.email)}" placeholder="email@example.com" /></td>
      <td style="white-space:nowrap">
        <button class="btn btn-ghost btn-sm preview-btn" data-id="${p.id}">Preview</button>
        <button class="btn btn-ghost btn-sm ocr-btn" data-id="${p.id}" title="Re-run OCR">OCR</button>
        <button class="btn btn-primary btn-sm send-single-btn" data-id="${p.id}" title="Send this payslip now">Send</button>
      </td>
    `;
    tableBody.appendChild(tr);

    const emailInput = tr.querySelector('.email-input');
    validateEmailInput(emailInput);

    // Live state sync — save to rowState as user types
    tr.querySelector('.name-input').addEventListener('input', e => {
      rowState[p.id].name = e.target.value;
    });
    tr.querySelector('.id-input').addEventListener('input', e => {
      const id = e.target.value.trim();
      rowState[p.id].idNumber = id;
      if (id) {
        const em = `${id.toLowerCase()}@qssguards.com`;
        emailInput.value = em;
        rowState[p.id].email = em;
        validateEmailInput(emailInput);
      }
    });
    emailInput.addEventListener('input', e => {
      rowState[p.id].email = e.target.value;
      validateEmailInput(e.target);
    });
    tr.querySelector('.row-check').addEventListener('change', e => {
      rowState[p.id].include = e.target.checked;
      tr.classList.toggle('excluded', !e.target.checked);
      updateSelectedCount();
      updateSendBtn();
      syncMasterCheck();
    });
    const overrideEl = tr.querySelector('.override-check');
    if (overrideEl) overrideEl.addEventListener('change', e => {
      rowState[p.id].override = e.target.checked;
    });
  });

  syncMasterCheck();
  updateSelectedCount();
  updateSendBtn();
  renderPagination();
}

/** Flush DOM inputs → rowState before any operation that replaces the DOM */
function saveCurrentPageEdits() {
  tableBody.querySelectorAll('tr').forEach(tr => {
    const id = parseInt(tr.dataset.id);
    if (isNaN(id) || !rowState[id]) return;
    rowState[id].name     = tr.querySelector('.name-input')?.value  || rowState[id].name;
    rowState[id].idNumber = tr.querySelector('.id-input')?.value    || rowState[id].idNumber;
    rowState[id].email    = tr.querySelector('.email-input')?.value || rowState[id].email;
    rowState[id].include  = tr.querySelector('.row-check')?.checked ?? rowState[id].include;
  });
}

// ─── Pagination ───────────────────────────────────────────────────────────────
function renderPagination() {
  const container = document.getElementById('paginationContainer');
  if (!container) return;

  const filtered = getFilteredPayslips();
  const totalPages = Math.ceil(filtered.length / rowsPerPage);
  if (totalPages <= 1) { container.innerHTML = ''; return; }

  const pages = buildPageNumbers(currentPage, totalPages);

  container.innerHTML = `
    <div class="pagination">
      <button class="pg-btn" data-pg="${currentPage - 1}" ${currentPage === 1 ? 'disabled' : ''}>&#8592; Prev</button>
      ${pages.map(p =>
        p === '…'
          ? `<span class="pg-ellipsis">…</span>`
          : `<button class="pg-btn ${p === currentPage ? 'active' : ''}" data-pg="${p}">${p}</button>`
      ).join('')}
      <button class="pg-btn" data-pg="${currentPage + 1}" ${currentPage === totalPages ? 'disabled' : ''}>Next &#8594;</button>
      <span class="pg-info">Page ${currentPage} of ${totalPages}</span>
      <select class="pg-size" id="pgSizeSelect">
        ${[5, 10, 20, 50].map(n => `<option value="${n}" ${n === rowsPerPage ? 'selected' : ''}>${n} per page</option>`).join('')}
      </select>
    </div>
  `;

  container.querySelectorAll('.pg-btn[data-pg]').forEach(btn => {
    btn.addEventListener('click', () => {
      const pg = parseInt(btn.dataset.pg);
      const max = Math.ceil(getFilteredPayslips().length / rowsPerPage);
      if (pg < 1 || pg > max) return;
      currentPage = pg;
      renderTable();
      // Scroll table into view smoothly
      document.getElementById('payslipTable').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  document.getElementById('pgSizeSelect').addEventListener('change', e => {
    rowsPerPage = parseInt(e.target.value);
    currentPage = 1;
    renderTable();
  });
}

function buildPageNumbers(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = [];
  pages.push(1);
  if (current > 3)          pages.push('…');
  for (let p = Math.max(2, current - 1); p <= Math.min(total - 1, current + 1); p++) pages.push(p);
  if (current < total - 2)  pages.push('…');
  pages.push(total);
  return pages;
}

// ─── Select All / Deselect All ────────────────────────────────────────────────
function syncMasterCheck() {
  const allIncluded = Object.values(rowState).every(s => s.include);
  const noneIncluded = Object.values(rowState).every(s => !s.include);
  masterCheck.checked       = allIncluded;
  masterCheck.indeterminate = !allIncluded && !noneIncluded;
}

masterCheck.addEventListener('change', () => {
  Object.keys(rowState).forEach(id => { rowState[id].include = masterCheck.checked; });
  renderTable();
});

document.getElementById('selectAllBtn').addEventListener('click', () => {
  Object.keys(rowState).forEach(id => { rowState[id].include = true; });
  renderTable();
});
document.getElementById('deselectAllBtn').addEventListener('click', () => {
  Object.keys(rowState).forEach(id => { rowState[id].include = false; });
  renderTable();
});

function updateSelectedCount() {
  const total    = Object.keys(rowState).length;
  const selected = Object.values(rowState).filter(s => s.include).length;
  selectedCount.textContent = `${selected} of ${total} selected`;
}

function updateSendBtn() {
  const hasAny  = Object.values(rowState).some(s => s.include);
  const hasSmtp = !!(smtpSettings.host && smtpSettings.user && smtpSettings.pass);
  sendBtn.disabled = !hasAny || !hasSmtp;
  sendBtn.title    = !hasSmtp ? 'Configure SMTP settings first' : '';
}

function validateEmailInput(input) {
  const val = input.value.trim();
  input.classList.remove('valid', 'invalid');
  if (!val) return;
  input.classList.add(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val) ? 'valid' : 'invalid');
  updateSendBtn();
}

// ─── Preview ──────────────────────────────────────────────────────────────────
let currentPreviewId = null;

async function loadPreview(id, source = false) {
  const res  = await fetch(`/api/preview/${id}${source ? '?source=1' : ''}`);
  const data = await res.json();
  if (!data.pdf) return;
  const blob = b64toBlob(data.pdf, 'application/pdf');
  document.getElementById('previewFrame').src = URL.createObjectURL(blob);
  return data;
}

document.addEventListener('click', async e => {
  if (!e.target.classList.contains('preview-btn')) return;
  const id = e.target.dataset.id;
  currentPreviewId = id;
  const toggle = document.getElementById('previewToggle');
  toggle.dataset.mode = 'generated';
  toggle.textContent  = 'View Original Scan';
  const data = await loadPreview(id, false);
  document.getElementById('previewTitle').textContent =
    `Payslip Preview — ${parseInt(id) + 1}${data?.name ? ': ' + data.name : ''}`;
  previewModal.classList.remove('hidden');
});

document.getElementById('previewToggle').addEventListener('click', async () => {
  const toggle     = document.getElementById('previewToggle');
  const isGenerated = toggle.dataset.mode === 'generated';
  toggle.dataset.mode = isGenerated ? 'source' : 'generated';
  toggle.textContent  = isGenerated ? 'View Generated PDF' : 'View Original Scan';
  await loadPreview(currentPreviewId, isGenerated);
});

document.getElementById('previewClose').addEventListener('click', () => {
  previewModal.classList.add('hidden');
  document.getElementById('previewFrame').src = '';
  currentPreviewId = null;
});
previewModal.addEventListener('click', e => {
  if (e.target === previewModal) document.getElementById('previewClose').click();
});

// ─── OCR button ───────────────────────────────────────────────────────────────
document.addEventListener('click', async e => {
  if (!e.target.classList.contains('ocr-btn')) return;
  const btn = e.target;
  const id  = parseInt(btn.dataset.id);
  const tr  = btn.closest('tr');
  btn.disabled  = true;
  btn.textContent = '…';

  try {
    const res  = await fetch(`/api/ocr/${id}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    // Update rowState
    if (data.detectedName)  rowState[id].name     = data.detectedName;
    if (data.idNumber)      rowState[id].idNumber  = data.idNumber;
    if (data.detectedEmail) rowState[id].email     = data.detectedEmail;

    // Update DOM fields in current row
    if (data.detectedName && tr.querySelector('.name-input'))
      tr.querySelector('.name-input').value = data.detectedName;
    if (data.idNumber && tr.querySelector('.id-input'))
      tr.querySelector('.id-input').value = data.idNumber;
    if (data.detectedEmail) {
      const em = tr.querySelector('.email-input');
      if (em) { em.value = data.detectedEmail; validateEmailInput(em); }
    }

    let snippet = tr.querySelector('.ocr-snippet');
    if (!snippet) {
      snippet = document.createElement('div');
      snippet.className = 'ocr-snippet';
      tr.querySelector('.name-input').after(snippet);
    }
    snippet.textContent = (data.ocrText || '').substring(0, 80) + '…';

    showToast(`OCR done — "${data.detectedName || 'no name detected'}"`, 'success');
    updateSendBtn();
  } catch (err) {
    showToast('OCR error: ' + err.message, 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'OCR';
  }
});

// ─── Send Single ─────────────────────────────────────────────────────────────
document.addEventListener('click', async e => {
  if (!e.target.classList.contains('send-single-btn')) return;
  const btn = e.target;
  const id  = parseInt(btn.dataset.id);
  const tr  = btn.closest('tr');

  // Flush current row DOM → rowState
  const st = rowState[id];
  if (!st) return;
  const nameEl  = tr.querySelector('.name-input');
  const idEl    = tr.querySelector('.id-input');
  const emailEl = tr.querySelector('.email-input');
  if (nameEl)  st.name     = nameEl.value;
  if (idEl)    st.idNumber = idEl.value;
  if (emailEl) st.email    = emailEl.value;

  // Validate email
  const email = (st.email || '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast('Enter a valid email address for this row first.', 'error');
    return;
  }

  // Validate SMTP
  if (!(smtpSettings.host && smtpSettings.user && smtpSettings.pass)) {
    showToast('Configure SMTP settings before sending.', 'error');
    openSmtpModal();
    return;
  }

  // Show spinner on button
  btn.disabled    = true;
  btn.textContent = '…';

  try {
    const res  = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        smtp: smtpSettings,
        recipients: [{ pageId: id, name: st.name, idNumber: st.idNumber, email, include: true, override: st.override === true }],
        emailTemplate: {
          subject: emailTemplate.subject || document.getElementById('emailSubject').value,
          body:    emailTemplate.body    || document.getElementById('emailBody').value,
        },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    const r0 = data.results?.[0];
    const sent = r0?.status === 'sent';
    const blocked = r0?.status === 'blocked';
    btn.textContent = sent ? '✓ Sent' : blocked ? '⛔ Blocked' : '✗ Failed';
    btn.style.background = sent ? '#065f46' : '#991b1b';
    showToast(
      sent ? `Payslip sent to ${email}`
        : blocked ? `Blocked by audit: ${r0.message}. Tick "Send anyway" to override.`
        : `Failed: ${r0?.message || 'unknown error'}`,
      sent ? 'success' : 'error');
  } catch (err) {
    btn.textContent = '✗ Error';
    btn.style.background = '#991b1b';
    showToast('Send error: ' + err.message, 'error');
  }

  // Restore button after 3 s
  setTimeout(() => {
    btn.disabled    = false;
    btn.textContent = 'Send';
    btn.style.background = '';
  }, 3000);
});

// ─── CSV Import ───────────────────────────────────────────────────────────────
csvInput.addEventListener('change', async e => {
  if (!e.target.files[0]) return;
  const formData = new FormData();
  formData.append('csv', e.target.files[0]);
  try {
    const res  = await fetch('/api/import-csv', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    let matched = 0;
    payslips.forEach((p, i) => {
      const st = rowState[p.id];
      const csvEntry = data.mapping.find(m => {
        const csvName = (m.name || '').toLowerCase();
        const rowName = st.name.toLowerCase();
        return csvName && (csvName === rowName || csvName.includes(rowName) || rowName.includes(csvName));
      }) || data.mapping[i];

      if (csvEntry?.email && !st.email) {
        st.email = csvEntry.email;
        if (csvEntry.name) st.name = csvEntry.name;
        matched++;
      }
    });

    renderTable(); // re-render to show updated values
    showToast(`CSV imported. ${matched} email${matched !== 1 ? 's' : ''} filled in.`, 'success');
    updateSendBtn();
  } catch (err) {
    showToast('CSV error: ' + err.message, 'error');
  }
  e.target.value = '';
});

// ─── Send ─────────────────────────────────────────────────────────────────────
sendBtn.addEventListener('click', async () => {
  saveCurrentPageEdits();

  const recipients = [];
  let invalid = 0;

  // Read from rowState — covers ALL pages, not just visible
  payslips.forEach(p => {
    const st = rowState[p.id];
    if (!st.include) return;
    if (!st.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(st.email)) { invalid++; return; }
    recipients.push({ pageId: p.id, name: st.name, idNumber: st.idNumber, email: st.email, include: true, override: st.override === true });
  });

  if (invalid > 0) {
    showToast(`${invalid} row${invalid !== 1 ? 's' : ''} skipped — invalid or missing email.`, 'error');
    if (recipients.length === 0) return;
  }
  if (recipients.length === 0) { showToast('No valid recipients selected.', 'error'); return; }

  if (!window.confirm(`Send payslips to ${recipients.length} employee${recipients.length !== 1 ? 's' : ''}?`)) return;

  sendingOverlay.classList.remove('hidden');
  document.getElementById('sendingProgress').textContent = `Sending to ${recipients.length} recipients…`;

  try {
    const res  = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        smtp: smtpSettings,
        recipients,
        emailTemplate: {
          subject: emailTemplate.subject || document.getElementById('emailSubject').value,
          body:    emailTemplate.body    || document.getElementById('emailBody').value,
        },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    renderResults(data);
  } catch (err) {
    showToast('Send failed: ' + err.message, 'error');
  } finally {
    sendingOverlay.classList.add('hidden');
  }
});

function renderResults(data) {
  resultsSection.classList.remove('hidden');
  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

  document.getElementById('resultsSummary').innerHTML = `
    <div class="result-stat success">
      <span class="stat-num">${data.sent}</span>
      <span class="stat-label">Sent</span>
    </div>
    <div class="result-stat ${data.failed > 0 ? 'danger' : 'success'}">
      <span class="stat-num">${data.failed}</span>
      <span class="stat-label">Failed</span>
    </div>
    ${data.blocked > 0 ? `
    <div class="result-stat danger">
      <span class="stat-num">${data.blocked}</span>
      <span class="stat-label">Blocked (audit)</span>
    </div>` : ''}
  `;

  document.getElementById('resultsList').innerHTML = data.results.map(r => `
    <div class="result-item">
      <div class="result-status ${r.status}">
        ${r.status === 'sent'
          ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>'
          : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'}
      </div>
      <span class="result-name">${escapeHtml(r.name || `Payslip ${r.pageId + 1}`)}</span>
      <span class="result-email">${escapeHtml(r.email)}</span>
      ${r.message ? `<span class="result-error">${escapeHtml(r.message)}</span>` : ''}
    </div>
  `).join('');
}

document.getElementById('resetBtn').addEventListener('click', () => {
  payslips  = [];
  rowState  = {};
  currentPage = 1;
  searchQuery = '';
  searchInput.value = '';
  searchClear.classList.add('hidden');
  tableBody.innerHTML = '';
  const pc = document.getElementById('paginationContainer');
  if (pc) pc.innerHTML = '';
  fileInfo.classList.remove('show');
  mappingSection.classList.add('hidden');
  resultsSection.classList.add('hidden');
  progressFill.style.width = '0%';
  progressFill.style.background = '';
  uploadProgress.classList.add('hidden');
  pdfInput.value = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ─── SMTP Modal ───────────────────────────────────────────────────────────────
const PRESETS = {
  quest:    { host: QUEST_SMTP_HOST,      port: 587, note: 'QSS Guards mail server. Username & password are your @qssguards.com mailbox.' },
  gmail:    { host: 'smtp.gmail.com',     port: 587, note: 'Use an App Password (not your account password).' },
  outlook:  { host: 'smtp.office365.com', port: 587, note: '' },
  yahoo:    { host: 'smtp.mail.yahoo.com',port: 587, note: 'Use an App Password from Yahoo security settings.' },
  sendgrid: { host: 'smtp.sendgrid.net',  port: 587, note: 'Username is "apikey", password is your API key.' },
  custom:   { host: '', port: 587, note: '' },
};

document.getElementById('smtpBtn').addEventListener('click', openSmtpModal);
document.getElementById('smtpClose').addEventListener('click', () => smtpModal.classList.add('hidden'));
smtpModal.addEventListener('click', e => { if (e.target === smtpModal) smtpModal.classList.add('hidden'); });

function openSmtpModal() {
  document.getElementById('smtpHost').value       = smtpSettings.host       || QUEST_SMTP_HOST;
  document.getElementById('smtpPort').value       = smtpSettings.port       || 587;
  document.getElementById('smtpUser').value       = smtpSettings.user       || '';
  document.getElementById('smtpPass').value       = smtpSettings.pass       || '';
  document.getElementById('smtpFrom').value       = smtpSettings.from       || '';
  document.getElementById('smtpSenderName').value = smtpSettings.senderName || 'HR Department';
  document.getElementById('emailSubject').value   = emailTemplate.subject   || 'Your Payslip {{period}}';
  document.getElementById('emailBody').value      = emailTemplate.body      || getDefaultBody();
  document.getElementById('smtpStatus').classList.add('hidden');
  smtpModal.classList.remove('hidden');
}

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const p = PRESETS[btn.dataset.preset];
    if (!p) return;
    document.getElementById('smtpHost').value = p.host;
    document.getElementById('smtpPort').value = p.port;
    const status = document.getElementById('smtpStatus');
    if (p.note) { status.textContent = 'Note: ' + p.note; status.className = 'smtp-status success'; status.classList.remove('hidden'); }
    else status.classList.add('hidden');
  });
});

document.getElementById('testSmtpBtn').addEventListener('click', async () => {
  const btn = document.getElementById('testSmtpBtn');
  btn.disabled = true; btn.textContent = 'Testing…';
  const status = document.getElementById('smtpStatus');
  try {
    const res  = await fetch('/api/test-smtp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ smtp: getSmtpFormValues() }),
    });
    const data = await res.json();
    status.textContent = data.success ? 'Connection successful!' : 'Error: ' + data.error;
    status.className   = `smtp-status ${data.success ? 'success' : 'error'}`;
    status.classList.remove('hidden');
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
    status.className   = 'smtp-status error';
    status.classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = 'Test Connection';
  }
});

document.getElementById('saveSmtpBtn').addEventListener('click', () => {
  smtpSettings  = getSmtpFormValues();
  emailTemplate = {
    subject: document.getElementById('emailSubject').value,
    body:    document.getElementById('emailBody').value,
  };
  localStorage.setItem('smtpSettings',  JSON.stringify(smtpSettings));
  localStorage.setItem('emailTemplate', JSON.stringify(emailTemplate));
  smtpModal.classList.add('hidden');
  updateSendBtn();
  showToast('SMTP settings saved.', 'success');
});

function getSmtpFormValues() {
  return {
    host:       document.getElementById('smtpHost').value.trim(),
    port:       parseInt(document.getElementById('smtpPort').value) || 587,
    user:       document.getElementById('smtpUser').value.trim(),
    pass:       document.getElementById('smtpPass').value,
    from:       document.getElementById('smtpFrom').value.trim(),
    senderName: document.getElementById('smtpSenderName').value.trim(),
    secure:     parseInt(document.getElementById('smtpPort').value) === 465,
  };
}

function getDefaultBody() {
  return `<p>Dear {{name}},</p>\n<p>Please find attached your payslip{{period_text}}.</p>\n<p>If you have any questions, please contact the HR department.</p>\n<br>\n<p>Regards,<br><strong>{{sender_name}}</strong></p>`;
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg, type = 'success') {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  Object.assign(t.style, {
    position: 'fixed', bottom: '24px', right: '24px',
    padding: '12px 18px', borderRadius: '8px',
    background: type === 'success' ? '#065f46' : '#991b1b',
    color: 'white', fontSize: '13px', fontWeight: '500',
    zIndex: '999', boxShadow: '0 4px 12px rgba(0,0,0,.2)', maxWidth: '320px',
  });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function b64toBlob(b64, type) {
  const bytes = atob(b64);
  const arr   = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type });
}

// ─── Init ─────────────────────────────────────────────────────────────────────
updateSendBtn();
if (smtpSettings.host) {
  document.getElementById('smtpBtn').style.borderColor = '#10b981';
  document.getElementById('smtpBtn').style.color       = '#065f46';
}
