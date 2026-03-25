// GideonMail — Renderer
// Single-account IMAP/SMTP email client

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let currentFolder = "INBOX";
let currentPage = 0;
let currentMessages = [];
let currentUid = null;
let currentMsg = null;
let composeAttachments = [];
let composeMode = null; // null | "new" | "reply" | "replyall" | "forward"

// ── Init ────────────────────────────────────────────────────────────────────
async function init() {
  bindEvents();
  bindAIEvents();

  const account = await gideon.getAccount();
  if (!account) {
    openSettings();
    return;
  }

  await loadFolders();
  await loadMessages();
}

function bindEvents() {
  $("#btnCompose").addEventListener("click", () => openCompose("new"));
  $("#btnSettings").addEventListener("click", openSettings);
  $("#btnRefresh").addEventListener("click", () => loadMessages());
  $("#btnPrev").addEventListener("click", () => { if (currentPage > 0) { currentPage--; loadMessages(); } });
  $("#btnNext").addEventListener("click", () => { currentPage++; loadMessages(); });

  // Search
  let searchTimer;
  $("#searchInput").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    searchTimer = setTimeout(() => {
      if (q.length >= 2) searchMail(q);
      else loadMessages();
    }, 400);
  });

  // Read pane actions
  $("#btnReply").addEventListener("click", () => openCompose("reply"));
  $("#btnReplyAll").addEventListener("click", () => openCompose("replyall"));
  $("#btnForward").addEventListener("click", () => openCompose("forward"));
  $("#btnDelete").addEventListener("click", deleteCurrent);
  $("#btnStar").addEventListener("click", starCurrent);
  $("#btnScan").addEventListener("click", async () => {
    if (!currentUid) return;
    $("#scanResult").style.display = "block";
    $("#scanResult").textContent = "Scanning...";
    $("#scanResult").style.color = "var(--fg2)";
    const r = await gideon.securityScan(currentUid);
    if (r.error) {
      $("#scanResult").textContent = "Scan error: " + r.error;
      $("#scanResult").style.color = "var(--danger)";
    } else if (r.flags && r.flags.length) {
      $("#scanResult").textContent = "THREATS DETECTED (score: " + r.score + "):\n" + r.details.join("\n");
      $("#scanResult").style.color = "#ef4444";
      $("#scanResult").style.background = "#450a0a";
      $("#scanResult").style.padding = "8px 20px";
      $("#scanResult").style.borderRadius = "4px";
    } else {
      $("#scanResult").textContent = "Clean — no threats detected" + (r.details.length ? "\n" + r.details.join("\n") : "");
      $("#scanResult").style.color = "#22c55e";
    }
  });

  // Compose
  $("#composeClose").addEventListener("click", closeCompose);
  $("#composeSend").addEventListener("click", sendCompose);
  $("#composeAttach").addEventListener("change", handleAttachFiles);

  // Settings
  $("#settingsClose").addEventListener("click", () => { $("#settingsModal").style.display = "none"; });
  $("#cfgTest").addEventListener("click", testConnection);
  $("#cfgSave").addEventListener("click", saveSettings);
  $("#cfgAiVerify").addEventListener("click", async () => {
    $("#cfgAiResult").textContent = "Verifying...";
    $("#cfgAiResult").style.color = "";
    await saveSettingsQuiet();
    const r = await gideon.aiVerifyKey();
    $("#cfgAiResult").textContent = r.ok ? "Verified!" : "Failed: " + r.message;
    $("#cfgAiResult").style.color = r.ok ? "var(--success)" : "var(--danger)";
  });
  // ── Rules panel ────────────────────────────────────────────────────────
  $("#btnRules").addEventListener("click", openRules);
  $("#rulesClose").addEventListener("click", () => { $("#rulesModal").style.display = "none"; });

  // Tab switching
  for (const tab of $$(".rules-tab")) {
    tab.addEventListener("click", () => {
      $$(".rules-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const sections = { whitelist: "rulesWhitelist", blacklist: "rulesBlacklist", greylist: "rulesGreylist", instructions: "rulesInstructions", security: "rulesSecurity", conversations: "rulesConversations", sms: "rulesSms" };
      Object.values(sections).forEach((id) => { const el = $(`#${id}`); if (el) el.style.display = "none"; });
      const target = sections[tab.dataset.tab];
      if (target) $(`#${target}`).style.display = "block";
    });
  }

  // Blacklist add
  $("#blAddBtn").addEventListener("click", async () => {
    const addr = $("#blAddAddr").value.trim();
    if (!addr) return;
    await gideon.blacklistAdd({ address: addr, name: $("#blAddName").value.trim() });
    $("#blAddAddr").value = ""; $("#blAddName").value = "";
    renderManagedList("#blacklistEntries", gideon.blacklistGet, gideon.blacklistToggle, gideon.blacklistRemove, gideon.blacklistUpdate, "#ef4444");
  });
  $("#blAddAddr").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#blAddBtn").click(); });

  // Greylist add
  $("#glAddBtn").addEventListener("click", async () => {
    const addr = $("#glAddAddr").value.trim();
    if (!addr) return;
    await gideon.greylistAdd({ address: addr, name: $("#glAddName").value.trim() });
    $("#glAddAddr").value = ""; $("#glAddName").value = "";
    renderManagedList("#greylistEntries", gideon.greylistGet, gideon.greylistToggle, gideon.greylistRemove, gideon.greylistUpdate, "#94a3b8");
  });
  $("#glAddAddr").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#glAddBtn").click(); });

  // Instructions add
  $("#instrAddBtn").addEventListener("click", async () => {
    const text = $("#instrAddInput").value.trim();
    if (!text) return;
    await gideon.instructionsAdd(text);
    $("#instrAddInput").value = "";
    renderSettingsInstructions();
  });
  $("#instrAddInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#instrAddBtn").click();
  });

  // Whitelist add
  $("#wlAddBtn").addEventListener("click", async () => {
    const addr = $("#wlAddAddr").value.trim();
    if (!addr) return;
    await gideon.whitelistAdd({ address: addr, name: $("#wlAddName").value.trim() });
    $("#wlAddAddr").value = "";
    $("#wlAddName").value = "";
    renderWhitelist();
  });
  $("#wlAddAddr").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#wlAddBtn").click();
  });

  // Check Now
  $("#rulesCheckNow").addEventListener("click", async () => {
    $("#checkNowResult").textContent = "Checking...";
    const r = await gideon.checkNow();
    $("#checkNowResult").textContent = r.message;
    $("#checkNowResult").style.color = r.ok ? "var(--success)" : "var(--danger)";
  });

  // Rules save all
  $("#rulesSave").addEventListener("click", async () => {
    await saveRulesSettings();
    $("#rulesSave").textContent = "Saved!";
    setTimeout(() => { $("#rulesSave").textContent = "Save All"; }, 1500);
  });

  $("#cfgConvoTest").addEventListener("click", async () => {
    $("#cfgConvoResult").textContent = "Checking...";
    $("#cfgConvoResult").style.color = "";
    await saveSettingsQuiet();
    const r = await gideon.convoTest();
    $("#cfgConvoResult").textContent = r.message;
    $("#cfgConvoResult").style.color = r.ok ? "var(--success)" : "var(--danger)";
  });
  $("#cfgAutoLaunch").addEventListener("change", async (e) => {
    await gideon.autolaunchSet(e.target.checked);
  });
  $("#cfgSmsTest").addEventListener("click", async () => {
    $("#cfgSmsResult").textContent = "Sending...";
    await saveSettingsQuiet();
    const r = await gideon.smsTest();
    $("#cfgSmsResult").textContent = r.ok ? "Sent!" : "Failed: " + r.error;
    $("#cfgSmsResult").style.color = r.ok ? "var(--success)" : "var(--danger)";
  });

  // Push updates
  gideon.onInboxUpdated((data) => {
    if (data && !data.error && currentFolder === "INBOX") {
      currentMessages = data.messages || [];
      renderMessageList();
    }
  });
}

