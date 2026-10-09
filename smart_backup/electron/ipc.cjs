const path = require('node:path');
const fs = require('node:fs');
const { app, dialog, ipcMain, safeStorage, BrowserWindow } = require('electron');
const { randomUUID } = require('node:crypto');
const { StateStore } = require('./state-store.cjs');
const { BackupEngine } = require('./backup-engine.cjs');
const { createVault, createVaultForProvider } = require('./storage/vault-factory.cjs');
const { assertExistingDirectory, assertExistingFile } = require('./path-safety.cjs');
const {
  buildDirectoryRestorePlan,
  buildRestorePlan,
  executeRestorePlan,
  listBackupFolders,
  listFolderContent,
  restoreRecordToPath
} = require('./restore-service.cjs');
const { deleteBackupSelection, describeDeleteSelection } = require('./delete-service.cjs');
const { BackupAutomation } = require('./backup-automation.cjs');
const { connectCloudProvider, disconnectCloudProvider } = require('./oauth/oauth-manager.cjs');
const { getOAuthAvailability } = require('./oauth/oauth-apps.cjs');

function publicState(state) {
  const copy = structuredClone(state);
  copy.settings.s3.secretEncrypted = '';
  copy.settings.s3.hasSecret = Boolean(state.settings.s3.secretEncrypted);

  copy.settings.oauthApps ||= {
    google: { clientId: '', clientSecretEncrypted: '' },
    microsoft: { clientId: '' },
    dropbox: { clientId: '' },
    pcloud: { clientId: '' }
  };
  copy.settings.oauthApps.google.clientSecretEncrypted = '';
  copy.settings.oauthApps.google.hasClientSecret = Boolean(
    state.settings.oauthApps?.google?.clientSecretEncrypted
  );

  copy.settings.googleDrive.tokenEncrypted = '';
  copy.settings.googleDrive.connected = Boolean(state.settings.googleDrive.tokenEncrypted);
  copy.settings.oneDrive.tokenEncrypted = '';
  copy.settings.oneDrive.connected = Boolean(state.settings.oneDrive.tokenEncrypted);
  copy.settings.dropbox.tokenEncrypted = '';
  copy.settings.dropbox.connected = Boolean(state.settings.dropbox.tokenEncrypted);
  copy.settings.pCloud.tokenEncrypted = '';
  copy.settings.pCloud.connected = Boolean(state.settings.pCloud.tokenEncrypted);
  copy.settings.webdav.passwordEncrypted = '';
  copy.settings.webdav.hasPassword = Boolean(state.settings.webdav.passwordEncrypted);
  copy.cloudProviderAvailability = getOAuthAvailability(state.settings.oauthApps || {});
  return copy;
}

const OAUTH_APP_KEYS = Object.freeze({
  'google-drive': 'google',
  onedrive: 'microsoft',
  dropbox: 'dropbox',
  pcloud: 'pcloud'
});

function validateOAuthClientId(provider, value) {
  const clientId = String(value || '').trim();
  if (!clientId) throw new Error('Enter the provider application client ID first.');
  if (clientId.length > 512) throw new Error('Provider application client ID is too long.');

  if (provider === 'google-drive' && !clientId.endsWith('.apps.googleusercontent.com')) {
    throw new Error('Google desktop OAuth client IDs normally end with .apps.googleusercontent.com.');
  }
  if (provider === 'onedrive' && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(clientId)) {
    throw new Error('Microsoft Application (client) ID must be a valid GUID.');
  }
  return clientId;
}

