import { api, login, getPass } from './api.js';
import { toast, confirmModal, promptModal, row, badge, countBadge, showErrorBanner, clearErrorBanner } from './ui.js';
import { icon } from './icons.js';

const $ = s => document.querySelector(s);

// LOGIN
$('#enterBtn').onclick = async () => {
  const ok = await login($('#pass').value);
  if (ok) { $('#gate').classList.add('hidden'); $('#app').classList.remove('hidden'); boot(); }
  else $('#gateErr').textContent = 'Wrong passphrase.';
};
$('#pass').addEventListener('keydown', e => { if (e.key === 'Enter') $('#enterBtn').click(); });

// TABS
document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(x => x.classList.add('hidden'));
  t.classList.add('active');
  $('#tab-' + t.dataset.tab).classList.remove('hidden');
  // Land on whichever sub-tab has pending items each time Leads is opened — consumed by
  // loadLeadsTab() below, not on every 30s background poll, so it doesn't yank the
  // operator away from what they're looking at while the tab stays open.
  if (t.dataset.tab === 'leads') leadsTabNeedsAutoNav = true;
});

// LEADS SUB-TABS
document.querySelectorAll('.subtab').forEach(t => t.onclick = () => selectSubtab(t.dataset.subtab));
function selectSubtab(name) {
  document.querySelectorAll('.subtab').forEach(x => x.classList.toggle('active', x.dataset.subtab === name));
  document.querySelectorAll('.subtab-panel').forEach(x => x.classList.toggle('hidden', x.id !== 'subtab-' + name));
}

async function boot() { loadHeaderStatus(); loadBatches(); loadConfig(); wireOrganizer(); loadLeadsTab(); }

// Wires the "Organize old Drive recordings" card, which now lives as static markup in
// index.html (Actions tab) instead of being injected into the DOM at boot — keeps the
// tab's real content fully visible in the HTML rather than only knowable by reading JS.
function wireOrganizer() {
  $('#orgPreview').onclick = async () => {
    $('#orgResult').textContent = 'Scanning Drive…';
    try {
      const r = await api('/api/organize/preview');
      if (!r.count) { $('#orgResult').textContent = 'No recordings found in the folder.'; return; }
      $('#orgResult').innerHTML = `<b>${r.count} files</b> will be organized like this:<br><br>` +
        r.plan.map(p => `${p.name}<br>&nbsp;&nbsp;➜ <b>${p.target}</b>`).join('<br><br>');
      $('#orgApply').style.display = 'inline-block';
    } catch (e) { $('#orgResult').textContent = 'Error: ' + e.message; }
  };

  $('#orgApply').onclick = async () => {
    const ok = await confirmModal({ title: 'Move all these recordings?', body: 'Old share links will keep working, but files will be reorganized into Batch/Topic folders.', confirmLabel: 'Move files' });
    if (!ok) return;
    $('#orgApply').disabled = true; $('#orgResult').textContent = 'Organizing… (bade archive me thoda time lagega)';
    try {
      const r = await api('/api/organize/execute', { method: 'POST' });
      $('#orgResult').textContent = `Done — ${r.moved}/${r.total} files organized.`;
      $('#orgApply').style.display = 'none';
    } catch (e) { $('#orgResult').textContent = 'Error: ' + e.message; }
    $('#orgApply').disabled = false;
  };
}


// Header status pills — WhatsApp connection, contact-cache sync, and bot mode all live
// here now instead of only inside the Leads tab, since all three determine "is it safe
// to leave the bot alone right now" and shouldn't require opening a tab to check.
async function loadHeaderStatus() {
  try {
    const s = await api('/api/whatsapp/status');
    setPill('pillWa', s.ready ? 'WhatsApp connected' : 'WhatsApp: scan QR', s.ready ? 'success' : 'danger');
  } catch {
    setPill('pillWa', 'WhatsApp: unavailable', 'danger');
  }

  try {
    const stats = await api('/api/leads/stats');
    const cache = stats.contactCache;
    setPill('pillCache',
      cache.ready ? `Contact sync: ${cache.size} loaded` : 'Contact sync: not ready — bot silent for everyone',
      cache.ready ? 'success' : 'warning');
    setPill('pillMode',
      `Bot: ${stats.mode === 'auto' ? 'AUTO (sends live)' : 'DRAFT'}`,
      stats.mode === 'auto' ? 'warning' : null);
  } catch {
    setPill('pillCache', 'Contact sync: unavailable', 'danger');
    setPill('pillMode', 'Bot: unavailable', 'danger');
  }

  setTimeout(loadHeaderStatus, 15000);
}

