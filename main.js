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

async function fetchMessage(uid) {
  const client = await getImapClient();
  const lock = await client.getMailboxLock("INBOX");

  try {
    const raw = await client.download(uid.toString(), undefined, { uid: true });
    const chunks = [];
    for await (const chunk of raw.content) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    const parsed = await simpleParser(buffer);

    // Mark as seen
    await client.messageFlagsAdd(uid.toString(), ["\\Seen"], { uid: true });

    return {
      uid,
      subject: parsed.subject || "(no subject)",
      from: parsed.from?.value?.[0] || {},
      to: (parsed.to?.value || []),
      cc: (parsed.cc?.value || []),
      date: parsed.date?.toISOString(),
      html: parsed.html || "",
      text: parsed.text || "",
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

async function fetchAttachment(uid, filename) {
  const client = await getImapClient();
  const lock = await client.getMailboxLock("INBOX");

  try {
    const raw = await client.download(uid.toString(), undefined, { uid: true });
    const chunks = [];
    for await (const chunk of raw.content) chunks.push(chunk);
    const parsed = await simpleParser(Buffer.concat(chunks));

    const att = (parsed.attachments || []).find((a) => a.filename === filename);
    if (!att) throw new Error("Attachment not found");

    return { filename: att.filename, contentType: att.contentType, data: att.content.toString("base64") };
  } finally {
    lock.release();
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
  } finally {
    try { await client.logout(); } catch (e) {}
  }

  function walk(node) {
    if (node.path) {
      folders.push({
        name: node.name,
        path: node.path,
        specialUse: node.specialUse || null,
        delimiter: node.delimiter,
      });
    }
    if (node.folders) node.folders.forEach(walk);
  }
  walk(tree);
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
function _setLastCheckTime() {
  store.set("sms_last_check_time", new Date().toISOString());
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

  const actionId = `GM-${Date.now()}-${originalMsg.uid}`;
  const fromName = originalMsg.from?.name || originalMsg.from?.address || "Unknown";

  const actionButtons = actions.map((a) =>
    `<a href="mailto:${cfg.email || cfg.username}?subject=${encodeURIComponent(`[GIDEON-ACTION:${actionId}] ${a.command}`)}&body=${encodeURIComponent(a.command === "reply" ? "reply: " : a.command)}" style="display:inline-block;padding:8px 20px;margin:4px;background:${a.color || "#7c6cff"};color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px">${a.label}</a>`
  ).join("\n");

  const html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#111113;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:500px;margin:20px auto;background:#1a1a1f;border-radius:12px;overflow:hidden;border:1px solid #2a2a32">
    <div style="background:linear-gradient(135deg,#7c6cff,#6355e0);padding:16px 24px">
      <div style="color:#fff;font-size:18px;font-weight:700">GideonMail</div>
      <div style="color:#e0d4ff;font-size:11px;margin-top:2px">Action Required</div>
    </div>
    <div style="padding:20px 24px">
      <div style="color:#8b8b96;font-size:11px;margin-bottom:4px">From: ${fromName}</div>
      <div style="color:#e4e4e8;font-size:16px;font-weight:600;margin-bottom:12px">${originalMsg.subject || "(no subject)"}</div>
      <div style="color:#e4e4e8;font-size:13px;line-height:1.6;padding:12px;background:#111113;border-radius:8px;margin-bottom:16px">${summary}</div>
      <div style="text-align:center;padding:8px 0">
        ${actionButtons}
      </div>
      <div style="color:#55555e;font-size:10px;text-align:center;margin-top:16px;padding-top:12px;border-top:1px solid #2a2a32">
        Click a button above or reply to this email with a command:<br>
        <span style="color:#8b8b96">reply: [your message]</span> · <span style="color:#8b8b96">approve</span> · <span style="color:#8b8b96">decline</span> · <span style="color:#8b8b96">later</span> · <span style="color:#8b8b96">ignore</span>
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
      subject: `[ACTION] ${fromName}: ${originalMsg.subject || "(no subject)"}`,
      html,
      text: `GideonMail Action Required\n\nFrom: ${fromName}\nSubject: ${originalMsg.subject}\n\n${summary}\n\nReply with: reply: [message] | approve | decline | later | ignore`,
      headers: { "X-GideonMail-Action-Id": actionId, "X-GideonMail-UID": String(originalMsg.uid) },
    });

    // Track sent action emails
    const sent = store.get("action_emails_sent") || [];
    sent.push({ actionId, uid: originalMsg.uid, from: originalMsg.from, subject: originalMsg.subject, sent: new Date().toISOString() });
    if (sent.length > 50) sent.splice(0, sent.length - 50);
    store.set("action_emails_sent", sent);

  } catch (e) { console.error("Action email failed:", e.message); }
}

// Scan for replies to action emails and execute commands
async function processActionReplies() {
  const enabled = store.get("action_email_enabled") === true;
  if (!enabled) return;

  const sentActions = store.get("action_emails_sent") || [];
  if (!sentActions.length) return;

  try {
    const client = await createFreshImapClient();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        // Search for replies to action emails
        const uids = await client.search({ subject: "[GIDEON-ACTION:" }, { uid: true });
        if (!uids.length) return;

        for await (const msg of client.fetch({ uid: uids.slice(-20) }, { envelope: true, source: true })) {
          const subject = msg.envelope?.subject || "";
          const actionMatch = subject.match(/\[GIDEON-ACTION:([^\]]+)\]/);
          if (!actionMatch) continue;

          const actionId = actionMatch[1].trim();
          const originalAction = sentActions.find((a) => subject.includes(a.actionId));
          if (!originalAction) continue;

          // Parse the command from the subject or body
          let command = subject.replace(/.*\[GIDEON-ACTION:[^\]]+\]\s*/, "").trim().toLowerCase();

          // Parse body for command if subject doesn't have it
          if (!command && msg.source) {
            const parsed = await simpleParser(msg.source);
            const bodyText = (parsed.text || "").trim().split("\n")[0].trim().toLowerCase();
            if (bodyText.startsWith("reply:") || ["approve", "decline", "later", "ignore"].includes(bodyText.split(/\s/)[0])) {
              command = bodyText;
            }
          }

          if (!command) continue;

          console.log(`Action reply: ${command} for UID ${originalAction.uid}`);

          // Execute the command
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
          }
          // "ignore" = do nothing

          // Delete the action reply from inbox
          try { await client.messageDelete(String(msg.uid), { uid: true }); } catch (e) {}

          // Remove from tracking
          const idx = sentActions.findIndex((a) => a.actionId === actionId);
          if (idx >= 0) sentActions.splice(idx, 1);
          store.set("action_emails_sent", sentActions);
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

  const client = await getImapClient();
  const alerts = [];

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
      // Normalize the subject for thread matching (strip Re:/Fwd: prefixes)
      const baseSubject = (msg.subject || "")
        .replace(/^(re|fwd|fw)\s*:\s*/gi, "")
        .replace(/^(re|fwd|fw)\s*:\s*/gi, "") // double strip
        .trim();

      if (!baseSubject || baseSubject.length < 3) continue;

      // Search Sent folder for our replies in this thread (last 6 months)
      try {
        const sentUids = await client.search({
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
        // Search failed for this message, skip
      }
    }
  } finally {
    lock.release();
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

  // Filter out greylisted and blacklisted senders from SMS triggers
  const _greylist = (store.get("sms_greylist") || []).filter((g) => g.enabled);
  const _blacklist = (store.get("sms_blacklist") || []).filter((b) => b.enabled);
  const _matchesList = (msg, list) => list.some((w) => {
    const addr = (msg.from?.address || "").toLowerCase();
    const name = (msg.from?.name || "").toLowerCase();
    return w.address && (addr === w.address || addr.includes(w.address) || name.includes(w.address));
  });
  const smsEligible = newMsgs.filter((m) => !_matchesList(m, _greylist) && !_matchesList(m, _blacklist));

  // Run blacklist cleanup (delete emails > 1 week old from blacklisted senders)
  cleanupBlacklistedEmails().catch((e) => console.error("Blacklist cleanup:", e.message));
  processActionReplies().catch((e) => console.error("Action replies:", e.message));

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
                system: `Extract calendar event details from this email. Today is ${today}. Return ONLY valid JSON: {"title":"","date":"YYYY-MM-DD","startTime":"HH:MM","endTime":"HH:MM","location":"","description":"","attendees":[]}. If no date, use tomorrow. If no time, use 09:00-10:00.`,
                messages: [{ role: "user", content: `From: ${fullMsg.from?.name || ""} <${fullMsg.from?.address || ""}>\nSubject: ${fullMsg.subject}\n\n${content}` }],
              });
              const jsonMatch = (resp.content[0]?.text || "").match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                const event = JSON.parse(jsonMatch[0]);
                const token = await googleAuth.getToken();
                const calId = store.get("google_calendar_id") || "primary";
                const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
                // Auto-calendar never invites attendees — only manual Task with approval does
                const body = JSON.stringify({
                  summary: event.title, description: event.description || "", location: event.location || "",
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

          // Deadline detection for VIP emails
          if (store.get("anthropic_api_key")) {
            const deadline = await detectDeadline(m);
            if (deadline) smsText += ` [DUE ${deadline}]`;
          }

          // Meeting detection + location extraction for VIP emails (one AI call)
          let meetingLocation = "";
          if (detectMeetings && store.get("anthropic_api_key")) {
            try {
              const client = getAnthropicClient();
              const resp = await client.messages.create({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 100,
                system: `Analyze this email. Respond with ONLY valid JSON:
{"meeting": true/false, "location": "full address or venue name or empty string"}
A meeting is any scheduled event, appointment, call, interview, or gathering with a specific date/time.
For location: extract the full street address if available. If only a venue name, include it. If no location mentioned, use empty string.`,
                messages: [{ role: "user", content: `From: ${m.from?.name || m.from?.address}\nSubject: ${m.subject}` }],
              });
              const meetingText = (resp.content[0]?.text || "").trim();
              try {
                const parsed = JSON.parse(meetingText.match(/\{[\s\S]*\}/)?.[0] || "{}");
                isMeeting = !!parsed.meeting;
                meetingLocation = parsed.location || "";
              } catch (e) {
                isMeeting = meetingText.toUpperCase().includes("TRUE");
              }
            } catch (e) { /* skip detection */ }
          }

          // VIP auto-calendar: create event immediately, no prompt
          const vipAutoCalendar = store.get("vip_auto_calendar") === true;
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
            // Auto-create calendar event immediately
            try {
              await autoCreateTask(m, `Meeting: ${m.subject}`);
              smsText = `MEETING AUTO-ADDED: ${m.from?.name || m.from?.address}: ${m.subject}`;
              if (meetingLocation) smsText += `\n📍 ${meetingLocation}`;
              try {
                const { Notification: WinNotifAuto } = require("electron");
                if (WinNotifAuto.isSupported()) {
                  const n = new WinNotifAuto({ title: "Meeting Auto-Added to Calendar", body: `${m.from?.name || m.from?.address}: ${m.subject}`, silent: false });
                  n.show();
                  n.on("click", () => { mainWindow?.show(); mainWindow?.focus(); });
                }
              } catch (e) {}
            } catch (e) { console.error("VIP auto-calendar failed:", e.message); }
          } else if (isMeeting) {
            smsText = `MEETING from ${m.from?.name || m.from?.address}: ${m.subject}`;
            if (meetingLocation) smsText += `\n📍 ${meetingLocation}`;
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
            // Send action email for phone-based reply
            await sendActionEmail(m, smsText, [
              { label: "Reply", command: "reply", color: "#7c6cff" },
              { label: "Approve", command: "approve", color: "#4ade80" },
              { label: "Decline", command: "decline", color: "#f06060" },
              { label: "Later", command: "later", color: "#ff9f43" },
              { label: "Ignore", command: "ignore", color: "#55555e" },
            ]);
          } catch (e) { console.error("VIP alert failed:", e.message); }
        }
      }
    }
  }

  // ── Check for active conversations (only SMS-eligible senders) ─────────
  if (smsTo) {
    try {
      const conversationAlerts = await checkActiveConversations(smsEligible);
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
    } catch (e) {}

    // Auto-check on configurable interval (default 120 min / 2 hours)
    const checkMin = store.get("auto_check_interval_min") || 120;
    console.log(`Auto-check interval: ${checkMin} minutes`);
    const interval = setInterval(async () => {
      try {
        const result = await fetchInbox(0, 50);
        mainWindow?.webContents?.send("inbox-updated", result);
        await autoTriageNewMail(result.messages || []);
      } catch (e) {
        // reconnect on next cycle
      }
    }, checkMin * 60000);

    app.on("before-quit", () => clearInterval(interval));
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
    return await fetchInbox(page || 0);
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle("fetch-message", async (_, uid) => {
  try {
    return await fetchMessage(uid);
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
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle("delete-message", async (_, uid) => {
  try {
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
  }
  return { ok: true };
});

ipcMain.handle("people-change-role", (_, id, oldRole, newRole) => {
  // Remove from old list
  const storeKeys = { vip: "sms_whitelist", watch: "ai_watchlist", blocked: "sms_blacklist", muted: "sms_greylist" };
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
  const storeKeys = { vip: "sms_whitelist", watch: "ai_watchlist", blocked: "sms_blacklist", muted: "sms_greylist" };
  const key = storeKeys[role];
  if (!key) return { error: "Invalid role" };
  let list = store.get(key) || [];
  list = list.filter((i) => i.id !== id);
  store.set(key, list);
  return { ok: true };
});

ipcMain.handle("people-toggle", (_, id, role) => {
  const storeKeys = { vip: "sms_whitelist", watch: "ai_watchlist", blocked: "sms_blacklist", muted: "sms_greylist" };
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

// Check which list a sender is on (for UI coloring and SMS logic)
function _senderListStatus(fromAddress, fromName) {
  const addr = (fromAddress || "").toLowerCase();
  const name = (fromName || "").toLowerCase();
  const match = (list) => list.filter((w) => w.enabled).some((w) => w.address && (addr === w.address || addr.includes(w.address) || name.includes(w.address)));
  if (match(store.get("sms_blacklist") || [])) return "blacklist";
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

    // Actually run the triage
    if (unread.length > 0) {
      log.push("Running full auto-triage...");
      await autoTriageNewMail(allMsgs);
      log.push("Done.");
    }

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
  "attendees": ["email@example.com"] (extract any email addresses mentioned)
}
For location: always include the FULL address with street, city, province/state, postal code if available in the email. If only a venue name is given (e.g. "Starbucks on Main"), include it as-is.
If dates/times are relative (e.g. "next Tuesday", "tomorrow at 3pm"), convert to absolute. If no time specified, default to 09:00-10:00. If no date found, use tomorrow.`,
      messages: [{ role: "user", content: `From: ${email.from?.name || ""} <${email.from?.address || ""}>\nSubject: ${email.subject}\nDate: ${email.date}\n\n${content}` }],
    });

    const text = response.content[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { error: "Could not extract event details" };
    const event = JSON.parse(jsonMatch[0]);

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
    autoCalendar: store.get("vip_auto_calendar") === true,
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

    const briefing = `Morning: ${unread} unread${vipCount ? `, ${vipCount} VIP` : ""}${pending ? `, ${pending} meetings pending` : ""}${calendarInfo ? `. ${calendarInfo}` : ""}`;
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

// ── Auto-Task for Watch senders ─────────────────────────────────────────
async function autoCreateTask(msg, eventTitle) {
  if (!googleAuth?.isConnected) return;
  try {
    const token = await googleAuth.getToken();
    const calId = store.get("google_calendar_id") || "primary";
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    // Find next available 30-min slot (search next 3 days, business hours)
    const todayStr = new Date().toISOString().split("T")[0];
    const params = new URLSearchParams({
      timeMin: new Date().toISOString(),
      timeMax: new Date(Date.now() + 3 * 86400000).toISOString(),
      singleEvents: "true", orderBy: "startTime",
    });

    const https = require("https");
    const res = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "www.googleapis.com",
        path: `/calendar/v3/calendars/${encodeURIComponent(calId)}/events?${params}`,
        headers: { "Authorization": `Bearer ${token}` },
      }, (r) => { let d = ""; r.on("data", (c) => { d += c; }); r.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({}); } }); });
      req.on("error", reject);
      req.end();
    });

    // Find first free 30-min slot between 9am-5pm
    const events = (res.items || []).map((e) => ({
      start: new Date(e.start?.dateTime || e.start?.date),
      end: new Date(e.end?.dateTime || e.end?.date),
    }));

    let slotStart = null;
    for (let day = 0; day < 3; day++) {
      const d = new Date(Date.now() + day * 86400000);
      const schedStart = store.get("sched_start_hour") || 9;
      const schedEnd = store.get("sched_end_hour") || 17;
      for (let h = schedStart; h < schedEnd; h++) {
        const candidate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, 0, 0);
        if (candidate < new Date()) continue;
        const candidateEnd = new Date(candidate.getTime() + 30 * 60000);
        const conflict = events.some((e) => candidate < e.end && candidateEnd > e.start);
        if (!conflict) { slotStart = candidate; break; }
      }
      if (slotStart) break;
    }

    if (!slotStart) return;
    const slotEnd = new Date(slotStart.getTime() + 30 * 60000);

    const body = JSON.stringify({
      summary: eventTitle || `Review: ${msg.subject}`,
      description: `From: ${msg.from?.name || ""} <${msg.from?.address || ""}>\nAuto-created by GideonMail`,
      start: { dateTime: slotStart.toISOString(), timeZone: timezone },
      end: { dateTime: slotEnd.toISOString(), timeZone: timezone },
    });

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

    console.log(`Auto-task: scheduled "${eventTitle || msg.subject}" at ${slotStart.toLocaleTimeString()}`);
  } catch (e) { console.error("Auto-task failed:", e.message); }
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

  // Morning briefing check every 15 min
  setInterval(() => sendMorningBriefing().catch(() => {}), 900000);
  // Check immediately too
  setTimeout(() => sendMorningBriefing().catch(() => {}), 10000);
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
