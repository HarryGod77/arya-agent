let PASS = '';
const $ = s => document.querySelector(s);
const api = (url, opts = {}) => fetch(url, {
  ...opts,
  headers: { 'Content-Type': 'application/json', 'x-admin-pass': PASS, ...(opts.headers || {}) }
}).then(async r => { if (!r.ok) throw new Error((await r.json()).error || r.status); return r.json(); });

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2800); }

// LOGIN
$('#enterBtn').onclick = async () => {
  PASS = $('#pass').value;
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(r => r.json());
  if (r.ok) { $('#gate').classList.add('hidden'); $('#app').classList.remove('hidden'); boot(); }
  else $('#gateErr').textContent = 'Wrong passphrase.';
};
$('#pass').addEventListener('keydown', e => { if (e.key === 'Enter') $('#enterBtn').click(); });

// TABS
document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(x => x.classList.add('hidden'));
  t.classList.add('active');
  $('#tab-' + t.dataset.tab).classList.remove('hidden');
});

async function boot() { loadWa(); loadBatches(); loadConfig(); injectOrganizer(); loadLeadsTab(); }

function injectOrganizer() {
  const panel = $('#tab-actions');
  if (!panel || $('#orgTool')) return;
  const box = document.createElement('div');
  box.className = 'card';
  box.id = 'orgTool';
  box.style.marginTop = '16px';
  box.innerHTML = `
    <h2>🗂 Organize old Drive recordings</h2>
    <p class="muted">Reads recordings in your Meet Recordings folder and sorts them into <b>Batch / Topic</b> folders. Preview first — nothing moves until you apply. Moving keeps old share links working.</p>
    <button class="ghost" id="orgPreview">Preview plan</button>
    <button id="orgApply" style="display:none">Apply — move files</button>
    <div id="orgResult" style="margin-top:10px;font-size:.9em"></div>`;
  panel.appendChild(box);

  $('#orgPreview').onclick = async () => {
    $('#orgResult').textContent = 'Scanning Drive…';
    try {
      const r = await api('/api/organize/preview');
      if (!r.count) { $('#orgResult').textContent = 'No recordings found in the folder.'; return; }
      $('#orgResult').innerHTML = `<b>${r.count} files</b> will be organized like this:<br><br>` +
        r.plan.map(p => `📄 ${p.name}<br>&nbsp;&nbsp;➜ <b>${p.target}</b>`).join('<br><br>');
      $('#orgApply').style.display = 'inline-block';
    } catch (e) { $('#orgResult').textContent = 'Error: ' + e.message; }
  };

  $('#orgApply').onclick = async () => {
    if (!confirm('Move all these recordings into Batch/Topic folders? Old share links will keep working, but files will be reorganized.')) return;
    $('#orgApply').disabled = true; $('#orgResult').textContent = 'Organizing… (bade archive me thoda time lagega)';
    try {
      const r = await api('/api/organize/execute', { method: 'POST' });
      $('#orgResult').textContent = `✅ Done — ${r.moved}/${r.total} files organized.`;
      $('#orgApply').style.display = 'none';
    } catch (e) { $('#orgResult').textContent = 'Error: ' + e.message; }
    $('#orgApply').disabled = false;
  };
}


async function loadWa() {
  try {
    const s = await api('/api/whatsapp/status');
    const p = $('#waStatus');
    p.textContent = 'WhatsApp: ' + (s.ready ? 'connected' : 'scan QR in terminal');
    p.className = 'pill ' + (s.ready ? 'on' : 'off');
  } catch {}
  setTimeout(loadWa, 15000);
}

// Short date-time like "10 Jul, 06:21 am"
const shortDT = (d) => new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
const REMS = [[1440, '24h'], [180, '3h'], [60, '1h'], [10, '10m'], [2, '2m']];