function setPill(id, text, tone) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = 'status-pill' + (tone ? ' status-pill-' + tone : '');
  el.innerHTML = `<span class="dot"></span>${text}`;
}

// Short date-time like "10 Jul, 06:21 am"
const shortDT = (d) => new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
const REMS = [[1440, '24h'], [180, '3h'], [60, '1h'], [10, '10m'], [2, '2m']];

// BATCHES
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Shared list-row email editor — used by both the new-batch form and every existing
// batch's edit box, instead of a single cramped comma-separated field. `emails` is the
// current array; onChange(nextArray) is called after every add/remove so the caller
// decides what to do with the new list (hold it in memory, or PUT it on save).
function renderEmailList(container, emails, onChange) {
  container.innerHTML = `
    <div class="list">
      ${emails.length ? emails.map((e, i) => row({
        icon: 'mail',
        primary: e,
        actionsHtml: `<button type="button" class="icon-btn danger" data-remove-email="${i}" title="Remove email">${icon('trash')}</button>`
      })).join('') : '<div class="empty-state">No emails yet.</div>'}
      <button type="button" class="list-row-add" data-add-email>${icon('plus')} Add email</button>
    </div>`;

  container.querySelectorAll('[data-remove-email]').forEach(btn => btn.onclick = () => {
    onChange(emails.filter((_, i) => i !== Number(btn.dataset.removeEmail)));
  });

  container.querySelector('[data-add-email]').onclick = async () => {
    const value = await promptModal({ title: 'Add student email', placeholder: 'student@email.com', confirmLabel: 'Add' });
    if (value === null) return; // cancelled
    const email = value.trim();
    if (!email) return;
    if (!EMAIL_RE.test(email)) return toast('That doesn’t look like a valid email', { tone: 'danger' });
    if (emails.includes(email)) return toast('Already in the list', { tone: 'danger' });
    onChange([...emails, email]);
  };
}

// New-batch form state — held in memory until "Create batch" is clicked, same as the
// name/JID/folder fields already were.
let newBatchEmails = [];
function renderNewBatchEmails() {
  renderEmailList($('#bEmailList'), newBatchEmails, (next) => { newBatchEmails = next; renderNewBatchEmails(); });
}
renderNewBatchEmails();

// Per-batch pending email edits, keyed by batch id — only meaningful while that batch's
// edit box is open; re-seeded from the server's copy every time loadBatches() re-renders.
const pendingEditEmails = {};

