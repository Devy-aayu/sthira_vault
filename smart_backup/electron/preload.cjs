const { contextBridge, ipcRenderer } = require('electron');

const api = Object.freeze({
  getState: () => ipcRenderer.invoke('backup:get-state'),
  getAutomationStatus: () => ipcRenderer.invoke('automation:get-status'),
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),
  selectFiles: () => ipcRenderer.invoke('dialog:select-files'),
  addFolder: (folderPath) => ipcRenderer.invoke('backup:add-folder', { folderPath }),
  removeFolder: (folderId) => ipcRenderer.invoke('backup:remove-folder', { folderId }),
  startBackup: (folderId = null) => ipcRenderer.invoke('backup:start', { folderId }),
  analyzeSmartBackup: (folderId = null) => ipcRenderer.invoke('smart:analyze', { folderId }),
  retryInterrupted: (interruptedId) => ipcRenderer.invoke('backup:retry', { interruptedId }),
  retryAllInterrupted: () => ipcRenderer.invoke('backup:retry-all'),
  clearInterrupted: (interruptedId) => ipcRenderer.invoke('backup:clear-interrupted', { interruptedId }),
  manualUpload: (filePaths) => ipcRenderer.invoke('backup:manual-upload', { filePaths }),
  listBackups: (query = '') => ipcRenderer.invoke('backup:list-files', { query }),
  listBackupFolders: (query = '') => ipcRenderer.invoke('backup:list-folders', { query }),
  listFolderContent: (folderId, query = '') => ipcRenderer.invoke('backup:list-folder-content', { folderId, query }),
  restoreFile: (fileId) => ipcRenderer.invoke('backup:restore', { fileId }),
  restoreFolder: (folderId) => ipcRenderer.invoke('backup:restore-folder', { folderId }),
  restoreDirectory: (folderId, relativePath) => ipcRenderer.invoke('backup:restore-directory', { folderId, relativePath }),
  deleteBackupItem: (selection) => ipcRenderer.invoke('backup:delete-item', selection),
  restoreAll: () => ipcRenderer.invoke('backup:restore-all'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  testStorage: (settings) => ipcRenderer.invoke('settings:test-storage', settings),
  saveOAuthAppConfig: (provider, config) => ipcRenderer.invoke('oauth:save-app-config', { provider, ...config }),
  connectCloudProvider: (provider) => ipcRenderer.invoke('cloud:connect', { provider }),
  disconnectCloudProvider: (provider) => ipcRenderer.invoke('cloud:disconnect', { provider }),
  onProgress: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('backup:progress', wrapped);
    return () => ipcRenderer.removeListener('backup:progress', wrapped);
  },
  onRestoreProgress: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('restore:progress', wrapped);
    return () => ipcRenderer.removeListener('restore:progress', wrapped);
  },
  onStateChanged: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('backup:state-changed', wrapped);
    return () => ipcRenderer.removeListener('backup:state-changed', wrapped);
  }
});

contextBridge.exposeInMainWorld('backupApp', api);