// BATCHES
async function loadBatches() {
  const list = await api('/api/batches');
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
        <div>🔮 <b>${c.topic}</b> — ${shortDT(start)} · <a href="${c.meetLink}" target="_blank">Join link</a>
          <button class="del" data-delcls="${b.id}:${c.id}" style="margin-left:8px">✕ cancel class</button>
          <button data-sendrec="${b.id}:${c.id}" style="margin-left:8px">🎥 send recording</button></div>
        <div class="rem" style="opacity:.7;font-size:.85em;margin:4px 0 10px">⏰ Reminders → ${rem}</div>
      </div>`;
    }).join('');

    const historyHtml = history.length ? `
      <div style="margin-top:10px;padding-top:8px;border-top:1px solid #333">
        <div style="opacity:.6;font-size:.85em;margin-bottom:6px">📁 History (${history.length})</div>
        ${history.map(c => {
          const cancelled = c.status === 'cancelled';
          const badge = cancelled ? '❌ Cancelled' : '✅ Completed';
          const rec = c.recordingLink
            ? ` · <a href="${c.recordingLink}" target="_blank">▶ Recording</a>`
            : (cancelled ? '' : ` · <button data-sendrec="${b.id}:${c.id}">🎥 send recording</button>`);
          const reason = cancelled && c.cancelReason ? `<div style="opacity:.6;font-size:.8em">Reason: ${c.cancelReason}</div>` : '';
          return `<div class="classline" style="opacity:.9">
            <div>${badge} · <b>${c.topic}</b> — ${shortDT(new Date(c.startISO))}${rec}
              <button class="del" data-purge="${b.id}:${c.id}" style="margin-left:8px">🗑 remove</button></div>
            ${reason}
          </div>`;
        }).join('')}
      </div>` : '';

    return `
    <div class="batch">
      <h3>${b.name}</h3>
      <div class="meta">${b.emails.length} emails${b.driveFolderId ? ' (viewer access ✓)' : ''} · ${b.whatsappGroupJid ? 'group linked ✓' : 'no group (Note-to-Self)'}${b.driveFolderId ? ` · <a href="https://drive.google.com/drive/folders/${b.driveFolderId}" target="_blank">📁 batch folder</a>` : ''}
        <button class="del" data-editbtn="${b.id}" style="margin-left:8px">✎ edit batch</button></div>

      <div class="editbox" id="edit_${b.id}" style="display:none;margin:8px 0;padding:10px;border:1px solid #444;border-radius:8px">
        <label>Batch name</label>
        <input id="en_${b.id}" value="${(b.name || '').replace(/"/g, '&quot;')}">
        <label>Student emails (comma separated)</label>
        <input id="ee_${b.id}" value="${(b.emails || []).join(', ').replace(/"/g, '&quot;')}">
        <label>WhatsApp group JID or invite link</label>
        <input id="ej_${b.id}" value="${(b.whatsappGroupJid || '').replace(/"/g, '&quot;')}" placeholder="120363...@g.us  OR  https://chat.whatsapp.com/xxxx">
        <button data-saveedit="${b.id}" style="margin-top:8px">Save changes</button>
      </div>

      ${upcomingHtml || '<div style="opacity:.5;font-size:.85em;margin:6px 0">No upcoming classes.</div>'}
      ${historyHtml}

      <div class="addcls">
        <input placeholder="Topic e.g. Mind Reading" id="t_${b.id}">
        <input type="datetime-local" id="dt_${b.id}" title="Pick date & time" style="min-width:210px">
        <input placeholder="Meet link (blank = auto-generate)" id="lk_${b.id}" style="min-width:220px">
        <button data-add="${b.id}">Add class</button>
        <button class="del" data-del="${b.id}">Delete batch</button>
      </div>
    </div>`;
  }).join('') || '<p class="muted">No batches yet.</p>';

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
        emails: $('#ee_' + bid).value.split(','),
        whatsappGroupJid: $('#ej_' + bid).value.trim()
      }) });
      toast('Batch updated ✓'); loadBatches();
    } catch (e) { toast('Error: ' + e.message); btn.disabled = false; }
  });

  document.querySelectorAll('[data-add]').forEach(btn => btn.onclick = async () => {
    const bid = btn.dataset.add;
    const topic = $('#t_' + bid).value.trim();
    const dt = $('#dt_' + bid).value;
    const meetLink = $('#lk_' + bid).value.trim();
    if (!topic || !dt) return toast('Topic aur date-time dono chahiye');
    const startISO = new Date(dt).toISOString();
    btn.disabled = true; toast(meetLink ? 'Adding…' : 'Creating Meet link…');
    try {
      await api(`/api/batches/${bid}/classes`, { method: 'POST', body: JSON.stringify({ topic, startISO, meetLink }) });
      toast('Class added + WhatsApp sent ✓'); loadBatches();
    } catch (e) { toast('Error: ' + e.message); btn.disabled = false; }
  });

  document.querySelectorAll('[data-sendrec]').forEach(btn => btn.onclick = async () => {
    const [bid, cid] = btn.dataset.sendrec.split(':');
    btn.disabled = true; toast('Checking Drive for recording…');
    try {
      await api(`/api/batches/${bid}/classes/${cid}/send-recording`, { method: 'POST' });
      toast('Recording sent to group + email ✓'); loadBatches();
    } catch (e) { toast('Error: ' + e.message); btn.disabled = false; }
  });

  document.querySelectorAll('[data-delcls]').forEach(btn => btn.onclick = async () => {
    const [bid, cid] = btn.dataset.delcls.split(':');
    const reason = prompt('Cancel this class? Type a reason (students ko yahi reason jayega):', '');
    if (reason === null) return; // cancelled the prompt
    try {
      await api(`/api/batches/${bid}/classes/${cid}`, { method: 'DELETE', body: JSON.stringify({ reason }) });
      toast('Class cancelled + message sent'); loadBatches();
    } catch (e) { toast('Error: ' + e.message); }
  });

  document.querySelectorAll('[data-purge]').forEach(btn => btn.onclick = async () => {
    if (!confirm('Remove this from history permanently?')) return;
    const [bid, cid] = btn.dataset.purge.split(':');
    try { await api(`/api/batches/${bid}/classes/${cid}/purge`, { method: 'DELETE' }); toast('Removed'); loadBatches(); }
    catch (e) { toast('Error: ' + e.message); }
  });

  document.querySelectorAll('[data-del]').forEach(btn => btn.onclick = async () => {
    if (!confirm('Delete this whole batch?')) return;
    await api('/api/batches/' + btn.dataset.del, { method: 'DELETE' }); loadBatches();
  });
}

$('#addBatch').onclick = async () => {
  const name = $('#bName').value.trim();
  if (!name) return toast('Batch name chahiye');
  await api('/api/batches', { method: 'POST', body: JSON.stringify({
    name,
    emails: $('#bEmails').value.split(','),
    whatsappGroupJid: $('#bGroup').value.trim(),
    driveRootFolderId: $('#bDrive').value.trim()
  }) });
  $('#bName').value = $('#bEmails').value = $('#bGroup').value = $('#bDrive').value = '';
  toast('Batch created'); loadBatches();
};

// LEADS
let LR_CONFIG = {};
async function loadLeadsTab() {
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
          ? ` · <span style="color:#c77">${kc.unreadWithoutContent.length} unread chat(s) with NO cached text — invisible to the backlog scanner until they message again or you find them manually: ${kc.unreadWithoutContent.map(u => u.jid.split('@')[0]).join(', ')}</span>`
          : '');
    }
  } catch {}

  try {
    const filtered = await api('/api/leads/filtered-contacts');
    if (filtered.length) {
      $('#lrFilteredCard').style.display = 'block';
      $('#lrFilteredList').innerHTML = filtered.map(f => `
        <div class="classline">
          <div>${f.jid.split('@')[0]} — ${shortDT(f.ts)}
            <button data-treatlead="${f.jid}" style="margin-left:8px">Treat as lead</button></div>
        </div>`).join('');
      document.querySelectorAll('[data-treatlead]').forEach(btn => btn.onclick = async () => {
        btn.disabled = true;
        try { await api(`/api/leads/${encodeURIComponent(btn.dataset.treatlead)}/treat-as-lead`, { method: 'POST' }); toast('Now tracked as a lead ✓'); loadLeadsTab(); }
        catch (e) { toast('Error: ' + e.message); btn.disabled = false; }
      });
    } else {
      $('#lrFilteredCard').style.display = 'none';
    }
  } catch {}

  try {
    const queue = await api('/api/learning-queue');
    if (queue.length) {
      $('#lrLearningCard').style.display = 'block';
      $('#lrLearningList').innerHTML = queue.map(q => `
        <div class="classline">
          <div style="opacity:.7;font-size:.85em;margin-bottom:4px">${q.phone}${q.pushName ? ' (' + q.pushName + ')' : ''} — ${shortDT(q.createdAt)}</div>
          <label style="display:block;font-size:.85em;margin-bottom:2px">Question</label>
          <textarea data-lq-question="${q.id}" style="width:100%;min-height:44px;margin-bottom:6px">${q.question}</textarea>
          <label style="display:block;font-size:.85em;margin-bottom:2px">Your answer (goes into the FAQ verbatim)</label>
          <textarea data-lq-answer="${q.id}" style="width:100%;min-height:60px;margin-bottom:6px">${q.answer}</textarea>
          <div>
            <button data-lq-approve="${q.id}">Approve — add to FAQ</button>
            <button class="del" data-lq-discard="${q.id}" style="margin-left:8px">Discard</button>
          </div>
        </div>`).join('');
      document.querySelectorAll('[data-lq-approve]').forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.lqApprove;
        const question = document.querySelector(`[data-lq-question="${id}"]`).value.trim();
        const answer = document.querySelector(`[data-lq-answer="${id}"]`).value.trim();
        if (!question || !answer) return toast('Question and answer are both required');
        btn.disabled = true;
        try { await api(`/api/learning-queue/${encodeURIComponent(id)}/approve`, { method: 'POST', body: JSON.stringify({ question, answer }) }); toast('Added to FAQ ✓'); loadLeadsTab(); }
        catch (e) { toast('Error: ' + e.message); btn.disabled = false; }
      });
      document.querySelectorAll('[data-lq-discard]').forEach(btn => btn.onclick = async () => {
        btn.disabled = true;
        try { await api(`/api/learning-queue/${encodeURIComponent(btn.dataset.lqDiscard)}/discard`, { method: 'POST' }); toast('Discarded'); loadLeadsTab(); }
        catch (e) { toast('Error: ' + e.message); btn.disabled = false; }
      });
    } else {
      $('#lrLearningCard').style.display = 'none';
    }
  } catch {}

  try {
    const backlog = await api('/api/backlog');
    if (backlog.queue.length) {
      $('#lrBacklogCard').style.display = 'block';
      $('#lrBacklogStatus').textContent =
        (backlog.firstRunCleared ? 'Auto-sends once its turn comes up — remove to veto' : 'First run — nothing sends until you approve it') +
        ` · Sent today: ${backlog.sentToday}/5`;
      $('#lrBacklogList').innerHTML = backlog.queue.map(q => `
        <div class="classline">
          <div>${q.phone}${q.pushName ? ' (' + q.pushName + ')' : ''} — "${(q.lastMessageSnippet || '').slice(0, 80)}"</div>
          <div style="opacity:.7;font-size:.85em;margin:4px 0 8px">
            Last message: ${shortDT(q.lastMessageAt)} · ${q.approved ? '✅ approved, waiting its turn' : '⏳ needs approval'}
          </div>
          <div>
            ${!q.approved ? `<button data-approve="${q.jid}">Approve</button>` : ''}
            <button class="del" data-removebacklog="${q.jid}" style="margin-left:8px">Remove</button>
          </div>
        </div>`).join('');
      document.querySelectorAll('[data-approve]').forEach(btn => btn.onclick = async () => {
        btn.disabled = true;
        try { await api(`/api/backlog/${encodeURIComponent(btn.dataset.approve)}/approve`, { method: 'POST' }); toast('Approved ✓'); loadLeadsTab(); }
        catch (e) { toast('Error: ' + e.message); btn.disabled = false; }
      });
      document.querySelectorAll('[data-removebacklog]').forEach(btn => btn.onclick = async () => {
        if (!confirm('Remove this chat from the backlog queue permanently? It will not be re-discovered by future scans.')) return;
        btn.disabled = true;
        try { await api(`/api/backlog/${encodeURIComponent(btn.dataset.removebacklog)}/remove`, { method: 'POST' }); toast('Removed'); loadLeadsTab(); }
        catch (e) { toast('Error: ' + e.message); btn.disabled = false; }
      });
    } else {
      $('#lrBacklogCard').style.display = 'none';
    }
  } catch {}

  try {
    const leads = await api('/api/leads');
    $('#lrLeadList').innerHTML = leads.length ? leads.map(l => {
      const lastMsg = l.messages[l.messages.length - 1];
      const flagBadge = l.flags.length ? ` · 🚩 ${l.flags.length}` : '';
      const needsPaymentConfirm = l.state !== 'converted' && l.flags.some(f => f.reason === 'payment_screenshot_received');
      return `<div class="classline">
        <div><b>${l.phone}</b>${l.pushName ? ' (' + l.pushName + ')' : ''} — <span class="pill ${l.state === 'converted' ? 'on' : ''}">${l.state}</span>${flagBadge}</div>
        <div style="opacity:.7;font-size:.85em;margin:4px 0">
          ${lastMsg ? `${lastMsg.dir === 'in' ? 'Them' : 'Bot'}: "${lastMsg.text.slice(0, 100)}" — ${shortDT(lastMsg.ts)}` : 'No messages yet'}
          ${lastMsg?.dir === 'out' && lastMsg.tier != null ? ` · <span title="Priority tier that produced this reply">${lastMsg.tier === 'human' ? 'Manual reply' : lastMsg.tier === 0 ? 'Tier 0 (knowledge base)' : `Tier ${lastMsg.tier} (${lastMsg.model})`}</span>` : ''}
          · replies: ${l.replyCount} · follow-ups: ${l.followUps.count}/3${l.manualOverride ? ` · ${l.manualOverride}` : ''}
        </div>
        ${needsPaymentConfirm ? `
        <div style="margin:8px 0;padding:8px;border:1px solid #446;border-radius:6px">
          <div style="font-size:.85em;margin-bottom:6px">📸 Payment screenshot received — confirm the amount to generate + send the invoice:</div>
          <input type="number" min="1" data-payamount="${l.jid}" placeholder="Amount e.g. 25000" style="width:140px">
          <button data-confirmpay="${l.jid}">Confirm &amp; send invoice</button>
        </div>` : ''}
        <div style="margin-top:6px">
          ${l.state !== 'converted' ? `<button data-converted="${l.jid}">Mark converted</button>` : ''}
          ${l.manualOverride !== 'ignore' ? `<button class="del" data-ignorelead="${l.jid}" style="margin-left:8px">Ignore</button>` : ''}
        </div>
      </div>`;
    }).join('') : '<p class="muted">No leads yet.</p>';

    document.querySelectorAll('[data-converted]').forEach(btn => btn.onclick = async () => {
      btn.disabled = true;
      try { await api(`/api/leads/${encodeURIComponent(btn.dataset.converted)}/converted`, { method: 'POST' }); toast('Marked converted ✓'); loadLeadsTab(); }
      catch (e) { toast('Error: ' + e.message); btn.disabled = false; }
    });
    document.querySelectorAll('[data-ignorelead]').forEach(btn => btn.onclick = async () => {
      if (!confirm('Stop the bot from responding to this number?')) return;
      btn.disabled = true;
      try { await api(`/api/leads/${encodeURIComponent(btn.dataset.ignorelead)}/ignore`, { method: 'POST' }); toast('Ignored ✓'); loadLeadsTab(); }
      catch (e) { toast('Error: ' + e.message); btn.disabled = false; }
    });
    document.querySelectorAll('[data-confirmpay]').forEach(btn => btn.onclick = async () => {
      const jid = btn.dataset.confirmpay;
      const amount = Number(document.querySelector(`[data-payamount="${CSS.escape(jid)}"]`).value);
      if (!amount || amount <= 0) return toast('Enter a valid amount');
      if (!confirm(`Confirm ₹${amount.toLocaleString('en-IN')} received and send the invoice to this lead?`)) return;
      btn.disabled = true; toast('Generating invoice…');
      try {
        const r = await api(`/api/leads/${encodeURIComponent(jid)}/confirm-payment`, { method: 'POST', body: JSON.stringify({ amount }) });
        toast(r.waSent ? `Invoice ${r.invoiceNumber} sent ✓` : `Invoice ${r.invoiceNumber} generated, but WhatsApp send failed — retry from Payments below`);
        loadLeadsTab();
      } catch (e) { toast('Error: ' + e.message); btn.disabled = false; }
    });
  } catch { $('#lrLeadList').innerHTML = '<p class="muted">Error loading leads.</p>'; }

  try {
    const payments = await api('/api/payments');
    $('#lrPaymentsList').innerHTML = payments.length ? payments.map(p => `
      <div class="classline">
        <div><b>${p.invoiceNumber}</b> — ${p.phone}${p.pushName ? ' (' + p.pushName + ')' : ''} · ₹${Number(p.amount).toLocaleString('en-IN')}</div>
        <div style="opacity:.7;font-size:.85em;margin:4px 0">
          ${shortDT(p.confirmedAt)} · ${p.waSent ? 'WhatsApp sent ✓' : '⚠️ WhatsApp send failed'}${p.driveFileId ? ' · Drive backup ✓' : ''}
        </div>
        ${!p.waSent ? `<button data-resendinv="${p.invoiceNumber}">Resend to lead</button>` : ''}
      </div>`).join('') : '<p class="muted">No payments recorded yet.</p>';
    document.querySelectorAll('[data-resendinv]').forEach(btn => btn.onclick = async () => {
      btn.disabled = true; toast('Resending…');
      try { await api(`/api/payments/${encodeURIComponent(btn.dataset.resendinv)}/resend`, { method: 'POST' }); toast('Resent ✓'); loadLeadsTab(); }
      catch (e) { toast('Error: ' + e.message); btn.disabled = false; }
    });
  } catch { $('#lrPaymentsList').innerHTML = '<p class="muted">Error loading payments.</p>'; }

  setTimeout(loadLeadsTab, 30000);
}

$('#paymentsExport').onclick = async () => {
  try {
    const r = await fetch('/api/payments/export', { headers: { 'x-admin-pass': PASS } });
    if (!r.ok) throw new Error('Export failed');
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'payments.csv'; a.click();
    URL.revokeObjectURL(url);
  } catch (e) { toast('Error: ' + e.message); }
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
function seg(id, val) { document.querySelectorAll(`#${id} button`).forEach(b => b.classList.toggle('sel', b.dataset.v === val)); }
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
  const pick = id => document.querySelector(`#${id} button.sel`)?.dataset.v;
  await api('/api/config', { method: 'PUT', body: JSON.stringify({
    whatsappDirectToGroup: $('#cfgGroup').checked,
    postsPerDay: +$('#cfgPerDay').value,
    social: {
      facebook: { enabled: $('#fbOn').checked, format: pick('fbFmt') || 'reel' },
      instagram: { enabled: $('#igOn').checked, format: 'reel' },
      youtube: { enabled: $('#ytOn').checked, format: pick('ytFmt') || 'short' }
    }
  }) });
  toast('Settings saved');
};

// ACTIONS
document.querySelectorAll('[data-job]').forEach(b => b.onclick = async () => {
  toast('Running…');
  try { await api('/api/run/' + b.dataset.job, { method: 'POST' }); toast('Done ✓'); }
  catch (e) { toast('Error: ' + e.message); }
});
$('#loadGroups').onclick = async () => {
  const groups = await api('/api/whatsapp/groups');
  $('#groupList').innerHTML = groups.length
    ? groups.map(g => `<div class="gcard">${g.name}<br><code>${g.jid}</code></div>`).join('')
    : '<p class="muted">No groups (WhatsApp connected hai?).</p>';
};
