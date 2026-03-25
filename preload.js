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

  // Security filters
  securityFiltersGet:  () => ipcRenderer.invoke("security-filters-get"),
  securityFiltersSave: (f) => ipcRenderer.invoke("security-filters-save", f),

  // Auto-check interval
  autocheckGet:  () => ipcRenderer.invoke("autocheck-get"),
  autocheckSave: (c) => ipcRenderer.invoke("autocheck-save", c),

  // Auto-launch
  autolaunchGet: () => ipcRenderer.invoke("autolaunch-get"),
  autolaunchSet: (on) => ipcRenderer.invoke("autolaunch-set", on),

  // SMS Delivery Settings
  smsSettingsGet:  ()    => ipcRenderer.invoke("sms-settings-get"),
  smsSettingsSave: (cfg) => ipcRenderer.invoke("sms-settings-save", cfg),

  // SMS Whitelist
  whitelistGet:    ()          => ipcRenderer.invoke("whitelist-get"),
  whitelistAdd:    (entry)     => ipcRenderer.invoke("whitelist-add", entry),
  whitelistRemove: (id)        => ipcRenderer.invoke("whitelist-remove", id),
  whitelistToggle: (id)        => ipcRenderer.invoke("whitelist-toggle", id),
  whitelistUpdate: (id, u)     => ipcRenderer.invoke("whitelist-update", id, u),

  // Check Now (debug)
  checkNow: () => ipcRenderer.invoke("check-now"),

  // Blacklist & Greylist
  blacklistGet:    ()        => ipcRenderer.invoke("blacklist-get"),
  blacklistAdd:    (e)       => ipcRenderer.invoke("blacklist-add", e),
  blacklistRemove: (id)      => ipcRenderer.invoke("blacklist-remove", id),
  blacklistToggle: (id)      => ipcRenderer.invoke("blacklist-toggle", id),
  blacklistUpdate: (id, u)   => ipcRenderer.invoke("blacklist-update", id, u),
  greylistGet:     ()        => ipcRenderer.invoke("greylist-get"),
  greylistAdd:     (e)       => ipcRenderer.invoke("greylist-add", e),
  greylistRemove:  (id)      => ipcRenderer.invoke("greylist-remove", id),
  greylistToggle:  (id)      => ipcRenderer.invoke("greylist-toggle", id),
  greylistUpdate:  (id, u)   => ipcRenderer.invoke("greylist-update", id, u),
  senderStatusBulk:(msgs)    => ipcRenderer.invoke("sender-list-status-bulk", msgs),

  // Conversation Alerts
  convoGetConfig:  ()    => ipcRenderer.invoke("convo-get-config"),
  convoSaveConfig: (cfg) => ipcRenderer.invoke("convo-save-config", cfg),
  convoTest:       ()    => ipcRenderer.invoke("convo-test"),

  // Standing Instructions
  instructionsGet:    ()      => ipcRenderer.invoke("instructions-get"),
  instructionsAdd:    (text)  => ipcRenderer.invoke("instructions-add", text),
  instructionsRemove: (id)    => ipcRenderer.invoke("instructions-remove", id),
  instructionsToggle: (id)    => ipcRenderer.invoke("instructions-toggle", id),
  instructionsUpdate: (id, t) => ipcRenderer.invoke("instructions-update", id, t),

  onInboxUpdated: (cb) => {
    ipcRenderer.on("inbox-updated", (_, data) => cb(data));
  },
});