// ── Folders ─────────────────────────────────────────────────────────────────
async function loadFolders() {
  const folders = await gideon.listFolders();
  if (folders.error) return;

  const list = $("#folderList");
  list.innerHTML = "";

  // Preferred order
  const priority = ["INBOX", "Sent", "Drafts", "Trash", "Junk", "Spam", "Archive"];
  const sorted = [...folders].sort((a, b) => {
    const ai = priority.findIndex((p) => a.path.toUpperCase().includes(p.toUpperCase()));
    const bi = priority.findIndex((p) => b.path.toUpperCase().includes(p.toUpperCase()));
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.path.localeCompare(b.path);
  });

  for (const f of sorted) {
    const div = document.createElement("div");
    div.className = "folder-item" + (f.path === currentFolder ? " active" : "");
    div.innerHTML = `<span>${escHtml(f.name)}</span>`;
    div.addEventListener("click", () => {
      currentFolder = f.path;
      currentPage = 0;
      loadMessages();
      loadFolders();
    });
    list.appendChild(div);
  }
}

// ── Message list ────────────────────────────────────────────────────────────
async function loadMessages() {
  const result = currentFolder === "INBOX"
    ? await gideon.fetchInbox(currentPage)
    : await gideon.fetchFolder(currentFolder, currentPage);

  if (result.error) {
    $("#messageList").innerHTML = `<div class="placeholder" style="font-size:12px;color:#ef4444">${escHtml(result.error)}</div>`;
    return;
  }

  currentMessages = result.messages || [];
  const total = result.total || 0;

  renderMessageList();

  // Pagination
  $("#btnPrev").disabled = currentPage === 0;
  $("#btnNext").disabled = (currentPage + 1) * 50 >= total;
  $("#pageInfo").textContent = total > 0 ? `${currentPage * 50 + 1}–${Math.min((currentPage + 1) * 50, total)} of ${total}` : "Empty";
}

let senderStatuses = {};

async function renderMessageList() {
  const list = $("#messageList");
  list.innerHTML = "";

  // Bulk fetch sender list statuses for coloring
  try {
    senderStatuses = await gideon.senderStatusBulk(currentMessages) || {};
  } catch (e) { senderStatuses = {}; }

  for (const m of currentMessages) {
    const status = senderStatuses[m.from?.address] || null;
    const div = document.createElement("div");
    div.className = "msg-row" + (!m.seen ? " unread" : "") + (m.uid === currentUid ? " active" : "");

    // Color based on list membership
    if (status === "blacklist") {
      div.style.cssText = "background:#450a0a;color:#fecaca;border-left:3px solid #ef4444";
    } else if (status === "greylist") {
      div.style.cssText = "background:#1e293b;color:#cbd5e1;border-left:3px solid #64748b";
    }

    div.innerHTML = `
      <div class="msg-top">
        <span class="msg-from">${escHtml(m.from?.name || m.from?.address || "Unknown")}</span>
        <span class="msg-date">${formatDate(m.date)}</span>
      </div>
      <div class="msg-subject" style="${status === "blacklist" ? "color:#fca5a5" : status === "greylist" ? "color:#94a3b8" : ""}">${escHtml(m.subject)}</div>
      <div class="msg-icons">
        ${m.flagged ? '<span class="star">&#9733;</span>' : ""}
        ${m.hasAttachments ? '<span class="clip">&#128206;</span>' : ""}
        ${status === "blacklist" ? '<span style="color:#ef4444;font-size:10px">BLOCKED</span>' : ""}
        ${status === "greylist" ? '<span style="color:#64748b;font-size:10px">GREY</span>' : ""}
      </div>
    `;
    div.addEventListener("click", () => openMessage(m.uid));
    list.appendChild(div);
  }
}

