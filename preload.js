const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gideon", {
  getAccount:      ()           => ipcRenderer.invoke("get-account"),
  saveAccount:     (cfg)        => ipcRenderer.invoke("save-account", cfg),
  testConnection:  ()           => ipcRenderer.invoke("test-connection"),
  fetchInbox:      (page)       => ipcRenderer.invoke("fetch-inbox", page),
  fetchMessage:    (uid)        => ipcRenderer.invoke("fetch-message", uid),
  fetchAttachment: (uid, name)  => ipcRenderer.invoke("fetch-attachment", uid, name),
  sendMail:        (opts)       => ipcRenderer.invoke("send-mail", opts),
  deleteMessage:   (uid)        => ipcRenderer.invoke("delete-message", uid),
  toggleFlag:      (uid, flag)  => ipcRenderer.invoke("toggle-flag", uid, flag),
  listFolders:     ()           => ipcRenderer.invoke("list-folders"),
  fetchFolder:     (path, page) => ipcRenderer.invoke("fetch-folder", path, page),
  searchMessages:  (query)      => ipcRenderer.invoke("search-messages", query),

  // SMS Notifications
  smsGetConfig:  ()        => ipcRenderer.invoke("sms-get-config"),
  smsSaveConfig: (cfg)     => ipcRenderer.invoke("sms-save-config", cfg),
  smsTest:       (msg)     => ipcRenderer.invoke("sms-test", msg),

  // AI Assistant
  aiVerifyKey:   ()              => ipcRenderer.invoke("ai-verify-key"),
  aiGetKey:      ()              => ipcRenderer.invoke("ai-get-key"),
  aiSaveKey:     (key)           => ipcRenderer.invoke("ai-save-key", key),
  aiTriage:      (msgs)          => ipcRenderer.invoke("ai-triage", msgs),
  aiAnalyze:     (email)         => ipcRenderer.invoke("ai-analyze", email),
  aiDraftReply:  (email, instr)  => ipcRenderer.invoke("ai-draft-reply", email, instr),
  aiChat:        (msg, ctx)      => ipcRenderer.invoke("ai-chat", msg, ctx),
  aiClearHistory:()              => ipcRenderer.invoke("ai-clear-history"),

  onInboxUpdated: (cb) => {
    ipcRenderer.on("inbox-updated", (_, data) => cb(data));
  },
});
