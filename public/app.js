let appState = null;

// Tab navigation
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    const target = document.getElementById(`tab-${btn.dataset.tab}`);
    if (target) target.classList.add('active');
  });
});

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function fetchState() {
  const res = await fetch('/api/state');
  appState = await res.json();
  renderAll();
}

function renderAll() {
  if (!appState) return;

  const cfg = appState.config || {};
  document.getElementById('sidebarModelBadge').textContent = cfg.model || 'gemini-3.8-flash';
  document.getElementById('sidebarTriggersBadge').textContent = (cfg.triggerWords || ['Riz']).map((w) => `"${w}"`).join(', ');
  document.getElementById('globalStatusPill').textContent = cfg.whatsappEnabled
    ? `● Listening for "${(cfg.triggerWords && cfg.triggerWords[0]) || 'Riz'}"`
    : '⏸ WhatsApp Paused';

  renderWhatsAppLogs();
  renderAccounts();
  renderWorkspaceData();
  populateSettingsForm();
}

function appendWaBubble({ sender, text, isRiz, statusNote, waDeepLink }) {
  const stream = document.getElementById('waMessagesStream');
  const div = document.createElement('div');
  div.className = `wa-bubble ${isRiz ? 'riz-reply' : 'incoming'}`;
  div.innerHTML = `
    <div class="wa-sender-tag">${escapeHtml(sender)}</div>
    <div>${escapeHtml(text)}</div>
    <div class="wa-status-note">
      <span>${escapeHtml(statusNote || '')}</span>
      ${waDeepLink ? `<a href="${escapeHtml(waDeepLink)}" target="_blank" rel="noopener" style="color:#86efac;text-decoration:underline;">Send in WhatsApp ↗</a>` : ''}
    </div>
  `;
  stream.appendChild(div);
  stream.scrollTop = stream.scrollHeight;
}

function renderWhatsAppLogs() {
  const logs = appState.whatsappLogs || [];
  document.getElementById('waLogCountBadge').textContent = `${logs.length} events`;
  const list = document.getElementById('waActivityLogList');
  if (logs.length === 0) {
    list.innerHTML = `<div class="log-item">No WhatsApp messages processed yet. Click one of the quick prompt chips on the left to test!</div>`;
    return;
  }

  list.innerHTML = logs
    .map((item) => {
      const toolsHtml = (item.toolCalls || [])
        .map((t) => `<span class="tool-pill">⚡ ${escapeHtml(t.name)}(${escapeHtml(JSON.stringify(t.arguments || {}))})</span>`)
        .join('');
      return `
        <div class="log-item ${item.triggered ? 'triggered' : 'skipped'}">
          <div style="display:flex;justify-content:space-between;">
            <strong>${escapeHtml(item.senderName)} (${escapeHtml(item.chatType.toUpperCase())})</strong>
            <span style="color:var(--muted);font-size:11px;">${new Date(item.timestamp).toLocaleTimeString()}</span>
          </div>
          <div style="margin-top:4px;">💬 <em>"${escapeHtml(item.incomingMessage)}"</em></div>
          <div style="margin-top:4px;color:${item.triggered ? '#86efac' : '#f59e0b'};font-weight:600;">
            ${item.triggered ? `✅ Triggered (${escapeHtml(item.reason)})` : `⏭ Ignored (${escapeHtml(item.reason)})`}
          </div>
          ${toolsHtml ? `<div>${toolsHtml}</div>` : ''}
          ${item.reply ? `<div style="margin-top:6px;background:rgba(0,0,0,0.25);padding:7px;border-radius:6px;">🤖 <strong>Riz Reply:</strong> ${escapeHtml(item.reply)}</div>` : ''}
        </div>
      `;
    })
    .join('');
}

function renderAccounts() {
  const grid = document.getElementById('accountsGrid');
  grid.innerHTML = (appState.accounts || [])
    .map(
      (acc) => `
      <div class="card account-card">
        <div>
          <div class="account-top">
            <div style="display:flex;align-items:center;gap:10px;">
              <span class="account-icon">${acc.icon}</span>
              <div>
                <h4>${escapeHtml(acc.name)}</h4>
                <span style="font-size:11.5px;color:var(--muted);">${escapeHtml(acc.category)}</span>
              </div>
            </div>
            <span class="badge" style="color:${acc.connected ? '#86efac' : '#f87171'};">
              ${acc.connected ? '● Connected' : '○ Disconnected'}
            </span>
          </div>
          <p style="font-size:12.5px;color:var(--muted);margin-top:10px;">Mode: <strong>${escapeHtml(acc.mode)}</strong></p>
          <ul style="font-size:12px;color:var(--text);margin-top:8px;padding-left:18px;">
            ${(acc.permissions || []).map((p) => `<li>${escapeHtml(p)}</li>`).join('')}
          </ul>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px;">
          <button class="btn ${acc.connected ? 'btn-outline' : 'btn-primary'}" onclick="toggleAccount('${acc.id}')">
            ${acc.connected ? 'Pause Access' : 'Enable Access'}
          </button>
          <a href="${escapeHtml(acc.deeplink)}" target="_blank" rel="noopener" class="btn btn-primary">Launch App ↗</a>
        </div>
      </div>
    `
    )
    .join('');
}