async function loadBatches() {
  let list;
  try {
    list = await api('/api/batches');
  } catch (e) {
    showErrorBanner($('#batchList'), 'Could not load batches: ' + e.message, loadBatches);
    return;
  }
  clearErrorBanner($('#batchList'));

  const now = Date.now();
  const endOf = c => new Date(c.startISO).getTime() + (c.durationMin || 60) * 60000;

  $('#batchList').innerHTML = list.map(b => {
    const upcoming = (b.classes || []).filter(c => c.status !== 'cancelled' && endOf(c) > now);
    const history  = (b.classes || []).filter(c => c.status === 'cancelled' || endOf(c) <= now)
                        .sort((a, z) => new Date(z.startISO) - new Date(a.startISO));

    const upcomingHtml = upcoming.map(c => {
      const start = new Date(c.startISO);
      const rem = REMS.map(([m, lab]) => {
        const t = new Date(start.getTime() - m * 60000);
        return `${lab} ${shortDT(t)}${t.getTime() < now ? '✓' : ''}`;
      }).join('  ·  ');
      return `<div class="classline">
        <div>${icon('calendar', { size: 14 })} <b>${c.topic}</b> — ${shortDT(start)} · <a href="${c.meetLink}" target="_blank">Join link</a>
          <button class="btn btn-danger btn-sm" data-delcls="${b.id}:${c.id}" style="margin-left:8px">Cancel class</button>
          <button class="btn btn-secondary btn-sm" data-sendrec="${b.id}:${c.id}" style="margin-left:8px">${icon('video', { size: 13 })} Send recording</button></div>
        <div class="rem" style="opacity:.7;font-size:.85em;margin:4px 0 10px">${icon('clock', { size: 12 })} Reminders → ${rem}</div>
      </div>`;
    }).join('');

    const historyHtml = history.length ? `
      <div style="margin-top:10px;padding-top:8px;border-top:1px solid #333">
        <div style="opacity:.6;font-size:.85em;margin-bottom:6px">${icon('folder', { size: 13 })} History (${history.length})</div>
        ${history.map(c => {
          const cancelled = c.status === 'cancelled';
          const badge = cancelled
            ? `<span class="badge badge-danger">Cancelled</span>`
            : `<span class="badge badge-success">Completed</span>`;
          const rec = c.recordingLink
            ? ` · <a href="${c.recordingLink}" target="_blank">▶ Recording</a>`
            : (cancelled ? '' : ` · <button class="btn btn-secondary btn-sm" data-sendrec="${b.id}:${c.id}">${icon('video', { size: 13 })} Send recording</button>`);
          const reason = cancelled && c.cancelReason ? `<div style="opacity:.6;font-size:.8em">Reason: ${c.cancelReason}</div>` : '';
          return `<div class="classline" style="opacity:.9">
            <div>${badge} <b>${c.topic}</b> — ${shortDT(new Date(c.startISO))}${rec}
              <button class="icon-btn danger" data-purge="${b.id}:${c.id}" title="Remove from history" style="margin-left:8px">${icon('trash', { size: 13 })}</button></div>
            ${reason}
          </div>`;
        }).join('')}
      </div>` : '';

    if (!(b.id in pendingEditEmails)) pendingEditEmails[b.id] = [...(b.emails || [])];

    return `
    <div class="batch">
      <h3>${b.name}</h3>
      <div class="meta">${b.emails.length} emails${b.driveFolderId ? ' (viewer access ✓)' : ''} · ${b.whatsappGroupJid ? 'group linked ✓' : 'no group (Note-to-Self)'}${b.driveFolderId ? ` · <a href="https://drive.google.com/drive/folders/${b.driveFolderId}" target="_blank">${icon('folder', { size: 12 })} batch folder</a>` : ''}
        <button class="btn btn-secondary btn-sm" data-editbtn="${b.id}" style="margin-left:8px">${icon('edit', { size: 13 })} Edit batch</button></div>

      <div class="editbox" id="edit_${b.id}" style="display:none;margin:10px 0;padding:14px;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-surface-2)">
        <div class="field">
          <label class="field-label" for="en_${b.id}">Batch name</label>
          <input id="en_${b.id}" class="input" value="${(b.name || '').replace(/"/g, '&quot;')}">
        </div>
        <div class="field">
          <label class="field-label">Student emails</label>
          <div id="ee_${b.id}"></div>
        </div>
        <div class="field">
          <label class="field-label" for="ej_${b.id}">WhatsApp group JID or invite link</label>
          <input id="ej_${b.id}" class="input" value="${(b.whatsappGroupJid || '').replace(/"/g, '&quot;')}" placeholder="120363...@g.us  OR  https://chat.whatsapp.com/xxxx">
        </div>
        <button class="btn btn-primary" data-saveedit="${b.id}" style="margin-top:4px">Save changes</button>
      </div>

      ${upcomingHtml || '<div style="opacity:.5;font-size:.85em;margin:6px 0">No upcoming classes.</div>'}
      ${historyHtml}

      <div class="addcls">
        <div class="field" style="margin:10px 0 0"><label class="field-label" for="t_${b.id}">Topic</label><input class="input" placeholder="e.g. Mind Reading" id="t_${b.id}"></div>
        <div class="field" style="margin:10px 0 0"><label class="field-label" for="dt_${b.id}">Date &amp; time</label><input type="datetime-local" class="input" id="dt_${b.id}"></div>
        <div class="field" style="margin:10px 0 0"><label class="field-label" for="lk_${b.id}">Meet link (optional)</label><input class="input" placeholder="blank = auto-generate" id="lk_${b.id}"></div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn btn-primary" data-add="${b.id}">${icon('plus', { size: 14 })} Add class</button>
          <button class="btn btn-danger" data-del="${b.id}">${icon('trash', { size: 14 })} Delete batch</button>
        </div>
      </div>
    </div>`;
  }).join('') || '<p class="muted">No batches yet.</p>';

  // Render each batch's email editor now that its container exists in the DOM.
  list.forEach(b => {
    const container = $('#ee_' + b.id);
    if (!container) return;
    const rerender = () => renderEmailList(container, pendingEditEmails[b.id], (next) => { pendingEditEmails[b.id] = next; rerender(); });
    rerender();
  });

  document.querySelectorAll('[data-editbtn]').forEach(btn => btn.onclick = () => {
    const box = $('#edit_' + btn.dataset.editbtn);
    box.style.display = box.style.display === 'none' ? 'block' : 'none';
  });
  document.querySelectorAll('[data-saveedit]').forEach(btn => btn.onclick = async () => {
    const bid = btn.dataset.saveedit;
    btn.disabled = true; toast('Saving…');
    try {
      await api(`/api/batches/${bid}`, { method: 'PUT', body: JSON.stringify({
        name: $('#en_' + bid).value.trim(),
        emails: pendingEditEmails[bid] || [],
        whatsappGroupJid: $('#ej_' + bid).value.trim()
      }) });
      delete pendingEditEmails[bid];
      toast('Batch updated ✓'); loadBatches();
    } catch (e) { toast('Error: ' + e.message, { tone: 'danger' }); btn.disabled = false; }
  });

  document.querySelectorAll('[data-add]').forEach(btn => btn.onclick = async () => {
    const bid = btn.dataset.add;
    const topic = $('#t_' + bid).value.trim();
    const dt = $('#dt_' + bid).value;
    const meetLink = $('#lk_' + bid).value.trim();
    if (!topic || !dt) return toast('Topic and date/time are both required', { tone: 'danger' });
    const startISO = new Date(dt).toISOString();
    btn.disabled = true; toast(meetLink ? 'Adding…' : 'Creating Meet link…');
    try {
      await api(`/api/batches/${bid}/classes`, { method: 'POST', body: JSON.stringify({ topic, startISO, meetLink }) });
      toast('Class added + WhatsApp sent ✓'); loadBatches();
    } catch (e) { toast('Error: ' + e.message, { tone: 'danger' }); btn.disabled = false; }
  });

  document.querySelectorAll('[data-sendrec]').forEach(btn => btn.onclick = async () => {
    const [bid, cid] = btn.dataset.sendrec.split(':');
    btn.disabled = true; toast('Checking Drive for recording…');
    try {
      await api(`/api/batches/${bid}/classes/${cid}/send-recording`, { method: 'POST' });
      toast('Recording sent to group + email ✓'); loadBatches();
    } catch (e) { toast('Error: ' + e.message, { tone: 'danger' }); btn.disabled = false; }
  });

  document.querySelectorAll('[data-delcls]').forEach(btn => btn.onclick = async () => {
    const [bid, cid] = btn.dataset.delcls.split(':');
    const reason = await promptModal({ title: 'Cancel this class?', body: 'This reason is sent to students in the cancellation message.', placeholder: 'Reason', confirmLabel: 'Cancel class' });
    if (reason === null) return; // backed out
    try {
      await api(`/api/batches/${bid}/classes/${cid}`, { method: 'DELETE', body: JSON.stringify({ reason }) });
      toast('Class cancelled + message sent'); loadBatches();
    } catch (e) { toast('Error: ' + e.message, { tone: 'danger' }); }
  });

  document.querySelectorAll('[data-purge]').forEach(btn => btn.onclick = async () => {
    const ok = await confirmModal({ title: 'Remove from history?', body: 'This removes the class from history permanently — it cannot be undone.', confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    const [bid, cid] = btn.dataset.purge.split(':');
    try { await api(`/api/batches/${bid}/classes/${cid}/purge`, { method: 'DELETE' }); toast('Removed'); loadBatches(); }
    catch (e) { toast('Error: ' + e.message, { tone: 'danger' }); }
  });

  document.querySelectorAll('[data-del]').forEach(btn => btn.onclick = async () => {
    const ok = await confirmModal({ title: 'Delete this whole batch?', body: 'This deletes the batch and all its classes permanently — it cannot be undone.', confirmLabel: 'Delete batch', danger: true });
    if (!ok) return;
    try {
      await api('/api/batches/' + btn.dataset.del, { method: 'DELETE' });
      delete pendingEditEmails[btn.dataset.del];
      toast('Batch deleted'); loadBatches();
    } catch (e) { toast('Error: ' + e.message, { tone: 'danger' }); }
  });
}

$('#addBatch').onclick = async () => {
  const name = $('#bName').value.trim();
  if (!name) return toast('Batch name is required', { tone: 'danger' });
  try {
    await api('/api/batches', { method: 'POST', body: JSON.stringify({
      name,
      emails: newBatchEmails,
      whatsappGroupJid: $('#bGroup').value.trim(),
      driveRootFolderId: $('#bDrive').value.trim()
    }) });
    $('#bName').value = $('#bGroup').value = $('#bDrive').value = '';
    newBatchEmails = []; renderNewBatchEmails();
    toast('Batch created ✓'); loadBatches();
  } catch (e) { toast('Error: ' + e.message, { tone: 'danger' }); }
};

// LEADS
let LR_CONFIG = {};
let leadsTabNeedsAutoNav = true; // consumed once per Leads-tab visit — see the TABS handler above

async function loadLeadsTab() {
  let filteredCount = 0, learningCount = 0, backlogPendingCount = 0, leadsAttentionCount = 0, paymentsAttentionCount = 0;

  try {
    const cfg = await api('/api/config');
    LR_CONFIG = cfg.leadResponder || { mode: 'draft', dailyCap: 30, silentHours: { start: 23, end: 8 }, paymentAutoSend: false };
    $('#lrAuto').checked = LR_CONFIG.mode === 'auto';
    $('#lrPaymentAuto').checked = !!LR_CONFIG.paymentAutoSend;
  } catch {}

  try {
    const stats = await api('/api/leads/stats');
    $('#lrStats').innerHTML = `New leads today: ${stats.dailyCount}/${stats.dailyCap} · Contact cache: ` +
      (stats.contactCache.ready ? `${stats.contactCache.size} loaded ✓` : '⚠️ not ready yet — bot stays silent for everyone until synced');
    const kc = stats.knownChats;
    if (kc) {
      $('#lrKnownChatsStats').innerHTML = `WhatsApp reports ${kc.knownChatsTotal} known chat(s) · ${kc.chatsWithContent} have cached message text the scanner can use` +
        (kc.unreadWithoutContent.length
          ? ` · <span style="color:var(--color-danger)">${kc.unreadWithoutContent.length} unread chat(s) with NO cached text — invisible to the backlog scanner until they message again or you find them manually: ${kc.unreadWithoutContent.map(u => u.jid.split('@')[0]).join(', ')}</span>`
          : '');
    }
  } catch {}

  try {
    const filtered = await api('/api/leads/filtered-contacts');
    filteredCount = filtered.length;
    if (filtered.length) {
      $('#lrFilteredCard').style.display = 'block';
      $('#lrFilteredList').innerHTML = filtered.map(f => row({
        icon: 'alertTriangle',
        primary: f.jid.split('@')[0],
        secondary: shortDT(f.ts),
        actionsHtml: `<button class="btn btn-secondary btn-sm" data-treatlead="${f.jid}">Treat as lead</button>`
      })).join('');
      document.querySelectorAll('[data-treatlead]').forEach(btn => btn.onclick = async () => {
        btn.disabled = true;
        try { await api(`/api/leads/${encodeURIComponent(btn.dataset.treatlead)}/treat-as-lead`, { method: 'POST' }); toast('Now tracked as a lead ✓'); loadLeadsTab(); }
        catch (e) { toast('Error: ' + e.message, { tone: 'danger' }); btn.disabled = false; }
      });
    } else {
      $('#lrFilteredCard').style.display = 'none';
    }
  } catch {}

  try {
    const queue = await api('/api/learning-queue');
    learningCount = queue.length;
    if (queue.length) {
      $('#lrLearningCard').style.display = 'block';
      $('#lrLearningList').innerHTML = queue.map(q => `
        <div class="list-row stacked">
          <div class="row-secondary" style="margin-bottom:8px">${q.phone}${q.pushName ? ' (' + q.pushName + ')' : ''} — ${shortDT(q.createdAt)}</div>
          <div class="field" style="margin:0 0 8px">
            <label class="field-label">Question</label>
            <textarea class="textarea" data-lq-question="${q.id}" style="min-height:44px">${q.question}</textarea>
          </div>
          <div class="field" style="margin:0 0 10px">
            <label class="field-label">Your answer (goes into the FAQ verbatim)</label>
            <textarea class="textarea" data-lq-answer="${q.id}" style="min-height:60px">${q.answer}</textarea>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-primary btn-sm" data-lq-approve="${q.id}">Approve — add to FAQ</button>
            <button class="btn btn-danger btn-sm" data-lq-discard="${q.id}">Discard</button>
          </div>
        </div>`).join('');
      document.querySelectorAll('[data-lq-approve]').forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.lqApprove;
        const question = document.querySelector(`[data-lq-question="${id}"]`).value.trim();
        const answer = document.querySelector(`[data-lq-answer="${id}"]`).value.trim();
        if (!question || !answer) return toast('Question and answer are both required', { tone: 'danger' });
        btn.disabled = true;
        try { await api(`/api/learning-queue/${encodeURIComponent(id)}/approve`, { method: 'POST', body: JSON.stringify({ question, answer }) }); toast('Added to FAQ ✓'); loadLeadsTab(); }
        catch (e) { toast('Error: ' + e.message, { tone: 'danger' }); btn.disabled = false; }
      });
      document.querySelectorAll('[data-lq-discard]').forEach(btn => btn.onclick = async () => {
        btn.disabled = true;
        try { await api(`/api/learning-queue/${encodeURIComponent(btn.dataset.lqDiscard)}/discard`, { method: 'POST' }); toast('Discarded'); loadLeadsTab(); }
        catch (e) { toast('Error: ' + e.message, { tone: 'danger' }); btn.disabled = false; }
      });
    } else {
      $('#lrLearningCard').style.display = 'none';
    }
  } catch {}

  try {
    const backlog = await api('/api/backlog');
    backlogPendingCount = backlog.queue.filter(q => !q.approved).length;
    if (backlog.queue.length) {
      $('#lrBacklogCard').style.display = 'block';
      $('#lrBacklogStatus').textContent =
        (backlog.firstRunCleared ? 'Auto-sends once its turn comes up — remove to veto' : 'First run — nothing sends until you approve it') +
        ` · Sent today: ${backlog.sentToday}/5`;
      $('#lrBacklogList').innerHTML = backlog.queue.map(q => `
        <div class="list-row stacked">
          <div class="row-primary">${q.phone}${q.pushName ? ' (' + q.pushName + ')' : ''}</div>
          <div class="row-secondary" style="margin:2px 0 8px">"${(q.lastMessageSnippet || '').slice(0, 80)}"</div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
            ${badge(q.approved ? 'Approved, waiting its turn' : 'Needs approval', q.approved ? 'success' : 'warning')}
            <span class="row-secondary">Last message: ${shortDT(q.lastMessageAt)}</span>
          </div>
          <div style="display:flex;gap:8px">
            ${!q.approved ? `<button class="btn btn-primary btn-sm" data-approve="${q.jid}">Approve</button>` : ''}
            <button class="btn btn-danger btn-sm" data-removebacklog="${q.jid}">Remove</button>
          </div>
        </div>`).join('');
      document.querySelectorAll('[data-approve]').forEach(btn => btn.onclick = async () => {
        btn.disabled = true;
        try { await api(`/api/backlog/${encodeURIComponent(btn.dataset.approve)}/approve`, { method: 'POST' }); toast('Approved ✓'); loadLeadsTab(); }
        catch (e) { toast('Error: ' + e.message, { tone: 'danger' }); btn.disabled = false; }
      });
      document.querySelectorAll('[data-removebacklog]').forEach(btn => btn.onclick = async () => {
        const ok = await confirmModal({ title: 'Remove from backlog queue?', body: 'This chat will not be re-discovered by future scans.', confirmLabel: 'Remove', danger: true });
        if (!ok) return;
        btn.disabled = true;
        try { await api(`/api/backlog/${encodeURIComponent(btn.dataset.removebacklog)}/remove`, { method: 'POST' }); toast('Removed'); loadLeadsTab(); }
        catch (e) { toast('Error: ' + e.message, { tone: 'danger' }); btn.disabled = false; }
      });
    } else {
      $('#lrBacklogCard').style.display = 'none';
    }
  } catch {}

  try {
    const leads = await api('/api/leads');
    clearErrorBanner($('#lrLeadList'));
    leadsAttentionCount = leads.filter(l => l.state !== 'converted' && l.manualOverride !== 'ignore' && l.flags.length > 0).length;

    $('#lrLeadList').innerHTML = leads.length ? leads.map(l => {
      const lastMsg = l.messages[l.messages.length - 1];
      const needsPaymentConfirm = l.state !== 'converted' && l.flags.some(f => f.reason === 'payment_screenshot_received');
      return `<div class="list-row stacked">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <div class="row-primary"><b>${l.phone}</b>${l.pushName ? ' (' + l.pushName + ')' : ''}</div>
          <div style="display:flex;gap:6px;align-items:center">
            ${badge(l.state, l.state === 'converted' ? 'success' : undefined)}
            ${l.flags.length ? badge(`${icon('flag', { size: 11 })} ${l.flags.length}`, 'danger') : ''}
          </div>
        </div>
        <div class="row-secondary" style="margin:6px 0">
          ${lastMsg ? `${lastMsg.dir === 'in' ? 'Them' : 'Bot'}: "${lastMsg.text.slice(0, 100)}" — ${shortDT(lastMsg.ts)}` : 'No messages yet'}
          ${lastMsg?.dir === 'out' && lastMsg.tier != null ? ` · ${lastMsg.tier === 'human' ? 'Manual reply' : lastMsg.tier === 0 ? 'Tier 0 (knowledge base)' : `Tier ${lastMsg.tier} (${lastMsg.model})`}` : ''}
          · replies: ${l.replyCount} · follow-ups: ${l.followUps.count}/3${l.manualOverride ? ` · ${l.manualOverride}` : ''}
        </div>
        ${needsPaymentConfirm ? `
        <div style="margin:8px 0;padding:12px;border:1px solid var(--color-warning);border-radius:var(--radius-md);background:var(--color-warning-soft)">
          <div style="font-size:.85em;margin-bottom:8px;display:flex;align-items:center;gap:6px">${icon('camera', { size: 14 })} Payment screenshot received — confirm the amount to generate + send the invoice:</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <input type="number" min="1" class="input" data-payamount="${l.jid}" placeholder="Amount e.g. 25000" style="width:160px">
            <button class="btn btn-primary btn-sm" data-confirmpay="${l.jid}">Confirm &amp; send invoice</button>
          </div>
        </div>` : ''}
        <div style="display:flex;gap:8px;margin-top:8px">
          ${l.state !== 'converted' ? `<button class="btn btn-secondary btn-sm" data-converted="${l.jid}">Mark converted</button>` : ''}
          ${l.manualOverride !== 'ignore' ? `<button class="btn btn-danger btn-sm" data-ignorelead="${l.jid}">Ignore</button>` : ''}
        </div>
      </div>`;
    }).join('') : '<div class="empty-state">No leads yet.</div>';

    document.querySelectorAll('[data-converted]').forEach(btn => btn.onclick = async () => {
      btn.disabled = true;
      try { await api(`/api/leads/${encodeURIComponent(btn.dataset.converted)}/converted`, { method: 'POST' }); toast('Marked converted ✓'); loadLeadsTab(); }
      catch (e) { toast('Error: ' + e.message, { tone: 'danger' }); btn.disabled = false; }
    });
    document.querySelectorAll('[data-ignorelead]').forEach(btn => btn.onclick = async () => {
      const ok = await confirmModal({ title: 'Stop responding to this number?', body: 'The bot will no longer reply to this lead automatically.', confirmLabel: 'Ignore', danger: true });
      if (!ok) return;
      btn.disabled = true;
      try { await api(`/api/leads/${encodeURIComponent(btn.dataset.ignorelead)}/ignore`, { method: 'POST' }); toast('Ignored ✓'); loadLeadsTab(); }
      catch (e) { toast('Error: ' + e.message, { tone: 'danger' }); btn.disabled = false; }
    });
    document.querySelectorAll('[data-confirmpay]').forEach(btn => btn.onclick = async () => {
      const jid = btn.dataset.confirmpay;
      const amount = Number(document.querySelector(`[data-payamount="${CSS.escape(jid)}"]`).value);
      if (!amount || amount <= 0) return toast('Enter a valid amount', { tone: 'danger' });
      const ok = await confirmModal({ title: 'Confirm payment received?', body: `₹${amount.toLocaleString('en-IN')} — this generates and sends an official invoice to the lead.`, confirmLabel: 'Confirm & send' });
      if (!ok) return;
      btn.disabled = true; toast('Generating invoice…');
      try {
        const r = await api(`/api/leads/${encodeURIComponent(jid)}/confirm-payment`, { method: 'POST', body: JSON.stringify({ amount }) });
        toast(r.waSent ? `Invoice ${r.invoiceNumber} sent ✓` : `Invoice ${r.invoiceNumber} generated, but WhatsApp send failed — retry from Payments`);
        loadLeadsTab();
      } catch (e) { toast('Error: ' + e.message, { tone: 'danger' }); btn.disabled = false; }
    });
  } catch (e) {
    showErrorBanner($('#lrLeadList'), 'Could not load leads: ' + e.message, loadLeadsTab);
  }

  try {
    const payments = await api('/api/payments');
    paymentsAttentionCount = payments.filter(p => !p.waSent).length;
    $('#lrPaymentsList').innerHTML = payments.length ? payments.map(p => `
      <div class="list-row stacked">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <div class="row-primary"><b>${p.invoiceNumber}</b> — ${p.phone}${p.pushName ? ' (' + p.pushName + ')' : ''}</div>
          <div class="row-primary">₹${Number(p.amount).toLocaleString('en-IN')}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:6px 0">
          <span class="row-secondary">${shortDT(p.confirmedAt)}</span>
          ${badge(p.waSent ? 'WhatsApp sent' : 'Send failed', p.waSent ? 'success' : 'danger')}
          ${p.driveFileId ? badge('Drive backup', 'info') : ''}
        </div>
        ${!p.waSent ? `<button class="btn btn-primary btn-sm" data-resendinv="${p.invoiceNumber}">Resend to lead</button>` : ''}
      </div>`).join('') : '<div class="empty-state">No payments recorded yet.</div>';
    document.querySelectorAll('[data-resendinv]').forEach(btn => btn.onclick = async () => {
      btn.disabled = true; toast('Resending…');
      try { await api(`/api/payments/${encodeURIComponent(btn.dataset.resendinv)}/resend`, { method: 'POST' }); toast('Resent ✓'); loadLeadsTab(); }
      catch (e) { toast('Error: ' + e.message, { tone: 'danger' }); btn.disabled = false; }
    });
  } catch (e) {
    showErrorBanner($('#lrPaymentsList'), 'Could not load payments: ' + e.message, loadLeadsTab);
  }

  // Badges — every sub-tab gets one; countBadge() renders nothing for 0, so a quiet
  // sub-tab just shows no chip rather than a "0".
  $('#badgeConversations').innerHTML = countBadge(leadsAttentionCount);
  $('#badgeQueues').innerHTML = countBadge(filteredCount + learningCount + backlogPendingCount);
  $('#badgePayments').innerHTML = countBadge(paymentsAttentionCount);

  if (leadsTabNeedsAutoNav) {
    leadsTabNeedsAutoNav = false;
    if (leadsAttentionCount > 0) selectSubtab('conversations');
    else if (filteredCount + learningCount + backlogPendingCount > 0) selectSubtab('queues');
    else if (paymentsAttentionCount > 0) selectSubtab('payments');
  }

  setTimeout(loadLeadsTab, 30000);
}

