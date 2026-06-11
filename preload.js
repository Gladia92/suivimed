const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  readData:      (filename)          => ipcRenderer.invoke("read-data", filename),
  writeData:     (filename, content) => ipcRenderer.invoke("write-data", filename, content),
  listData:      ()                  => ipcRenderer.invoke("list-data"),
  getDataDir:    ()                  => ipcRenderer.invoke("get-data-dir"),
  chooseDataDir: ()                  => ipcRenderer.invoke("choose-data-dir"),
  exportJSON:    (content)           => ipcRenderer.invoke("export-json", content),
  importJSON:    ()                  => ipcRenderer.invoke("import-json"),
  // Ollama
  // Sync Google Drive
  gdriveSignIn:  ()                  => ipcRenderer.invoke("gdrive-signin"),
  gdriveSignOut: ()                  => ipcRenderer.invoke("gdrive-signout"),
  gdriveStatus:  ()                  => ipcRenderer.invoke("gdrive-status"),
  gdrivePull:    ()                  => ipcRenderer.invoke("gdrive-pull"),
  gdrivePush:    ()                  => ipcRenderer.invoke("gdrive-push"),
  ollamaStatus:  ()                  => ipcRenderer.invoke("ollama-status"),
  ollamaSetup:   ()                  => ipcRenderer.invoke("ollama-setup"),
  ollamaStart:   ()                  => ipcRenderer.invoke("ollama-start"),
  ollamaAnalyze: (prompt)            => ipcRenderer.invoke("ollama-analyze", prompt),
  onOllamaProgress: (cb)             => ipcRenderer.on("ollama-progress", (_e, data) => cb(data)),
});