// ── Read message ────────────────────────────────────────────────────────────
async function openMessage(uid) {
  currentUid = uid;
  renderMessageList(); // highlight active

  $("#readPlaceholder").style.display = "none";
  $("#readContent").style.display = "flex";
  $("#readHeader").innerHTML = `<div style="color:var(--fg2);font-size:12px">Loading...</div>`;

  const msg = await gideon.fetchMessage(uid);
  if (msg.error) {
    $("#readHeader").innerHTML = `<div style="color:var(--danger)">${escHtml(msg.error)}</div>`;
    return;
  }

  currentMsg = msg;

  // Mark as read in list
  const listMsg = currentMessages.find((m) => m.uid === uid);
  if (listMsg) { listMsg.seen = true; renderMessageList(); }

  // Header
  $("#readHeader").innerHTML = `
    <h2>${escHtml(msg.subject)}</h2>
    <div class="meta">
      <strong>${escHtml(msg.from?.name || msg.from?.address || "")}</strong>
      &lt;${escHtml(msg.from?.address || "")}&gt;<br>
      To: ${(msg.to || []).map((t) => escHtml(t.name || t.address)).join(", ")}
      ${msg.cc?.length ? "<br>Cc: " + msg.cc.map((t) => escHtml(t.name || t.address)).join(", ") : ""}
      <br>${formatDateFull(msg.date)}
    </div>
  `;

  // Star button
  const starred = currentMessages.find((m) => m.uid === uid)?.flagged;
  $("#btnStar").innerHTML = starred ? "&#9733;" : "&#9734;";
  $("#btnStar").style.color = starred ? "#fbbf24" : "";

  // Attachments
  const attDiv = $("#readAttachments");
  attDiv.innerHTML = "";
  for (const a of msg.attachments || []) {
    const chip = document.createElement("div");
    chip.className = "att-chip";
    chip.textContent = `${a.filename} (${formatSize(a.size)})`;
    chip.addEventListener("click", () => downloadAttachment(uid, a.filename));
    attDiv.appendChild(chip);
  }

  // Body (sandboxed iframe)
  const iframe = $("#readBody");
  const html = msg.html || `<pre style="font-family:inherit;white-space:pre-wrap">${escHtml(msg.text || "")}</pre>`;
  const doc = iframe.contentDocument || iframe.contentWindow.document;
  doc.open();
  doc.write(`
    <html><head><style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 14px; color: #1e293b; padding: 16px; line-height: 1.6; }
      img { max-width: 100%; height: auto; }
      a { color: #2563eb; cursor: pointer; }
      blockquote { border-left: 3px solid #cbd5e1; margin: 8px 0; padding: 4px 12px; color: #64748b; }
    </style></head><body>${html}</body></html>
  `);
  doc.close();

  // Make links open in system browser
  doc.addEventListener("click", (e) => {
    const link = e.target.closest("a");
    if (link && link.href && (link.href.startsWith("http://") || link.href.startsWith("https://") || link.href.startsWith("mailto:"))) {
      e.preventDefault();
      window.open(link.href);
    }
  });
}

async function deleteCurrent() {
  if (!currentUid) return;
  if (!confirm("Delete this message?")) return;

  const result = await gideon.deleteMessage(currentUid);
  if (result.ok) {
    currentUid = null;
    currentMsg = null;
    $("#readContent").style.display = "none";
    $("#readPlaceholder").style.display = "flex";
    loadMessages();
  }
}

async function starCurrent() {
  if (!currentUid) return;
  await gideon.toggleFlag(currentUid, "flagged");
  const m = currentMessages.find((m) => m.uid === currentUid);
  if (m) m.flagged = !m.flagged;
  renderMessageList();
  $("#btnStar").innerHTML = m?.flagged ? "&#9733;" : "&#9734;";
  $("#btnStar").style.color = m?.flagged ? "#fbbf24" : "";
}

