const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification } = require("electron");
const path = require("path");
const _esm = require("electron-store");
const Store = _esm.default || _esm;
const { ImapFlow } = require("imapflow");
const nodemailer = require("nodemailer");
const { simpleParser } = require("mailparser");

const store = new Store({ name: "gideonmail-config" });

let mainWindow = null;
let tray = null;
let imapClient = null;
let unreadCount = 0;

// ── Window ──────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
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
async function getImapClient() {
  const cfg = store.get("account");
  if (!cfg) throw new Error("No account configured");

  if (imapClient && imapClient.usable) return imapClient;

  imapClient = new ImapFlow({
    host: cfg.imapHost,
    port: cfg.imapPort || 993,
    secure: cfg.imapSecure !== false,
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
let lastSeenUids = new Set();

async function sendSMS(message) {
  const phone = store.get("sms_to");
  const carrier = store.get("sms_carrier") || "rogers";
  if (!phone) return;

  const gateways = {
    rogers:   "pcs.rogers.com",
    bell:     "txt.bell.ca",
    telus:    "msg.telus.com",
    fido:     "fido.ca",
    koodo:    "msg.telus.com",
    freedom:  "txt.freedommobile.ca",
  };

  const gateway = gateways[carrier];
  if (!gateway) { console.error("Unknown carrier:", carrier); return; }

  // Strip everything except digits from phone number
  const digits = phone.replace(/\D/g, "").replace(/^1/, ""); // remove country code
  const smsEmail = `${digits}@${gateway}`;

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
      from: cfg.email || cfg.username,
      to: smsEmail,
      subject: "",
      text: message.substring(0, 160), // SMS length limit
    });
  } catch (e) {
    console.error("SMS via email failed:", e.message);
  }
}

async function autoTriageNewMail(messages) {
  // Find new unread messages we haven't seen before
  const newMsgs = messages.filter((m) => !m.seen && !lastSeenUids.has(m.uid));
  if (!newMsgs.length) return;

  // Update seen set
  for (const m of messages) lastSeenUids.add(m.uid);

  // Desktop notification for any new mail
  if (Notification.isSupported()) {
    const n = new Notification({
      title: `${newMsgs.length} new email${newMsgs.length > 1 ? "s" : ""}`,
      body: newMsgs.map((m) => `${m.from?.name || m.from?.address}: ${m.subject}`).join("\n").substring(0, 200),
      silent: false,
    });
    n.show();
    n.on("click", () => { mainWindow?.show(); mainWindow?.focus(); });
  }

  // AI triage for importance — only if API key configured
  const apiKey = store.get("anthropic_api_key");
  const smsTo = store.get("sms_to");
  if (!apiKey || !smsTo) return;

  try {
    const client = getAnthropicClient();
    const account = store.get("account") || {};

    const emailList = newMsgs.slice(0, 5).map((m) => {
      return `From: ${m.from?.name || m.from?.address || "Unknown"}\nSubject: ${m.subject}\nDate: ${m.date}`;
    }).join("\n---\n");

    const response = await client.messages.create({
      model: "claude-3-5-sonnet-20241022",
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
    }
  } catch (e) {
    console.error("AI auto-triage failed:", e.message);
  }
}

async function startIdle() {
  if (idleActive) return;
  const cfg = store.get("account");
  if (!cfg) return;

  try {
    const client = await getImapClient();
    idleActive = true;

    // Seed the seen-UIDs set with current inbox
    try {
      const initial = await fetchInbox(0, 50);
      for (const m of (initial.messages || [])) lastSeenUids.add(m.uid);
      mainWindow?.webContents?.send("inbox-updated", initial);
    } catch (e) {}

    // Re-check inbox every 60 minutes (one AI call per batch of new emails)
    const interval = setInterval(async () => {
      try {
        const result = await fetchInbox(0, 50);
        mainWindow?.webContents?.send("inbox-updated", result);
        await autoTriageNewMail(result.messages || []);
      } catch (e) {
        // reconnect on next cycle
      }
    }, 3600000);

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
  // If password is masked, keep the old one
  const existing = store.get("account");
  if (cfg.password === "••••••••" && existing?.password) {
    cfg.password = existing.password;
  }
  store.set("account", cfg);

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
    model: "claude-3-5-sonnet-20241022",
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
    model: "claude-3-5-sonnet-20241022",
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
    model: "claude-3-5-sonnet-20241022",
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

async function aiChat(message, emailContext) {
  const client = getAnthropicClient();
  const account = store.get("account") || {};

  conversationHistory.push({ role: "user", content: message });
  // Keep last 20 messages
  if (conversationHistory.length > 20) conversationHistory = conversationHistory.slice(-20);

  const systemMsg = emailContext
    ? `You are a personal email assistant for ${account.displayName || "the user"} (${account.email || ""}). You are currently looking at an email.\nFrom: ${emailContext.from?.name || ""} <${emailContext.from?.address || ""}>\nSubject: ${emailContext.subject}\nDate: ${emailContext.date}\n\nEmail body:\n${(emailContext.text || emailContext.html?.replace(/<[^>]+>/g, " ") || "").substring(0, 2000)}\n\nHelp the user with this email — summarize, draft replies, suggest actions, answer questions about it.`
    : `You are a personal email assistant for ${account.displayName || "the user"} (${account.email || ""}). Help manage their email — triage, draft replies, suggest actions, answer questions. Be concise.`;

  const response = await client.messages.create({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 1024,
    system: systemMsg,
    messages: conversationHistory,
  });

  const reply = response.content[0]?.text || "No response";
  conversationHistory.push({ role: "assistant", content: reply });

  return reply;
}

ipcMain.handle("ai-get-key", () => {
  return store.get("anthropic_api_key") ? "••••••••" : "";
});

ipcMain.handle("ai-save-key", (_, key) => {
  if (key && key !== "••••••••") {
    store.set("anthropic_api_key", key);
    anthropicClient = null;
  }
  return { ok: true };
});

ipcMain.handle("ai-verify-key", async () => {
  try {
    const client = getAnthropicClient();
    const response = await client.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 10,
      messages: [{ role: "user", content: "Say OK" }],
    });
    return { ok: true, message: "API key verified" };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle("sms-get-config", () => {
  return {
    smsTo: store.get("sms_to") || "",
    smsCarrier: store.get("sms_carrier") || "rogers",
  };
});

ipcMain.handle("sms-save-config", (_, cfg) => {
  if (cfg.smsTo) store.set("sms_to", cfg.smsTo);
  if (cfg.smsCarrier) store.set("sms_carrier", cfg.smsCarrier);
  return { ok: true };
});

ipcMain.handle("sms-test", async (_, msg) => {
  try {
    await sendSMS(msg || "GideonMail test: SMS notifications are working.");
    return { ok: true };
  } catch (e) { return { error: e.message }; }
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
  if (imapClient) {
    try { await imapClient.logout(); } catch (e) {}
  }
});