window.toggleAccount = async function (id) {
  await fetch('/api/accounts/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  });
  await fetchState();
};

function renderWorkspaceData() {
  document.getElementById('calendarList').innerHTML = (appState.calendarEvents || [])
    .map(
      (e) => `
      <div class="list-row">
        <strong>${escapeHtml(e.time)} — ${escapeHtml(e.title)}</strong>
        <div style="font-size:12px;color:var(--muted);">${escapeHtml(e.date)} • ${escapeHtml(e.location)} (${e.durationMinutes}m)</div>
      </div>
    `
    )
    .join('');

  document.getElementById('tasksList').innerHTML = (appState.tasks || [])
    .map(
      (t) => `
      <div class="list-row" style="display:flex;justify-content:space-between;align-items:center;">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
          <input type="checkbox" ${t.completed ? 'checked' : ''} onchange="toggleTask('${t.id}')" />
          <span style="${t.completed ? 'text-decoration:line-through;color:var(--muted);' : ''}">${escapeHtml(t.title)}</span>
        </label>
        <span class="badge">${escapeHtml(t.priority)}</span>
      </div>
    `
    )
    .join('');

  document.getElementById('notesList').innerHTML = (appState.notes || [])
    .map(
      (n) => `
      <div class="list-row">
        <strong>${escapeHtml(n.title)}</strong>
        <div style="font-size:12.5px;color:var(--muted);margin-top:3px;">${escapeHtml(n.content)}</div>
      </div>
    `
    )
    .join('');

  document.getElementById('emailsList').innerHTML = (appState.emails || [])
    .map(
      (m) => `
      <div class="list-row">
        <div style="display:flex;justify-content:space-between;">
          <strong>${m.unread ? '🟢 ' : ''}${escapeHtml(m.subject)}</strong>
          <span style="font-size:11px;color:var(--muted);">${escapeHtml(m.from)}</span>
        </div>
        <div style="font-size:12px;color:var(--muted);margin-top:4px;">${escapeHtml(m.snippet)}</div>
      </div>
    `
    )
    .join('');
}

window.toggleTask = async function (id) {
  await fetch('/api/tasks/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  });
  await fetchState();
};

function populateSettingsForm() {
  const cfg = appState.config || {};
  document.getElementById('cfgAssistantName').value = cfg.assistantName || 'Riz';
  document.getElementById('cfgTriggerWords').value = (cfg.triggerWords || ['Riz']).join(', ');
  const pwdEl = document.getElementById('cfgAccessPassword');
  if (pwdEl) pwdEl.value = cfg.accessPassword || 'blacky';
  document.getElementById('cfgModel').value = cfg.model || 'gemini-3.8-flash';
  document.getElementById('cfgSystemInstruction').value = cfg.systemInstruction || '';
  document.getElementById('cfgWhatsappEnabled').checked = cfg.whatsappEnabled !== false;
  document.getElementById('cfgReplyInGroups').checked = cfg.replyInGroups !== false;
  document.getElementById('cfgReplyInDMs').checked = cfg.replyInDMs !== false;
  document.getElementById('cfgRequireTriggerInDMs').checked = cfg.requireTriggerInDMs !== false;

  const prof = appState.ownerProfile || {};
  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.value = v || '';
  };
  setVal('profName', prof.name);
  setVal('profLocation', prof.currentLocation);
  setVal('profStatus', prof.currentStatus);
  setVal('profWorkingHours', prof.workingHours);
  setVal('profAvailability', prof.availabilitySummary);
  setVal('profBio', prof.bio);

  const hint = document.getElementById('apiKeyStatusHint');
  if (cfg.geminiApiKeyConfigured) {
    hint.textContent = `✓ Gemini API Key configured (${cfg.geminiApiKeyPreview}) — Live Gemini Interactions API active`;
  } else {
    hint.textContent = 'Currently using Riz Open Conversation Engine. Add your GEMINI_API_KEY above to activate live Gemini 3.8 Flash / 4 Argon.';
  }
}

// WhatsApp Simulator Submit
async function sendSimulatedWhatsAppMessage(senderName, messageText) {
  const chatType = document.getElementById('waChatTypeSelect').value;
  appendWaBubble({
    sender: senderName,
    text: messageText,
    isRiz: false,
    statusNote: `Incoming WhatsApp (${chatType.toUpperCase()})`
  });

  const res = await fetch('/api/whatsapp/incoming', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      senderName,
      chatName: chatType === 'group' ? 'Friends & Work Group' : senderName,
      chatType,
      messageText
    })
  });
  const data = await res.json();

  if (data.triggered && data.reply) {
    const toolNames = (data.toolCalls || []).map((t) => t.name).join(', ');
    appendWaBubble({
      sender: '🤖 Riz AI Assistant',
      text: data.reply,
      isRiz: true,
      statusNote: toolNames ? `Tools used: ${toolNames}` : `State: ${data.sessionState || 'active'}`,
      waDeepLink: data.waDeepLink
    });
  } else {
    appendWaBubble({
      sender: '🔇 Riz Filter',
      text: `[No reply sent — ${data.reason}]`,
      isRiz: true,
      statusNote: 'Silent Pass'
    });
  }

  await fetchState();
}