async function downloadAttachment(uid, filename) {
  const result = await gideon.fetchAttachment(uid, filename);
  if (result.error) { alert(result.error); return; }

  const blob = new Blob([Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0))], { type: result.contentType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = result.filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Search ──────────────────────────────────────────────────────────────────
async function searchMail(query) {
  const result = await gideon.searchMessages(query);
  if (result.error) return;
  currentMessages = result.messages || [];
  renderMessageList();
  $("#pageInfo").textContent = `${currentMessages.length} results`;
  $("#btnPrev").disabled = true;
  $("#btnNext").disabled = true;
}

// ── Compose ─────────────────────────────────────────────────────────────────
function openCompose(mode) {
  composeMode = mode;
  composeAttachments = [];
  $("#composeAttachList").innerHTML = "";
  $("#composeModal").style.display = "flex";

  if (mode === "new") {
    $("#composeTitle").textContent = "New Message";
    $("#composeTo").value = "";
    $("#composeCc").value = "";
    $("#composeSubject").value = "";
    $("#composeEditor").innerHTML = "";
  } else if (mode === "reply" && currentMsg) {
    $("#composeTitle").textContent = "Reply";
    $("#composeTo").value = currentMsg.from?.address || "";
    $("#composeCc").value = "";
    $("#composeSubject").value = currentMsg.subject?.startsWith("Re:") ? currentMsg.subject : `Re: ${currentMsg.subject}`;
    $("#composeEditor").innerHTML = `<br><br><blockquote style="border-left:3px solid #cbd5e1;padding-left:12px;color:#64748b">
      On ${formatDateFull(currentMsg.date)}, ${escHtml(currentMsg.from?.name || currentMsg.from?.address || "")} wrote:<br>
      ${currentMsg.html || escHtml(currentMsg.text || "")}
    </blockquote>`;
  } else if (mode === "replyall" && currentMsg) {
    $("#composeTitle").textContent = "Reply All";
    const allTo = [currentMsg.from, ...(currentMsg.to || []), ...(currentMsg.cc || [])]
      .filter((t) => t?.address)
      .map((t) => t.address);
    const unique = [...new Set(allTo)];
    $("#composeTo").value = currentMsg.from?.address || "";
    $("#composeCc").value = unique.filter((a) => a !== currentMsg.from?.address).join(", ");
    $("#composeSubject").value = currentMsg.subject?.startsWith("Re:") ? currentMsg.subject : `Re: ${currentMsg.subject}`;
    $("#composeEditor").innerHTML = `<br><br><blockquote style="border-left:3px solid #cbd5e1;padding-left:12px;color:#64748b">
      On ${formatDateFull(currentMsg.date)}, ${escHtml(currentMsg.from?.name || currentMsg.from?.address || "")} wrote:<br>
      ${currentMsg.html || escHtml(currentMsg.text || "")}
    </blockquote>`;
  } else if (mode === "forward" && currentMsg) {
    $("#composeTitle").textContent = "Forward";
    $("#composeTo").value = "";
    $("#composeCc").value = "";
    $("#composeSubject").value = currentMsg.subject?.startsWith("Fwd:") ? currentMsg.subject : `Fwd: ${currentMsg.subject}`;
    $("#composeEditor").innerHTML = `<br><br>---------- Forwarded message ----------<br>
      From: ${escHtml(currentMsg.from?.name || "")} &lt;${escHtml(currentMsg.from?.address || "")}&gt;<br>
      Date: ${formatDateFull(currentMsg.date)}<br>
      Subject: ${escHtml(currentMsg.subject || "")}<br><br>
      ${currentMsg.html || escHtml(currentMsg.text || "")}`;
  }

  $("#composeTo").focus();
}

function closeCompose() {
  $("#composeModal").style.display = "none";
  composeMode = null;
  composeAttachments = [];
}

function handleAttachFiles(e) {
  for (const file of e.target.files) {
    const reader = new FileReader();
    reader.onload = () => {
      composeAttachments.push({
        filename: file.name,
        contentType: file.type,
        data: reader.result.split(",")[1], // base64
      });
      renderAttachList();
    };
    reader.readAsDataURL(file);
  }
  e.target.value = "";
}

function renderAttachList() {
  const list = $("#composeAttachList");
  list.innerHTML = "";
  for (let i = 0; i < composeAttachments.length; i++) {
    const span = document.createElement("span");
    span.className = "att-chip";
    span.textContent = composeAttachments[i].filename;
    span.style.cursor = "pointer";
    span.addEventListener("click", () => {
      composeAttachments.splice(i, 1);
      renderAttachList();
    });
    list.appendChild(span);
  }
}

async function sendCompose() {
  const to = $("#composeTo").value.trim();
  if (!to) { alert("Enter a recipient"); return; }

  $("#composeSend").disabled = true;
  $("#composeSend").textContent = "Sending...";

  const opts = {
    to,
    cc: $("#composeCc").value.trim() || undefined,
    subject: $("#composeSubject").value.trim(),
    html: $("#composeEditor").innerHTML,
    text: $("#composeEditor").innerText,
    attachments: composeAttachments.length ? composeAttachments : undefined,
  };

  if (composeMode === "reply" || composeMode === "replyall") {
    opts.inReplyTo = currentMsg?.messageId;
    opts.references = currentMsg?.references;
  }

  const result = await gideon.sendMail(opts);

  $("#composeSend").disabled = false;
  $("#composeSend").textContent = "Send";

  if (result.error) {
    alert("Send failed: " + result.error);
  } else {
    closeCompose();
  }
}

// ── Settings ────────────────────────────────────────────────────────────────
async function openSettings() {
  const cfg = await gideon.getAccount() || {};
  $("#cfgDisplayName").value = cfg.displayName || "";
  $("#cfgEmail").value = cfg.email || "";
  $("#cfgUsername").value = cfg.username || "";
  $("#cfgPassword").value = cfg.password || "";
  $("#cfgImapHost").value = cfg.imapHost || "";
  $("#cfgImapPort").value = cfg.imapPort || 993;
  $("#cfgImapSecure").checked = cfg.imapSecure !== false;
  $("#cfgSmtpHost").value = cfg.smtpHost || "";
  $("#cfgSmtpPort").value = cfg.smtpPort || 587;
  $("#cfgSmtpSecure").checked = cfg.smtpSecure || false;
  const aiKey = await gideon.aiGetKey();
  $("#cfgApiKey").value = aiKey || "";
  const smsCfg = await gideon.smsGetConfig();
  $("#cfgSmsTo").value = smsCfg.smsTo || "";
  $("#cfgTextbeltKey").value = smsCfg.textbeltKey || "";
  $("#cfgSmsResult").textContent = "";
  const alState = await gideon.autolaunchGet();
  $("#cfgAutoLaunch").checked = alState.enabled;
  const convoCfg = await gideon.convoGetConfig();
  $("#cfgConvoEnabled").checked = convoCfg.enabled !== false;
  $("#cfgConvoMinReplies").value = convoCfg.minReplies || 2;
  $("#cfgConvoLookback").value = convoCfg.lookbackMonths || 6;
  $("#cfgConvoInterval").value = convoCfg.checkIntervalMin || 60;
  $("#cfgConvoResult").textContent = "";
  $("#cfgTestResult").textContent = "";
  $("#settingsModal").style.display = "flex";
}

async function testConnection() {
  $("#cfgTestResult").textContent = "Testing...";
  $("#cfgTestResult").className = "";

  try {
    // Save first so the test uses current values
    await saveSettingsQuiet();

    const result = await gideon.testConnection();
    $("#cfgTestResult").textContent = result.ok ? result.message : "Failed: " + result.message;
    $("#cfgTestResult").className = result.ok ? "test-ok" : "test-fail";
  } catch (e) {
    $("#cfgTestResult").textContent = "Error: " + (e.message || e);
    $("#cfgTestResult").className = "test-fail";
  }
}

async function saveSettingsQuiet() {
  const cfg = {
    displayName: $("#cfgDisplayName").value.trim(),
    email: $("#cfgEmail").value.trim(),
    username: $("#cfgUsername").value.trim(),
    password: $("#cfgPassword").value,
    imapHost: $("#cfgImapHost").value.trim(),
    imapPort: parseInt($("#cfgImapPort").value) || 993,
    imapSecure: $("#cfgImapSecure").checked,
    smtpHost: $("#cfgSmtpHost").value.trim(),
    smtpPort: parseInt($("#cfgSmtpPort").value) || 587,
    smtpSecure: $("#cfgSmtpSecure").checked,
  };
  await gideon.saveAccount(cfg);
  const apiKey = $("#cfgApiKey").value.trim();
  if (apiKey) await gideon.aiSaveKey(apiKey);
  await gideon.smsSaveConfig({
    smsTo: $("#cfgSmsTo").value.trim(),
    textbeltKey: $("#cfgTextbeltKey").value.trim(),
  });
}

async function saveSettings() {
  await saveSettingsQuiet();
  $("#settingsModal").style.display = "none";
  loadFolders();
  loadMessages();
}

// ── Generic list renderer (whitelist, blacklist, greylist) ──────────────
async function renderManagedList(containerId, getFn, toggleFn, removeFn, updateFn, color) {
  const list = await getFn();
  const container = $(containerId);
  if (!container) return;
  container.innerHTML = "";

  const header = document.createElement("div");
  header.style.cssText = "font-size:10px;color:" + color + ";padding:2px 0 4px;font-weight:600";
  header.textContent = list.length ? `${list.length} entr${list.length > 1 ? "ies" : "y"}` : "Empty. Add one below.";
  container.appendChild(header);

  for (const item of list) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:6px;padding:5px 4px;font-size:11px;border-bottom:1px solid var(--border);background:var(--bg2);border-radius:4px;margin-bottom:2px";

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = item.enabled;
    toggle.addEventListener("change", async () => { await toggleFn(item.id); renderManagedList(containerId, getFn, toggleFn, removeFn, updateFn, color); });

    const info = document.createElement("div");
    info.style.cssText = `flex:1;color:${item.enabled ? "var(--fg)" : "var(--fg2)"};${item.enabled ? "" : "text-decoration:line-through"}`;
    const addrLine = document.createElement("div");
    addrLine.textContent = item.address;
    addrLine.style.fontWeight = "600";
    info.appendChild(addrLine);
    if (item.name) { const n = document.createElement("div"); n.textContent = item.name; n.style.cssText = "font-size:10px;color:var(--fg2)"; info.appendChild(n); }

    const editBtn = document.createElement("button");
    editBtn.style.cssText = "background:none;border:1px solid var(--bg3);color:var(--fg2);cursor:pointer;font-size:10px;padding:1px 6px;border-radius:3px";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => {
      const newAddr = prompt("Email or name to match:", item.address);
      if (newAddr === null) return;
      const newName = prompt("Label (optional):", item.name || "");
      updateFn(item.id, { address: newAddr, name: newName || "" }).then(() => renderManagedList(containerId, getFn, toggleFn, removeFn, updateFn, color));
    });

    const del = document.createElement("button");
    del.style.cssText = "background:none;border:none;color:var(--danger);cursor:pointer;font-size:14px;padding:0 4px";
    del.textContent = "\u00d7";
    del.addEventListener("click", async () => {
      if (!confirm(`Remove "${item.name || item.address}"?`)) return;
      await removeFn(item.id);
      renderManagedList(containerId, getFn, toggleFn, removeFn, updateFn, color);
    });

    row.appendChild(toggle);
    row.appendChild(info);
    row.appendChild(editBtn);
    row.appendChild(del);
    container.appendChild(row);
  }
}

