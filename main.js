const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require("electron");
app.setName("GideonMail");
if (process.platform === "win32") app.setAppUserModelId("GideonMail");

// Prevent crash on IMAP connection resets
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err.message);
  if (err.code === "ECONNRESET" || err.code === "EPIPE" || err.code === "ETIMEDOUT") {
    console.log("Network error — will reconnect on next operation");
    imapClient = null;
  }
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err?.message || err);
});

// Single instance lock — prevent multiple tray icons
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // Someone tried to run a second instance — focus the existing window
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
const path = require("path");
const _esm = require("electron-store");
const Store = _esm.default || _esm;
const { ImapFlow } = require("imapflow");
const nodemailer = require("nodemailer");
const { simpleParser } = require("mailparser");
const security = require("./security");
const GoogleAuth = require("./google-auth");
let bayesianFilter = null;
let googleAuth = null;

const store = new Store({ name: "gideonmail-config" });
const AutoLaunch = (() => { const m = require("auto-launch"); return m.default || m; })();
const autoLauncher = new AutoLaunch({ name: "GideonMail", isHidden: true });

bayesianFilter = new security.BayesianFilter(store);
googleAuth = new GoogleAuth(store);

// Auto-backup config on startup (keep last 3 backups)
function backupConfig() {
  try {
    const fs = require("fs");
    const configDir = path.join(require("os").homedir(), "AppData", "Roaming", "gideonmail");
    const configFile = path.join(configDir, "gideonmail-config.json");
    if (!fs.existsSync(configFile)) return;
    const backupFile = path.join(configDir, `gideonmail-config.backup-${Date.now()}.json`);
    fs.copyFileSync(configFile, backupFile);
    // Keep only last 3 backups
    const backups = fs.readdirSync(configDir).filter((f) => f.startsWith("gideonmail-config.backup-")).sort().reverse();
    for (const old of backups.slice(3)) {
      fs.unlinkSync(path.join(configDir, old));
    }
  } catch (e) { /* non-fatal */ }
}
backupConfig();

let mainWindow = null;
let tray = null;
let imapClient = null;
let unreadCount = 0;
const startHidden = process.argv.includes("--hidden");

// ── Window ──────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: !startHidden,
    title: "GideonMail",
    icon: path.join(__dirname, "assets", "icon.png"),
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile("renderer/index.html");

  // Open links in the system browser instead of inside Electron
  const { shell } = require("electron");
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      e.preventDefault();
      if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:")) {
        shell.openExternal(url);
      }
    }
  });

  mainWindow.on("close", (e) => {
    if (app.isQuitting) return;
    e.preventDefault();

    const { dialog } = require("electron");
    dialog.showMessageBox(mainWindow, {
      type: "question",
      buttons: ["Minimize to Tray", "Quit"],
      defaultId: 0,
      title: "GideonMail",
      message: "Keep running in the background?",
      detail: "GideonMail will continue checking email and sending alerts from the system tray.",
    }).then(({ response }) => {
      if (response === 0) {
        mainWindow.hide();
      } else {
        app.isQuitting = true;
        app.quit();
      }
    });
  });
}

// ── Tray ────────────────────────────────────────────────────────────────────
function createTray() {
  if (tray) { try { tray.destroy(); } catch (e) {} tray = null; }
  const iconPath = path.join(__dirname, "assets", "icon-16.png");
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip("GideonMail");
  tray.on("click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  updateTrayMenu();
}

function updateTrayMenu() {
  const menu = Menu.buildFromTemplate([
    { label: `GideonMail${unreadCount ? ` (${unreadCount})` : ""}`, enabled: false },
    { type: "separator" },
    { label: "Open", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: "Check Mail", click: () => fetchInbox() },
    { type: "separator" },
    { label: "Quit", click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray?.setContextMenu(menu);
}

// ── IMAP ────────────────────────────────────────────────────────────────────
// Fresh IMAP connection for each AI tool operation
// No caching — avoids stale connections and lock contention entirely
async function createFreshImapClient() {
  const cfg = store.get("account");
  if (!cfg) throw new Error("No account configured");

  const client = new ImapFlow({
    host: cfg.imapHost,
    port: cfg.imapPort || 993,
    secure: cfg.imapSecure === true,
    auth: { user: cfg.username, pass: cfg.password },
    logger: false,
    tls: { rejectUnauthorized: false },
  });

  await client.connect();
  return client;
}

async function getImapClient() {
  const cfg = store.get("account");
  if (!cfg) throw new Error("No account configured");

  // Force reconnect if connection is dead
  if (imapClient && !imapClient.usable) {
    try { await imapClient.logout(); } catch (e) {}
    imapClient = null;
  }

  if (imapClient && imapClient.usable) return imapClient;

  imapClient = new ImapFlow({
    host: cfg.imapHost,
    port: cfg.imapPort || 993,
    secure: cfg.imapSecure === true,
    auth: { user: cfg.username, pass: cfg.password },
    logger: false,
    tls: { rejectUnauthorized: false },
  });

  // Handle unexpected disconnects
  imapClient.on("error", (err) => {
    console.error("IMAP connection error:", err.message);
    imapClient = null;
  });
  imapClient.on("close", () => {
    console.log("IMAP connection closed, will reconnect on next use");
    imapClient = null;
  });

  await imapClient.connect();
  return imapClient;
}

async function fetchInbox(page = 0, perPage = 50) {
  const client = await getImapClient();
  const lock = await client.getMailboxLock("INBOX");

  try {
    const total = client.mailbox.exists;
    const start = Math.max(1, total - (page + 1) * perPage + 1);
    const end = Math.max(1, total - page * perPage);

    if (start > end) return { messages: [], total, page };

    const messages = [];
    for await (const msg of client.fetch(`${start}:${end}`, {
      envelope: true,
      flags: true,
      bodyStructure: true,
      uid: true,
    })) {
      messages.push({
        uid: msg.uid,
        seq: msg.seq,
        date: msg.envelope.date?.toISOString(),
        subject: msg.envelope.subject || "(no subject)",
        from: msg.envelope.from?.[0] || {},
        to: msg.envelope.to || [],
        flags: Array.from(msg.flags || []),
        seen: msg.flags?.has("\\Seen") || false,
        flagged: msg.flags?.has("\\Flagged") || false,
        hasAttachments: _hasAttachments(msg.bodyStructure),
      });
    }

    // Sort newest first
    messages.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

    // Update unread count
    unreadCount = messages.filter((m) => !m.seen).length;
    updateTrayMenu();
    tray?.setToolTip(`GideonMail${unreadCount ? ` — ${unreadCount} unread` : ""}`);

    return { messages, total, page };
  } finally {
    lock.release();
  }
}

function _hasAttachments(structure) {
  if (!structure) return false;
  if (structure.disposition === "attachment") return true;
  if (structure.childNodes) return structure.childNodes.some(_hasAttachments);
  return false;
}

async function fetchMessage(uid, folder) {
  const mailbox = folder || "INBOX";
  // Try shared client first, retry with fresh client on failure
  async function _download(client) {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const raw = await client.download(uid.toString(), undefined, { uid: true });
      if (!raw || !raw.content) throw new Error("Download returned empty");
      const chunks = [];
      for await (const chunk of raw.content) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      const parsed = await simpleParser(buffer);

      // Mark as seen
      try { await client.messageFlagsAdd(uid.toString(), ["\\Seen"], { uid: true }); } catch (e) {}

      // Extract ICS/calendar attachment text for AI processing
      let icsText = "";
      for (const att of (parsed.attachments || [])) {
        if (att.contentType === "text/calendar" || (att.filename || "").toLowerCase().endsWith(".ics")) {
          try { icsText += "\n\n[Calendar Invite]\n" + att.content.toString("utf-8"); } catch (e) {}
        }
      }
      if (!icsText && parsed.headerLines) {
        for (const h of parsed.headerLines) {
          if (h.key === "content-type" && h.line?.includes("text/calendar")) {
            icsText = "\n\n[Calendar Invite]\n" + (parsed.text || "");
            break;
          }
        }
      }

      return {
        uid,
        subject: parsed.subject || "(no subject)",
        from: parsed.from?.value?.[0] || {},
        to: (parsed.to?.value || []),
        cc: (parsed.cc?.value || []),
        date: parsed.date?.toISOString(),
        html: parsed.html || "",
        text: (parsed.text || "") + icsText,
        icsText,
        attachments: (parsed.attachments || []).map((a) => ({
          filename: a.filename || "attachment",
          contentType: a.contentType,
          size: a.size,
          contentId: a.contentId,
        })),
      };
    } finally {
      lock.release();
    }
  }

  // Attempt 1: shared client
  try {
    const client = await getImapClient();
    return await _download(client);
  } catch (e) {
    console.log(`fetchMessage: shared client failed (${e.message}), retrying with fresh connection`);
  }

  // Attempt 2: fresh client (handles stale/dropped connections)
  const fresh = await createFreshImapClient();
  try {
    return await _download(fresh);
  } finally {
    try { await fresh.logout(); } catch (e) {}
  }
}

async function fetchAttachment(uid, filename) {
  async function _downloadAtt(client) {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const raw = await client.download(uid.toString(), undefined, { uid: true });
      if (!raw || !raw.content) throw new Error("Download returned empty");
      const chunks = [];
      for await (const chunk of raw.content) chunks.push(chunk);
      const parsed = await simpleParser(Buffer.concat(chunks));
      const att = (parsed.attachments || []).find((a) => a.filename === filename);
      if (!att) throw new Error("Attachment not found");
      return { filename: att.filename, contentType: att.contentType, data: att.content.toString("base64") };
    } finally { lock.release(); }
  }

  try {
    return await _downloadAtt(await getImapClient());
  } catch (e) {
    console.log(`fetchAttachment: retrying with fresh connection (${e.message})`);
    const fresh = await createFreshImapClient();
    try { return await _downloadAtt(fresh); }
    finally { try { await fresh.logout(); } catch (e) {} }
  }
}

async function deleteMessage(uid) {
  const client = await getImapClient();
  const lock = await client.getMailboxLock("INBOX");
  try {
    await client.messageFlagsAdd(uid.toString(), ["\\Deleted"], { uid: true });
    await client.messageDelete(uid.toString(), { uid: true });
  } finally {
    lock.release();
  }
}

async function toggleFlag(uid, flag) {
  const client = await getImapClient();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const msgs = [];
    for await (const m of client.fetch(uid.toString(), { flags: true, uid: true })) {
      msgs.push(m);
    }
    const msg = msgs[0];
    if (!msg) return;

    const imapFlag = flag === "flagged" ? "\\Flagged" : flag === "seen" ? "\\Seen" : null;
    if (!imapFlag) return;

    if (msg.flags.has(imapFlag)) {
      await client.messageFlagsRemove(uid.toString(), [imapFlag], { uid: true });
    } else {
      await client.messageFlagsAdd(uid.toString(), [imapFlag], { uid: true });
    }
  } finally {
    lock.release();
  }
}

// ── SMTP ────────────────────────────────────────────────────────────────────
async function sendMail({ to, cc, bcc, subject, html, text, inReplyTo, references, attachments }) {
  const cfg = store.get("account");
  if (!cfg) throw new Error("No account configured");

  const transport = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort || 587,
    secure: cfg.smtpSecure || false,
    auth: { user: cfg.username, pass: cfg.password },
    tls: { rejectUnauthorized: false },
  });

  const mailOpts = {
    from: `${cfg.displayName || cfg.username} <${cfg.email || cfg.username}>`,
    to,
    cc,
    bcc,
    subject,
    html,
    text,
    inReplyTo,
    references,
  };

  if (attachments && attachments.length) {
    mailOpts.attachments = attachments.map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.data, "base64"),
      contentType: a.contentType,
    }));
  }

  await transport.sendMail(mailOpts);
}

// ── Folder list ─────────────────────────────────────────────────────────────
async function listFolders() {
  const client = await createFreshImapClient();
  const folders = [];
  let tree;
  try {
    tree = await client.listTree();

    function walk(node) {
      if (node.path) {
        folders.push({
          name: node.name,
          path: node.path,
          specialUse: node.specialUse || null,
          delimiter: node.delimiter,
          unseen: 0,
        });
      }
      if (node.folders) node.folders.forEach(walk);
    }
    walk(tree);

    // Get unseen count for each folder (fast — uses STATUS, doesn't open mailbox)
    for (const f of folders) {
      try {
        const status = await client.status(f.path, { unseen: true });
        f.unseen = status.unseen || 0;
      } catch (e) { f.unseen = 0; }
    }
  } finally {
    try { await client.logout(); } catch (e) {}
  }

  return folders;
}

async function fetchFolder(folderPath, page = 0, perPage = 50) {
  const client = await getImapClient();
  const lock = await client.getMailboxLock(folderPath);

  try {
    const total = client.mailbox.exists;
    const start = Math.max(1, total - (page + 1) * perPage + 1);
    const end = Math.max(1, total - page * perPage);

    if (start > end || total === 0) return { messages: [], total, page };

    const messages = [];
    for await (const msg of client.fetch(`${start}:${end}`, {
      envelope: true,
      flags: true,
      bodyStructure: true,
      uid: true,
    })) {
      messages.push({
        uid: msg.uid,
        seq: msg.seq,
        date: msg.envelope.date?.toISOString(),
        subject: msg.envelope.subject || "(no subject)",
        from: msg.envelope.from?.[0] || {},
        to: msg.envelope.to || [],
        flags: Array.from(msg.flags || []),
        seen: msg.flags?.has("\\Seen") || false,
        flagged: msg.flags?.has("\\Flagged") || false,
        hasAttachments: _hasAttachments(msg.bodyStructure),
      });
    }

    messages.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    return { messages, total, page, folder: folderPath };
  } finally {
    lock.release();
  }
}

// ── Search ──────────────────────────────────────────────────────────────────
async function searchMessages(query) {
  const client = await createFreshImapClient();
  try {
  const lock = await client.getMailboxLock("INBOX");

  try {
    // Search subject first, then from (simple queries work on all servers)
    let uids = await client.search({ subject: query }, { uid: true });
    if (!uids.length) {
      uids = await client.search({ from: query }, { uid: true });
    }
    if (!uids.length) {
      try { uids = await client.search({ to: query }, { uid: true }); } catch (e) {}
    }

    if (!uids.length) return { messages: [], total: 0 };

    const messages = [];
    for await (const msg of client.fetch({ uid: uids.slice(-100) }, {
      envelope: true,
      flags: true,
      bodyStructure: true,
    })) {
      messages.push({
        uid: msg.uid,
        seq: msg.seq,
        date: msg.envelope.date?.toISOString(),
        subject: msg.envelope.subject || "(no subject)",
        from: msg.envelope.from?.[0] || {},
        to: msg.envelope.to || [],
        flags: Array.from(msg.flags || []),
        seen: msg.flags?.has("\\Seen") || false,
        flagged: msg.flags?.has("\\Flagged") || false,
        hasAttachments: _hasAttachments(msg.bodyStructure),
      });
    }

    messages.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    return { messages, total: messages.length };
  } finally {
    lock.release();
  }
  } finally {
    try { await client.logout(); } catch (e) {}
  }
}

// ── IDLE (push notifications + AI triage + SMS) ────────────────────────────
let idleActive = false;

// Persistent tracking: which UIDs we've already sent SMS for
function _getSmsSentUids() {
  return new Set(store.get("sms_sent_uids") || []);
}
function _addSmsSentUid(uid) {
  const uids = store.get("sms_sent_uids") || [];
  uids.push(uid);
  // Keep last 500 to prevent unbounded growth
  if (uids.length > 500) uids.splice(0, uids.length - 500);
  store.set("sms_sent_uids", uids);
}
function _getLastCheckTime() {
  return store.get("sms_last_check_time") || null;
}
function _setLastCheckTime(val) {
  if (val === null) store.delete("sms_last_check_time");
  else store.set("sms_last_check_time", new Date().toISOString());
}

// ── SMS delivery with smart settings ────────────────────────────────────
let _smsSentToday = 0;
let _smsSentHour = 0;
let _smsLastHourReset = Date.now();
let _smsLastDayReset = new Date().toDateString();

function _getSmsSettings() {
  return {
    maxLength:     store.get("sms_max_length") || 160,      // chars per SMS (160 = 1 segment on Textbelt)
    format:        store.get("sms_format") || "sender_subject", // sender_subject | subject_only | full_preview
    batchMultiple: store.get("sms_batch") !== false,         // combine multiple emails into one SMS
    quietStart:    store.get("sms_quiet_start") ?? 22,       // hour (24h) — don't text after this
    quietEnd:      store.get("sms_quiet_end") ?? 7,          // hour (24h) — don't text before this
    maxPerHour:    store.get("sms_max_per_hour") || 10,
    maxPerDay:     store.get("sms_max_per_day") || 30,
    prefix:        store.get("sms_prefix") || "GideonMail",
    historyHours:  store.get("sms_history_hours") || 4,
  };
}

function _isQuietHours() {
  const s = _getSmsSettings();
  const hour = new Date().getHours();
  if (s.quietStart > s.quietEnd) {
    // e.g. 22-7 wraps midnight
    return hour >= s.quietStart || hour < s.quietEnd;
  }
  return hour >= s.quietStart && hour < s.quietEnd;
}

function _checkRateLimit() {
  const s = _getSmsSettings();
  const now = Date.now();
  const today = new Date().toDateString();

  // Reset hourly counter
  if (now - _smsLastHourReset > 3600000) {
    _smsSentHour = 0;
    _smsLastHourReset = now;
  }
  // Reset daily counter
  if (today !== _smsLastDayReset) {
    _smsSentToday = 0;
    _smsLastDayReset = today;
  }

  if (_smsSentHour >= s.maxPerHour) return "Hourly SMS limit reached";
  if (_smsSentToday >= s.maxPerDay) return "Daily SMS limit reached";
  return null;
}

function formatSmsMessage(rawMessage) {
  const s = _getSmsSettings();
  const prefix = s.prefix ? s.prefix + ": " : "";
  const msg = prefix + rawMessage;
  return msg.substring(0, s.maxLength);
}

async function sendSMS(message) {
  const phone = store.get("sms_to");
  if (!phone) return;

  // Quiet hours check
  if (_isQuietHours()) {
    console.log("SMS suppressed — quiet hours");
    return;
  }

  // Rate limit check
  const limitMsg = _checkRateLimit();
  if (limitMsg) {
    console.log("SMS suppressed —", limitMsg);
    return;
  }

  const key = store.get("textbelt_key") || "textbelt";
  const digits = phone.replace(/\D/g, "");
  const fullNumber = digits.startsWith("1") ? digits : "1" + digits;
  const formatted = formatSmsMessage(message);

  try {
    const https = require("https");
    const postData = JSON.stringify({ phone: fullNumber, message: formatted, key });

    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "textbelt.com",
        path: "/text",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
      }, (res) => {
        let body = "";
        res.on("data", (d) => { body += d; });
        res.on("end", () => {
          const r = JSON.parse(body);
          if (r.success) { _smsSentHour++; _smsSentToday++; resolve(r); }
          else reject(new Error(r.error || "SMS send failed"));
        });
      });
      req.on("error", reject);
      req.write(postData);
      req.end();
    });
  } catch (e) {
    console.error("SMS failed:", e.message);
    throw e;
  }
}

// ── Email alert (alternative/addition to SMS) ───────────────────────────
async function sendEmailAlert(message) {
  const alertEmail = store.get("alert_email_to");
  if (!alertEmail) return;

  const cfg = store.get("account");
  if (!cfg) return;

  try {
    const transport = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort || 587,
      secure: cfg.smtpSecure || false,
      auth: { user: cfg.username, pass: cfg.password },
      tls: { rejectUnauthorized: false },
    });

    await transport.sendMail({
      from: `GideonMail Alerts <${cfg.email || cfg.username}>`,
      to: alertEmail,
      subject: `GideonMail: ${message.substring(0, 80)}`,
      text: message,
    });
  } catch (e) {
    console.error("Email alert failed:", e.message);
  }
}

