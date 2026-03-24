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

  onInboxUpdated: (cb) => {
    ipcRenderer.on("inbox-updated", (_, data) => cb(data));
  },
});