// ── Rules Panel ─────────────────────────────────────────────────────────
async function openRules() {
  // Load all settings into the rules panel
  const smsSett = await gideon.smsSettingsGet();
  $("#cfgSmsFormat").value = smsSett.format || "sender_subject";
  $("#cfgSmsMaxLen").value = smsSett.maxLength || 160;
  $("#cfgSmsPrefix").value = smsSett.prefix || "GideonMail";
  $("#cfgSmsBatch").checked = smsSett.batchMultiple !== false;
  $("#cfgQuietStart").value = smsSett.quietStart ?? 22;
  $("#cfgQuietEnd").value = smsSett.quietEnd ?? 7;
  $("#cfgSmsMaxHour").value = smsSett.maxPerHour || 10;
  $("#cfgSmsMaxDay").value = smsSett.maxPerDay || 30;
  $("#cfgSmsHistory").value = smsSett.historyHours || 4;

  const convoCfg = await gideon.convoGetConfig();
  $("#cfgConvoEnabled").checked = convoCfg.enabled !== false;
  $("#cfgConvoMinReplies").value = convoCfg.minReplies || 2;
  $("#cfgConvoLookback").value = convoCfg.lookbackMonths || 6;
  $("#cfgConvoInterval").value = convoCfg.checkIntervalMin || 60;
  $("#cfgConvoResult").textContent = "";

  // Security filters
  const sf = await gideon.securityFiltersGet();
  $("#sfSpamassassin").checked = sf.spamassassin || false;
  $("#sfSpamhaus").checked = sf.spamhaus || false;
  $("#sfVirustotal").checked = sf.virustotal || false;
  $("#sfSafebrowsing").checked = sf.safebrowsing || false;
  $("#sfPhishtank").checked = sf.phishtank || false;
  $("#sfAbuseipdb").checked = sf.abuseipdb || false;
  $("#sfClamav").checked = sf.clamav || false;
  $("#sfBayesian").checked = sf.bayesian || false;

  // API keys
  const apiKeys = await gideon.securityApiKeysGet();
  $("#sfKeyVt").value = apiKeys.virustotal || "";
  $("#sfKeySb").value = apiKeys.safebrowsing || "";
  $("#sfKeyAbuse").value = apiKeys.abuseipdb || "";

  // Auto-check interval
  const ac = await gideon.autocheckGet();
  $("#sfAutoCheckInterval").value = String(ac.intervalMin || 120);

  $("#rulesModal").style.display = "flex";
  renderManagedList("#whitelistEntries", gideon.whitelistGet, gideon.whitelistToggle, gideon.whitelistRemove, gideon.whitelistUpdate, "var(--accent)");
  renderManagedList("#blacklistEntries", gideon.blacklistGet, gideon.blacklistToggle, gideon.blacklistRemove, gideon.blacklistUpdate, "#ef4444");
  renderManagedList("#greylistEntries", gideon.greylistGet, gideon.greylistToggle, gideon.greylistRemove, gideon.greylistUpdate, "#94a3b8");
  renderSettingsInstructions();
}