// Unified alert: sends to SMS and/or email based on config
const _originalSendSMS = sendSMS;
// ── Action Email Relay (phone control via email) ────────────────────────
async function sendActionEmail(originalMsg, summary, actions) {
  const enabled = store.get("action_email_enabled") === true;
  if (!enabled) return;

  const targetEmail = store.get("action_email_address") || store.get("alert_email_to") || "";
  if (!targetEmail) return;

  const cfg = store.get("account");
  if (!cfg) return;

  const crypto = require("crypto");
  const verifyCode = crypto.randomBytes(6).toString("hex");
  const actionId = `GM-${Date.now()}-${originalMsg.uid}`;
  const fromName = originalMsg.from?.name || originalMsg.from?.address || "Unknown";
  const fromAddr = originalMsg.from?.address || "";
  const senderStatus = _senderListStatus(fromAddr, originalMsg.from?.name) || "unknown";

  // Fetch the full email body for context
  let emailPreview = "";
  let aiSynopsis = "";
  try {
    const fullMsg = await fetchMessage(originalMsg.uid);
    const bodyText = fullMsg.text || fullMsg.html?.replace(/<[^>]+>/g, " ").substring(0, 3000) || "";
    emailPreview = bodyText.substring(0, 800).trim();

    // AI synopsis if available
    if (store.get("anthropic_api_key")) {
      try {
        const aiClient = getAnthropicClient();
        const resp = await aiClient.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 150,
          system: "Summarize this email in 2-3 sentences. What is it about? What action does the sender want? What's the tone? Be direct and specific.",
          messages: [{ role: "user", content: `From: ${fromName} <${fromAddr}>\nSubject: ${originalMsg.subject}\nDate: ${originalMsg.date}\n\n${bodyText.substring(0, 2000)}` }],
        });
        aiSynopsis = (resp.content[0]?.text || "").trim();
      } catch (e) {}
    }
  } catch (e) {}

  // Build action buttons
  const actionButtons = actions.map((a) =>
    `<a href="mailto:${cfg.email || cfg.username}?subject=${encodeURIComponent(`[GIDEON-ACTION:${actionId}:${verifyCode}] ${a.command}`)}&body=${encodeURIComponent(a.command === "reply" ? "reply: " : a.command)}" style="display:inline-block;padding:8px 20px;margin:4px;background:${a.color || "#7c6cff"};color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px">${a.label}</a>`
  ).join("\n");

  // Sender management buttons
  const senderButtons = ["vip", "watch", "daily", "blocked", "muted"].map((role) => {
    const colors = { vip: "#3b82f6", watch: "#f59e0b", daily: "#22c55e", blocked: "#ef4444", muted: "#64748b" };
    const labels = { vip: "VIP", watch: "Watch", daily: "Daily", blocked: "Block", muted: "Mute" };
    const isActive = (senderStatus === "whitelist" && role === "vip") || (senderStatus === "watch" && role === "watch") || (senderStatus === "daily" && role === "daily") || (senderStatus === "blacklist" && role === "blocked") || (senderStatus === "greylist" && role === "muted");
    const bg = isActive ? colors[role] : "#2a2a32";
    const border = isActive ? colors[role] : "#55555e";
    return `<a href="mailto:${cfg.email || cfg.username}?subject=${encodeURIComponent(`[GIDEON-ACTION:${actionId}:${verifyCode}] ${role}`)}&body=${encodeURIComponent(role)}" style="display:inline-block;padding:4px 10px;margin:2px;background:${bg};color:#fff;text-decoration:none;border-radius:4px;font-size:10px;font-weight:600;border:1px solid ${border}">${labels[role]}</a>`;
  }).join("");

  const statusLabel = { whitelist: "VIP", watch: "WATCH", daily: "DAILY", blacklist: "BLOCKED", greylist: "MUTED", unknown: "Unknown sender" }[senderStatus] || senderStatus;
  const statusColor = { whitelist: "#3b82f6", watch: "#f59e0b", daily: "#22c55e", blacklist: "#ef4444", greylist: "#64748b", unknown: "#55555e" }[senderStatus] || "#55555e";

  const html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#111113;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:550px;margin:20px auto;background:#1a1a1f;border-radius:12px;overflow:hidden;border:1px solid #2a2a32">
    <div style="background:linear-gradient(135deg,#7c6cff,#6355e0);padding:16px 24px">
      <div style="color:#fff;font-size:18px;font-weight:700">GideonMail</div>
      <div style="color:#e0d4ff;font-size:11px;margin-top:2px">Action Required</div>
    </div>
    <div style="padding:20px 24px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="color:#8b8b96;font-size:11px">From: <span style="color:#e4e4e8">${fromName}</span></div>
        <span style="padding:2px 8px;border-radius:3px;font-size:9px;font-weight:700;color:#fff;background:${statusColor}">${statusLabel}</span>
      </div>
      <div style="color:#8b8b96;font-size:10px;margin-bottom:4px">${fromAddr} &middot; ${originalMsg.date ? new Date(originalMsg.date).toLocaleString() : ""}</div>
      <div style="color:#e4e4e8;font-size:16px;font-weight:600;margin-bottom:12px">${originalMsg.subject || "(no subject)"}</div>

      ${aiSynopsis ? `<div style="padding:10px 12px;background:#1a1025;border-left:3px solid #a78bfa;border-radius:0 6px 6px 0;margin-bottom:12px">
        <div style="font-size:9px;color:#a78bfa;font-weight:700;margin-bottom:4px">AI SYNOPSIS</div>
        <div style="color:#e4e4e8;font-size:12px;line-height:1.5">${aiSynopsis.replace(/\n/g, "<br>")}</div>
      </div>` : ""}

      ${(summary || "") !== "" ? `<div style="color:#e4e4e8;font-size:12px;line-height:1.5;padding:10px 12px;background:#111113;border-radius:6px;margin-bottom:12px">${(summary || "").replace(/\n/g, "<br>")}</div>` : ""}

      ${emailPreview ? `<div style="padding:10px 12px;background:#111113;border-radius:6px;margin-bottom:12px;border:1px solid #2a2a32">
        <div style="font-size:9px;color:#55555e;font-weight:700;margin-bottom:4px">EMAIL PREVIEW</div>
        <div style="color:#8b8b96;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word">${emailPreview.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</div>
      </div>` : ""}

      <div style="text-align:center;padding:8px 0">
        ${actionButtons}
      </div>

      <div style="padding:10px 0 4px;border-top:1px solid #2a2a32;margin-top:12px">
        <div style="font-size:9px;color:#55555e;font-weight:700;margin-bottom:6px;text-align:center">MANAGE THIS SENDER</div>
        <div style="text-align:center">${senderButtons}</div>
      </div>

      <div style="color:#55555e;font-size:10px;text-align:center;margin-top:12px;padding-top:10px;border-top:1px solid #2a2a32">
        Reply with: <span style="color:#8b8b96">reply: [message]</span> &middot; <span style="color:#8b8b96">approve</span> &middot; <span style="color:#8b8b96">decline</span> &middot; <span style="color:#8b8b96">later</span> &middot; <span style="color:#8b8b96">ignore</span>
      </div>
    </div>
  </div>
</body></html>`;

  try {
    const transport = nodemailer.createTransport({
      host: cfg.smtpHost, port: cfg.smtpPort || 587,
      secure: cfg.smtpSecure || false,
      auth: { user: cfg.username, pass: cfg.password },
      tls: { rejectUnauthorized: false },
    });

    await transport.sendMail({
      from: `GideonMail <${cfg.email || cfg.username}>`,
      to: targetEmail,
      subject: `[ACTION:${verifyCode}] ${fromName}: ${originalMsg.subject || "(no subject)"}`,
      html,
      text: `GideonMail Action Required\n\nFrom: ${fromName} <${fromAddr}>\nStatus: ${statusLabel}\nSubject: ${originalMsg.subject}\nDate: ${originalMsg.date || ""}\n\n${aiSynopsis ? `AI Synopsis: ${aiSynopsis}\n\n` : ""}${summary ? `${summary}\n\n` : ""}${emailPreview ? `--- Email Preview ---\n${emailPreview}\n\n` : ""}Reply with: reply: [message] | approve | decline | later | ignore | vip | watch | daily | blocked | muted`,
      headers: { "X-GideonMail-Action-Id": actionId, "X-GideonMail-UID": String(originalMsg.uid) },
    });

    // Track sent action emails (with verify code for safe auto-delete)
    const sent = store.get("action_emails_sent") || [];
    sent.push({ actionId, verifyCode, uid: originalMsg.uid, from: originalMsg.from, subject: originalMsg.subject, sent: new Date().toISOString() });
    if (sent.length > 50) sent.splice(0, sent.length - 50);
    store.set("action_emails_sent", sent);

  } catch (e) { console.error("Action email failed:", e.message); }
}

// Scan for replies to action emails and execute commands
async function processActionReplies() {
  const enabled = store.get("action_email_enabled") === true;
  if (!enabled) return;

  const sentActions = store.get("action_emails_sent") || [];
  // Build a Set of all valid verify codes for fast lookup
  const validCodes = new Set(sentActions.map((a) => a.verifyCode).filter(Boolean));
  if (!validCodes.size) return;

  try {
    const client = await createFreshImapClient();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        // Search for anything with ACTION: in subject (outgoing + replies)
        const uids = await client.search({ subject: "ACTION:" }, { uid: true });
        if (!uids.length) return;

        const toDelete = [];

        for await (const msg of client.fetch({ uid: uids.slice(-30) }, { envelope: true, source: true })) {
          const subject = msg.envelope?.subject || "";

          // Extract the verify code from subject — present in both outgoing and reply
          // Outgoing: [ACTION:abc123] ...
          // Reply button: [GIDEON-ACTION:GM-xxx:abc123] command
          const codeMatch = subject.match(/\[(?:GIDEON-)?ACTION:(?:[^\]:]*:)?([a-f0-9]{12})\]/);
          if (!codeMatch) continue;

          const code = codeMatch[1];
          if (!validCodes.has(code)) continue; // not ours or already processed

          // Code is valid — this is a GideonMail action email, safe to process + delete
          const originalAction = sentActions.find((a) => a.verifyCode === code);

          // Check if this is a reply with a command (vs the outgoing action email)
          const actionCmdMatch = subject.match(/\[GIDEON-ACTION:[^\]]+\]\s*(.*)/);
          if (actionCmdMatch && originalAction) {
            let command = (actionCmdMatch[1] || "").trim().toLowerCase();

            // Parse body for command if subject doesn't have it
            if (!command && msg.source) {
              const parsed = await simpleParser(msg.source);
              const bodyText = (parsed.text || "").trim().split("\n")[0].trim().toLowerCase();
              if (bodyText.startsWith("reply:") || ["approve", "decline", "later", "ignore"].includes(bodyText.split(/\s/)[0])) {
                command = bodyText;
              }
            }

            if (command) {
              console.log(`Action reply (code verified): ${command} for UID ${originalAction.uid}`);

              if (command.startsWith("reply:") || command.startsWith("reply ")) {
                const replyText = command.replace(/^reply[:\s]+/, "").trim();
                if (replyText) {
                  await sendMail({
                    to: originalAction.from?.address,
                    subject: originalAction.subject?.startsWith("Re:") ? originalAction.subject : `Re: ${originalAction.subject}`,
                    text: replyText,
                    html: replyText.replace(/\n/g, "<br>"),
                  });
                  console.log(`Action: replied to ${originalAction.from?.address}`);
                }
              } else if (command === "approve") {
                await sendMail({
                  to: originalAction.from?.address,
                  subject: `Re: ${originalAction.subject}`,
                  text: "Approved.",
                  html: "Approved.",
                });
              } else if (command === "decline") {
                await sendMail({
                  to: originalAction.from?.address,
                  subject: `Re: ${originalAction.subject}`,
                  text: "Thank you, but I'll have to decline.",
                  html: "Thank you, but I'll have to decline.",
                });
              } else if (command === "later") {
                await autoCreateTask({ uid: originalAction.uid, subject: originalAction.subject, from: originalAction.from });
              } else if (command === "vip" || command === "watch" || command === "blocked" || command === "muted" || command === "daily") {
                // Sender management from action email
                const senderAddr = originalAction.from?.address;
                const senderName = originalAction.from?.name || "";
                if (senderAddr) {
                  // Remove from any existing list first
                  for (const key of ["sms_whitelist", "ai_watchlist", "sms_blacklist", "sms_greylist", "daily_update_list"]) {
                    let list = store.get(key) || [];
                    list = list.filter((i) => i.address !== senderAddr.toLowerCase());
                    store.set(key, list);
                  }
                  // Add to new role
                  const roleKeys = { vip: "sms_whitelist", watch: "ai_watchlist", blocked: "sms_blacklist", muted: "sms_greylist", daily: "daily_update_list" };
                  const list = store.get(roleKeys[command]) || [];
                  const entry = { id: Date.now().toString(), address: senderAddr.toLowerCase(), name: senderName, enabled: true, created: new Date().toISOString() };
                  if (command === "watch") entry.actions = { aiAnalyze: true, smsAlert: true, autoCalendar: false, flagImportant: true };
                  list.push(entry);
                  store.set(roleKeys[command], list);
                  console.log(`Action: moved ${senderAddr} to ${command} list`);
                }
              }

              // Command processed — remove from tracking
              const idx = sentActions.findIndex((a) => a.verifyCode === code);
              if (idx >= 0) sentActions.splice(idx, 1);
              store.set("action_emails_sent", sentActions);
            }
          }

          // Valid code = safe to auto-delete (outgoing or reply, doesn't matter)
          toDelete.push(msg.uid);
        }

        // Batch delete all action emails with valid codes
        if (toDelete.length > 0) {
          try {
            await client.messageDelete(toDelete.map(String), { uid: true });
            console.log(`Action cleanup: deleted ${toDelete.length} action email(s)`);
          } catch (e) {
            for (const uid of toDelete) {
              try { await client.messageDelete(String(uid), { uid: true }); } catch (e2) {}
            }
          }
        }
      } finally { lock.release(); }
    } finally { try { await client.logout(); } catch (e) {} }
  } catch (e) { console.error("Action reply processing failed:", e.message); }
}

async function sendAlert(message) {
  const useSms = !!store.get("sms_to");
  const useEmail = !!store.get("alert_email_to");

  if (useSms) {
    try { await sendSMS(message); } catch (e) {}
  }
  if (useEmail) {
    try { await sendEmailAlert(message); } catch (e) {}
  }
}

async function checkActiveConversations(newMsgs) {
  // Check if enabled
  if (store.get("convo_alert_enabled") === false) return [];

  const minReplies = store.get("convo_min_replies") || 2;
  const lookbackMonths = store.get("convo_lookback_months") || 6;

  const client = await createFreshImapClient();
  const alerts = [];

  try {
  // Find the Sent folder
  const tree = await client.listTree();
  let sentPath = null;
  function findSent(node) {
    if (node.specialUse === "\\Sent" || /^sent/i.test(node.name)) { sentPath = node.path; return; }
    if (node.folders) node.folders.forEach(findSent);
  }
  findSent(tree);
  if (!sentPath) return alerts;

  const lookbackDate = new Date();
  lookbackDate.setMonth(lookbackDate.getMonth() - lookbackMonths);

  const lock = await client.getMailboxLock(sentPath);
  try {
    for (const msg of newMsgs) {
      const senderAddr = (msg.from?.address || "").toLowerCase();
      if (!senderAddr) continue;

      // Skip if sender is on blocked or greylist (spam shouldn't trigger conversations)
      const senderStatus = _senderListStatus(msg.from?.address, msg.from?.name);
      if (senderStatus === "blacklist" || senderStatus === "greylist") continue;

      // Normalize subject
      const baseSubject = (msg.subject || "")
        .replace(/^(re|fwd|fw)\s*:\s*/gi, "")
        .replace(/^(re|fwd|fw)\s*:\s*/gi, "")
        .trim();

      if (!baseSubject || baseSubject.length < 5) continue; // too short = too many false matches

      // Search Sent folder for replies TO THIS SPECIFIC SENDER (not just subject match)
      try {
        const sentUids = await client.search({
          to: senderAddr,
          subject: baseSubject,
          since: lookbackDate,
        }, { uid: true });

        if (sentUids.length >= minReplies) {
          alerts.push({
            uid: msg.uid,
            subject: msg.subject,
            from: msg.from?.name || msg.from?.address || "Unknown",
            replyCount: sentUids.length,
          });
        }
      } catch (e) {
        // If combined search fails, try just TO address (some servers don't support both)
        try {
          const sentUids2 = await client.search({
            to: senderAddr,
            since: lookbackDate,
          }, { uid: true });

          // Only alert if we've sent multiple emails to this person
          if (sentUids2.length >= minReplies) {
            alerts.push({
              uid: msg.uid,
              subject: msg.subject,
              from: msg.from?.name || msg.from?.address || "Unknown",
              replyCount: sentUids2.length,
            });
          }
        } catch (e2) {}
      }
    }
  } finally {
    lock.release();
  }
  } finally {
    try { await client.logout(); } catch (e) {}
  }

  return alerts;
}

function _formatEmailForSms(msg, format) {
  const from = msg.from?.name || msg.from?.address || "Unknown";
  const subject = msg.subject || "(no subject)";
  switch (format) {
    case "subject_only": return subject;
    case "full_preview": return `${from}: ${subject}`;
    case "sender_subject":
    default: return `${from} — ${subject}`;
  }
}

// Extract online meeting links from email text
function _extractMeetingLink(text) {
  if (!text) return "";
  const patterns = [
    /https?:\/\/[\w.-]*zoom\.us\/j\/[\w?=&%-]+/i,
    /https?:\/\/teams\.microsoft\.com\/l\/meetup-join\/[\w?=&%/+-]+/i,
    /https?:\/\/meet\.google\.com\/[\w-]+/i,
    /https?:\/\/[\w.-]*webex\.com\/[\w./%-]+/i,
    /https?:\/\/[\w.-]*gotomeet(?:ing)?\.com\/[\w/%-]+/i,
    /https?:\/\/[\w.-]*whereby\.com\/[\w/%-]+/i,
    /https?:\/\/[\w.-]*bluejeans\.com\/[\w/%-]+/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[0];
  }
  return "";
}

// ── Voice Profile (Learn Voice) ─────────────────────────────────────────
async function learnVoice() {
  // Sample sent emails to build a writing style profile
  const existing = store.get("voice_profile");
  const lastLearn = store.get("voice_profile_date");
  // Refresh weekly at most
  if (existing && lastLearn && (Date.now() - new Date(lastLearn).getTime()) < 7 * 86400000) return existing;

  if (!store.get("anthropic_api_key")) return existing || "";

  try {
    const client = await createFreshImapClient();
    try {
      const tree = await client.listTree();
      let sentPath = null;
      function findSent(node) { if (node.specialUse === "\\Sent" || /^sent/i.test(node.name)) sentPath = node.path; if (node.folders) node.folders.forEach(findSent); }
      findSent(tree);
      if (!sentPath) return existing || "";

      const lock = await client.getMailboxLock(sentPath);
      try {
        // Get the 20 most recent sent emails
        const uids = await client.search({ since: new Date(Date.now() - 30 * 86400000) }, { uid: true });
        if (!uids.length) return existing || "";

        const samples = [];
        const sampleUids = uids.slice(-20);
        for await (const msg of client.fetch({ uid: sampleUids }, { source: true })) {
          try {
            const parsed = await simpleParser(msg.source);
            const text = (parsed.text || "").substring(0, 500);
            if (text.length > 30) samples.push(text);
          } catch (e) {}
          if (samples.length >= 15) break;
        }

        if (samples.length < 3) return existing || "";

        // AI analyzes writing style
        const aiClient = getAnthropicClient();
        const resp = await aiClient.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 300,
          system: `Analyze these email samples and describe the writer's style in 3-4 sentences. Focus on: tone (formal/casual/friendly), typical greeting/sign-off, sentence length, vocabulary level, any distinctive patterns. This will be used to ghost-write emails in their voice.`,
          messages: [{ role: "user", content: samples.map((s, i) => `Sample ${i + 1}:\n${s}`).join("\n\n") }],
        });

        const profile = (resp.content[0]?.text || "").trim();
        if (profile) {
          store.set("voice_profile", profile);
          store.set("voice_profile_date", new Date().toISOString());
          console.log("Voice profile updated:", profile.substring(0, 80));
          return profile;
        }
      } finally { lock.release(); }
    } finally { try { await client.logout(); } catch (e) {} }
  } catch (e) { console.error("Learn voice failed:", e.message); }
  return existing || "";
}

// ── Thread Summarization ────────────────────────────────────────────────
async function summarizeThread(msg) {
  // Fetch the full message and look for quoted/forwarded content to summarize
  try {
    const fullMsg = await fetchMessage(msg.uid);
    const content = fullMsg.text || fullMsg.html?.replace(/<[^>]+>/g, " ").substring(0, 4000) || "";

    // Only summarize if there's quoted content (indicates a thread)
    const hasThread = content.includes("On ") && content.includes("wrote:") ||
                      content.includes("From:") && content.includes("Sent:") ||
                      content.includes("-----Original Message-----") ||
                      content.includes(">" + " ");
    if (!hasThread && content.length < 500) return null;

    const aiClient = getAnthropicClient();
    const resp = await aiClient.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      system: `Summarize this email thread in 1-2 sentences. Focus on: what's being discussed, any decisions made, and what action is needed now. If it's a single email (no thread), summarize it in one sentence.`,
      messages: [{ role: "user", content: `From: ${msg.from?.name || msg.from?.address}\nSubject: ${msg.subject}\n\n${content}` }],
    });
    return (resp.content[0]?.text || "").trim() || null;
  } catch (e) { return null; }
}

