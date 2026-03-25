const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require("electron");
app.setName("GideonMail");
if (process.platform === "win32") app.setAppUserModelId("GideonMail");
const path = require("path");
const _esm = require("electron-store");
const Store = _esm.default || _esm;
const { ImapFlow } = require("imapflow");
const nodemailer = require("nodemailer");
const { simpleParser } = require("mailparser");
const security = require("./security");
let bayesianFilter = null;

const store = new Store({ name: "gideonmail-config" });
const AutoLaunch = (() => { const m = require("auto-launch"); return m.default || m; })();
const autoLauncher = new AutoLaunch({ name: "GideonMail", isHidden: true });

bayesianFilter = new security.BayesianFilter(store);

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
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ── Tray ────────────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, "assets", "icon.png");
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }));
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

  if (imapClient && imapClient.usable) return imapClient;

  imapClient = new ImapFlow({
    host: cfg.imapHost,
    port: cfg.imapPort || 993,
    secure: cfg.imapSecure === true,
    auth: { user: cfg.username, pass: cfg.password },
    logger: false,
    tls: { rejectUnauthorized: false },
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
  const client = await getImapClient();
  const folders = [];
  const tree = await client.listTree();

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
  const client = await getImapClient();
  const lock = await client.getMailboxLock("INBOX");

  try {
    const uids = await client.search({ or: [{ subject: query }, { from: query }, { to: query }, { body: query }] }, { uid: true });

    if (!uids.length) return { messages: [], total: 0 };

    const uidRange = uids.slice(-100).join(",");
    const messages = [];
    for await (const msg of client.fetch(uidRange, {
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
    return { messages, total: messages.length };
  } finally {
    lock.release();
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
        if (s.batchMultiple) {
          const summary = whitelistAlerts.map((m) => _formatEmailForSms(m, s.format)).join(" | ");
          try { await sendSMS(`VIP: ${summary}`); whitelistAlerts.forEach((m) => _addSmsSentUid(m.uid)); } catch (e) { console.error("Whitelist SMS failed:", e.message); }
        } else {
          for (const m of whitelistAlerts) {
            try { await sendSMS(`VIP: ${_formatEmailForSms(m, s.format)}`); _addSmsSentUid(m.uid); } catch (e) { console.error("Whitelist SMS failed:", e.message); }
          }
        }
      }
    }
  }

  // ── Check for active conversations ────────────────────────────────────
  if (smsTo) {
    try {
      const conversationAlerts = await checkActiveConversations(newMsgs);
      if (conversationAlerts.length > 0) {
        const summary = conversationAlerts.map((a) =>
          `${a.from}: ${a.subject} (you replied ${a.replyCount}x)`
        ).join("\n");
        await sendSMS(`GideonMail: ${conversationAlerts.length} email${conversationAlerts.length > 1 ? "s" : ""} in active conversations:\n${summary}`);
        conversationAlerts.forEach((a) => _addSmsSentUid(a.uid));
      }
    } catch (e) {
      console.error("Conversation check failed:", e.message);
    }
  }

  // ── AI triage for importance ──────────────────────────────────────────
  const apiKey = store.get("anthropic_api_key");
  if (!apiKey || !smsTo) return;

  try {
    const client = getAnthropicClient();
    const account = store.get("account") || {};

    const emailList = newMsgs.slice(0, 5).map((m) => {
      return `From: ${m.from?.name || m.from?.address || "Unknown"}\nSubject: ${m.subject}\nDate: ${m.date}`;
    }).join("\n---\n");

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system: `You are an email importance filter for ${account.displayName || "the user"}.
For each email, respond with ONLY "URGENT" or "SKIP" followed by a 5-word reason.
URGENT means: needs action within hours, from a real person about something important.
SKIP means: marketing, newsletter, automated notification, spam, or can wait.
Be very selective — only flag truly urgent emails.${getInstructionsBlock()}`,
      messages: [{ role: "user", content: emailList }],
    });

    const triageText = response.content[0]?.text || "";
    const urgentLines = triageText.split("\n").filter((l) => l.toUpperCase().startsWith("URGENT"));

    if (urgentLines.length > 0) {
      const urgentSummary = newMsgs.slice(0, urgentLines.length).map((m, i) => {
        return `${m.from?.name || m.from?.address}: ${m.subject}`;
      }).join("\n");

      await sendSMS(`GideonMail: ${urgentLines.length} urgent email${urgentLines.length > 1 ? "s" : ""}:\n${urgentSummary}`);
      newMsgs.slice(0, urgentLines.length).forEach((m) => _addSmsSentUid(m.uid));
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
  };
});

ipcMain.handle("sms-save-config", (_, cfg) => {
  // Never overwrite with empty — only update if value is non-empty or explicitly clearing
  if (cfg.smsTo) store.set("sms_to", cfg.smsTo);
  if (cfg.textbeltKey && cfg.textbeltKey !== "••••••••") store.set("textbelt_key", cfg.textbeltKey);
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

ipcMain.handle("autocheck-save", (_, cfg) => {
  if (cfg.intervalMin !== undefined) store.set("auto_check_interval_min", cfg.intervalMin);
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
  if (match(store.get("sms_whitelist") || [])) return "whitelist";
  return null;
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
      await sendSMS(`GideonMail: ${alerts.length} email${alerts.length > 1 ? "s" : ""} in active conversations:\n${summary}`);
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
  if (imapClient) { try { await imapClient.logout(); } catch (e) {} }
});