async function saveRulesSettings() {
  await gideon.smsSettingsSave({
    format: $("#cfgSmsFormat").value,
    maxLength: parseInt($("#cfgSmsMaxLen").value) || 160,
    prefix: $("#cfgSmsPrefix").value.trim(),
    batchMultiple: $("#cfgSmsBatch").checked,
    quietStart: parseInt($("#cfgQuietStart").value) ?? 22,
    quietEnd: parseInt($("#cfgQuietEnd").value) ?? 7,
    maxPerHour: parseInt($("#cfgSmsMaxHour").value) || 10,
    maxPerDay: parseInt($("#cfgSmsMaxDay").value) || 30,
    historyHours: parseInt($("#cfgSmsHistory").value) || 4,
  });
  await gideon.convoSaveConfig({
    enabled: $("#cfgConvoEnabled").checked,
    minReplies: parseInt($("#cfgConvoMinReplies").value) || 2,
    lookbackMonths: parseInt($("#cfgConvoLookback").value) || 6,
    checkIntervalMin: parseInt($("#cfgConvoInterval").value) || 60,
  });
  await gideon.securityFiltersSave({
    spamassassin: $("#sfSpamassassin").checked,
    spamhaus: $("#sfSpamhaus").checked,
    virustotal: $("#sfVirustotal").checked,
    safebrowsing: $("#sfSafebrowsing").checked,
    phishtank: $("#sfPhishtank").checked,
    abuseipdb: $("#sfAbuseipdb").checked,
    clamav: $("#sfClamav").checked,
    bayesian: $("#sfBayesian").checked,
  });
  await gideon.autocheckSave({
    intervalMin: parseInt($("#sfAutoCheckInterval").value) || 120,
  });
  await gideon.securityApiKeysSave({
    virustotal: $("#sfKeyVt").value.trim(),
    safebrowsing: $("#sfKeySb").value.trim(),
    abuseipdb: $("#sfKeyAbuse").value.trim(),
  });
}

// ── Whitelist Management ────────────────────────────────────────────────
async function renderWhitelist() {
  const list = await gideon.whitelistGet();
  const container = $("#whitelistEntries");
  if (!container) { console.error("whitelistEntries element not found"); return; }
  container.innerHTML = "";

  // Header with count
  const header = document.createElement("div");
  header.style.cssText = "font-size:10px;color:var(--accent);padding:2px 0 4px;font-weight:600";
  header.textContent = list.length ? `${list.length} VIP sender${list.length > 1 ? "s" : ""} — emails from these always trigger SMS` : "No VIP senders. Add one below.";
  container.appendChild(header);

  for (const item of list) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:6px;padding:5px 4px;font-size:11px;border-bottom:1px solid var(--border);background:var(--bg2);border-radius:4px;margin-bottom:2px";

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = item.enabled;
    toggle.title = item.enabled ? "Enabled — click to disable" : "Disabled — click to enable";
    toggle.addEventListener("change", async () => {
      await gideon.whitelistToggle(item.id);
      renderWhitelist();
    });

    const info = document.createElement("div");
    info.style.cssText = `flex:1;color:${item.enabled ? "var(--fg)" : "var(--fg2)"};${item.enabled ? "" : "text-decoration:line-through"}`;
    const addrLine = document.createElement("div");
    addrLine.textContent = item.address;
    addrLine.style.cssText = "font-weight:600";
    info.appendChild(addrLine);
    if (item.name) {
      const nameLine = document.createElement("div");
      nameLine.textContent = item.name;
      nameLine.style.cssText = "font-size:10px;color:var(--fg2)";
      info.appendChild(nameLine);
    }

    const editBtn = document.createElement("button");
    editBtn.style.cssText = "background:none;border:1px solid var(--bg3);color:var(--fg2);cursor:pointer;font-size:10px;padding:1px 6px;border-radius:3px";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => {
      const newAddr = prompt("Email or name to match:", item.address);
      if (newAddr === null) return;
      const newName = prompt("Label (optional):", item.name || "");
      gideon.whitelistUpdate(item.id, { address: newAddr, name: newName || "" }).then(renderWhitelist);
    });

    const del = document.createElement("button");
    del.style.cssText = "background:none;border:none;color:var(--danger);cursor:pointer;font-size:14px;padding:0 4px";
    del.textContent = "\u00d7";
    del.title = "Remove";
    del.addEventListener("click", async () => {
      if (!confirm(`Remove "${item.name || item.address}" from whitelist?`)) return;
      await gideon.whitelistRemove(item.id);
      renderWhitelist();
    });

    row.appendChild(toggle);
    row.appendChild(info);
    row.appendChild(editBtn);
    row.appendChild(del);
    container.appendChild(row);
  }
}