document.getElementById('waSimulateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const sender = document.getElementById('waSenderInput').value.trim() || 'Alex';
  const input = document.getElementById('waMessageInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await sendSimulatedWhatsAppMessage(sender, text);
});

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', async () => {
    const msg = chip.dataset.msg;
    const sender = document.getElementById('waSenderInput').value.trim() || 'Alex';
    await sendSimulatedWhatsAppMessage(sender, msg);
  });
});

// Direct Chat with Riz
document.getElementById('directChatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('directChatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  const stream = document.getElementById('directChatStream');
  const userDiv = document.createElement('div');
  userDiv.className = 'list-row';
  userDiv.innerHTML = `<strong>You:</strong> ${escapeHtml(text)}`;
  stream.appendChild(userDiv);

  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: text, sender: 'Owner' })
  });
  const data = await res.json();

  const rizDiv = document.createElement('div');
  rizDiv.className = 'list-row';
  rizDiv.style.borderLeft = '3px solid var(--accent)';
  const toolsBadges = (data.toolCalls || [])
    .map((t) => `<span class="tool-pill">⚡ ${escapeHtml(t.name)}</span>`)
    .join('');
  rizDiv.innerHTML = `
    <div style="display:flex;justify-content:space-between;">
      <strong>🤖 Riz:</strong>
      <span style="font-size:11px;color:var(--muted);">${escapeHtml(data.provider || '')}</span>
    </div>
    <div style="margin-top:6px;white-space:pre-wrap;">${escapeHtml(data.reply)}</div>
    ${toolsBadges ? `<div style="margin-top:6px;">${toolsBadges}</div>` : ''}
  `;
  stream.appendChild(rizDiv);
  stream.scrollTop = stream.scrollHeight;
  await fetchState();
});

// Save Settings
document.getElementById('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pwdEl = document.getElementById('cfgAccessPassword');
  const payload = {
    assistantName: document.getElementById('cfgAssistantName').value.trim() || 'Riz',
    triggerWords: document.getElementById('cfgTriggerWords').value,
    accessPassword: pwdEl ? pwdEl.value.trim() || 'blacky' : 'blacky',
    model: document.getElementById('cfgModel').value,
    systemInstruction: document.getElementById('cfgSystemInstruction').value,
    whatsappEnabled: document.getElementById('cfgWhatsappEnabled').checked,
    replyInGroups: document.getElementById('cfgReplyInGroups').checked,
    replyInDMs: document.getElementById('cfgReplyInDMs').checked,
    requireTriggerInDMs: document.getElementById('cfgRequireTriggerInDMs').checked
  };

  const newKey = document.getElementById('cfgGeminiApiKey').value.trim();
  if (newKey) payload.geminiApiKey = newKey;

  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  document.getElementById('cfgGeminiApiKey').value = '';
  const msg = document.getElementById('settingsSaveMsg');
  msg.textContent = '✓ Saved!';
  setTimeout(() => (msg.textContent = ''), 2500);
  await fetchState();
});

const ownerProfileForm = document.getElementById('ownerProfileForm');
if (ownerProfileForm) {
  ownerProfileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      name: document.getElementById('profName').value.trim(),
      currentLocation: document.getElementById('profLocation').value.trim(),
      currentStatus: document.getElementById('profStatus').value.trim(),
      workingHours: document.getElementById('profWorkingHours').value.trim(),
      availabilitySummary: document.getElementById('profAvailability').value.trim(),
      bio: document.getElementById('profBio').value.trim()
    };
    await fetch('/api/owner-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const msg = document.getElementById('profileSaveMsg');
    if (msg) {
      msg.textContent = '✓ Profile Saved!';
      setTimeout(() => (msg.textContent = ''), 2500);
    }
    await fetchState();
  });
}