// ── Auto-Unsubscribe ────────────────────────────────────────────────────
async function autoUnsubscribe(uid) {
  // Check for List-Unsubscribe header and act on it
  try {
    const client = await createFreshImapClient();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const raw = await client.download(uid.toString(), undefined, { uid: true });
        if (!raw || !raw.content) throw new Error("Download failed");
        const chunks = [];
        for await (const chunk of raw.content) chunks.push(chunk);
        const parsed = await simpleParser(Buffer.concat(chunks));

        const unsubHeader = parsed.headers?.get("list-unsubscribe") || "";
        const unsubPost = parsed.headers?.get("list-unsubscribe-post") || "";

        // Fallback: if no List-Unsubscribe header, scan body for unsubscribe links
        if (!unsubHeader) {
          const bodyHtml = parsed.html || "";
          const bodyText = parsed.text || "";
          // Look for unsubscribe links in HTML (most common pattern)
          const unsubLinkMatch = bodyHtml.match(/<a[^>]+href=["'](https?:\/\/[^"']+unsubscribe[^"']*|https?:\/\/[^"']*opt[_-]?out[^"']*|https?:\/\/[^"']*remove[^"']*|https?:\/\/[^"']*preferences[^"']*)['"]/i)
            || bodyText.match(/(https?:\/\/\S*unsubscribe\S*|https?:\/\/\S*opt[_-]?out\S*)/i);
          if (unsubLinkMatch) {
            const unsubUrl = unsubLinkMatch[1];
            try {
              const mod = unsubUrl.startsWith("https") ? require("https") : require("http");
              await new Promise((resolve) => {
                const urlParsed = new URL(unsubUrl);
                const req = mod.request({
                  hostname: urlParsed.hostname, port: urlParsed.port,
                  path: urlParsed.pathname + urlParsed.search,
                  method: "GET",
                  headers: { "User-Agent": "GideonMail/1.0" },
                }, (r) => { r.resume(); r.on("end", () => resolve(true)); });
                req.on("error", () => resolve(false));
                req.end();
              });
              console.log(`Auto-unsubscribe (body link): ${unsubUrl}`);
              return true;
            } catch (e) {}
          }
          return false;
        }

        // Try mailto: unsubscribe first (most reliable)
        const mailtoMatch = unsubHeader.match(/<mailto:([^>]+)>/i);
        if (mailtoMatch) {
          const mailto = mailtoMatch[1];
          const [addr, queryStr] = mailto.split("?");
          let subject = "unsubscribe";
          if (queryStr) {
            const params = new URLSearchParams(queryStr);
            subject = params.get("subject") || "unsubscribe";
          }
          const cfg = store.get("account");
          if (cfg) {
            const transport = nodemailer.createTransport({
              host: cfg.smtpHost, port: cfg.smtpPort || 587,
              secure: cfg.smtpSecure || false,
              auth: { user: cfg.username, pass: cfg.password },
              tls: { rejectUnauthorized: false },
            });
            await transport.sendMail({
              from: `${cfg.displayName || cfg.username} <${cfg.email || cfg.username}>`,
              to: addr, subject, text: "unsubscribe",
            });
            console.log(`Auto-unsubscribe (mailto): sent to ${addr}`);
            return true;
          }
        }

        // Try HTTP unsubscribe (one-click via POST if List-Unsubscribe-Post header present)
        const httpMatch = unsubHeader.match(/<(https?:\/\/[^>]+)>/i);
        if (httpMatch && unsubPost) {
          const url = httpMatch[1];
          try {
            const mod = url.startsWith("https") ? require("https") : require("http");
            await new Promise((resolve) => {
              const parsed = new URL(url);
              const postBody = "List-Unsubscribe=One-Click";
              const req = mod.request({
                hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search,
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(postBody) },
              }, (r) => { r.resume(); r.on("end", () => resolve(true)); });
              req.on("error", () => resolve(false));
              req.write(postBody); req.end();
            });
            console.log(`Auto-unsubscribe (HTTP POST): ${url}`);
            return true;
          } catch (e) {}
        }

        return false;
      } finally { lock.release(); }
    } finally { try { await client.logout(); } catch (e) {} }
  } catch (e) { console.error("Auto-unsubscribe failed:", e.message); return false; }
}

// ── Low Touch Autopilot ─────────────────────────────────────────────────
async function lowTouchEnsureFolders() {
  // Create AI category folders if they don't exist (only when Low Touch is on)
  const folders = ["Newsletters", "Receipts", "Notifications"];
  try {
    const client = await createFreshImapClient();
    try {
      const tree = await client.listTree();
      const existing = new Set();
      function walk(n) { if (n.path) existing.add(n.path); if (n.folders) n.folders.forEach(walk); }
      walk(tree);

      for (const f of folders) {
        if (!existing.has(f)) {
          try { await client.mailboxCreate(f); console.log(`Low Touch: created folder "${f}"`); } catch (e) {}
        }
      }
    } finally { try { await client.logout(); } catch (e) {} }
  } catch (e) { console.error("Low Touch folder setup failed:", e.message); }
}

let _lowTouchRunning = false;
async function lowTouchProcess(messages) {
  if (store.get("low_touch_enabled") !== true) return;
  if (!store.get("anthropic_api_key")) return;
  if (_lowTouchRunning) { console.log("Low Touch: already running, skipping"); return; }
  _lowTouchRunning = true;

  try {
  // Ensure category folders exist
  await lowTouchEnsureFolders();

  const sentUids = _getSmsSentUids();
  const processedKey = "low_touch_processed";
  const processed = new Set(store.get(processedKey) || []);

  const unread = messages.filter((m) => !m.seen && !processed.has(m.uid));
  if (!unread.length) return;

  // Only process unknown senders (listed senders handled by normal triage)
  const unknown = unread.filter((m) => !_senderListStatus(m.from?.address, m.from?.name));
  if (!unknown.length) return;

  const client = getAnthropicClient();
  const account = store.get("account") || {};
  const smsTo = store.get("sms_to");

  // Learn voice profile on first run (or refresh weekly)
  const voiceProfile = await learnVoice();

  for (const msg of unknown.slice(0, 10)) { // max 10 per cycle
    try {
      // Step 1: AI categorize
      const resp = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 150,
        system: `Categorize this email. Respond with ONLY valid JSON:
{"category": "personal|receipt|newsletter|action|meeting|deadline|spam|notification",
 "needsReply": true/false,
 "deadline": "YYYY-MM-DD or null",
 "summary": "one sentence summary"}

Categories:
- personal: from a real person, conversational
- receipt: purchase confirmation, invoice, payment
- newsletter: marketing, blog digest, mailing list
- action: requires a response or decision from the user
- meeting: about a scheduled event with date/time
- deadline: contains a due date or time-sensitive request
- spam: junk, scam, unsolicited
- notification: automated alert, social media, service update`,
        messages: [{ role: "user", content: `From: ${msg.from?.name || ""} <${msg.from?.address || ""}>\nSubject: ${msg.subject}\nDate: ${msg.date}` }],
      });

      let cat = {};
      try {
        cat = JSON.parse((resp.content[0]?.text || "").match(/\{[\s\S]*\}/)?.[0] || "{}");
      } catch (e) { continue; }

      const category = cat.category || "notification";
      console.log(`Low Touch: ${msg.from?.address} "${msg.subject}" → ${category}`);

      // Scan personal/action emails for incoming commitments
      if (category === "personal" || category === "action" || category === "meeting") {
        try {
          const fullMsgForCommit = await fetchMessage(msg.uid);
          const commitContent = fullMsgForCommit.text || fullMsgForCommit.html?.replace(/<[^>]+>/g, " ").substring(0, 1500) || "";
          if (commitContent.length > 30) scanIncomingCommitments(msg, commitContent).catch(() => {});
        } catch (e) {}
      }

      // Step 2: Act based on category
      if (category === "spam") {
        // Delete spam
        try { await deleteMessage(msg.uid); } catch (e) {}
        console.log(`Low Touch: deleted spam from ${msg.from?.address}`);

      } else if (category === "newsletter") {
        // Auto-unsubscribe if enabled, then move to Newsletters folder
        if (store.get("low_touch_auto_unsub") === true) {
          const unsub = await autoUnsubscribe(msg.uid);
          if (unsub) console.log(`Low Touch: auto-unsubscribed from ${msg.from?.address}`);
        }
        // Move to Newsletters folder
        try {
          const archiveClient = await createFreshImapClient();
          try {
            const lock = await archiveClient.getMailboxLock("INBOX");
            try {
              try { await archiveClient.messageMove(String(msg.uid), "Newsletters", { uid: true }); }
              catch (e) {
                try { await archiveClient.messageMove(String(msg.uid), "Archive", { uid: true }); }
                catch (e2) { await archiveClient.messageFlagsAdd(String(msg.uid), ["\\Seen"], { uid: true }); }
              }
            } finally { lock.release(); }
          } finally { try { await archiveClient.logout(); } catch (e) {} }
        } catch (e) {}
        console.log(`Low Touch: moved newsletter to folder from ${msg.from?.address}`);

      } else if (category === "receipt") {
        // Move to Receipts folder
        try {
          const rcptClient = await createFreshImapClient();
          try {
            const lock = await rcptClient.getMailboxLock("INBOX");
            try {
              try { await rcptClient.messageMove(String(msg.uid), "Receipts", { uid: true }); }
              catch (e) { await rcptClient.messageFlagsAdd(String(msg.uid), ["\\Seen"], { uid: true }); }
            } finally { lock.release(); }
          } finally { try { await rcptClient.logout(); } catch (e) {} }
        } catch (e) {}
        console.log(`Low Touch: filed receipt from ${msg.from?.address}`);

      } else if (category === "notification") {
        // Move to Notifications folder
        try {
          const notifClient = await createFreshImapClient();
          try {
            const lock = await notifClient.getMailboxLock("INBOX");
            try {
              try { await notifClient.messageMove(String(msg.uid), "Notifications", { uid: true }); }
              catch (e) { await notifClient.messageFlagsAdd(String(msg.uid), ["\\Seen"], { uid: true }); }
            } finally { lock.release(); }
          } finally { try { await notifClient.logout(); } catch (e) {} }
        } catch (e) {}

      } else if (category === "action" || cat.needsReply) {
        // AI drafts a reply in the user's learned voice
        try {
          const fullMsg = await fetchMessage(msg.uid);
          const content = fullMsg.text || fullMsg.html?.replace(/<[^>]+>/g, " ").substring(0, 2000) || "";

          // Scan for incoming commitments (promises they're making to us)
          scanIncomingCommitments(msg, content).catch(() => {});

          // Thread summary for context
          const threadSummary = await summarizeThread(msg);

          const voiceInstr = voiceProfile
            ? `\n\nIMPORTANT — Write in this person's voice:\n${voiceProfile}`
            : "";
          const threadCtx = threadSummary
            ? `\n\nThread summary: ${threadSummary}`
            : "";

          const draftResp = await client.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 300,
            system: `You are drafting a reply on behalf of ${account.displayName || "the user"} (${account.email || ""}).
Write a concise reply that sounds like them. Only output the reply body.${voiceInstr}`,
            messages: [{ role: "user", content: `Original from ${msg.from?.name || msg.from?.address}:\nSubject: ${msg.subject}${threadCtx}\n\n${content}\n\nDraft a reply.` }],
          });
          const draft = draftResp.content[0]?.text || "";

          if (draft) {
            // Send action email with the draft for phone approval
            await sendActionEmail(msg, `AI Draft Reply:\n\n${draft}`, [
              { label: "Send This Reply", command: `reply: ${draft}`, color: "#4ade80" },
              { label: "Decline", command: "decline", color: "#f06060" },
              { label: "Later", command: "later", color: "#ff9f43" },
              { label: "Ignore", command: "ignore", color: "#55555e" },
            ]);

            if (smsTo) {
              await sendAlert(`ACTION: ${msg.from?.name || msg.from?.address}: ${msg.subject}\nDraft reply sent to your email for approval`);
              _addSmsSentUid(msg.uid);
            }
          }
        } catch (e) { console.error("Low Touch draft failed:", e.message); }

      } else if (category === "meeting") {
        // Fetch body for meeting link extraction + proper calendar creation
        let meetBody = "";
        try {
          const fullMsg = await fetchMessage(msg.uid);
          meetBody = fullMsg.text || fullMsg.html?.replace(/<[^>]+>/g, " ").substring(0, 3000) || "";
        } catch (e) {}
        const meetLink = _extractMeetingLink(meetBody);

        if (googleAuth?.isConnected) {
          try { await autoCreateTask(msg, `Meeting: ${msg.subject}`, meetBody, meetLink); } catch (e) {}
        }
        let alertText = `MEETING: ${msg.from?.name || msg.from?.address}: ${msg.subject}`;
        if (meetLink) alertText += `\n🔗 ${meetLink}`;
        if (smsTo) {
          await sendAlert(alertText);
          _addSmsSentUid(msg.uid);
        }

      } else if (category === "deadline") {
        // SMS alert with deadline
        const deadline = cat.deadline || "soon";
        if (smsTo) {
          await sendAlert(`DEADLINE: ${msg.from?.name || msg.from?.address}: ${msg.subject} [DUE ${deadline}]`);
          _addSmsSentUid(msg.uid);
        }
      }

      // Track as processed
      processed.add(msg.uid);
    } catch (e) { console.error("Low Touch failed for UID", msg.uid, e.message); }
  }

  // Persist processed list (keep last 200)
  const arr = [...processed];
  if (arr.length > 200) arr.splice(0, arr.length - 200);
  store.set(processedKey, arr);

  // Follow-up nudge check (emails sent > N days ago with no reply)
  const nudgeDays = store.get("low_touch_nudge_days") || 5;
  try {
    const nudgeClient = await createFreshImapClient();
    try {
      // Find sent folder
      const tree = await nudgeClient.listTree();
      let sentPath = null;
      function findSent(node) { if (node.specialUse === "\\Sent" || /^sent/i.test(node.name)) sentPath = node.path; if (node.folders) node.folders.forEach(findSent); }
      findSent(tree);

      if (sentPath) {
        const lock = await nudgeClient.getMailboxLock(sentPath);
        try {
          const nudgeCutoff = new Date(Date.now() - nudgeDays * 86400000);
          const nudgeRecent = new Date(Date.now() - (nudgeDays + 2) * 86400000);

          // Search sent emails from the nudge window
          const sentUids = await nudgeClient.search({ since: nudgeRecent, before: nudgeCutoff }, { uid: true });
          if (sentUids.length) {
            const nudgedKey = "low_touch_nudged";
            const nudged = new Set(store.get(nudgedKey) || []);

            for await (const sent of nudgeClient.fetch({ uid: sentUids.slice(-10) }, { envelope: true })) {
              if (nudged.has(sent.uid)) continue;
              const toAddr = sent.envelope?.to?.[0]?.address;
              if (!toAddr) continue;

              // Check if they replied (search inbox for from:toAddr since we sent)
              try {
                const inboxClient = await createFreshImapClient();
                try {
                  const iLock = await inboxClient.getMailboxLock("INBOX");
                  try {
                    const replies = await inboxClient.search({ from: toAddr, since: nudgeCutoff }, { uid: true });
                    if (replies.length === 0 && !nudged.has(sent.uid)) {
                      // No reply — auto-send follow-up nudge if enabled
                      if (store.get("low_touch_auto_nudge") === true && voiceProfile) {
                        try {
                          const aiClient = getAnthropicClient();
                          const nudgeResp = await aiClient.messages.create({
                            model: "claude-haiku-4-5-20251001",
                            max_tokens: 200,
                            system: `Write a brief, polite follow-up email. The user sent an email ${nudgeDays} days ago and hasn't received a reply. Keep it short (2-3 sentences). Don't be pushy. Only output the email body.\n\nWrite in this person's voice:\n${voiceProfile}`,
                            messages: [{ role: "user", content: `Original subject: ${sent.envelope?.subject}\nSent to: ${toAddr}\nDays since sent: ${nudgeDays}` }],
                          });
                          const nudgeText = (nudgeResp.content[0]?.text || "").trim();
                          if (nudgeText) {
                            const originalSubject = sent.envelope?.subject || "";
                            const reSubject = originalSubject.startsWith("Re:") ? originalSubject : `Re: ${originalSubject}`;
                            await sendMail({ to: toAddr, subject: reSubject, text: nudgeText, html: nudgeText.replace(/\n/g, "<br>") });
                            console.log(`Low Touch: auto-nudge sent to ${toAddr} re: "${originalSubject}"`);
                            if (smsTo) await sendAlert(`NUDGE SENT: Follow-up to ${toAddr} re: "${originalSubject}"`);
                          }
                        } catch (e) { console.error("Auto-nudge draft failed:", e.message); }
                      } else if (smsTo) {
                        // Fallback: just alert
                        await sendAlert(`FOLLOW-UP: No reply from ${toAddr} to "${sent.envelope?.subject}" (${nudgeDays} days)`);
                      }
                      nudged.add(sent.uid);
                    }
                  } finally { iLock.release(); }
                } finally { try { await inboxClient.logout(); } catch (e) {} }
              } catch (e) {}
            }

            const nudgeArr = [...nudged];
            if (nudgeArr.length > 100) nudgeArr.splice(0, nudgeArr.length - 100);
            store.set(nudgedKey, nudgeArr);
          }
        } finally { lock.release(); }
      }
    } finally { try { await nudgeClient.logout(); } catch (e) {} }
  } catch (e) { console.error("Low Touch nudge check failed:", e.message); }
  } finally { _lowTouchRunning = false; }
}

// IPC handlers for Low Touch
ipcMain.handle("low-touch-get", () => ({
  enabled: store.get("low_touch_enabled") === true,
  nudgeDays: store.get("low_touch_nudge_days") || 5,
  autoUnsub: store.get("low_touch_auto_unsub") === true,
  autoNudge: store.get("low_touch_auto_nudge") === true,
  voiceProfile: store.get("voice_profile") || "",
}));

ipcMain.handle("low-touch-set", (_, cfg) => {
  if (cfg.enabled !== undefined) store.set("low_touch_enabled", cfg.enabled);
  if (cfg.nudgeDays !== undefined) store.set("low_touch_nudge_days", cfg.nudgeDays);
  if (cfg.autoUnsub !== undefined) store.set("low_touch_auto_unsub", cfg.autoUnsub);
  if (cfg.autoNudge !== undefined) store.set("low_touch_auto_nudge", cfg.autoNudge);
  return { ok: true };
});

ipcMain.handle("low-touch-learn-voice", async () => {
  try {
    store.delete("voice_profile_date"); // force refresh
    const profile = await learnVoice();
    return { ok: true, profile };
  } catch (e) { return { error: e.message }; }
});

// Reputation + Commitments IPC
ipcMain.handle("reputation-get", () => store.get("sender_reputation") || {});
ipcMain.handle("reputation-suggestions", () => checkReputationSuggestions());
ipcMain.handle("commitments-get", () => (store.get("tracked_commitments") || []).filter((c) => !c.fulfilled));
ipcMain.handle("commitments-fulfill", (_, id) => {
  const list = store.get("tracked_commitments") || [];
  const item = list.find((c) => c.id === id);
  if (item) item.fulfilled = true;
  store.set("tracked_commitments", list);
  return { ok: true };
});

