const path = require('node:path');
const { safeStorage } = require('electron');
const { LocalVault } = require('./local-vault.cjs');
const { S3Vault } = require('./s3-vault.cjs');
const { GoogleDriveVault } = require('./google-drive-vault.cjs');
const { OneDriveVault } = require('./onedrive-vault.cjs');
const { DropboxVault } = require('./dropbox-vault.cjs');
const { PCloudVault } = require('./pcloud-vault.cjs');
const { WebDavVault } = require('./webdav-vault.cjs');
const { getOAuthApps } = require('../oauth/oauth-apps.cjs');
const { OAuthTokenSession } = require('../oauth/oauth-utils.cjs');

function decryptSecret(secretEncrypted) {
  if (!secretEncrypted) return '';
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows secure credential encryption is unavailable.');
  }
  return safeStorage.decryptString(Buffer.from(secretEncrypted, 'base64'));
}

function createVault(state, appDataPath, { store = null } = {}) {
  const settings = state.settings;
  if (settings.provider === 's3') {
    const secretAccessKey = decryptSecret(settings.s3.secretEncrypted);
    if (!settings.s3.bucket || !settings.s3.accessKeyId || !secretAccessKey) {
      throw new Error('S3 cloud storage settings are incomplete.');
    }
    return new S3Vault({
      ...settings.s3,
      secretAccessKey
    });
  }

  if (settings.provider === 'google-drive') {
    const apps = getOAuthApps();
    if (!apps.google.clientId) {
      throw new Error('Google Drive is not configured in this build.');
    }
    if (!settings.googleDrive?.tokenEncrypted) {
      throw new Error('Connect a Google Drive account in Settings first.');
    }
    return new GoogleDriveVault({
      tokenSession: new OAuthTokenSession({
        provider: 'google-drive',
        encryptedToken: settings.googleDrive.tokenEncrypted,
        appConfig: apps.google,
        store
      })
    });
  }

  if (settings.provider === 'onedrive') {
    const apps = getOAuthApps();
    if (!apps.microsoft.clientId) {
      throw new Error('OneDrive is not configured in this build.');
    }
    if (!settings.oneDrive?.tokenEncrypted) {
      throw new Error('Connect a OneDrive account in Settings first.');
    }
    return new OneDriveVault({
      tokenSession: new OAuthTokenSession({
        provider: 'onedrive',
        encryptedToken: settings.oneDrive.tokenEncrypted,
        appConfig: apps.microsoft,
        store
      })
    });
  }


  if (settings.provider === 'dropbox') {
    const apps = getOAuthApps();
    if (!apps.dropbox.clientId) {
      throw new Error('Dropbox is not configured in this build.');
    }
    if (!settings.dropbox?.tokenEncrypted) {
      throw new Error('Connect a Dropbox account in Settings first.');
    }
    return new DropboxVault({
      tokenSession: new OAuthTokenSession({
        provider: 'dropbox',
        encryptedToken: settings.dropbox.tokenEncrypted,
        appConfig: apps.dropbox,
        store
      })
    });
  }

  if (settings.provider === 'pcloud') {
    const apps = getOAuthApps();
    if (!apps.pcloud.clientId) {
      throw new Error('pCloud is not configured in this build.');
    }
    if (!settings.pCloud?.tokenEncrypted) {
      throw new Error('Connect a pCloud account in Settings first.');
    }
    return new PCloudVault({
      tokenSession: new OAuthTokenSession({
        provider: 'pcloud',
        encryptedToken: settings.pCloud.tokenEncrypted,
        appConfig: apps.pcloud,
        store
      })
    });
  }

  if (settings.provider === 'webdav') {
    const password = decryptSecret(settings.webdav?.passwordEncrypted);
    if (!settings.webdav?.baseUrl || !password) {
      throw new Error('WebDAV settings are incomplete. Enter the server URL and app password.');
    }
    return new WebDavVault({
      baseUrl: settings.webdav.baseUrl,
      username: settings.webdav.username || '',
      password
    });
  }

  const vaultPath = settings.localVaultPath || path.join(appDataPath, 'local-vault');
  return new LocalVault(vaultPath);
}

function createVaultForProvider(state, provider, appDataPath, options = {}) {
  const providerState = structuredClone(state);
  providerState.settings.provider = provider || state.settings.provider || 'local';
  return createVault(providerState, appDataPath, options);
}

module.exports = { createVault, createVaultForProvider };