function emitToAll(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function registerIpcHandlers() {
  const appDataPath = app.getPath('userData');
  const store = new StateStore(path.join(appDataPath, 'state.json'), {
    settings: {
      localVaultPath: path.join(appDataPath, 'local-vault')
    }
  });

  const engine = new BackupEngine({
    store,
    appDataPath,
    vaultFactory: createVault,
    progress: (payload) => emitToAll('backup:progress', payload),
    stateChanged: () => emitToAll('backup:state-changed', publicState(store.get()))
  });

  async function restoreWithPlan(title, buildPlan) {
    const state = store.get();
    const result = await dialog.showOpenDialog({
      title,
      buttonLabel: 'Restore here',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };

    const destinationRoot = result.filePaths[0];
    const plan = buildPlan(state, destinationRoot);
    let conflictPolicy = 'skip';

    if (plan.existingCount > 0) {
      const choice = await dialog.showMessageBox({
        type: 'warning',
        title: 'Existing files found',
        message: `${plan.existingCount} destination file(s) already exist.`,
        detail: 'Choose whether existing files should be skipped or replaced after the restored copy passes its SHA-256 integrity check.',
        buttons: ['Skip existing files', 'Overwrite existing files', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      });
      if (choice.response === 2) return { canceled: true };
      conflictPolicy = choice.response === 1 ? 'overwrite' : 'skip';
    }

    const vaultCache = new Map();
    const vaultResolver = (provider) => {
      const key = provider || 'local';
      if (!vaultCache.has(key)) {
        vaultCache.set(key, createVaultForProvider(state, key, appDataPath, { store }));
      }
      return vaultCache.get(key);
    };
    const summary = await executeRestorePlan({
      plan,
      vaultResolver,
      conflictPolicy,
      progress: (payload) => emitToAll('restore:progress', payload)
    });
    return { canceled: false, ...summary };
  }

  function restoreFolders(folderIds, title) {
    return restoreWithPlan(title, (state, destinationRoot) =>
      buildRestorePlan(state, folderIds, destinationRoot)
    );
  }

  ipcMain.handle('backup:get-state', () => publicState(store.get()));

  ipcMain.handle('dialog:select-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('dialog:select-files', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections']
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('backup:add-folder', (_event, payload) => {
    const folderPath = assertExistingDirectory(payload?.folderPath);
    const current = store.get();
    if (current.folders.some((folder) => folder.path.toLowerCase() === folderPath.toLowerCase())) {
      return publicState(current);
    }
    store.update((state) => {
      state.folders.push({
        id: randomUUID(),
        name: path.basename(folderPath),
        path: folderPath,
        addedAt: new Date().toISOString()
      });
    });
    return publicState(store.get());
  });

  ipcMain.handle('backup:remove-folder', (_event, payload) => {
    if (typeof payload?.folderId !== 'string') throw new Error('Invalid folder identifier.');
    store.update((state) => {
      state.folders = state.folders.filter((folder) => folder.id !== payload.folderId);
    });
    return publicState(store.get());
  });

  ipcMain.handle('backup:start', (_event, payload) => engine.run({
    folderId: payload?.folderId || null,
    trigger: 'manual'
  }));

  ipcMain.handle('smart:analyze', (_event, payload) => engine.analyze({
    folderId: payload?.folderId || null
  }));

  ipcMain.handle('backup:manual-upload', (_event, payload) => {
    if (!Array.isArray(payload?.filePaths) || payload.filePaths.length > 100) {
      throw new Error('Invalid file selection.');
    }
    payload.filePaths.forEach(assertExistingFile);
    return engine.manualUpload(payload.filePaths);
  });

  ipcMain.handle('backup:retry', (_event, payload) => engine.retry(payload?.interruptedId));

  ipcMain.handle('backup:retry-all', async () => {
    const ids = store.get().interrupted.map((entry) => entry.id);
    const results = [];
    for (const id of ids) {
      try {
        await engine.retry(id);
        results.push({ id, ok: true });
      } catch (error) {
        results.push({ id, ok: false, error: error.message });
      }
    }
    return results;
  });

  ipcMain.handle('backup:clear-interrupted', (_event, payload) => {
    store.update((state) => {
      state.interrupted = state.interrupted.filter((entry) => entry.id !== payload?.interruptedId);
    });
    return publicState(store.get());
  });

  ipcMain.handle('backup:list-files', (_event, payload) => {
    const query = String(payload?.query || '').trim().toLowerCase();
    const files = store.get().files;
    const filtered = query
      ? files.filter((file) =>
          file.relativePath.toLowerCase().includes(query) ||
          file.folderName.toLowerCase().includes(query)
        )
      : files;
    return filtered.sort((a, b) => b.backedUpAt.localeCompare(a.backedUpAt));
  });

  ipcMain.handle('backup:list-folders', (_event, payload) => {
    return listBackupFolders(store.get(), payload?.query || '');
  });

  ipcMain.handle('backup:list-folder-content', (_event, payload) => {
    if (typeof payload?.folderId !== 'string') throw new Error('Invalid folder identifier.');
    return listFolderContent(store.get(), payload.folderId, payload?.query || '');
  });

  ipcMain.handle('backup:restore', async (_event, payload) => {
    const state = store.get();
    const file = state.files.find((item) => item.id === payload?.fileId);
    if (!file) throw new Error('Backup file not found.');

    const result = await dialog.showSaveDialog({
      defaultPath: path.basename(file.relativePath),
      properties: ['createDirectory', 'showOverwriteConfirmation']
    });
    if (result.canceled || !result.filePath) return { canceled: true };

    const vault = createVaultForProvider(state, file.provider || 'local', appDataPath, { store });
    await restoreRecordToPath({
      vault,
      record: file,
      destinationPath: result.filePath,
      overwrite: fs.existsSync(result.filePath)
    });
    return { canceled: false, restoredTo: result.filePath };
  });

  ipcMain.handle('backup:restore-folder', async (_event, payload) => {
    if (typeof payload?.folderId !== 'string') throw new Error('Invalid folder identifier.');
    const available = listBackupFolders(store.get()).some((folder) => folder.id === payload.folderId);
    if (!available) throw new Error('Backup folder not found.');
    return restoreFolders([payload.folderId], 'Choose where to restore this folder');
  });


  ipcMain.handle('backup:restore-directory', async (_event, payload) => {
    if (typeof payload?.folderId !== 'string') throw new Error('Invalid folder identifier.');
    if (typeof payload?.relativePath !== 'string' || !payload.relativePath.trim()) {
      throw new Error('Invalid folder path.');
    }
    const content = listFolderContent(store.get(), payload.folderId);
    if (!content.directories.includes(payload.relativePath)) throw new Error('Backup folder not found.');
    return restoreWithPlan('Choose where to restore this folder', (state, destinationRoot) =>
      buildDirectoryRestorePlan(state, payload.folderId, payload.relativePath, destinationRoot)
    );
  });

  ipcMain.handle('backup:restore-all', async () => {
    const folderIds = listBackupFolders(store.get()).map((folder) => folder.id);
    if (!folderIds.length) throw new Error('No backup folders are available to restore.');
    return restoreFolders(folderIds, 'Choose where to restore all backup folders');
  });

  ipcMain.handle('backup:delete-item', async (_event, payload) => {
    const state = store.get();
    const selection = describeDeleteSelection(state, payload || {});
    const noun = selection.kind === 'file'
      ? 'file'
      : selection.kind === 'directory'
        ? 'folder'
        : 'backup folder';
    const choice = await dialog.showMessageBox({
      type: 'warning',
      title: `Delete ${noun}?`,
      message: `Delete “${selection.targetName}” from the backup catalog?`,
      detail: `${selection.versionCount} stored version(s) will be permanently deleted from the active backup storage. The original source on your computer will not be deleted. If the source is still protected, a later backup can add it again.`,
      buttons: ['Cancel', 'Delete backup'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (choice.response !== 1) return { canceled: true };

    const vaultCache = new Map();
    const vaultResolver = (provider) => {
      const key = provider || 'local';
      if (!vaultCache.has(key)) {
        vaultCache.set(key, createVaultForProvider(state, key, appDataPath, { store }));
      }
      return vaultCache.get(key);
    };
    const result = await deleteBackupSelection({
      store,
      state,
      vaultResolver,
      selection
    });
    emitToAll('backup:state-changed', publicState(store.get()));
    return { canceled: false, ...result };
  });

  ipcMain.handle('settings:save', (_event, payload) => {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid settings.');

    store.update((state) => {
      const allowedProviders = new Set(['local', 's3', 'google-drive', 'onedrive', 'dropbox', 'pcloud', 'webdav']);
      const provider = allowedProviders.has(payload.provider) ? payload.provider : 'local';
      state.settings.provider = provider;
      state.settings.autoBackup = Boolean(payload.autoBackup);
      state.settings.scheduleMinutes = Math.max(5, Math.min(1440, Number(payload.scheduleMinutes) || 30));
      state.settings.watchChanges = Boolean(payload.watchChanges);
      state.settings.changeDebounceMinutes = Math.max(1, Math.min(1440, Number(payload.changeDebounceMinutes) || 10));
      state.settings.runInBackground = payload.runInBackground !== false;
      state.settings.launchAtLogin = Boolean(payload.launchAtLogin);
      state.settings.startMinimized = Boolean(
        state.settings.runInBackground &&
        state.settings.launchAtLogin &&
        payload.startMinimized
      );
      state.settings.maxConcurrentUploads = Math.max(
        1,
        Math.min(6, Number(payload.maxConcurrentUploads) || 3)
      );

      const smart = payload.smartBackup && typeof payload.smartBackup === 'object'
        ? payload.smartBackup
        : {};
      state.settings.smartBackup = {
        ...state.settings.smartBackup,
        enabled: smart.enabled !== false,
        profile: ['essential', 'balanced', 'everything'].includes(smart.profile)
          ? smart.profile
          : 'balanced',
        maxFileSizeMB: Number.isFinite(Number(smart.maxFileSizeMB))
          ? Math.max(0, Math.min(102400, Number(smart.maxFileSizeMB)))
          : 1024,
        includeLargeMedia: Boolean(smart.includeLargeMedia),
        includeArchives: Boolean(smart.includeArchives),
        skipTemporaryFiles: smart.skipTemporaryFiles !== false,
        skipGeneratedFolders: smart.skipGeneratedFolders !== false
      };

      if (Array.isArray(payload.exclusions)) {
        state.settings.exclusions = [...new Set(
          payload.exclusions
            .map((item) => String(item || '').trim())
            .filter(Boolean)
            .slice(0, 100)
        )];
      }

      if (typeof payload.localVaultPath === 'string' && payload.localVaultPath.trim()) {
        state.settings.localVaultPath = path.resolve(payload.localVaultPath);
      }

      if (payload.s3 && typeof payload.s3 === 'object') {
        state.settings.s3.endpoint = String(payload.s3.endpoint || '').trim();
        state.settings.s3.region = String(payload.s3.region || 'auto').trim();
        state.settings.s3.bucket = String(payload.s3.bucket || '').trim();
        state.settings.s3.accessKeyId = String(payload.s3.accessKeyId || '').trim();
        state.settings.s3.forcePathStyle = Boolean(payload.s3.forcePathStyle);

        const secret = String(payload.s3.secretAccessKey || '');
        if (secret) {
          if (!safeStorage.isEncryptionAvailable()) {
            throw new Error('Secure credential storage is unavailable.');
          }
          state.settings.s3.secretEncrypted = safeStorage.encryptString(secret).toString('base64');
        }
      }

      if (payload.webdav && typeof payload.webdav === 'object') {
        state.settings.webdav.baseUrl = String(payload.webdav.baseUrl || '').trim();
        state.settings.webdav.username = String(payload.webdav.username || '').trim();
        const password = String(payload.webdav.password || '');
        if (password) {
          if (!safeStorage.isEncryptionAvailable()) {
            throw new Error('Secure credential storage is unavailable.');
          }
          state.settings.webdav.passwordEncrypted = safeStorage.encryptString(password).toString('base64');
        }
      }
    });
    emitToAll('backup:state-changed', publicState(store.get()));
    return publicState(store.get());
  });

  ipcMain.handle('oauth:save-app-config', (_event, payload) => {
    const provider = String(payload?.provider || '');
    const settingsKey = OAUTH_APP_KEYS[provider];
    if (!settingsKey) throw new Error('Unsupported cloud provider configuration.');

    const clientId = validateOAuthClientId(provider, payload?.clientId);
    const clientSecret = String(payload?.clientSecret || '').trim();
    if (clientSecret.length > 2048) throw new Error('Provider client secret is too long.');

    store.update((state) => {
      state.settings.oauthApps ||= {
        google: { clientId: '', clientSecretEncrypted: '' },
        microsoft: { clientId: '' },
        dropbox: { clientId: '' },
        pcloud: { clientId: '' }
      };
      state.settings.oauthApps[settingsKey] ||= {};
      state.settings.oauthApps[settingsKey].clientId = clientId;

      if (provider === 'google-drive') {
        if (payload?.clearClientSecret) {
          state.settings.oauthApps.google.clientSecretEncrypted = '';
        } else if (clientSecret) {
          if (!safeStorage.isEncryptionAvailable()) {
            throw new Error('Secure provider configuration storage is unavailable.');
          }
          state.settings.oauthApps.google.clientSecretEncrypted = safeStorage
            .encryptString(clientSecret)
            .toString('base64');
        }
      }
    });

    const result = publicState(store.get());
    emitToAll('backup:state-changed', result);
    return {
      ok: true,
      provider,
      availability: result.cloudProviderAvailability,
      message: `${provider === 'google-drive' ? 'Google Drive' : provider === 'onedrive' ? 'OneDrive' : provider === 'dropbox' ? 'Dropbox' : 'pCloud'} application configuration saved.`
    };
  });

  ipcMain.handle('cloud:connect', async (_event, payload) => {
    const provider = String(payload?.provider || '');
    const result = await connectCloudProvider({ provider, store });
    emitToAll('backup:state-changed', publicState(store.get()));
    return result;
  });

  ipcMain.handle('cloud:disconnect', (_event, payload) => {
    const provider = String(payload?.provider || '');
    const result = disconnectCloudProvider({ provider, store });
    emitToAll('backup:state-changed', publicState(store.get()));
    return result;
  });

  ipcMain.handle('settings:test-storage', async (_event, payload) => {
    const tempState = store.get();
    const provider = String(payload?.provider || 'local');
    if (provider === 's3') {
      tempState.settings.provider = 's3';
      tempState.settings.s3 = {
        ...tempState.settings.s3,
        endpoint: String(payload.s3?.endpoint || '').trim(),
        region: String(payload.s3?.region || 'auto').trim(),
        bucket: String(payload.s3?.bucket || '').trim(),
        accessKeyId: String(payload.s3?.accessKeyId || '').trim(),
        forcePathStyle: Boolean(payload.s3?.forcePathStyle)
      };
      if (payload.s3?.secretAccessKey) {
        tempState.settings.s3.secretEncrypted = safeStorage
          .encryptString(String(payload.s3.secretAccessKey))
          .toString('base64');
      }
    } else if (provider === 'google-drive' || provider === 'onedrive' || provider === 'dropbox' || provider === 'pcloud') {
      tempState.settings.provider = provider;
    } else if (provider === 'webdav') {
      tempState.settings.provider = 'webdav';
      tempState.settings.webdav = {
        ...tempState.settings.webdav,
        baseUrl: String(payload.webdav?.baseUrl || '').trim(),
        username: String(payload.webdav?.username || '').trim()
      };
      if (payload.webdav?.password) {
        tempState.settings.webdav.passwordEncrypted = safeStorage
          .encryptString(String(payload.webdav.password))
          .toString('base64');
      }
    } else {
      tempState.settings.provider = 'local';
      tempState.settings.localVaultPath = path.resolve(
        payload?.localVaultPath || tempState.settings.localVaultPath
      );
    }
    return createVault(tempState, appDataPath, { store }).testConnection();
  });

  return { store, engine };
}

function createScheduler({ store, engine }, onAutomationEvent = () => {}) {
  const automation = new BackupAutomation({
    store,
    engine,
    emit: (payload) => {
      emitToAll('backup:progress', payload);
      onAutomationEvent(payload);
    }
  });
  automation.start();
  ipcMain.removeHandler('automation:get-status');
  ipcMain.handle('automation:get-status', () => automation.getStatus());
  return automation;
}

module.exports = { registerIpcHandlers, createScheduler };