async function autoTriageNewMail(messages) {
  // Use persistent tracking — survives app restarts
  const sentUids = _getSmsSentUids();
  const lookbackHours = store.get("sms_history_hours") || 4;
  const cutoff = new Date(Date.now() - lookbackHours * 3600000).toISOString();

  // Find unread messages that:
  // 1. We haven't already sent SMS for (persistent)
  // 2. Arrived within the lookback window
  const newMsgs = messages.filter((m) => {
    if (m.seen) return false;
    if (sentUids.has(m.uid)) return false;
    if (m.date && m.date < cutoff) return false; // too old
    return true;
  });
  if (!newMsgs.length) { _setLastCheckTime(); return; }

  // Debounce: wait 30 seconds before sending to avoid duplicate sends
  // on rapid open/close cycles
  const lastCheck = _getLastCheckTime();
  if (lastCheck) {
    const sinceLast = Date.now() - new Date(lastCheck).getTime();
    if (sinceLast < 30000) { return; } // checked less than 30s ago, skip
  }

  // Filter out greylisted, daily update, and blacklisted senders from SMS triggers
  const _greylist = (store.get("sms_greylist") || []).filter((g) => g.enabled);
  const _blacklist = (store.get("sms_blacklist") || []).filter((b) => b.enabled);
  const _dailyUpdate = (store.get("daily_update_list") || []).filter((d) => d.enabled);
  const _matchesList = (msg, list) => list.some((w) => {
    const addr = (msg.from?.address || "").toLowerCase();
    const name = (msg.from?.name || "").toLowerCase();
    return w.address && (addr === w.address || addr.includes(w.address) || name.includes(w.address));
  });
  const smsEligible = newMsgs.filter((m) => !_matchesList(m, _greylist) && !_matchesList(m, _blacklist) && !_matchesList(m, _dailyUpdate));

  // Run blacklist cleanup (delete emails > 1 week old from blacklisted senders)
  cleanupBlacklistedEmails().catch((e) => console.error("Blacklist cleanup:", e.message));
  processActionReplies().catch((e) => console.error("Action replies:", e.message));

  // ── Basic spam heuristic (always runs, no API needed) ──────────────────
  // Remove obvious spam from smsEligible before any processing
  const spamPatterns = [
    /\b(bitcoin|btc|crypto|wallet|ransom)\b/i,
    /\b(recorded you|i recorded|webcam|pervert)\b/i,
    /\b(lottery|winner|million dollars|inheritance)\b/i,
    /\b(viagra|cialis|pharmacy|pills)\b/i,
    /\b(nigerian|prince|beneficiary|unclaimed)\b/i,
    /\b(click here|act now|limited time|urgent action)\b.*\b(account|verify|password)\b/i,
  ];
  for (let i = smsEligible.length - 1; i >= 0; i--) {
    const m = smsEligible[i];
    if (_isSpamImmune(m.from?.address, m.from?.name)) continue;
    const text = `${m.subject || ""} ${m.from?.name || ""}`;
    if (spamPatterns.some((p) => p.test(text))) {
      console.log(`Spam heuristic: removed "${m.subject}" from ${m.from?.address}`);
      smsEligible.splice(i, 1);
    }
  }

  // ── Run spam filters on unknown senders BEFORE AI gets a look ─────────
  // Trusted senders (VIP, Watch, Muted) skip this. Only unknown + blocked.
  const filters = store.get("security_filters") || {};
  if (filters.spamassassin) {
    const unknownMsgs = smsEligible.filter((m) => !_isSpamImmune(m.from?.address, m.from?.name));
    if (unknownMsgs.length > 0) {
      try {
        const spamClient = await createFreshImapClient();
        try {
          const lock = await spamClient.getMailboxLock("INBOX");
          try {
            const spamUids = [];
            // Fetch headers for unknown sender emails to check SpamAssassin score
            for await (const msg of spamClient.fetch({ uid: unknownMsgs.map((m) => m.uid) }, { headers: true })) {
              const hdrs = msg.headers?.toString() || "";
              const scoreMatch = hdrs.match(/X-Spam-Status:.*?score=([0-9.-]+)/i) || hdrs.match(/X-Spam-Score:\s*([0-9.-]+)/i);
              if (scoreMatch) {
                const score = parseFloat(scoreMatch[1]);
                if (score >= 5) {
                  spamUids.push(msg.uid);
                }
              }
            }

            if (spamUids.length > 0) {
              console.log(`SpamAssassin: flagged ${spamUids.length} emails (score >= 5)`);
              const spamSet = new Set(spamUids);
              for (let i = smsEligible.length - 1; i >= 0; i--) {
                if (spamSet.has(smsEligible[i].uid)) smsEligible.splice(i, 1);
              }
            }
          } finally { lock.release(); }
        } finally { try { await spamClient.logout(); } catch (e) {} }
      } catch (e) { console.error("SpamAssassin pre-filter failed:", e.message); }
    }
  }

  // ── AI Watch List (smart senders: AI analyze + actions) ────────────────
  const watchlist = (store.get("ai_watchlist") || []).filter((w) => w.enabled);
  if (watchlist.length > 0 && store.get("anthropic_api_key")) {
    for (const msg of smsEligible) {
      const fromAddr = (msg.from?.address || "").toLowerCase();
      const fromName = (msg.from?.name || "").toLowerCase();
      const match = watchlist.find((w) => w.address && (fromAddr === w.address || fromAddr.includes(w.address) || fromName.includes(w.address)));
      if (!match) continue;

      try {
        // AI Analysis
        if (match.actions?.aiAnalyze) {
          const fullMsg = await fetchMessage(msg.uid);
          const analysis = await aiAnalyzeEmail(fullMsg);

          // SMS alert with AI summary
          if (match.actions?.smsAlert && smsTo) {
            await sendAlert(`WATCH [${match.name || match.address}]: ${analysis.substring(0, 120)}`);
            _addSmsSentUid(msg.uid);
          }

          // Auto-calendar
          if (match.actions?.autoCalendar && googleAuth?.isConnected) {
            try {
              const extracted = await new Promise((resolve) => {
                ipcMain.emit("ai-extract-event", null, fullMsg);
                // Use the extract function directly
                resolve(null);
              });
              // Direct extraction
              const client = getAnthropicClient();
              const content = fullMsg.text || fullMsg.html?.replace(/<[^>]+>/g, " ").substring(0, 3000) || "";
              const today = new Date().toISOString().split("T")[0];
              const resp = await client.messages.create({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 512,
                system: `Extract calendar event details from this email. Today is ${today}. Return ONLY valid JSON: {"title":"","date":"YYYY-MM-DD","startTime":"HH:MM","endTime":"HH:MM","location":"","description":"","attendees":[],"meetingLink":""}. If no date, use tomorrow. If no time, use 09:00-10:00. For meetingLink: extract any Zoom/Teams/Meet/Webex URL. If only a meeting ID is given (e.g. "Zoom ID: 123 456 7890"), construct the full URL (e.g. "https://zoom.us/j/12345678900"). Include passcode if present.`,
                messages: [{ role: "user", content: `From: ${fullMsg.from?.name || ""} <${fullMsg.from?.address || ""}>\nSubject: ${fullMsg.subject}\n\n${content}` }],
              });
              const jsonMatch = (resp.content[0]?.text || "").match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                const event = JSON.parse(jsonMatch[0]);
                // Also try regex extraction
                if (!event.meetingLink) event.meetingLink = _extractMeetingLink(content);
                const token = await googleAuth.getToken();
                const calId = store.get("google_calendar_id") || "primary";
                const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
                // Auto-calendar never invites attendees — only manual Task with approval does
                let eventDesc = event.description || "";
                if (event.meetingLink) eventDesc += `\n\nJoin meeting: ${event.meetingLink}`;
                eventDesc += "\nAuto-created by GideonMail";
                const eventLoc = event.location || event.meetingLink || "";
                const body = JSON.stringify({
                  summary: event.title, description: eventDesc, location: eventLoc,
                  start: { dateTime: `${event.date}T${event.startTime || "09:00"}:00`, timeZone: timezone },
                  end: { dateTime: `${event.date}T${event.endTime || "10:00"}:00`, timeZone: timezone },
                });
                const https = require("https");
                await new Promise((resolve) => {
                  const req = https.request({
                    hostname: "www.googleapis.com",
                    path: `/calendar/v3/calendars/${encodeURIComponent(calId)}/events`,
                    method: "POST",
                    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
                  }, (res) => { let d = ""; res.on("data", (c) => { d += c; }); res.on("end", () => resolve(d)); });
                  req.on("error", () => resolve(null));
                  req.write(body); req.end();
                });
                console.log(`Watchlist: auto-created calendar event for ${msg.from?.address}: ${event.title}`);
                // Windows notification for auto-created event
                try {
                  const { Notification: WinNotif2 } = require("electron");
                  if (WinNotif2.isSupported()) {
                    const n = new WinNotif2({
                      title: "Calendar Event Added",
                      body: `${event.title}\n${event.date} ${event.startTime || ""}–${event.endTime || ""}`,
                      silent: false,
                      icon: path.join(__dirname, "assets", "icon.png"),
                    });
                    n.show();
                    n.on("click", () => {
                      if (!mainWindow || mainWindow.isDestroyed()) createWindow();
                      mainWindow.show();
                      mainWindow.focus();
                    });
                  }
                } catch (notifErr) { console.error("Calendar notification failed:", notifErr.message); }
              }
            } catch (e) { console.error("Watchlist auto-calendar failed:", e.message); }
          }

          // Flag important
          if (match.actions?.flagImportant) {
            try { await toggleFlag(msg.uid, "flagged"); } catch (e) {}
          }

          // Auto-task: schedule a calendar slot to review this email
          if (match.actions?.autoTask) {
            await autoCreateTask(msg);
          }

          // Deadline detection: include in SMS if found
          const deadline = await detectDeadline(msg);
          if (deadline && match.actions?.smsAlert) {
            try { await sendAlert(`DEADLINE [${match.name || match.address}]: ${msg.subject} — due ${deadline}`); } catch (e) {}
          }
        }
      } catch (e) { console.error("Watchlist processing failed:", e.message); }
    }
  }

  // ── Whitelist check (always SMS for these senders) ─────────────────────
  const smsTo = store.get("sms_to");
  if (smsTo) {
    const whitelist = (store.get("sms_whitelist") || []).filter((w) => w.enabled);
    if (whitelist.length > 0) {
      const whitelistAlerts = [];
      for (const msg of smsEligible) {
        const fromAddr = (msg.from?.address || "").toLowerCase();
        const fromName = (msg.from?.name || "").toLowerCase();
        for (const w of whitelist) {
          if (w.address && (fromAddr === w.address || fromAddr.includes(w.address) || fromName.includes(w.address))) {
            whitelistAlerts.push(msg);
            break;
          }
        }
      }
      if (whitelistAlerts.length > 0) {
        const s = _getSmsSettings();
        const detectMeetings = store.get("vip_detect_meetings") !== false;

        for (const m of whitelistAlerts) {
          let smsText = `VIP: ${_formatEmailForSms(m, s.format)}`;
          let isMeeting = false;

          // DKIM/DMARC/SPF check — warn if VIP sender fails authentication
          try {
            const freshAuth = await createFreshImapClient();
            try {
              const lock = await freshAuth.getMailboxLock("INBOX");
              try {
                const raw = await freshAuth.download(m.uid.toString(), undefined, { uid: true });
                if (raw?.content) {
                  const chunks = []; for await (const c of raw.content) chunks.push(c);
                  const parsed = await simpleParser(Buffer.concat(chunks));
                  const hdrs = parsed.headers ? Object.fromEntries(parsed.headers) : {};
                  const auth = security.checkAuthentication(hdrs);
                  if (auth.spoofRisk) {
                    smsText = `⚠ SPOOF WARNING: ${m.from?.address} failed DKIM/SPF/DMARC — may be impersonating a VIP\n${smsText}`;
                    console.warn(`VIP SPOOF RISK: ${m.from?.address} — ${auth.details}`);
                  }
                }
              } finally { lock.release(); }
            } finally { try { await freshAuth.logout(); } catch (e) {} }
          } catch (e) { /* auth check failed, proceed with caution */ }

          // Deadline detection for VIP emails
          if (store.get("anthropic_api_key")) {
            const deadline = await detectDeadline(m);
            if (deadline) smsText += ` [DUE ${deadline}]`;
          }

          // Meeting detection + location/link extraction for VIP emails (one AI call)
          // Fetch the email body so AI can detect meetings mentioned in body, not just subject
          let meetingLocation = "";
          let meetingLink = "";
          let emailBodyText = "";
          if (detectMeetings && store.get("anthropic_api_key")) {
            try {
              const freshClient = await createFreshImapClient();
              try {
                const lock = await freshClient.getMailboxLock("INBOX");
                try {
                  const raw = await freshClient.download(m.uid.toString(), undefined, { uid: true });
                  if (!raw || !raw.content) throw new Error("Download failed");
                  const chunks = [];
                  for await (const chunk of raw.content) chunks.push(chunk);
                  const parsed = await simpleParser(Buffer.concat(chunks));
                  emailBodyText = (parsed.text || parsed.html?.replace(/<[^>]+>/g, " ") || "").substring(0, 2000);
                  // Extract ICS calendar attachments
                  for (const att of (parsed.attachments || [])) {
                    if (att.contentType === "text/calendar" || (att.filename || "").toLowerCase().endsWith(".ics")) {
                      try { emailBodyText += "\n\n[Calendar Invite]\n" + att.content.toString("utf-8").substring(0, 1500); } catch (e) {}
                    }
                  }
                } finally { lock.release(); }
              } finally { try { await freshClient.logout(); } catch (e) {} }
            } catch (e) { console.error("VIP body fetch:", e.message); }

            // Extract online meeting link via regex (more reliable than AI for URLs)
            meetingLink = _extractMeetingLink(emailBodyText);

            try {
              const client = getAnthropicClient();
              const emailContent = emailBodyText || m.subject;
              const resp = await client.messages.create({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 100,
                system: `Analyze this email. Respond with ONLY valid JSON:
{"meeting": true/false, "location": "full address or venue name or empty string"}
A meeting is any scheduled event, appointment, call, interview, or gathering with a specific date/time.
Online meetings (Zoom, Teams, Meet, etc.) count as meetings.
For location: extract the full street address if available. If only a venue name, include it. If it's an online meeting, use the platform name (e.g. "Zoom", "Microsoft Teams"). If no location mentioned, use empty string.`,
                messages: [{ role: "user", content: `From: ${m.from?.name || m.from?.address}\nSubject: ${m.subject}\n\n${emailContent}` }],
              });
              const meetingText = (resp.content[0]?.text || "").trim();
              try {
                const parsed = JSON.parse(meetingText.match(/\{[\s\S]*\}/)?.[0] || "{}");
                isMeeting = !!parsed.meeting;
                meetingLocation = parsed.location || "";
              } catch (e) {
                isMeeting = meetingText.toUpperCase().includes("TRUE");
              }
              console.log(`VIP meeting detect: "${m.subject}" => isMeeting=${isMeeting}, location="${meetingLocation}"`);
            } catch (e) { console.error("VIP meeting AI:", e.message); }
          }

          // VIP auto-calendar: create event immediately, no prompt
          // Default to true when meeting detection is on (user expects it to work)
          const vipAutoCalendar = store.get("vip_auto_calendar") !== false;
          const vipAiReview = store.get("vip_ai_review") === true;

          // AI review for VIP emails
          if (vipAiReview && store.get("anthropic_api_key")) {
            try {
              const fullMsg = await fetchMessage(m.uid);
              const analysis = await aiAnalyzeEmail(fullMsg);
              smsText += `\nAI: ${analysis.substring(0, 80)}`;
            } catch (e) {}
          }

          if (isMeeting && vipAutoCalendar && googleAuth?.isConnected) {
            // Auto-create or reschedule calendar event
            try {
              const result = await autoCreateTask(m, `Meeting: ${m.subject}`, emailBodyText, meetingLink);
              const fromName = m.from?.name || m.from?.address;

              // Build detailed SMS with all meeting info
              const startStr = result?.start ? result.start.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
              const endStr = result?.end ? result.end.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
              const loc = result?.location || meetingLocation || "";

              if (result?.rescheduled && result.oldEvent) {
                const oldStart = new Date(result.oldEvent.start).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
                smsText = `MEETING RESCHEDULED: ${fromName}\n${result.title || m.subject}\n${oldStart} → ${startStr}`;
                if (result.oldEvent.location && result.oldEvent.location !== loc) smsText += `\nWas: ${result.oldEvent.location}`;
              } else if (result?.rescheduled) {
                smsText = `MEETING RESCHEDULED: ${fromName}: ${result.title || m.subject}\n📅 ${startStr}–${endStr}`;
              } else {
                smsText = `MEETING ADDED: ${fromName}: ${result?.title || m.subject}\n📅 ${startStr}–${endStr}`;
              }
              if (loc) smsText += `\n📍 ${loc}`;
              if (result?.meetingLink || meetingLink) smsText += `\n🔗 ${result?.meetingLink || meetingLink}`;

              try {
                const { Notification: WinNotifAuto } = require("electron");
                if (WinNotifAuto.isSupported()) {
                  const notifTitle = result?.rescheduled ? "Meeting Rescheduled on Calendar" : "Meeting Auto-Added to Calendar";
                  const n = new WinNotifAuto({ title: notifTitle, body: `${fromName}: ${m.subject}`, silent: false });
                  n.show();
                  n.on("click", () => { mainWindow?.show(); mainWindow?.focus(); });
                }
              } catch (e) {}
            } catch (e) { console.error("VIP auto-calendar failed:", e.message); }
          } else if (isMeeting) {
            smsText = `MEETING from ${m.from?.name || m.from?.address}: ${m.subject}`;
            if (meetingLocation) smsText += `\n📍 ${meetingLocation}`;
            if (meetingLink) smsText += `\n🔗 ${meetingLink}`;
            // Queue as pending appointment
            const pending = store.get("pending_appointments") || [];
            pending.push({ uid: m.uid, subject: m.subject, from: m.from, date: m.date, created: new Date().toISOString() });
            if (pending.length > 20) pending.splice(0, pending.length - 20);
            store.set("pending_appointments", pending);
            // Notify the renderer
            mainWindow?.webContents?.send("pending-appointment", { uid: m.uid, subject: m.subject, from: m.from });

            // Windows notification for pending meeting
            try {
              const { Notification: WinNotif } = require("electron");
              if (WinNotif.isSupported()) {
                const meetingUid = m.uid;
                const n = new WinNotif({
                  title: "Meeting Waiting for Calendar",
                  body: `${m.from?.name || m.from?.address}: ${m.subject}\nClick to review and add to calendar`,
                  silent: false,
                  icon: path.join(__dirname, "assets", "icon.png"),
                });
                n.show();
                n.on("click", () => {
                  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
                  mainWindow.show();
                  mainWindow.focus();
                  mainWindow.webContents.send("open-meeting-task", { uid: meetingUid, subject: m.subject, from: m.from });
                });
              }
            } catch (notifErr) { console.error("Meeting notification failed:", notifErr.message); }
          }

          try {
            await sendAlert(smsText);
            _addSmsSentUid(m.uid);
            // Send detailed action email for phone-based reply
            const actionButtons = isMeeting ? [
              { label: "Accept & Reply", command: "approve", color: "#4ade80" },
              { label: "Decline", command: "decline", color: "#f06060" },
              { label: "Reschedule", command: "reply: Can we reschedule? Let me check my calendar and get back to you.", color: "#ff9f43" },
              { label: "Reply", command: "reply", color: "#7c6cff" },
              { label: "Ignore", command: "ignore", color: "#55555e" },
            ] : [
              { label: "Reply", command: "reply", color: "#7c6cff" },
              { label: "Approve", command: "approve", color: "#4ade80" },
              { label: "Decline", command: "decline", color: "#f06060" },
              { label: "Later", command: "later", color: "#ff9f43" },
              { label: "Ignore", command: "ignore", color: "#55555e" },
            ];
            await sendActionEmail(m, smsText, actionButtons);
          } catch (e) { console.error("VIP alert failed:", e.message); }
        }
      }
    }
  }

  // ── Check for active conversations (only SMS-eligible senders, skip already-alerted) ──
  if (smsTo) {
    try {
      const alreadyAlerted = _getSmsSentUids();
      const convoEligible = smsEligible.filter((m) => !alreadyAlerted.has(m.uid));
      const conversationAlerts = await checkActiveConversations(convoEligible);
      if (conversationAlerts.length > 0) {
        const summary = conversationAlerts.map((a) =>
          `${a.from}: ${a.subject} (you replied ${a.replyCount}x)`
        ).join("\n");
        await sendAlert(`GideonMail: ${conversationAlerts.length} email${conversationAlerts.length > 1 ? "s" : ""} in active conversations:\n${summary}`);
        conversationAlerts.forEach((a) => _addSmsSentUid(a.uid));
      }
    } catch (e) {
      console.error("Conversation check failed:", e.message);
    }
  }

  // ── AI triage for importance ──────────────────────────────────────────
  // DISABLED BY DEFAULT — opt-in via Rules → Security → "AI urgency triage for unknown senders"
  // When enabled, only texts for emails the AI thinks are truly urgent.
  // Without this, ONLY VIP, Watch, and Conversation alerts send SMS.
  const aiTriageEnabled = store.get("ai_urgency_triage_enabled") === true;
  const apiKey = store.get("anthropic_api_key");
  if (!aiTriageEnabled || !apiKey || !smsTo) { _setLastCheckTime(); return; }

  const alreadySentUids = _getSmsSentUids();
  const untriaged = smsEligible.filter((m) => !alreadySentUids.has(m.uid));
  if (!untriaged.length) { _setLastCheckTime(); return; }

  try {
    const client = getAnthropicClient();
    const account = store.get("account") || {};

    const emailList = untriaged.slice(0, 5).map((m) => {
      return `From: ${m.from?.name || m.from?.address || "Unknown"}\nSubject: ${m.subject}\nDate: ${m.date}`;
    }).join("\n---\n");

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system: `You are an extremely selective email importance filter for ${account.displayName || "the user"}.
For each email, respond with ONLY "URGENT" or "SKIP" followed by a 5-word reason.

URGENT means ALL of these must be true:
- From a real human being (not automated, not marketing, not a newsletter, not a notification system)
- Requires the user's personal action within hours
- Contains a specific request, question, or time-sensitive matter

SKIP means ANY of these:
- Marketing, newsletter, promotion, or advertisement
- Automated notification (cron, server alert, social media, shipping update)
- Spam or unsolicited
- Informational only (no action needed)
- Can wait more than 24 hours

Default to SKIP. When in doubt, SKIP. Only 1 in 20 emails should be URGENT.${getInstructionsBlock()}`,
      messages: [{ role: "user", content: emailList }],
    });

    const triageText = response.content[0]?.text || "";
    const urgentLines = triageText.split("\n").filter((l) => l.toUpperCase().startsWith("URGENT"));

    if (urgentLines.length > 0) {
      const urgentSummary = untriaged.slice(0, urgentLines.length).map((m, i) => {
        return `${m.from?.name || m.from?.address}: ${m.subject}`;
      }).join("\n");

      await sendAlert(`GideonMail: ${urgentLines.length} urgent email${urgentLines.length > 1 ? "s" : ""}:\n${urgentSummary}`);
      untriaged.slice(0, urgentLines.length).forEach((m) => _addSmsSentUid(m.uid));
    }
  } catch (e) {
    console.error("AI auto-triage failed:", e.message);
  }

  // Mark check time
  _setLastCheckTime();
}

// ── Security filters ────────────────────────────────────────────────────
async function runSecurityFilters(messages) {
  const filters = store.get("security_filters") || { spamassassin: true, spamhaus: false, virustotal: false, safebrowsing: false, phishtank: false, abuseipdb: false };
  const results = {};

  for (const m of messages) {
    const key = m.uid;
    results[key] = { score: 0, flags: [] };

    // SpamAssassin: check X-Spam headers (already in email headers from ISPConfig)
    if (filters.spamassassin && m._spamScore !== undefined) {
      if (m._spamScore >= 5) {
        results[key].score += m._spamScore;
        results[key].flags.push(`SpamAssassin: ${m._spamScore}`);
      }
    }
  }

  return results;
}

async function startIdle() {
  if (idleActive) return;
  const cfg = store.get("account");
  if (!cfg) return;

  try {
    const client = await getImapClient();
    idleActive = true;

    // On startup: fetch inbox and check for emails that arrived while app was closed
    try {
      const initial = await fetchInbox(0, 50);
      mainWindow?.webContents?.send("inbox-updated", initial);
      await autoTriageNewMail(initial.messages || []);
      await lowTouchProcess(initial.messages || []);
    } catch (e) {}

    // Fast VIP check every 5 minutes — just checks for new VIP/Watch emails
    // Lightweight: no AI triage, no security scan, just list matching + SMS
    const fastInterval = setInterval(async () => {
      try {
        const result = await fetchInbox(0, 50);
        mainWindow?.webContents?.send("inbox-updated", result);
        // Quick VIP/Watch check only (no full triage)
        const msgs = result.messages || [];
        const sentUids = _getSmsSentUids();
        const newUnread = msgs.filter((m) => !m.seen && !sentUids.has(m.uid));
        if (newUnread.length > 0) {
          await autoTriageNewMail(msgs);
        }
      } catch (e) {}
    }, 300000); // 5 minutes

    // Full auto-check on configurable interval (default 120 min / 2 hours)
    // Includes: AI triage, security scanning, blacklist cleanup, action reply processing
    const checkMin = store.get("auto_check_interval_min") || 120;
    console.log(`Auto-check interval: ${checkMin} minutes, fast VIP check: 5 minutes`);
    const interval = setInterval(async () => {
      try {
        const result = await fetchInbox(0, 50);
        mainWindow?.webContents?.send("inbox-updated", result);
        await autoTriageNewMail(result.messages || []);
        await lowTouchProcess(result.messages || []);
      } catch (e) {
        // reconnect on next cycle
      }
    }, checkMin * 60000);

    app.on("before-quit", () => { clearInterval(interval); clearInterval(fastInterval); });
  } catch (e) {
    idleActive = false;
  }
}