$('#paymentsExport').onclick = async () => {
  try {
    const r = await fetch('/api/payments/export', { headers: { 'x-admin-pass': getPass() } });
    if (!r.ok) throw new Error('Export failed');
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'payments.csv'; a.click();
    URL.revokeObjectURL(url);
  } catch (e) { toast('Error: ' + e.message, { tone: 'danger' }); }
};

$('#lrSaveCfg').onclick = async () => {
  await api('/api/config', { method: 'PUT', body: JSON.stringify({
    leadResponder: { ...LR_CONFIG, mode: $('#lrAuto').checked ? 'auto' : 'draft', paymentAutoSend: $('#lrPaymentAuto').checked }
  }) });
  toast('Lead responder settings saved');
  loadLeadsTab();
};

$('#lrScanNow').onclick = async () => {
  const btn = $('#lrScanNow');
  btn.disabled = true;
  try {
    const r = await api('/api/backlog/scan', { method: 'POST' });
    toast(r.skipped ? `Scan skipped: ${r.reason}` : `Scan done — ${r.scanned} checked, ${r.queued} queued`);
    loadLeadsTab();
  } catch (e) { toast('Error: ' + e.message); }
  btn.disabled = false;
};

// CONFIG
let CFG;
function seg(id, val) { document.querySelectorAll(`#${id} button`).forEach(b => b.classList.toggle('selected', b.dataset.v === val)); }
async function loadConfig() {
  CFG = await api('/api/config');
  $('#cfgGroup').checked = CFG.whatsappDirectToGroup;
  $('#cfgPerDay').value = CFG.postsPerDay;
  $('#fbOn').checked = CFG.social.facebook.enabled;
  $('#igOn').checked = CFG.social.instagram.enabled;
  $('#ytOn').checked = CFG.social.youtube.enabled;
  seg('fbFmt', CFG.social.facebook.format);
  seg('ytFmt', CFG.social.youtube.format);
}
['fbFmt', 'ytFmt'].forEach(id => document.querySelectorAll(`#${id} button`).forEach(b => b.onclick = () => seg(id, b.dataset.v)));