function renderBridgeStatus(bridge) {
  const label = document.getElementById('waBridgeStateLabel');
  const qrContainer = document.getElementById('waQrContainer');
  const qrImg = document.getElementById('waQrImage');
  if (!label || !bridge) return;

  if (qrContainer && qrImg) {
    if ((bridge.state === 'qr_ready' || bridge.state === 'pairing_code_ready') && bridge.qrCode) {
      qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=210x210&data=${encodeURIComponent(bridge.qrCode)}`;
      qrContainer.style.display = 'block';
    } else if (bridge.state === 'connected' || bridge.state === 'connecting') {
      qrContainer.style.display = 'none';
    }
  }

  if (bridge.state === 'connected') {
    label.innerHTML = `<span style="color:#86efac;">● Connected to Live WhatsApp (+${escapeHtml(bridge.connectedUser || 'Linked')}) — Listening for "Riz"!</span>`;
  } else if (bridge.state === 'pairing_code_ready' && bridge.pairingCode) {
    label.innerHTML = `<span style="color:#86efac;font-size:15px;">🔑 Code for <strong>${escapeHtml(bridge.pairingPhone || '')}</strong>: <code style="font-size:16px;font-weight:800;color:#fff;background:#128c7e;padding:4px 10px;">${escapeHtml(bridge.pairingCode)}</code> — Enter in WhatsApp → Linked Devices → Link with phone number instead (or scan the QR code below)!</span>`;
  } else if (bridge.state === 'qr_ready' && bridge.qrCode) {
    label.innerHTML = `<span style="color:#86efac;">📷 QR Code Ready! Scan the QR code below using your phone's WhatsApp → Linked Devices → Link a Device.</span>`;
  } else if (bridge.state === 'connecting') {
    label.innerHTML = `<span style="color:#38bdf8;">⏳ Connecting to WhatsApp (takes ~2 seconds)...</span>`;
  } else if (bridge.state === 'error') {
    label.innerHTML = `<span style="color:#f87171;">⚠️ ${escapeHtml(bridge.lastError || 'Connection error')}</span>`;
  } else {
    label.innerHTML = `<span style="color:var(--muted);">Not linked yet — click "Show QR Code" or enter your number for an 8-digit code</span>`;
  }
}

let pairingPollTimer = null;

function startBridgePolling() {
  if (pairingPollTimer) clearInterval(pairingPollTimer);
  let polls = 0;
  pairingPollTimer = setInterval(async () => {
    polls++;
    if (polls > 60) return clearInterval(pairingPollTimer);
    const r = await fetch('/api/whatsapp/bridge-status');
    const st = await r.json();
    renderBridgeStatus(st);
    if (st.state === 'connected') {
      clearInterval(pairingPollTimer);
      await fetchState();
    }
  }, 1500);
}

const waShowQrBtn = document.getElementById('waShowQrBtn');
if (waShowQrBtn) {
  waShowQrBtn.addEventListener('click', async () => {
    waShowQrBtn.disabled = true;
    renderBridgeStatus({ state: 'connecting' });
    try {
      const res = await fetch('/api/whatsapp/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: '' })
      });
      const status = await res.json();
      renderBridgeStatus(status);
      startBridgePolling();
    } finally {
      setTimeout(() => {
        waShowQrBtn.disabled = false;
      }, 2000);
    }
  });
}

const waPairForm = document.getElementById('waPairForm');
if (waPairForm) {
  waPairForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const phone = document.getElementById('waPairPhoneInput').value.trim();
    if (!phone) return;

    const submitBtn = waPairForm.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    renderBridgeStatus({ state: 'connecting' });
    try {
      const res = await fetch('/api/whatsapp/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: phone })
      });
      const status = await res.json();
      renderBridgeStatus(status);
      startBridgePolling();
    } finally {
      setTimeout(() => {
        if (submitBtn) submitBtn.disabled = false;
      }, 2000);
    }
  });
}

// Seed initial welcome bubble in WhatsApp Simulator
appendWaBubble({
  sender: '🤖 Riz System',
  text: 'WhatsApp listener active! Send any message below or click a prompt chip. I will ONLY reply when someone calls my name ("Riz").',
  isRiz: true,
  statusNote: 'Ready'
});

fetchState().then(() => {
  if (appState && appState.whatsappBridge) {
    renderBridgeStatus(appState.whatsappBridge);
  }
});