// ── IPC Handlers ────────────────────────────────────────────────────────────
ipcMain.handle("get-account", () => {
  const cfg = store.get("account");
  if (!cfg) return null;
  // Don't send password to renderer
  return { ...cfg, password: cfg.password ? "••••••••" : "" };
});

ipcMain.handle("save-account", async (_, cfg) => {
  // Merge with existing — never overwrite with empty values
  const existing = store.get("account") || {};
  const merged = { ...existing };
  for (const [k, v] of Object.entries(cfg)) {
    if (v === "••••••••") continue; // masked password, keep old
    if (v === "" || v === undefined || v === null) continue; // empty, keep old
    merged[k] = v;
  }
  // Preserve booleans (checkboxes can be false legitimately)
  if (cfg.imapSecure !== undefined) merged.imapSecure = cfg.imapSecure;
  if (cfg.smtpSecure !== undefined) merged.smtpSecure = cfg.smtpSecure;
  store.set("account", merged);

  // Disconnect old client
  if (imapClient) {
    try { await imapClient.logout(); } catch (e) {}
    imapClient = null;
  }

  return { ok: true };
});

ipcMain.handle("test-connection", async () => {
  try {
    const client = await getImapClient();
    return { ok: true, message: `Connected to ${client.host}` };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle("fetch-inbox", async (_, page) => {
  try {
    const result = await fetchInbox(page || 0);
    // Cache messages for reputation tracking on delete
    if (result.messages) store.set("_last_inbox_messages", result.messages.map((m) => ({ uid: m.uid, from: m.from })));
    return result;
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle("fetch-message", async (_, uid, folder) => {
  try {
    const msg = await fetchMessage(uid, folder);
    // Track sender reputation: opened
    _trackSenderAction(msg.from?.address, "opened");
    return msg;
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle("fetch-attachment", async (_, uid, filename) => {
  try {
    return await fetchAttachment(uid, filename);
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle("send-mail", async (_, opts) => {
  try {
    await sendMail(opts);
    // Track sender reputation: replied (the "to" address is who we're replying to)
    if (opts.to) _trackSenderAction(opts.to, "replied");
    // Scan for commitments in outgoing email
    scanForCommitments({ to: opts.to, subject: opts.subject, text: opts.text || "" }).catch(() => {});
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle("delete-message", async (_, uid) => {
  try {
    // Track sender reputation before deleting
    const msgs = store.get("_last_inbox_messages") || [];
    const match = msgs.find((m) => m.uid === uid);
    if (match) _trackSenderAction(match.from?.address, "deleted");
    await deleteMessage(uid);
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle("toggle-flag", async (_, uid, flag) => {
  try {
    await toggleFlag(uid, flag);
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle("move-message", async (_, uid, sourceFolder, targetFolder) => {
  try {
    const client = await getImapClient();
    const lock = await client.getMailboxLock(sourceFolder || "INBOX");
    try {
      await client.messageMove(String(uid), targetFolder, { uid: true });
    } finally { lock.release(); }
    return { ok: true };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle("list-folders", async () => {
  try {
    return await listFolders();
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle("fetch-folder", async (_, folderPath, page) => {
  try {
    return await fetchFolder(folderPath, page || 0);
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle("search-messages", async (_, query) => {
  try {
    return await searchMessages(query);
  } catch (e) {
    return { error: e.message };
  }
});

// ── AI Assistant (Claude) ────────────────────────────────────────────────────
let anthropicClient = null;
let conversationHistory = [];

function getAnthropicClient() {
  const apiKey = store.get("anthropic_api_key");
  if (!apiKey) throw new Error("No Anthropic API key configured. Add it in Settings.");

  if (!anthropicClient) {
    const Anthropic = (() => {
      const m = require("@anthropic-ai/sdk");
      return m.default || m;
    })();
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

function getInstructionsBlock() {
  const list = (store.get("ai_instructions") || []).filter((i) => i.enabled);
  if (!list.length) return "";
  return "\n\nSTANDING INSTRUCTIONS (always follow these):\n" + list.map((i, n) => `${n + 1}. ${i.text}`).join("\n");
}

async function aiTriage(messages) {
  const client = getAnthropicClient();
  const account = store.get("account") || {};
  const instructions = getInstructionsBlock();

  const emailSummaries = messages.slice(0, 20).map((m, i) => {
    const from = m.from?.name || m.from?.address || "Unknown";
    const date = m.date ? new Date(m.date).toLocaleString() : "";
    return `${i + 1}. [${m.seen ? "READ" : "UNREAD"}]${m.flagged ? " [STARRED]" : ""} From: ${from} | Date: ${date} | Subject: ${m.subject}`;
  }).join("\n");

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: `You are a personal email assistant for ${account.displayName || "the user"}.
Triage incoming emails: categorize by priority (urgent, normal, low),
flag spam/marketing, and suggest quick actions (reply, archive, delete, flag).
Be concise — one line per email with your recommendation.
Use format: [#] PRIORITY | Action — Brief reason${instructions}`,
    messages: [{ role: "user", content: `Here are my latest emails:\n\n${emailSummaries}\n\nTriage these for me.` }],
  });

  return response.content[0]?.text || "No response";
}

async function aiAnalyzeEmail(email) {
  const client = getAnthropicClient();
  const account = store.get("account") || {};

  const content = email.text || email.html?.replace(/<[^>]+>/g, " ").substring(0, 3000) || "(empty)";

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: `You are a personal email assistant for ${account.displayName || "the user"}.
Analyze this email and provide:
1. A one-sentence summary
2. Priority (urgent/normal/low)
3. Suggested action (reply/archive/delete/flag/forward)
4. If reply is suggested, draft a brief response
Be concise and professional.${getInstructionsBlock()}`,
    messages: [{ role: "user", content: `From: ${email.from?.name || ""} <${email.from?.address || ""}>\nTo: ${(email.to || []).map(t => t.address).join(", ")}\nDate: ${email.date}\nSubject: ${email.subject}\n\n${content}` }],
  });

  return response.content[0]?.text || "No response";
}

async function aiDraftReply(email, instruction) {
  const client = getAnthropicClient();
  const account = store.get("account") || {};

  const content = email.text || email.html?.replace(/<[^>]+>/g, " ").substring(0, 3000) || "";

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: `You are drafting an email reply on behalf of ${account.displayName || "the user"} (${account.email || ""}).
Write a professional, concise reply. Only output the reply body — no subject line, no greeting preamble unless appropriate.
Match the tone of the original email (formal if formal, casual if casual).`,
    messages: [
      { role: "user", content: `Original email from ${email.from?.name || email.from?.address || ""}:\nSubject: ${email.subject}\n\n${content}\n\n---\nInstruction: ${instruction || "Write an appropriate reply."}` },
    ],
  });

  return response.content[0]?.text || "";
}

// Tools the AI can use to manage emails
const EMAIL_TOOLS = [
  {
    name: "forward_email",
    description: "Forward the current email to another address. Use when the user asks to forward, pass on, or share an email with someone.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Email address to forward to" },
        note: { type: "string", description: "Optional note to add above the forwarded message" },
      },
      required: ["to"],
    },
  },
  {
    name: "reply_to_email",
    description: "Send a reply to the current email. Use when the user asks you to reply, respond, or write back.",
    input_schema: {
      type: "object",
      properties: {
        body: { type: "string", description: "The reply text" },
        reply_all: { type: "boolean", description: "Reply to all recipients (true) or just sender (false)" },
      },
      required: ["body"],
    },
  },
  {
    name: "delete_email",
    description: "Delete the current email. Use when the user asks to delete, remove, or trash an email.",
    input_schema: {
      type: "object",
      properties: {
        confirm: { type: "boolean", description: "Must be true to confirm deletion" },
      },
      required: ["confirm"],
    },
  },
  {
    name: "flag_email",
    description: "Star/flag or unflag the current email. Use when user asks to star, flag, mark as important, or unflag.",
    input_schema: {
      type: "object",
      properties: {
        flagged: { type: "boolean", description: "true to flag, false to unflag" },
      },
      required: ["flagged"],
    },
  },
  {
    name: "mark_read_unread",
    description: "Mark the current email as read or unread.",
    input_schema: {
      type: "object",
      properties: {
        read: { type: "boolean", description: "true for read, false for unread" },
      },
      required: ["read"],
    },
  },
  {
    name: "send_new_email",
    description: "Compose and send a new email. Use when user asks to write, send, or compose a new message (not a reply).",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Email body text" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "search_emails",
    description: "Search the mailbox for emails matching a query. Searches subject, from, to, and body. Returns a list of matching emails with their UIDs. Use this when the user wants to find, list, or act on multiple emails.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text to match against subject, from, to, or body" },
        folder: { type: "string", description: "Folder to search in. Default: INBOX" },
      },
      required: ["query"],
    },
  },
  {
    name: "delete_multiple_emails",
    description: "Delete multiple emails by their UIDs. Use after search_emails to bulk delete matching messages. Always search first to find the UIDs.",
    input_schema: {
      type: "object",
      properties: {
        uids: { type: "array", items: { type: "number" }, description: "Array of email UIDs to delete" },
        reason: { type: "string", description: "Brief reason for deletion (for confirmation message)" },
      },
      required: ["uids"],
    },
  },
  {
    name: "read_email_by_uid",
    description: "Fetch and read the full content of a specific email by its UID. Use when you need to see the body of an email found via search.",
    input_schema: {
      type: "object",
      properties: {
        uid: { type: "number", description: "The email UID to read" },
      },
      required: ["uid"],
    },
  },
];

// Execute a tool call
async function executeEmailTool(toolName, toolInput, emailContext) {
  const account = store.get("account") || {};

  switch (toolName) {
    case "forward_email": {
      if (!emailContext) return { error: "No email open to forward" };
      const fwdBody = (toolInput.note ? toolInput.note + "\n\n" : "")
        + "---------- Forwarded message ----------\n"
        + `From: ${emailContext.from?.name || ""} <${emailContext.from?.address || ""}>\n`
        + `Date: ${emailContext.date}\n`
        + `Subject: ${emailContext.subject}\n\n`
        + (emailContext.text || emailContext.html?.replace(/<[^>]+>/g, " ") || "");
      await sendMail({ to: toolInput.to, subject: `Fwd: ${emailContext.subject}`, text: fwdBody, html: fwdBody.replace(/\n/g, "<br>") });
      return { success: true, message: `Forwarded to ${toolInput.to}` };
    }
    case "reply_to_email": {
      if (!emailContext) return { error: "No email open to reply to" };
      const replyTo = toolInput.reply_all
        ? [emailContext.from, ...(emailContext.to || []), ...(emailContext.cc || [])].filter(t => t?.address).map(t => t.address).join(", ")
        : emailContext.from?.address;
      await sendMail({
        to: replyTo,
        subject: emailContext.subject?.startsWith("Re:") ? emailContext.subject : `Re: ${emailContext.subject}`,
        text: toolInput.body,
        html: toolInput.body.replace(/\n/g, "<br>"),
        inReplyTo: emailContext.messageId,
      });
      return { success: true, message: `Reply sent to ${replyTo}` };
    }
    case "delete_email": {
      if (!emailContext?.uid) return { error: "No email open to delete" };
      if (!toolInput.confirm) return { error: "Deletion not confirmed" };
      await deleteMessage(emailContext.uid);
      return { success: true, message: "Email deleted" };
    }
    case "flag_email": {
      if (!emailContext?.uid) return { error: "No email open" };
      await toggleFlag(emailContext.uid, "flagged");
      return { success: true, message: toolInput.flagged ? "Email flagged" : "Email unflagged" };
    }
    case "mark_read_unread": {
      if (!emailContext?.uid) return { error: "No email open" };
      await toggleFlag(emailContext.uid, "seen");
      return { success: true, message: toolInput.read ? "Marked as read" : "Marked as unread" };
    }
    case "send_new_email": {
      await sendMail({ to: toolInput.to, subject: toolInput.subject, text: toolInput.body, html: toolInput.body.replace(/\n/g, "<br>") });
      return { success: true, message: `Email sent to ${toolInput.to}` };
    }
    case "search_emails": {
      const folder = toolInput.folder || "INBOX";
      const client = await createFreshImapClient();
      try {
        const lock = await client.getMailboxLock(folder);
        try {
          let uids = await client.search({ subject: toolInput.query }, { uid: true });
          if (!uids.length) {
            uids = await client.search({ from: toolInput.query }, { uid: true });
          }
          if (!uids.length) return { success: true, results: [], message: "No emails found matching: " + toolInput.query };
          const results = [];
          for await (const msg of client.fetch({ uid: uids.slice(-50) }, { envelope: true, flags: true })) {
            results.push({
              uid: msg.uid,
              subject: msg.envelope.subject || "(no subject)",
              from: `${msg.envelope.from?.[0]?.name || ""} <${msg.envelope.from?.[0]?.address || ""}>`,
              date: msg.envelope.date?.toISOString(),
              seen: msg.flags?.has("\\Seen") || false,
            });
          }
          results.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
          return { success: true, results, message: `Found ${results.length} emails matching "${toolInput.query}"` };
        } finally {
          lock.release();
        }
      } finally {
        try { await client.logout(); } catch (e) {}
      }
    }
    case "delete_multiple_emails": {
      if (!toolInput.uids || !toolInput.uids.length) return { error: "No UIDs provided" };
      const client = await createFreshImapClient();
      try {
        const lock = await client.getMailboxLock("INBOX");
        try {
          await client.messageFlagsAdd({ uid: toolInput.uids }, ["\\Deleted"]);
          await client.messageDelete({ uid: toolInput.uids });
          return { success: true, message: `Deleted ${toolInput.uids.length} emails${toolInput.reason ? " (" + toolInput.reason + ")" : ""}` };
        } finally {
          lock.release();
        }
      } finally {
        try { await client.logout(); } catch (e) {}
      }
    }
    case "read_email_by_uid": {
      try {
        const msg = await fetchMessage(toolInput.uid);
        const bodyText = msg.text || msg.html?.replace(/<[^>]+>/g, " ").substring(0, 2000) || "(empty)";
        return {
          success: true,
          uid: msg.uid,
          subject: msg.subject,
          from: `${msg.from?.name || ""} <${msg.from?.address || ""}>`,
          date: msg.date,
          body_preview: bodyText.substring(0, 1000),
          attachments: (msg.attachments || []).map(a => a.filename),
        };
      } catch (e) {
        return { error: `Could not read email ${toolInput.uid}: ${e.message}` };
      }
    }
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

async function aiChat(message, emailContext) {
  const client = getAnthropicClient();
  const account = store.get("account") || {};
  const instructions = getInstructionsBlock();

  // Sanitize history: remove orphaned tool_use messages without matching tool_result
  function sanitizeHistory() {
    const clean = [];
    for (let i = 0; i < conversationHistory.length; i++) {
      const msg = conversationHistory[i];
      // Check if this is an assistant message with tool_use
      if (msg.role === "assistant" && Array.isArray(msg.content) && msg.content.some(b => b.type === "tool_use")) {
        // Next message must be a user message with tool_result
        const next = conversationHistory[i + 1];
        if (next && next.role === "user" && Array.isArray(next.content) && next.content.some(b => b.type === "tool_result")) {
          clean.push(msg);
        } else {
          // Orphaned tool_use — skip it
          continue;
        }
      } else {
        clean.push(msg);
      }
    }
    return clean;
  }

  conversationHistory.push({ role: "user", content: message });
  if (conversationHistory.length > 20) conversationHistory = conversationHistory.slice(-20);
  conversationHistory = sanitizeHistory();

  const systemMsg = (emailContext
    ? `You are a personal email assistant for ${account.displayName || "the user"} (${account.email || ""}). You are currently looking at an email (UID: ${emailContext.uid || "unknown"}).\nFrom: ${emailContext.from?.name || ""} <${emailContext.from?.address || ""}>\nSubject: ${emailContext.subject}\nDate: ${emailContext.date}\n\nEmail body:\n${(emailContext.text || emailContext.html?.replace(/<[^>]+>/g, " ") || "").substring(0, 2000)}`
    : `You are a personal email assistant for ${account.displayName || "the user"} (${account.email || ""}).`)
    + `\n\nYou can take actions on emails using tools: forward, reply, delete, flag, mark read/unread, search mailbox, read any email by UID, and bulk delete. When the user asks you to do something, USE THE TOOLS — don't just say you can't. Always confirm what you did after taking action.

IMPORTANT: When the user says "delete ALL" or "delete every" email matching something, you MUST:
1. First use search_emails to find ALL matching emails
2. Then use delete_multiple_emails with ALL the UIDs from the search results
3. Do NOT use delete_email (single) — that only deletes one email

When the user asks to find/search/list emails, use search_emails.
When the user asks to read a specific email from search results, use read_email_by_uid.${instructions}`;

  try {
  let response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: systemMsg,
    messages: conversationHistory,
    tools: EMAIL_TOOLS,
  });

  // Process tool calls in a loop
  const actionLog = [];
  while (response.stop_reason === "tool_use") {
    const assistantContent = response.content;
    conversationHistory.push({ role: "assistant", content: assistantContent });

    const toolResults = [];
    for (const block of assistantContent) {
      if (block.type === "tool_use") {
        try {
          const result = await executeEmailTool(block.name, block.input, emailContext);
          actionLog.push(`${block.name}: ${result.message || result.error}`);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
        } catch (e) {
          actionLog.push(`${block.name}: ERROR ${e.message}`);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ error: e.message }), is_error: true });
        }
      }
    }

    conversationHistory.push({ role: "user", content: toolResults });

    response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: systemMsg,
      messages: conversationHistory,
      tools: EMAIL_TOOLS,
    });
  }

  const replyText = response.content.filter(b => b.type === "text").map(b => b.text).join("\n");
  const fullReply = actionLog.length
    ? `[Actions taken: ${actionLog.join(" | ")}]\n\n${replyText}`
    : replyText;

  conversationHistory.push({ role: "assistant", content: response.content });

  return fullReply || "Done.";
  } catch (e) {
    // Clear corrupted history on API error
    conversationHistory = [];
    throw e;
  }
}

ipcMain.handle("ai-get-key", () => {
  const key = store.get("anthropic_api_key") || "";
  // Only mask if it looks like a real key
  if (key.startsWith("sk-ant-")) return "••••••••";
  // Clear corrupt values
  if (key && !key.startsWith("sk-ant-")) {
    store.delete("anthropic_api_key");
    return "";
  }
  return "";
});

ipcMain.handle("ai-save-key", (_, key) => {
  if (key && key !== "••••••••") {
    if (!key.startsWith("sk-ant-")) {
      return { ok: false, error: "Invalid key format — must start with sk-ant-" };
    }
    store.set("anthropic_api_key", key);
    anthropicClient = null;
  }
  return { ok: true };
});

ipcMain.handle("ai-verify-key", async () => {
  try {
    const storedKey = store.get("anthropic_api_key") || "";
    const keyPreview = storedKey ? `${storedKey.substring(0, 12)}...${storedKey.slice(-4)} (${storedKey.length} chars)` : "(empty)";

    // Force recreate client with current key
    anthropicClient = null;
    const client = getAnthropicClient();

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      messages: [{ role: "user", content: "Say OK" }],
    });
    return { ok: true, message: `Verified! Key: ${keyPreview}` };
  } catch (e) {
    const storedKey = store.get("anthropic_api_key") || "";
    const keyPreview = storedKey ? `${storedKey.substring(0, 12)}...${storedKey.slice(-4)} (${storedKey.length} chars)` : "(empty)";
    return { ok: false, message: `${e.status || ""} ${e.message}\nKey used: ${keyPreview}` };
  }
});

ipcMain.handle("sms-get-config", () => {
  return {
    smsTo: store.get("sms_to") || "",
    textbeltKey: store.get("textbelt_key") ? "••••••••" : "",
    alertEmailTo: store.get("alert_email_to") || "",
  };
});

ipcMain.handle("sms-save-config", (_, cfg) => {
  // Never overwrite with empty — only update if value is non-empty or explicitly clearing
  if (cfg.smsTo) store.set("sms_to", cfg.smsTo);
  if (cfg.textbeltKey && cfg.textbeltKey !== "••••••••") store.set("textbelt_key", cfg.textbeltKey);
  if (cfg.alertEmailTo !== undefined) store.set("alert_email_to", cfg.alertEmailTo);
  return { ok: true };
});

ipcMain.handle("sms-test", async (_, msg) => {
  // Test bypasses quiet hours and rate limits — direct send
  const phone = store.get("sms_to");
  if (!phone) return { error: "No phone number configured" };
  const key = store.get("textbelt_key") || "textbelt";
  const digits = phone.replace(/\D/g, "");
  const fullNumber = digits.startsWith("1") ? digits : "1" + digits;
  const text = msg || "GideonMail test: SMS is working!";
  try {
    const https = require("https");
    const postData = JSON.stringify({ phone: fullNumber, message: text.substring(0, 160), key });
    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "textbelt.com", path: "/text", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
      }, (res) => {
        let body = "";
        res.on("data", (d) => { body += d; });
        res.on("end", () => {
          const r = JSON.parse(body);
          if (r.success) resolve(r);
          else reject(new Error(r.error || "SMS failed"));
        });
      });
      req.on("error", reject);
      req.write(postData);
      req.end();
    });
    return { ok: true };
  } catch (e) { return { error: e.message }; }
});

// ── SMS Delivery Settings ────────────────────────────────────────────────
// ── Auto-launch (start on Windows login) ────────────────────────────────
// ── Update checker ──────────────────────────────────────────────────────
const CURRENT_VERSION = require("./package.json").version;

ipcMain.handle("check-update", async () => {
  try {
    const https = require("https");
    const res = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "api.github.com",
        path: "/repos/gbroeckling/gideonmail/releases/latest",
        headers: { "User-Agent": "GideonMail/" + CURRENT_VERSION },
      }, (res) => {
        let data = "";
        res.on("data", (d) => { data += d; });
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      });
      req.on("error", reject);
      req.end();
    });

    const latestTag = (res.tag_name || "").replace(/^v/, "");
    const isPrerelease = res.prerelease || false;

    // Only notify for stable releases (not prerelease)
    if (isPrerelease) return { upToDate: true, current: CURRENT_VERSION };

    if (latestTag && latestTag !== CURRENT_VERSION) {
      // Simple semver comparison
      const cur = CURRENT_VERSION.split(".").map(Number);
      const lat = latestTag.split(".").map(Number);
      const isNewer = lat[0] > cur[0] || (lat[0] === cur[0] && lat[1] > cur[1]) || (lat[0] === cur[0] && lat[1] === cur[1] && lat[2] > cur[2]);

      if (isNewer) {
        return {
          upToDate: false,
          current: CURRENT_VERSION,
          latest: latestTag,
          url: res.html_url || `https://github.com/gbroeckling/gideonmail/releases/tag/v${latestTag}`,
          notes: (res.body || "").substring(0, 200),
        };
      }
    }
    return { upToDate: true, current: CURRENT_VERSION };
  } catch (e) {
    return { upToDate: true, current: CURRENT_VERSION, error: e.message };
  }
});

ipcMain.handle("get-version", () => CURRENT_VERSION);

ipcMain.handle("autolaunch-get", async () => {
  try { return { enabled: await autoLauncher.isEnabled() }; }
  catch (e) { return { enabled: false }; }
});

ipcMain.handle("autolaunch-set", async (_, enabled) => {
  try {
    if (enabled) await autoLauncher.enable();
    else await autoLauncher.disable();
    return { ok: true, enabled };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Security filters config ──────────────────────────────────────────────
ipcMain.handle("security-filters-get", () => {
  return store.get("security_filters") || {
    spamassassin: true,
    spamhaus: false,
    virustotal: false,
    safebrowsing: false,
    phishtank: false,
    abuseipdb: false,
    clamav: false,
    bayesian: false,
  };
});

ipcMain.handle("security-filters-save", (_, filters) => {
  store.set("security_filters", filters);
  return { ok: true };
});

ipcMain.handle("security-api-keys-get", () => {
  return {
    virustotal: store.get("api_virustotal") ? "••••••••" : "",
    safebrowsing: store.get("api_safebrowsing") ? "••••••••" : "",
    abuseipdb: store.get("api_abuseipdb") ? "••••••••" : "",
  };
});

ipcMain.handle("security-api-keys-save", (_, keys) => {
  if (keys.virustotal && keys.virustotal !== "••••••••") store.set("api_virustotal", keys.virustotal);
  if (keys.safebrowsing && keys.safebrowsing !== "••••••••") store.set("api_safebrowsing", keys.safebrowsing);
  if (keys.abuseipdb && keys.abuseipdb !== "••••••••") store.set("api_abuseipdb", keys.abuseipdb);
  return { ok: true };
});

// Scan a single email on demand
ipcMain.handle("security-scan", async (_, uid) => {
  try {
    const msg = await fetchMessage(uid);
    // Skip spam filters for listed senders (except blocked)
    if (_isSpamImmune(msg.from?.address, msg.from?.name)) {
      return { flags: [], score: 0, details: ["Sender is on your trusted list — spam filters skipped"] };
    }
    const filters = store.get("security_filters") || {};
    const apiKeys = { virustotal: store.get("api_virustotal"), safebrowsing: store.get("api_safebrowsing"), abuseipdb: store.get("api_abuseipdb") };
    // Fetch raw headers
    const client = await createFreshImapClient();
    let headers = {};
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const raw = await client.download(String(uid), undefined, { uid: true });
        if (!raw || !raw.content) throw new Error("Download failed");
        const chunks = []; for await (const c of raw.content) chunks.push(c);
        const parsed = await simpleParser(Buffer.concat(chunks));
        headers = parsed.headers ? Object.fromEntries(parsed.headers) : {};
      } finally { lock.release(); }
    } finally { try { await client.logout(); } catch(e) {} }
    const result = await security.scanEmail(msg, headers, filters, apiKeys, bayesianFilter);
    return result;
  } catch (e) { return { error: e.message }; }
});

// Train Bayesian filter
ipcMain.handle("bayesian-train", (_, text, isSpam) => {
  if (bayesianFilter) bayesianFilter.train(text, isSpam);
  return { ok: true };
});

// ── Auto-check interval ─────────────────────────────────────────────────
ipcMain.handle("autocheck-get", () => {
  return { intervalMin: store.get("auto_check_interval_min") || 120 };
});

ipcMain.handle("ai-urgency-get", () => {
  return { enabled: store.get("ai_urgency_triage_enabled") === true };
});

ipcMain.handle("ai-urgency-set", (_, enabled) => {
  store.set("ai_urgency_triage_enabled", enabled);
  return { ok: true };
});

ipcMain.handle("autocheck-save", (_, cfg) => {
  if (cfg.intervalMin !== undefined) store.set("auto_check_interval_min", cfg.intervalMin);
  return { ok: true };
});

// ── Action email config ──────────────────────────────────────────────────
ipcMain.handle("action-email-get", () => ({
  enabled: store.get("action_email_enabled") === true,
  address: store.get("action_email_address") || "",
}));

ipcMain.handle("action-email-save", (_, cfg) => {
  if (cfg.enabled !== undefined) store.set("action_email_enabled", cfg.enabled);
  if (cfg.address !== undefined && cfg.address) store.set("action_email_address", cfg.address);
  return { ok: true };
});

ipcMain.handle("sms-settings-get", () => _getSmsSettings());

ipcMain.handle("sms-settings-save", (_, cfg) => {
  if (cfg.maxLength !== undefined) store.set("sms_max_length", cfg.maxLength);
  if (cfg.format !== undefined) store.set("sms_format", cfg.format);
  if (cfg.batchMultiple !== undefined) store.set("sms_batch", cfg.batchMultiple);
  if (cfg.quietStart !== undefined) store.set("sms_quiet_start", cfg.quietStart);
  if (cfg.quietEnd !== undefined) store.set("sms_quiet_end", cfg.quietEnd);
  if (cfg.maxPerHour !== undefined) store.set("sms_max_per_hour", cfg.maxPerHour);
  if (cfg.maxPerDay !== undefined) store.set("sms_max_per_day", cfg.maxPerDay);
  if (cfg.prefix !== undefined) store.set("sms_prefix", cfg.prefix);
  if (cfg.historyHours !== undefined) store.set("sms_history_hours", cfg.historyHours);
  return { ok: true };
});

// ── SMS Whitelist (always text for these senders) ───────────────────────
ipcMain.handle("whitelist-get", () => {
  return store.get("sms_whitelist") || [];
});

ipcMain.handle("whitelist-add", (_, entry) => {
  const list = store.get("sms_whitelist") || [];
  list.push({
    id: Date.now().toString(),
    address: (entry.address || "").trim().toLowerCase(),
    name: (entry.name || "").trim(),
    enabled: true,
    created: new Date().toISOString(),
  });
  store.set("sms_whitelist", list);
  return list;
});

ipcMain.handle("whitelist-remove", (_, id) => {
  let list = store.get("sms_whitelist") || [];
  list = list.filter((i) => i.id !== id);
  store.set("sms_whitelist", list);
  return list;
});

ipcMain.handle("whitelist-toggle", (_, id) => {
  const list = store.get("sms_whitelist") || [];
  const item = list.find((i) => i.id === id);
  if (item) item.enabled = !item.enabled;
  store.set("sms_whitelist", list);
  return list;
});

ipcMain.handle("whitelist-update", (_, id, updates) => {
  const list = store.get("sms_whitelist") || [];
  const item = list.find((i) => i.id === id);
  if (item) {
    if (updates.address !== undefined) item.address = updates.address.trim().toLowerCase();
    if (updates.name !== undefined) item.name = updates.name.trim();
  }
  store.set("sms_whitelist", list);
  return list;
});

// ── AI Watch List (smart senders with per-sender actions) ───────────────
ipcMain.handle("watchlist-get", () => store.get("ai_watchlist") || []);

ipcMain.handle("watchlist-add", (_, entry) => {
  const list = store.get("ai_watchlist") || [];
  list.push({
    id: Date.now().toString(),
    address: (entry.address || "").trim().toLowerCase(),
    name: (entry.name || "").trim(),
    enabled: true,
    created: new Date().toISOString(),
    actions: {
      aiAnalyze: true,       // AI reads and summarizes
      smsAlert: entry.smsAlert !== false,   // send SMS notification
      autoCalendar: entry.autoCalendar || false, // auto-create calendar events
      autoReply: false,      // auto-draft a reply
      flagImportant: true,   // star/flag the email
    },
  });
  store.set("ai_watchlist", list);
  return list;
});

ipcMain.handle("watchlist-remove", (_, id) => {
  let list = store.get("ai_watchlist") || [];
  list = list.filter((i) => i.id !== id);
  store.set("ai_watchlist", list);
  return list;
});

ipcMain.handle("watchlist-toggle", (_, id) => {
  const list = store.get("ai_watchlist") || [];
  const item = list.find((i) => i.id === id);
  if (item) item.enabled = !item.enabled;
  store.set("ai_watchlist", list);
  return list;
});

ipcMain.handle("watchlist-update", (_, id, updates) => {
  const list = store.get("ai_watchlist") || [];
  const item = list.find((i) => i.id === id);
  if (item) {
    if (updates.address !== undefined) item.address = updates.address.trim().toLowerCase();
    if (updates.name !== undefined) item.name = updates.name.trim();
    if (updates.actions !== undefined) item.actions = { ...item.actions, ...updates.actions };
  }
  store.set("ai_watchlist", list);
  return list;
});

// ── Unified People list (merges VIP, Watch, Blacklist, Greylist) ─────────
ipcMain.handle("people-get-all", () => {
  const people = [];
  for (const item of store.get("sms_whitelist") || []) {
    people.push({ ...item, role: "vip", actions: { smsAlert: true } });
  }
  for (const item of store.get("ai_watchlist") || []) {
    people.push({ ...item, role: "watch" });
  }
  for (const item of (store.get("sms_blacklist") || [])) {
    people.push({ ...item, role: "blocked" });
  }
  for (const item of (store.get("sms_greylist") || [])) {
    people.push({ ...item, role: "muted" });
  }
  for (const item of (store.get("daily_update_list") || [])) {
    people.push({ ...item, role: "daily" });
  }
  people.sort((a, b) => (a.name || a.address).localeCompare(b.name || b.address));
  return people;
});

ipcMain.handle("people-add", (_, entry) => {
  const role = entry.role || "vip";
  const base = {
    id: Date.now().toString(),
    address: (entry.address || "").trim().toLowerCase(),
    name: (entry.name || "").trim(),
    enabled: true,
    created: new Date().toISOString(),
  };

  if (role === "vip") {
    const list = store.get("sms_whitelist") || [];
    list.push(base);
    store.set("sms_whitelist", list);
  } else if (role === "watch") {
    const list = store.get("ai_watchlist") || [];
    list.push({ ...base, actions: { aiAnalyze: true, smsAlert: true, autoCalendar: false, flagImportant: true, autoReply: false } });
    store.set("ai_watchlist", list);
  } else if (role === "blocked") {
    const list = store.get("sms_blacklist") || [];
    list.push(base);
    store.set("sms_blacklist", list);
  } else if (role === "muted") {
    const list = store.get("sms_greylist") || [];
    list.push(base);
    store.set("sms_greylist", list);
  } else if (role === "daily") {
    const list = store.get("daily_update_list") || [];
    list.push(base);
    store.set("daily_update_list", list);
    // Remove from greylist if present (daily supersedes muted)
    const grey = store.get("sms_greylist") || [];
    const filtered = grey.filter((g) => !base.address || !g.address || !(g.address.includes(base.address) || base.address.includes(g.address)));
    if (filtered.length !== grey.length) store.set("sms_greylist", filtered);
  }
  return { ok: true };
});

ipcMain.handle("people-change-role", (_, id, oldRole, newRole) => {
  // Remove from old list
  const storeKeys = { vip: "sms_whitelist", watch: "ai_watchlist", blocked: "sms_blacklist", muted: "sms_greylist", daily: "daily_update_list" };
  const oldKey = storeKeys[oldRole];
  const newKey = storeKeys[newRole];
  if (!oldKey || !newKey) return { error: "Invalid role" };

  let oldList = store.get(oldKey) || [];
  const item = oldList.find((i) => i.id === id);
  if (!item) return { error: "Not found" };

  // Remove from old
  oldList = oldList.filter((i) => i.id !== id);
  store.set(oldKey, oldList);

  // Add to new
  const newList = store.get(newKey) || [];
  if (newRole === "watch" && !item.actions) {
    item.actions = { aiAnalyze: true, smsAlert: true, autoCalendar: false, flagImportant: true, autoReply: false };
  }
  newList.push(item);
  store.set(newKey, newList);
  return { ok: true };
});

ipcMain.handle("people-remove", (_, id, role) => {
  const storeKeys = { vip: "sms_whitelist", watch: "ai_watchlist", blocked: "sms_blacklist", muted: "sms_greylist", daily: "daily_update_list" };
  const key = storeKeys[role];
  if (!key) return { error: "Invalid role" };
  let list = store.get(key) || [];
  list = list.filter((i) => i.id !== id);
  store.set(key, list);
  return { ok: true };
});

ipcMain.handle("people-toggle", (_, id, role) => {
  const storeKeys = { vip: "sms_whitelist", watch: "ai_watchlist", blocked: "sms_blacklist", muted: "sms_greylist", daily: "daily_update_list" };
  const key = storeKeys[role];
  if (!key) return { error: "Invalid role" };
  const list = store.get(key) || [];
  const item = list.find((i) => i.id === id);
  if (item) item.enabled = !item.enabled;
  store.set(key, list);
  return { ok: true };
});

ipcMain.handle("people-update-actions", (_, id, actions) => {
  const list = store.get("ai_watchlist") || [];
  const item = list.find((i) => i.id === id);
  if (item) { item.actions = { ...item.actions, ...actions }; store.set("ai_watchlist", list); }
  return { ok: true };
});

// ── Blacklist & Greylist (same CRUD pattern as whitelist) ────────────────
function _listCRUD(storeKey) {
  return {
    get: () => store.get(storeKey) || [],
    add: (entry) => {
      const list = store.get(storeKey) || [];
      list.push({ id: Date.now().toString(), address: (entry.address || "").trim().toLowerCase(), name: (entry.name || "").trim(), enabled: true, created: new Date().toISOString() });
      store.set(storeKey, list);
      return list;
    },
    remove: (id) => { let list = store.get(storeKey) || []; list = list.filter((i) => i.id !== id); store.set(storeKey, list); return list; },
    toggle: (id) => { const list = store.get(storeKey) || []; const item = list.find((i) => i.id === id); if (item) item.enabled = !item.enabled; store.set(storeKey, list); return list; },
    update: (id, updates) => { const list = store.get(storeKey) || []; const item = list.find((i) => i.id === id); if (item) { if (updates.address !== undefined) item.address = updates.address.trim().toLowerCase(); if (updates.name !== undefined) item.name = updates.name.trim(); } store.set(storeKey, list); return list; },
  };
}
const blacklistOps = _listCRUD("sms_blacklist");
const greylistOps = _listCRUD("sms_greylist");
const dailyUpdateOps = _listCRUD("daily_update_list");

ipcMain.handle("blacklist-get", () => blacklistOps.get());
ipcMain.handle("blacklist-add", (_, e) => blacklistOps.add(e));
ipcMain.handle("blacklist-remove", (_, id) => blacklistOps.remove(id));
ipcMain.handle("blacklist-toggle", (_, id) => blacklistOps.toggle(id));
ipcMain.handle("blacklist-update", (_, id, u) => blacklistOps.update(id, u));

ipcMain.handle("greylist-get", () => greylistOps.get());
ipcMain.handle("greylist-add", (_, e) => greylistOps.add(e));
ipcMain.handle("greylist-remove", (_, id) => greylistOps.remove(id));
ipcMain.handle("greylist-toggle", (_, id) => greylistOps.toggle(id));
ipcMain.handle("greylist-update", (_, id, u) => greylistOps.update(id, u));

ipcMain.handle("daily-update-get", () => dailyUpdateOps.get());
ipcMain.handle("daily-update-add", (_, e) => dailyUpdateOps.add(e));
ipcMain.handle("daily-update-remove", (_, id) => dailyUpdateOps.remove(id));
ipcMain.handle("daily-update-toggle", (_, id) => dailyUpdateOps.toggle(id));
ipcMain.handle("daily-update-update", (_, id, u) => dailyUpdateOps.update(id, u));

// Check which list a sender is on (for UI coloring and SMS logic)
function _senderListStatus(fromAddress, fromName) {
  const addr = (fromAddress || "").toLowerCase();
  const name = (fromName || "").toLowerCase();
  const match = (list) => list.filter((w) => w.enabled).some((w) => w.address && (addr === w.address || addr.includes(w.address) || name.includes(w.address)));
  if (match(store.get("sms_blacklist") || [])) return "blacklist";
  if (match(store.get("daily_update_list") || [])) return "daily";
  if (match(store.get("sms_greylist") || [])) return "greylist";
  if (match(store.get("ai_watchlist") || [])) return "watch";
  if (match(store.get("sms_whitelist") || [])) return "whitelist";
  return null;
}

// Anyone on VIP, Watch, or Muted list is immune from spam filters (only Blocked gets filtered)
function _isSpamImmune(fromAddress, fromName) {
  const status = _senderListStatus(fromAddress, fromName);
  return status && status !== "blacklist";
}

ipcMain.handle("sender-list-status", (_, fromAddress, fromName) => {
  return _senderListStatus(fromAddress, fromName);
});

// Bulk check for message list rendering
ipcMain.handle("sender-list-status-bulk", (_, messages) => {
  const result = {};
  for (const m of messages) {
    const key = m.from?.address || "";
    if (key && !result[key]) result[key] = _senderListStatus(m.from?.address, m.from?.name);
  }
  return result;
});

// ── Blacklist auto-delete (1 week old) ──────────────────────────────────
async function cleanupBlacklistedEmails() {
  const blacklist = (store.get("sms_blacklist") || []).filter((b) => b.enabled);
  if (!blacklist.length) return;
  try {
    const client = await createFreshImapClient();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const oneWeekAgo = new Date(Date.now() - 7 * 24 * 3600000);
        for (const b of blacklist) {
          const uids = await client.search({ from: b.address, before: oneWeekAgo }, { uid: true });
          if (uids.length) {
            await client.messageFlagsAdd({ uid: uids }, ["\\Deleted"]);
            await client.messageDelete({ uid: uids });
            console.log(`Blacklist cleanup: deleted ${uids.length} old emails from ${b.address}`);
          }
        }
      } finally { lock.release(); }
    } finally { try { await client.logout(); } catch (e) {} }
  } catch (e) { console.error("Blacklist cleanup failed:", e.message); }
}

// ── Conversation alert settings ─────────────────────────────────────────
ipcMain.handle("convo-get-config", () => {
  return {
    enabled: store.get("convo_alert_enabled") !== false,
    minReplies: store.get("convo_min_replies") || 2,
    lookbackMonths: store.get("convo_lookback_months") || 6,
    checkIntervalMin: store.get("convo_check_interval_min") || 60,
  };
});

ipcMain.handle("convo-save-config", (_, cfg) => {
  if (cfg.enabled !== undefined) store.set("convo_alert_enabled", cfg.enabled);
  if (cfg.minReplies !== undefined) store.set("convo_min_replies", cfg.minReplies);
  if (cfg.lookbackMonths !== undefined) store.set("convo_lookback_months", cfg.lookbackMonths);
  if (cfg.checkIntervalMin !== undefined) store.set("convo_check_interval_min", cfg.checkIntervalMin);
  return { ok: true };
});

ipcMain.handle("check-now", async () => {
  const log = [];
  try {
    log.push("Fetching inbox...");
    const result = await fetchInbox(0, 50);
    const allMsgs = result.messages || [];
    log.push(`Total messages: ${allMsgs.length}`);

    const sentUids = _getSmsSentUids();
    const lookbackHours = store.get("sms_history_hours") || 4;
    const cutoff = new Date(Date.now() - lookbackHours * 3600000).toISOString();
    const unread = allMsgs.filter((m) => !m.seen && !sentUids.has(m.uid) && (!m.date || m.date >= cutoff));
    log.push(`Unread in lookback window: ${unread.length}`);

    // Whitelist check
    const whitelist = (store.get("sms_whitelist") || []).filter((w) => w.enabled);
    log.push(`Whitelist entries: ${whitelist.length}`);
    let wlMatches = 0;
    for (const msg of unread) {
      const fromAddr = (msg.from?.address || "").toLowerCase();
      const fromName = (msg.from?.name || "").toLowerCase();
      for (const w of whitelist) {
        if (w.address && (fromAddr === w.address || fromAddr.includes(w.address) || fromName.includes(w.address))) {
          wlMatches++;
          log.push(`  VIP match: ${msg.from?.address} → ${w.address}`);
          break;
        }
      }
    }
    log.push(`VIP whitelist matches: ${wlMatches}`);

    // SMS config check
    const smsTo = store.get("sms_to");
    const textbeltKey = store.get("textbelt_key");
    log.push(`Phone: ${smsTo || "NOT SET"}`);
    log.push(`Textbelt key: ${textbeltKey ? textbeltKey.substring(0, 8) + "..." : "NOT SET"}`);
    log.push(`Quiet hours: ${_isQuietHours() ? "YES (suppressed)" : "No"}`);
    log.push(`Rate limit: ${_checkRateLimit() || "OK"}`);

    // Force-run everything (bypass debounce for manual check)
    log.push("Running full auto-triage (bypassing debounce)...");
    _setLastCheckTime(null); // clear debounce so autoTriageNewMail runs
    await autoTriageNewMail(allMsgs);
    await lowTouchProcess(allMsgs);
    log.push("Done.");

    return { ok: true, message: log.join("\n") };
  } catch (e) {
    log.push(`ERROR: ${e.message}`);
    return { ok: false, message: log.join("\n") };
  }
});

ipcMain.handle("convo-test", async () => {
  try {
    // Fetch latest inbox
    const result = await fetchInbox(0, 50);
    const msgs = (result.messages || []).filter((m) => !m.seen);
    if (!msgs.length) return { ok: false, message: "No unread emails to check" };

    const alerts = await checkActiveConversations(msgs);
    if (!alerts.length) {
      return { ok: true, message: `Checked ${msgs.length} unread emails — none match active conversation criteria` };
    }

    const summary = alerts.map((a) =>
      `${a.from}: "${a.subject}" (${a.replyCount} replies)`
    ).join("\n");

    // Send the SMS
    const smsTo = store.get("sms_to");
    if (smsTo) {
      await sendAlert(`GideonMail: ${alerts.length} email${alerts.length > 1 ? "s" : ""} in active conversations:\n${summary}`);
    }

    return { ok: true, message: `Found ${alerts.length} active conversation${alerts.length > 1 ? "s" : ""}:\n${summary}${smsTo ? "\nSMS sent!" : "\n(No phone number configured — SMS not sent)"}` };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle("ai-triage", async (_, messages) => {
  try { return { text: await aiTriage(messages) }; }
  catch (e) { return { error: e.message }; }
});

ipcMain.handle("ai-analyze", async (_, email) => {
  try { return { text: await aiAnalyzeEmail(email) }; }
  catch (e) { return { error: e.message }; }
});

ipcMain.handle("ai-draft-reply", async (_, email, instruction) => {
  try { return { text: await aiDraftReply(email, instruction) }; }
  catch (e) { return { error: e.message }; }
});

ipcMain.handle("ai-chat", async (_, message, emailContext) => {
  try { return { text: await aiChat(message, emailContext) }; }
  catch (e) { return { error: e.message }; }
});

// ── AI: Extract event from email ─────────────────────────────────────────
ipcMain.handle("ai-extract-event", async (_, email) => {
  try {
    const client = getAnthropicClient();
    const content = email.text || email.html?.replace(/<[^>]+>/g, " ").substring(0, 3000) || "";
    const today = new Date().toISOString().split("T")[0];

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      system: `Extract calendar event details from this email. Today is ${today}. Return ONLY valid JSON with these fields:
{
  "title": "event title",
  "date": "YYYY-MM-DD",
  "startTime": "HH:MM" (24h format),
  "endTime": "HH:MM" (24h format, estimate 1h if not specified),
  "location": "full street address if mentioned, or venue name, or empty string",
  "description": "brief summary of what this is about",
  "attendees": ["email@example.com"] (extract any email addresses mentioned),
  "meetingLink": "full join URL for online meetings, or empty string"
}
For location: always include the FULL address with street, city, province/state, postal code if available in the email. If only a venue name is given (e.g. "Starbucks on Main"), include it as-is.
If dates/times are relative (e.g. "next Tuesday", "tomorrow at 3pm"), convert to absolute. If no time specified, default to 09:00-10:00. If no date found, use tomorrow.
For meetingLink: extract any Zoom, Teams, Google Meet, Webex, GoTo, or other video call URL. If only a meeting ID is mentioned (e.g. "Zoom ID: 123 456 7890"), construct the full join URL (e.g. "https://zoom.us/j/12345678900"). If a passcode is also mentioned, append it (e.g. "?pwd=abc123").`,
      messages: [{ role: "user", content: `From: ${email.from?.name || ""} <${email.from?.address || ""}>\nSubject: ${email.subject}\nDate: ${email.date}\n\n${content}` }],
    });

    const text = response.content[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { error: "Could not extract event details" };
    const event = JSON.parse(jsonMatch[0]);

    // Also try regex extraction if AI didn't find a link
    if (!event.meetingLink) event.meetingLink = _extractMeetingLink(content);
    // Include meeting link in description for calendar event
    if (event.meetingLink) {
      event.description = (event.description || "") + `\n\nJoin meeting: ${event.meetingLink}`;
      if (!event.location) event.location = event.meetingLink;
    }

    // Add Google Maps link if location is present and specific
    if (event.location && event.location.length > 3) {
      const mapsQuery = encodeURIComponent(event.location);
      event.mapsLink = `https://www.google.com/maps/search/?api=1&query=${mapsQuery}`;

      // Try to get a definitive address via Google Geocoding (if key available)
      const safeBrowsingKey = store.get("api_safebrowsing"); // reuse Google API key
      if (safeBrowsingKey) {
        try {
          const https = require("https");
          const geoRes = await new Promise((resolve, reject) => {
            const req = https.request({
              hostname: "maps.googleapis.com",
              path: `/maps/api/geocode/json?address=${mapsQuery}&key=${safeBrowsingKey}`,
            }, (res) => {
              let d = ""; res.on("data", (c) => { d += c; });
              res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({}); } });
            });
            req.on("error", reject);
            req.end();
          });

          if (geoRes.status === "OK" && geoRes.results?.length) {
            const best = geoRes.results[0];
            if (best.formatted_address) {
              event.fullAddress = best.formatted_address;
              event.mapsLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(best.formatted_address)}`;
            }
          }
        } catch (e) { /* geocoding failed, use original location */ }
      }
    }

    return { ok: true, event };
  } catch (e) {
    return { error: e.message };
  }
});

// ── Google Calendar ─────────────────────────────────────────────────────
// Move/reschedule an existing Google Calendar event
ipcMain.handle("gcal-move-event", async (_, eventId, newStart, newEnd) => {
  try {
    const token = await googleAuth.getToken();
    const calId = store.get("google_calendar_id") || "primary";
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const body = JSON.stringify({
      start: { dateTime: newStart, timeZone: timezone },
      end: { dateTime: newEnd, timeZone: timezone },
    });

    const https = require("https");
    const res = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "www.googleapis.com",
        path: `/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      }, (r) => {
        let data = "";
        r.on("data", (d) => { data += d; });
        r.on("end", () => {
          try { resolve({ status: r.statusCode, data: JSON.parse(data) }); }
          catch (e) { resolve({ status: r.statusCode, data }); }
        });
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });

    if (res.status === 200) {
      return { ok: true, event: res.data };
    }
    return { error: `API error ${res.status}: ${JSON.stringify(res.data.error?.message || res.data)}` };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle("gcal-create-event", async (_, event) => {
  try {
    const calId = store.get("google_calendar_id") || "primary";
    const token = await googleAuth.getToken();

    const startDateTime = `${event.date}T${event.startTime || "09:00"}:00`;
    const endDateTime = `${event.date}T${event.endTime || "10:00"}:00`;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    // Use full address if available, include Maps link in description
    const eventLocation = event.fullAddress || event.location || "";
    let eventDesc = event.description || "";
    if (event.mapsLink) eventDesc += `\n\nGoogle Maps: ${event.mapsLink}`;

    const eventBody = {
      summary: event.title,
      description: eventDesc,
      location: eventLocation,
      start: { dateTime: startDateTime, timeZone: timezone },
      end: { dateTime: endDateTime, timeZone: timezone },
    };
    // Only include attendees if explicitly approved (event.attendeesApproved === true)
    const hasApprovedAttendees = event.attendeesApproved && event.attendees?.length;
    if (hasApprovedAttendees) {
      eventBody.attendees = event.attendees.filter(Boolean).map((e) => ({ email: e }));
    }
    const body = JSON.stringify(eventBody);

    // Send invite emails only when attendees are approved
    const sendUpdates = hasApprovedAttendees ? "all" : "none";
    const https = require("https");
    const res = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "www.googleapis.com",
        path: `/calendar/v3/calendars/${encodeURIComponent(calId)}/events?sendUpdates=${sendUpdates}`,
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      }, (res) => {
        let data = "";
        res.on("data", (d) => { data += d; });
        res.on("end", () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
          catch (e) { resolve({ status: res.statusCode, data }); }
        });
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });

    if (res.status === 200 || res.status === 201) {
      return { ok: true, link: res.data.htmlLink || "", id: res.data.id };
    }
    return { error: `Google Calendar API error ${res.status}: ${JSON.stringify(res.data.error?.message || res.data)}` };
  } catch (e) {
    return { error: e.message };
  }
});

// Get events for a specific day
ipcMain.handle("gcal-get-day", async (_, dateStr) => {
  try {
    const token = await googleAuth.getToken();
    const calId = store.get("google_calendar_id") || "primary";
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const dayStart = `${dateStr}T00:00:00`;
    const dayEnd = `${dateStr}T23:59:59`;

    const params = new URLSearchParams({
      timeMin: new Date(dayStart).toISOString(),
      timeMax: new Date(dayEnd + "Z").toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      timeZone: timezone,
    });

    const https = require("https");
    const res = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "www.googleapis.com",
        path: `/calendar/v3/calendars/${encodeURIComponent(calId)}/events?${params}`,
        headers: { "Authorization": `Bearer ${token}` },
      }, (res) => {
        let data = "";
        res.on("data", (d) => { data += d; });
        res.on("end", () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
          catch (e) { resolve({ status: res.statusCode, data }); }
        });
      });
      req.on("error", reject);
      req.end();
    });

    if (res.status !== 200) return { error: `API error ${res.status}` };

    const events = (res.data.items || []).map((e) => ({
      id: e.id,
      title: e.summary || "(no title)",
      start: e.start?.dateTime || e.start?.date || "",
      end: e.end?.dateTime || e.end?.date || "",
      location: e.location || "",
      description: (e.description || "").substring(0, 200),
      attendees: (e.attendees || []).map((a) => a.email),
    }));

    return { ok: true, events, date: dateStr };
  } catch (e) {
    return { error: e.message };
  }
});