// ── Instructions Management (Settings) ──────────────────────────────────
async function renderSettingsInstructions() {
  const list = await gideon.instructionsGet();
  const container = $("#instrEntries");
  if (!container) { console.error("instrEntries element not found"); return; }
  container.innerHTML = "";

  const header = document.createElement("div");
  header.style.cssText = "font-size:10px;color:var(--accent);padding:2px 0 4px;font-weight:600";
  header.textContent = list.length ? `${list.length} instruction${list.length > 1 ? "s" : ""} — the AI follows these when checking email` : "No instructions yet. Add one below or use 'Save as instruction' in the AI chat.";
  container.appendChild(header);

  for (const item of list) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:flex-start;gap:6px;padding:5px 4px;font-size:11px;border-bottom:1px solid var(--border);background:var(--bg2);border-radius:4px;margin-bottom:2px";

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = item.enabled;
    toggle.style.marginTop = "2px";
    toggle.title = item.enabled ? "Active" : "Disabled";
    toggle.addEventListener("change", async () => {
      await gideon.instructionsToggle(item.id);
      renderSettingsInstructions();
    });

    const text = document.createElement("div");
    text.style.cssText = `flex:1;color:${item.enabled ? "var(--fg)" : "var(--fg2)"};line-height:1.4;${item.enabled ? "" : "text-decoration:line-through"}`;
    text.textContent = item.text;
    const dateLine = document.createElement("div");
    dateLine.style.cssText = "font-size:9px;color:var(--fg2);margin-top:2px";
    dateLine.textContent = `Added ${new Date(item.created).toLocaleDateString()}`;
    text.appendChild(dateLine);

    const editBtn = document.createElement("button");
    editBtn.style.cssText = "background:none;border:1px solid var(--bg3);color:var(--fg2);cursor:pointer;font-size:10px;padding:1px 6px;border-radius:3px";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => {
      const newText = prompt("Edit instruction:", item.text);
      if (newText === null || !newText.trim()) return;
      gideon.instructionsUpdate(item.id, newText).then(renderSettingsInstructions);
    });

    const del = document.createElement("button");
    del.style.cssText = "background:none;border:none;color:var(--danger);cursor:pointer;font-size:14px;padding:0 4px";
    del.textContent = "\u00d7";
    del.title = "Remove";
    del.addEventListener("click", async () => {
      if (!confirm(`Remove instruction: "${item.text.substring(0, 50)}..."?`)) return;
      await gideon.instructionsRemove(item.id);
      renderSettingsInstructions();
    });

    row.appendChild(toggle);
    row.appendChild(text);
    row.appendChild(editBtn);
    row.appendChild(del);
    container.appendChild(row);
  }
}

// ── AI Assistant ────────────────────────────────────────────────────────────
let aiOpen = false;
let lastUserMessage = "";

function toggleAI() {
  aiOpen = !aiOpen;
  $("#aiPanel").style.display = aiOpen ? "flex" : "none";
}

function addAIMessage(text, role) {
  const div = document.createElement("div");
  div.className = "ai-msg " + role;
  div.textContent = text;

  // Add "Save as rule" button on assistant responses that followed a user instruction
  if (role === "assistant" && lastUserMessage && text.includes("Actions taken:") || (role === "assistant" && lastUserMessage)) {
    const saveRule = document.createElement("div");
    saveRule.style.cssText = "margin-top:6px;padding-top:4px;border-top:1px solid #ffffff15";
    const btn = document.createElement("button");
    btn.style.cssText = "background:#7c3aed22;border:1px solid #7c3aed44;color:#a78bfa;padding:2px 8px;border-radius:3px;font-size:10px;cursor:pointer";
    btn.textContent = "Save as standing instruction";
    const instrText = lastUserMessage;
    btn.addEventListener("click", async () => {
      await gideon.instructionsAdd(instrText);
      btn.textContent = "Saved!";
      btn.disabled = true;
      btn.style.color = "#22c55e";
      btn.style.borderColor = "#22c55e44";
      // AI confirms
      addAIMessage(`New instruction saved: "${instrText}"`, "system");
      if (instrVisible) renderInstructions();
    });
    saveRule.appendChild(btn);
    div.appendChild(saveRule);
  }

  $("#aiMessages").appendChild(div);
  $("#aiMessages").scrollTop = $("#aiMessages").scrollHeight;
}

