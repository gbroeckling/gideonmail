const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification } = require("electron");
const path = require("path");
const Store = require("electron-store");
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

// ── IDLE (push notifications) ───────────────────────────────────────────────
let idleActive = false;

async function startIdle() {
  if (idleActive) return;
  const cfg = store.get("account");
  if (!cfg) return;

  try {
    const client = await getImapClient();
    idleActive = true;

    // Re-check inbox every 2 minutes (IDLE keepalive)
    const interval = setInterval(async () => {
      try {
        const result = await fetchInbox(0, 50);
        mainWindow?.webContents?.send("inbox-updated", result);
      } catch (e) {
        // reconnect on next cycle
      }
    }, 120000);

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