// Check for conflicts with a proposed event
ipcMain.handle("gcal-check-conflicts", async (_, event) => {
  try {
    const dayResult = await new Promise((resolve) => {
      // Reuse the gcal-get-day handler logic
      const handler = async () => {
        const token = await googleAuth.getToken();
        const calId = store.get("google_calendar_id") || "primary";
        const params = new URLSearchParams({
          timeMin: new Date(`${event.date}T${event.startTime || "00:00"}:00`).toISOString(),
          timeMax: new Date(`${event.date}T${event.endTime || "23:59"}:00`).toISOString(),
          singleEvents: "true",
        });
        const https = require("https");
        return new Promise((res, rej) => {
          const req = https.request({
            hostname: "www.googleapis.com",
            path: `/calendar/v3/calendars/${encodeURIComponent(calId)}/events?${params}`,
            headers: { "Authorization": `Bearer ${token}` },
          }, (r) => {
            let d = ""; r.on("data", (c) => { d += c; });
            r.on("end", () => { try { res({ status: r.statusCode, data: JSON.parse(d) }); } catch(e) { res({ status: r.statusCode, data: d }); } });
          });
          req.on("error", rej);
          req.end();
        });
      };
      handler().then(resolve).catch(() => resolve({ error: "failed" }));
    });

    if (dayResult.error) return { conflicts: [], error: dayResult.error };
    const existing = (dayResult.data?.items || []).map((e) => ({
      title: e.summary || "(no title)",
      start: e.start?.dateTime || e.start?.date || "",
      end: e.end?.dateTime || e.end?.date || "",
    }));
    return { ok: true, conflicts: existing };
  } catch (e) {
    return { conflicts: [], error: e.message };
  }
});