async function aiTriageInbox() {
  if (!currentMessages.length) { addAIMessage("No messages to triage.", "error"); return; }
  addAIMessage("Triaging inbox...", "system");
  const result = await gideon.aiTriage(currentMessages);
  if (result.error) addAIMessage("Error: " + result.error, "error");
  else addAIMessage(result.text, "assistant");
}

async function aiAnalyzeCurrent() {
  if (!currentMsg) { addAIMessage("Open an email first.", "error"); return; }
  addAIMessage("Analyzing email...", "system");
  const result = await gideon.aiAnalyze(currentMsg);
  if (result.error) addAIMessage("Error: " + result.error, "error");
  else addAIMessage(result.text, "assistant");
}

async function aiDraftReplyCurrent() {
  if (!currentMsg) { addAIMessage("Open an email first.", "error"); return; }
  addAIMessage("Drafting reply...", "system");
  const result = await gideon.aiDraftReply(currentMsg, "");
  if (result.error) {
    addAIMessage("Error: " + result.error, "error");
  } else {
    addAIMessage(result.text, "assistant");
    // Also offer to use it
    const useBtn = document.createElement("div");
    useBtn.className = "ai-msg system";
    useBtn.style.cursor = "pointer";
    useBtn.textContent = "Click here to use this draft in a reply";
    useBtn.addEventListener("click", () => {
      openCompose("reply");
      setTimeout(() => { $("#composeEditor").innerText = result.text; }, 100);
    });
    $("#aiMessages").appendChild(useBtn);
    $("#aiMessages").scrollTop = $("#aiMessages").scrollHeight;
  }
}

async function aiSendChat() {
  const input = $("#aiInput");
  const sendBtn = $("#aiSend");
  const msg = input.value.trim();
  if (!msg) return;

  input.value = "";
  input.disabled = true;
  sendBtn.disabled = true;
  sendBtn.textContent = "...";
  lastUserMessage = msg;
  addAIMessage(msg, "user");
  addAIMessage("Working...", "system");

  try {
    const result = await gideon.aiChat(msg, currentMsg || null);
    // Remove the "Working..." message
    const msgs = $("#aiMessages");
    const last = msgs.lastElementChild;
    if (last && last.textContent === "Working...") last.remove();

    if (result.error) addAIMessage("Error: " + result.error, "error");
    else addAIMessage(result.text, "assistant");
  } catch (e) {
    const msgs = $("#aiMessages");
    const last = msgs.lastElementChild;
    if (last && last.textContent === "Working...") last.remove();
    addAIMessage("Error: " + (e.message || e), "error");
  }

  input.disabled = false;
  sendBtn.disabled = false;
  sendBtn.textContent = "Send";
  input.focus();
}

// ── Standing Instructions ────────────────────────────────────────────────────
let instrVisible = false;

async function renderInstructions() {
  const list = await gideon.instructionsGet();
  const container = $("#aiInstrList");
  container.innerHTML = "";

  if (!list.length) {
    container.innerHTML = '<div style="font-size:10px;color:var(--fg2);padding:4px 0">No instructions yet. Type one below and press Enter.</div>';
  }

  for (const item of list) {
    const row = document.createElement("div");
    row.className = "ai-instr-item" + (item.enabled ? "" : " disabled");

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = item.enabled;
    toggle.addEventListener("change", async () => {
      await gideon.instructionsToggle(item.id);
      renderInstructions();
    });

    const text = document.createElement("span");
    text.className = "text";
    text.textContent = item.text;

    const del = document.createElement("button");
    del.textContent = "\u00d7";
    del.title = "Remove";
    del.addEventListener("click", async () => {
      await gideon.instructionsRemove(item.id);
      renderInstructions();
    });

    row.appendChild(toggle);
    row.appendChild(text);
    row.appendChild(del);
    container.appendChild(row);
  }
}

async function addInstruction(text) {
  if (!text.trim()) return;
  await gideon.instructionsAdd(text.trim());
  $("#aiInstrInput").value = "";
  renderInstructions();

  // AI confirms understanding
  addAIMessage(`New instruction: "${text.trim()}"`, "user");
  const result = await gideon.aiChat(
    `I just added this standing instruction for you to follow when checking my emails: "${text.trim()}". Confirm you understand in one sentence, and explain briefly how you'll apply it.`,
    null
  );
  if (result.error) addAIMessage("Error: " + result.error, "error");
  else addAIMessage(result.text, "assistant");
}

function bindAIEvents() {
  $("#btnAI").addEventListener("click", () => { toggleAI(); renderInstructions(); });
  $("#aiClose").addEventListener("click", toggleAI);
  $("#aiTriage").addEventListener("click", aiTriageInbox);
  $("#aiAnalyze").addEventListener("click", aiAnalyzeCurrent);
  $("#aiDraft").addEventListener("click", aiDraftReplyCurrent);
  $("#aiSend").addEventListener("click", aiSendChat);
  $("#aiInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); aiSendChat(); }
  });

  // Instructions
  $("#aiInstrToggle").addEventListener("click", () => {
    instrVisible = !instrVisible;
    $("#aiInstrList").style.display = instrVisible ? "block" : "none";
    $("#aiInstrAdd").style.display = instrVisible ? "block" : "none";
    $("#aiInstrToggle").textContent = instrVisible ? "Hide" : "Show";
    if (instrVisible) renderInstructions();
  });
  $("#aiInstrInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addInstruction(e.target.value); }
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function escHtml(s) {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (now.getFullYear() === d.getFullYear()) {
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

function formatDateFull(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString([], {
    weekday: "short", year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function formatSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}

// ── Boot ────────────────────────────────────────────────────────────────────
init();