$('#saveCfg').onclick = async () => {
  const pick = id => document.querySelector(`#${id} button.selected`)?.dataset.v;
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify({
      whatsappDirectToGroup: $('#cfgGroup').checked,
      postsPerDay: +$('#cfgPerDay').value,
      social: {
        facebook: { enabled: $('#fbOn').checked, format: pick('fbFmt') || 'reel' },
        instagram: { enabled: $('#igOn').checked, format: 'reel' },
        youtube: { enabled: $('#ytOn').checked, format: pick('ytFmt') || 'short' }
      }
    }) });
    toast('Settings saved ✓');
  } catch (e) { toast('Error: ' + e.message, { tone: 'danger' }); }
};

// ACTIONS
document.querySelectorAll('[data-job]').forEach(b => b.onclick = async () => {
  b.disabled = true; toast('Running…');
  try { await api('/api/run/' + b.dataset.job, { method: 'POST' }); toast('Done ✓'); }
  catch (e) { toast('Error: ' + e.message, { tone: 'danger' }); }
  b.disabled = false;
});
$('#loadGroups').onclick = async () => {
  try {
    const groups = await api('/api/whatsapp/groups');
    $('#groupList').innerHTML = groups.length
      ? groups.map(g => row({ icon: 'message', primary: g.name, secondary: g.jid })).join('')
      : '<div class="empty-state">No groups found — is WhatsApp connected?</div>';
  } catch (e) { showErrorBanner($('#groupList'), 'Could not load groups: ' + e.message, () => $('#loadGroups').click()); }
};