// ── Google OAuth flow ────────────────────────────────────────────────────
ipcMain.handle("gcal-status", () => {
  return {
    configured: googleAuth.isConfigured,
    connected: googleAuth.isConnected,
    clientId: store.get("google_client_id") ? "••••••••" : "",
  };
});

ipcMain.handle("gcal-save-credentials", (_, clientId, clientSecret) => {
  if (clientId && clientId !== "••••••••") store.set("google_client_id", clientId);
  if (clientSecret && clientSecret !== "••••••••") store.set("google_client_secret", clientSecret);
  googleAuth = new GoogleAuth(store); // reinitialize
  return { ok: true };
});

ipcMain.handle("gcal-authorize", async () => {
  try {
    await googleAuth.authorize();
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle("gcal-disconnect", () => {
  googleAuth.disconnect();
  return { ok: true };
});

// ── Pending appointments ─────────────────────────────────────────────────
ipcMain.handle("pending-appointments-get", () => {
  return store.get("pending_appointments") || [];
});

ipcMain.handle("pending-appointments-clear", (_, uid) => {
  let list = store.get("pending_appointments") || [];
  if (uid) list = list.filter((p) => p.uid !== uid);
  else list = [];
  store.set("pending_appointments", list);
  return { ok: true };
});

ipcMain.handle("vip-meetings-get", () => {
  return { enabled: store.get("vip_detect_meetings") !== false };
});

ipcMain.handle("vip-meetings-set", (_, enabled) => {
  store.set("vip_detect_meetings", enabled);
  return { ok: true };
});

ipcMain.handle("vip-options-get", () => {
  return {
    detectMeetings: store.get("vip_detect_meetings") !== false,
    autoCalendar: store.get("vip_auto_calendar") !== false,
    aiReview: store.get("vip_ai_review") === true,
  };
});

ipcMain.handle("vip-options-save", (_, opts) => {
  if (opts.detectMeetings !== undefined) store.set("vip_detect_meetings", opts.detectMeetings);
  if (opts.autoCalendar !== undefined) store.set("vip_auto_calendar", opts.autoCalendar);
  if (opts.aiReview !== undefined) store.set("vip_ai_review", opts.aiReview);
  return { ok: true };
});

// ── Do Later (snooze email → auto-schedule calendar task) ───────────────
ipcMain.handle("do-later", async (_, uid, subject, from) => {
  try {
    await autoCreateTask({ uid, subject, from: { name: from || "", address: from || "" } });
    return { ok: true };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle("ai-clear-history", () => {
  conversationHistory = [];
  return { ok: true };
});

// ── Standing Instructions ───────────────────────────────────────────────────
ipcMain.handle("instructions-get", () => {
  return store.get("ai_instructions") || [];
});

ipcMain.handle("instructions-add", (_, text) => {
  const list = store.get("ai_instructions") || [];
  list.push({ id: Date.now().toString(), text, enabled: true, created: new Date().toISOString() });
  store.set("ai_instructions", list);
  return list;
});

ipcMain.handle("instructions-remove", (_, id) => {
  let list = store.get("ai_instructions") || [];
  list = list.filter((i) => i.id !== id);
  store.set("ai_instructions", list);
  return list;
});

ipcMain.handle("instructions-toggle", (_, id) => {
  const list = store.get("ai_instructions") || [];
  const item = list.find((i) => i.id === id);
  if (item) item.enabled = !item.enabled;
  store.set("ai_instructions", list);
  return list;
});

ipcMain.handle("instructions-update", (_, id, text) => {
  const list = store.get("ai_instructions") || [];
  const item = list.find((i) => i.id === id);
  if (item) item.text = text.trim();
  store.set("ai_instructions", list);
  return list;
});

// ── App lifecycle ───────────────────────────────────────────────────────────
// ── Morning Briefing ────────────────────────────────────────────────────
// Persisted — survives restarts

async function sendMorningBriefing() {
  const smsTo = store.get("sms_to");
  const apiKey = store.get("anthropic_api_key");
  if (!smsTo || !apiKey) return;

  const today = new Date().toDateString();
  if (store.get("briefing_sent_date") === today) return;

  const hour = new Date().getHours();
  const briefingHour = store.get("briefing_hour") || 7;
  if (hour < briefingHour) return;

  try {
    // Inbox stats
    const result = await fetchInbox(0, 50);
    const msgs = result.messages || [];
    const unread = msgs.filter((m) => !m.seen).length;

    // VIP count
    const whitelist = (store.get("sms_whitelist") || []).filter((w) => w.enabled);
    const _matchWl = (msg) => whitelist.some((w) => {
      const addr = (msg.from?.address || "").toLowerCase();
      return w.address && addr.includes(w.address);
    });
    const vipCount = msgs.filter((m) => !m.seen && _matchWl(m)).length;

    // Pending appointments
    const pending = (store.get("pending_appointments") || []).length;

    // Calendar today
    let calendarInfo = "";
    if (googleAuth?.isConnected) {
      try {
        const todayStr = new Date().toISOString().split("T")[0];
        const token = await googleAuth.getToken();
        const calId = store.get("google_calendar_id") || "primary";
        const https = require("https");
        const params = new URLSearchParams({
          timeMin: new Date(`${todayStr}T00:00:00`).toISOString(),
          timeMax: new Date(`${todayStr}T23:59:59`).toISOString(),
          singleEvents: "true", orderBy: "startTime",
        });
        const res = await new Promise((resolve, reject) => {
          const req = https.request({
            hostname: "www.googleapis.com",
            path: `/calendar/v3/calendars/${encodeURIComponent(calId)}/events?${params}`,
            headers: { "Authorization": `Bearer ${token}` },
          }, (r) => { let d = ""; r.on("data", (c) => { d += c; }); r.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({}); } }); });
          req.on("error", reject);
          req.end();
        });
        const events = res.items || [];
        calendarInfo = events.length ? `${events.length} events` : "calendar clear";
      } catch (e) { calendarInfo = ""; }
    }

    // Daily Update digest — summarize emails from daily update senders
    let dailyDigest = "";
    const dailyList = (store.get("daily_update_list") || []).filter((d) => d.enabled);
    if (dailyList.length > 0) {
      const dailyMatches = [];
      for (const msg of msgs) {
        const addr = (msg.from?.address || "").toLowerCase();
        const name = (msg.from?.name || "").toLowerCase();
        if (dailyList.some((d) => d.address && (addr === d.address || addr.includes(d.address) || name.includes(d.address)))) {
          dailyMatches.push(msg);
        }
      }
      if (dailyMatches.length > 0) {
        // Group by sender/domain
        const groups = {};
        for (const m of dailyMatches) {
          const key = m.from?.name || m.from?.address || "Unknown";
          if (!groups[key]) groups[key] = [];
          groups[key].push(m.subject || "(no subject)");
        }
        // AI summarize if available, otherwise just list
        if (apiKey) {
          try {
            const client = getAnthropicClient();
            const listing = Object.entries(groups).map(([sender, subjects]) =>
              `${sender}:\n${subjects.map((s) => `  - ${s}`).join("\n")}`
            ).join("\n");
            const resp = await client.messages.create({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 200,
              system: `Summarize these daily update emails in 2-4 bullet points. Focus on: deliveries, invoices, shipping status, order updates, account activity. Be concise. Use plain text, no markdown.`,
              messages: [{ role: "user", content: listing }],
            });
            dailyDigest = `\nDaily updates:\n${(resp.content[0]?.text || "").trim()}`;
          } catch (e) {
            // Fallback: just list counts
            dailyDigest = `\nDaily updates: ${Object.entries(groups).map(([k, v]) => `${k} (${v.length})`).join(", ")}`;
          }
        } else {
          dailyDigest = `\nDaily updates: ${Object.entries(groups).map(([k, v]) => `${k} (${v.length})`).join(", ")}`;
        }
      }
    }

    const briefing = `Morning: ${unread} unread${vipCount ? `, ${vipCount} VIP` : ""}${pending ? `, ${pending} meetings pending` : ""}${calendarInfo ? `. ${calendarInfo}` : ""}${dailyDigest}`;
    await sendAlert(briefing);
    store.set("briefing_sent_date", today);
    console.log("Morning briefing sent");
  } catch (e) { console.error("Morning briefing failed:", e.message); }
}

// ── Deadline Detection ──────────────────────────────────────────────────
async function detectDeadline(msg) {
  if (!store.get("anthropic_api_key")) return null;
  try {
    const client = getAnthropicClient();
    const resp = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 60,
      system: `If this email contains a deadline, due date, or response-by date, respond with ONLY the date in YYYY-MM-DD format. If no deadline, respond with ONLY "NONE". Today is ${new Date().toISOString().split("T")[0]}.`,
      messages: [{ role: "user", content: `From: ${msg.from?.name || msg.from?.address}\nSubject: ${msg.subject}` }],
    });
    const text = (resp.content[0]?.text || "").trim();
    if (text === "NONE" || text.length > 12) return null;
    return text;
  } catch (e) { return null; }
}

// ── Sender Reputation Learning ──────────────────────────────────────────
function _trackSenderAction(fromAddress, action) {
  if (!fromAddress) return;
  const addr = fromAddress.toLowerCase();
  const rep = store.get("sender_reputation") || {};
  if (!rep[addr]) rep[addr] = { opened: 0, replied: 0, deleted: 0, ignored: 0, firstSeen: new Date().toISOString() };
  rep[addr][action] = (rep[addr][action] || 0) + 1;
  rep[addr].lastAction = action;
  rep[addr].lastDate = new Date().toISOString();
  store.set("sender_reputation", rep);
}

function checkReputationSuggestions() {
  const rep = store.get("sender_reputation") || {};
  const suggestions = [];
  const existing = new Set();
  // Collect all addresses already on a list
  for (const list of ["sms_whitelist", "ai_watchlist", "sms_blacklist", "sms_greylist", "daily_update_list"]) {
    for (const item of (store.get(list) || [])) existing.add(item.address);
  }

  for (const [addr, stats] of Object.entries(rep)) {
    if (existing.has(addr)) continue; // already managed
    const total = (stats.opened || 0) + (stats.replied || 0) + (stats.deleted || 0) + (stats.ignored || 0);
    if (total < 5) continue; // not enough data

    const deleteRate = (stats.deleted || 0) / total;
    const replyRate = (stats.replied || 0) / total;
    const openRate = (stats.opened || 0) / total;
    const ignoreRate = (stats.ignored || 0) / total;

    if (deleteRate > 0.7 && total >= 5) {
      suggestions.push({ addr, action: "blocked", reason: `Deleted ${Math.round(deleteRate * 100)}% of ${total} emails` });
    } else if (replyRate > 0.5 && total >= 3) {
      suggestions.push({ addr, action: "watch", reason: `Replied to ${Math.round(replyRate * 100)}% of ${total} emails` });
    } else if (ignoreRate > 0.8 && total >= 8) {
      suggestions.push({ addr, action: "muted", reason: `Ignored ${Math.round(ignoreRate * 100)}% of ${total} emails` });
    }
  }

  return suggestions;
}

// ── Commitment Tracking ─────────────────────────────────────────────────
async function scanForCommitments(sentMsg) {
  if (!store.get("anthropic_api_key")) return;
  if (!store.get("low_touch_enabled")) return;
  try {
    const client = getAnthropicClient();
    const today = new Date().toISOString().split("T")[0];
    const resp = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: `Analyze this sent email for commitments or promises the sender made. Today is ${today}. Respond with ONLY valid JSON:
{"commitments": [{"text": "what was promised", "dueDate": "YYYY-MM-DD or null", "to": "recipient name/email"}]}
A commitment is: sending a document, following up, providing information, scheduling something, completing a task, getting back to someone.
If no commitments found, return {"commitments": []}.`,
      messages: [{ role: "user", content: `To: ${sentMsg.to}\nSubject: ${sentMsg.subject}\n\n${sentMsg.text || ""}` }],
    });
    const text = (resp.content[0]?.text || "").trim();
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{"commitments":[]}');
    if (parsed.commitments?.length > 0) {
      const commitments = store.get("tracked_commitments") || [];
      for (const c of parsed.commitments) {
        commitments.push({
          id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
          text: c.text,
          dueDate: c.dueDate || null,
          to: c.to || sentMsg.to,
          subject: sentMsg.subject,
          created: new Date().toISOString(),
          fulfilled: false,
        });
      }
      if (commitments.length > 50) commitments.splice(0, commitments.length - 50);
      store.set("tracked_commitments", commitments);
      console.log(`Commitments tracked: ${parsed.commitments.length} from "${sentMsg.subject}"`);
    }
  } catch (e) { console.error("Commitment scan failed:", e.message); }
}

async function scanIncomingCommitments(msg, bodyText) {
  if (!store.get("anthropic_api_key")) return;
  if (!store.get("low_touch_enabled")) return;
  if (!bodyText || bodyText.length < 20) return;
  try {
    const client = getAnthropicClient();
    const today = new Date().toISOString().split("T")[0];
    const resp = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: `Analyze this incoming email for commitments or promises the SENDER made to the recipient. Today is ${today}. Respond with ONLY valid JSON:
{"commitments": [{"text": "what they promised", "dueDate": "YYYY-MM-DD or null"}]}
A commitment is: promising to send a document, to follow up, to provide information, to schedule something, to complete a task, to get back to someone, to deliver something, to call back.
Only extract clear, specific promises — not vague pleasantries like "let's keep in touch".
If no commitments found, return {"commitments": []}.`,
      messages: [{ role: "user", content: `From: ${msg.from?.name || ""} <${msg.from?.address || ""}>\nSubject: ${msg.subject}\n\n${bodyText.substring(0, 1500)}` }],
    });
    const text = (resp.content[0]?.text || "").trim();
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{"commitments":[]}');
    if (parsed.commitments?.length > 0) {
      const commitments = store.get("tracked_commitments") || [];
      for (const c of parsed.commitments) {
        commitments.push({
          id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
          text: c.text,
          dueDate: c.dueDate || null,
          from: msg.from?.address || msg.from?.name || "Unknown",
          to: "you",
          direction: "incoming",
          subject: msg.subject,
          created: new Date().toISOString(),
          fulfilled: false,
        });
      }
      if (commitments.length > 100) commitments.splice(0, commitments.length - 100);
      store.set("tracked_commitments", commitments);
      console.log(`Incoming commitments tracked: ${parsed.commitments.length} from ${msg.from?.address} re: "${msg.subject}"`);
    }
  } catch (e) { console.error("Incoming commitment scan failed:", e.message); }
}

async function checkCommitments() {
  if (!store.get("low_touch_enabled")) return;
  const commitments = store.get("tracked_commitments") || [];
  if (!commitments.length) return;
  const smsTo = store.get("sms_to");
  const today = new Date().toISOString().split("T")[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];
  const nudged = new Set(store.get("commitment_nudged") || []);
  const alerts = [];

  for (const c of commitments) {
    if (c.fulfilled || nudged.has(c.id)) continue;

    if (c.direction === "incoming") {
      // Incoming: someone promised US something — check if they followed through
      if (c.dueDate && c.dueDate <= tomorrow) {
        const overdue = c.dueDate < today;
        alerts.push(`${overdue ? "OWED (OVERDUE)" : "OWED"}: ${c.from} promised "${c.text}"${c.dueDate ? ` by ${c.dueDate}` : ""}`);
        nudged.add(c.id);
      }
      if (!c.dueDate && (Date.now() - new Date(c.created).getTime()) > 5 * 86400000) {
        alerts.push(`OWED: ${c.from} promised "${c.text}" (${Math.round((Date.now() - new Date(c.created).getTime()) / 86400000)} days ago)`);
        nudged.add(c.id);
      }
    } else {
      // Outgoing: WE promised something — nudge before deadline
      if (c.dueDate && c.dueDate <= tomorrow) {
        const overdue = c.dueDate < today;
        alerts.push(`${overdue ? "OVERDUE" : "DUE"}: "${c.text}" to ${c.to}${c.dueDate ? ` (${c.dueDate})` : ""}`);
        nudged.add(c.id);
      }
      if (!c.dueDate && (Date.now() - new Date(c.created).getTime()) > 3 * 86400000) {
        alerts.push(`PENDING: "${c.text}" to ${c.to} (${Math.round((Date.now() - new Date(c.created).getTime()) / 86400000)} days ago)`);
        nudged.add(c.id);
      }
    }
  }

  if (alerts.length > 0 && smsTo) {
    await sendAlert(`Commitments:\n${alerts.join("\n")}`);
  }

  const nudgeArr = [...nudged];
  if (nudgeArr.length > 200) nudgeArr.splice(0, nudgeArr.length - 200);
  store.set("commitment_nudged", nudgeArr);
}

// ── Smart Digest Email ──────────────────────────────────────────────────
async function sendSmartDigest() {
  if (!store.get("low_touch_enabled")) return;
  const digestEmail = store.get("action_email_address") || store.get("alert_email_to") || "";
  if (!digestEmail) return;
  if (!store.get("anthropic_api_key")) return;

  const today = new Date().toDateString();
  if (store.get("digest_sent_date") === today) return;

  const hour = new Date().getHours();
  const digestHour = store.get("digest_hour") || 7;
  if (hour < digestHour) return;

  try {
    const result = await fetchInbox(0, 100);
    const msgs = result.messages || [];
    if (!msgs.length) return;

    // Categorize messages
    const unread = msgs.filter((m) => !m.seen);
    const needsAction = [];
    const fyi = [];
    const autoHandled = [];

    const processed = new Set(store.get("low_touch_processed") || []);

    for (const m of msgs.slice(0, 50)) {
      const status = _senderListStatus(m.from?.address, m.from?.name);
      if (status === "whitelist" || status === "watch") {
        needsAction.push(m);
      } else if (processed.has(m.uid)) {
        autoHandled.push(m);
      } else if (!m.seen) {
        fyi.push(m);
      }
    }

    // AI summarize each section
    const aiClient = getAnthropicClient();
    const sections = [];

    if (needsAction.length > 0) {
      const list = needsAction.slice(0, 10).map((m) => `${m.from?.name || m.from?.address}: ${m.subject}`).join("\n");
      try {
        const resp = await aiClient.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 300,
          system: "Summarize these emails that need the user's attention. 1-2 sentences per email. Be concise.",
          messages: [{ role: "user", content: list }],
        });
        sections.push({ title: "Needs Your Attention", color: "#ef4444", items: (resp.content[0]?.text || list).split("\n").filter(Boolean) });
      } catch (e) { sections.push({ title: "Needs Your Attention", color: "#ef4444", items: needsAction.map((m) => `${m.from?.name || m.from?.address}: ${m.subject}`) }); }
    }

    if (fyi.length > 0) {
      sections.push({ title: "FYI — New & Unread", color: "#f59e0b", items: fyi.slice(0, 15).map((m) => `${m.from?.name || m.from?.address}: ${m.subject}`) });
    }

    if (autoHandled.length > 0) {
      sections.push({ title: "Auto-Handled by GideonMail", color: "#22c55e", items: autoHandled.slice(0, 10).map((m) => `${m.from?.name || m.from?.address}: ${m.subject}`) });
    }

    // Commitments due
    const commitments = (store.get("tracked_commitments") || []).filter((c) => !c.fulfilled);
    const outgoing = commitments.filter((c) => c.direction !== "incoming");
    const incoming = commitments.filter((c) => c.direction === "incoming");
    if (outgoing.length > 0) {
      sections.push({ title: "Your Promises (Outgoing)", color: "#a78bfa", items: outgoing.slice(0, 5).map((c) => `"${c.text}" to ${c.to}${c.dueDate ? ` — due ${c.dueDate}` : ""}`) });
    }
    if (incoming.length > 0) {
      sections.push({ title: "Owed to You (Incoming)", color: "#f472b6", items: incoming.slice(0, 5).map((c) => `${c.from}: "${c.text}"${c.dueDate ? ` — due ${c.dueDate}` : ""}`) });
    }

    // Reputation suggestions
    const repSuggestions = checkReputationSuggestions();
    if (repSuggestions.length > 0) {
      sections.push({ title: "Sender Suggestions", color: "#06b6d4", items: repSuggestions.slice(0, 5).map((s) => `${s.addr} → ${s.action}: ${s.reason}`) });
    }

    if (!sections.length) return;

    // Build HTML
    const sectionHtml = sections.map((s) => `
      <div style="margin-bottom:16px">
        <div style="font-size:13px;font-weight:700;color:${s.color};padding:8px 0;border-bottom:1px solid ${s.color}33">${s.title} (${s.items.length})</div>
        ${s.items.map((item) => `<div style="padding:4px 0;font-size:12px;color:#e4e4e8;border-bottom:1px solid #2a2a32">${item}</div>`).join("")}
      </div>
    `).join("");

    const calInfo = sections.find((s) => s.title.includes("Calendar"));
    const html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#111113;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:600px;margin:20px auto;background:#1a1a1f;border-radius:12px;overflow:hidden;border:1px solid #2a2a32">
    <div style="background:linear-gradient(135deg,#7c6cff,#6355e0);padding:20px 24px">
      <div style="color:#fff;font-size:20px;font-weight:700">GideonMail Daily Digest</div>
      <div style="color:#e0d4ff;font-size:12px;margin-top:4px">${new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} — ${unread.length} unread</div>
    </div>
    <div style="padding:20px 24px">
      ${sectionHtml}
      <div style="color:#55555e;font-size:10px;text-align:center;margin-top:20px;padding-top:12px;border-top:1px solid #2a2a32">
        Generated by GideonMail Low Touch Autopilot
      </div>
    </div>
  </div>
</body></html>`;

    const cfg = store.get("account");
    if (cfg) {
      const transport = nodemailer.createTransport({
        host: cfg.smtpHost, port: cfg.smtpPort || 587,
        secure: cfg.smtpSecure || false,
        auth: { user: cfg.username, pass: cfg.password },
        tls: { rejectUnauthorized: false },
      });
      await transport.sendMail({
        from: `GideonMail <${cfg.email || cfg.username}>`,
        to: digestEmail,
        subject: `Daily Digest: ${unread.length} unread, ${needsAction.length} need attention`,
        html,
        text: sections.map((s) => `${s.title}:\n${s.items.join("\n")}`).join("\n\n"),
      });
      store.set("digest_sent_date", today);
      console.log("Smart digest sent");
    }
  } catch (e) { console.error("Smart digest failed:", e.message); }
}

// ── Auto-Task for Watch senders ─────────────────────────────────────────
async function autoCreateTask(msg, eventTitle, emailBodyText, meetingLinkOverride) {
  if (!googleAuth?.isConnected) return;
  try {
    const token = await googleAuth.getToken();
    const calId = store.get("google_calendar_id") || "primary";
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const https = require("https");

    // Try AI extraction first if we have the email body and an API key
    let slotStart = null;
    let slotEnd = null;
    let location = "";
    let onlineMeetingLink = meetingLinkOverride || "";
    let title = eventTitle || `Review: ${msg.subject}`;

    if (emailBodyText && store.get("anthropic_api_key")) {
      try {
        const aiClient = getAnthropicClient();
        const today = new Date().toISOString().split("T")[0];
        const resp = await aiClient.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 512,
          system: `Extract calendar event details from this email. Today is ${today}. Return ONLY valid JSON:
{"title": "event title", "date": "YYYY-MM-DD", "startTime": "HH:MM", "endTime": "HH:MM", "location": "venue or address or empty string", "meetingLink": "full URL or constructed from meeting ID or empty string"}
If dates are relative (e.g. "next Thursday"), convert to absolute. If no time specified, default to 12:00-13:00. If no date found, use tomorrow.
For meetingLink: extract any Zoom, Teams, Google Meet, Webex, GoTo, or other video call URL. If only a meeting ID is mentioned (e.g. "Zoom ID: 123 456 7890"), construct the full join URL (e.g. "https://zoom.us/j/12345678900"). If a passcode is also present, append it (e.g. "?pwd=abc123").`,
          messages: [{ role: "user", content: `From: ${msg.from?.name || ""} <${msg.from?.address || ""}>\nSubject: ${msg.subject}\n\n${emailBodyText}` }],
        });
        const text = (resp.content[0]?.text || "").trim();
        const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
        if (parsed.date && parsed.startTime) {
          slotStart = new Date(`${parsed.date}T${parsed.startTime}:00`);
          const endTime = parsed.endTime || parsed.startTime.replace(/:\d+/, (m) => `:${(parseInt(m.slice(1)) + 60) % 60}`);
          slotEnd = new Date(`${parsed.date}T${endTime}:00`);
          if (slotEnd <= slotStart) slotEnd = new Date(slotStart.getTime() + 60 * 60000);
          location = parsed.location || "";
          if (parsed.title) title = parsed.title;
          if (parsed.meetingLink && !onlineMeetingLink) onlineMeetingLink = parsed.meetingLink;
          console.log(`AI extracted event: "${title}" on ${parsed.date} at ${parsed.startTime}-${endTime}, location="${location}", link="${onlineMeetingLink}"`);
        }
      } catch (e) { console.error("AI event extraction:", e.message); }
    }

    // Also try regex extraction if AI didn't find a link
    if (!onlineMeetingLink && emailBodyText) {
      onlineMeetingLink = _extractMeetingLink(emailBodyText);
    }

    // Fallback: find next available 30-min slot if AI extraction didn't work
    if (!slotStart) {
      const params = new URLSearchParams({
        timeMin: new Date().toISOString(),
        timeMax: new Date(Date.now() + 3 * 86400000).toISOString(),
        singleEvents: "true", orderBy: "startTime",
      });

      const res = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: "www.googleapis.com",
          path: `/calendar/v3/calendars/${encodeURIComponent(calId)}/events?${params}`,
          headers: { "Authorization": `Bearer ${token}` },
        }, (r) => { let d = ""; r.on("data", (c) => { d += c; }); r.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({}); } }); });
        req.on("error", reject);
        req.end();
      });

      const events = (res.items || []).map((e) => ({
        start: new Date(e.start?.dateTime || e.start?.date),
        end: new Date(e.end?.dateTime || e.end?.date),
      }));

      for (let day = 0; day < 3; day++) {
        const d = new Date(Date.now() + day * 86400000);
        const schedStart = store.get("sched_start_hour") || 9;
        const schedEnd = store.get("sched_end_hour") || 17;
        for (let h = schedStart; h < schedEnd; h++) {
          const candidate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, 0, 0);
          if (candidate < new Date()) continue;
          const candidateEnd = new Date(candidate.getTime() + 30 * 60000);
          const conflict = events.some((e) => candidate < e.end && candidateEnd > e.start);
          if (!conflict) { slotStart = candidate; slotEnd = candidateEnd; break; }
        }
        if (slotStart) break;
      }
    }

    if (!slotStart) return;
    if (!slotEnd) slotEnd = new Date(slotStart.getTime() + 30 * 60000);

    // ── Reschedule detection: check for existing event from same sender ──
    let existingEventId = null;
    let existingEvent = null;
    const senderName = (msg.from?.name || "").toLowerCase();
    const senderAddr = (msg.from?.address || "").toLowerCase();
    try {
      // Search future events for ones created by GideonMail from this sender
      const searchParams = new URLSearchParams({
        timeMin: new Date().toISOString(),
        timeMax: new Date(Date.now() + 30 * 86400000).toISOString(),
        singleEvents: "true", orderBy: "startTime", maxResults: "50",
      });
      const searchRes = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: "www.googleapis.com",
          path: `/calendar/v3/calendars/${encodeURIComponent(calId)}/events?${searchParams}`,
          headers: { "Authorization": `Bearer ${token}` },
        }, (r) => { let d = ""; r.on("data", (c) => { d += c; }); r.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({}); } }); });
        req.on("error", reject);
        req.end();
      });

      for (const ev of (searchRes.items || [])) {
        const desc = (ev.description || "").toLowerCase();
        const summary = (ev.summary || "").toLowerCase();
        // Match if event was auto-created by GideonMail AND involves the same sender
        if (desc.includes("auto-created by gideonmail") &&
            (desc.includes(senderAddr) || (senderName && summary.includes(senderName)))) {
          existingEventId = ev.id;
          existingEvent = { summary: ev.summary, start: ev.start?.dateTime || ev.start?.date, end: ev.end?.dateTime || ev.end?.date, location: ev.location || "" };
          console.log(`Reschedule: found existing event "${ev.summary}" (${ev.id}) from same sender`);
          break;
        }
      }
    } catch (e) { console.error("Reschedule search:", e.message); }

    let description = `From: ${msg.from?.name || ""} <${msg.from?.address || ""}>\nAuto-created by GideonMail`;
    if (onlineMeetingLink) description += `\n\nJoin meeting: ${onlineMeetingLink}`;

    const eventBody = {
      summary: title,
      description,
      start: { dateTime: slotStart.toISOString(), timeZone: timezone },
      end: { dateTime: slotEnd.toISOString(), timeZone: timezone },
    };
    if (location) eventBody.location = location;
    // For online meetings, put the link in the location if no physical location
    if (onlineMeetingLink && !location) eventBody.location = onlineMeetingLink;

    if (existingEventId) {
      // PATCH the existing event (reschedule)
      const body = JSON.stringify(eventBody);
      await new Promise((resolve) => {
        const req = https.request({
          hostname: "www.googleapis.com",
          path: `/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(existingEventId)}?sendUpdates=none`,
          method: "PATCH",
          headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        }, (r) => { let d = ""; r.on("data", (c) => { d += c; }); r.on("end", () => resolve(d)); });
        req.on("error", () => resolve(null));
        req.write(body); req.end();
      });
      console.log(`Auto-task: RESCHEDULED "${title}" to ${slotStart.toLocaleString()}`);
      return { rescheduled: true, title, start: slotStart, end: slotEnd, location, meetingLink: onlineMeetingLink, oldEvent: existingEvent };
    } else {
      // POST a new event
      const body = JSON.stringify(eventBody);
      await new Promise((resolve) => {
        const req = https.request({
          hostname: "www.googleapis.com",
          path: `/calendar/v3/calendars/${encodeURIComponent(calId)}/events?sendUpdates=none`,
          method: "POST",
          headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        }, (r) => { let d = ""; r.on("data", (c) => { d += c; }); r.on("end", () => resolve(d)); });
        req.on("error", () => resolve(null));
        req.write(body); req.end();
      });
      console.log(`Auto-task: scheduled "${title}" at ${slotStart.toLocaleString()}`);
      return { rescheduled: false, title, start: slotStart, end: slotEnd, location, meetingLink: onlineMeetingLink };
    }
  } catch (e) { console.error("Auto-task failed:", e.message); return null; }
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  // Auto-connect if account is configured
  if (store.get("account")) {
    fetchInbox().then((result) => {
      mainWindow?.webContents?.send("inbox-updated", result);
      startIdle();
    }).catch(() => {});
  }

  // Morning briefing + smart digest + commitment check every 15 min
  setInterval(() => {
    sendMorningBriefing().catch(() => {});
    sendSmartDigest().catch(() => {});
    checkCommitments().catch(() => {});
  }, 900000);
  // Check immediately too
  setTimeout(() => {
    sendMorningBriefing().catch(() => {});
    sendSmartDigest().catch(() => {});
    checkCommitments().catch(() => {});
  }, 10000);
});

app.on("window-all-closed", () => {
  // Stay in tray on Windows
  if (process.platform !== "darwin") return;
  app.quit();
});

app.on("activate", () => {
  if (!mainWindow) createWindow();
  else mainWindow.show();
});

app.on("before-quit", async () => {
  if (tray) { try { tray.destroy(); } catch (e) {} tray = null; }
  if (imapClient) { try { await imapClient.logout(); } catch (e) {} }
});
