const crypto = require('node:crypto');
const { safeStorage } = require('electron');

function base64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/g, '');
}

function createPkce() {
  const verifier = base64Url(crypto.randomBytes(64));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function encryptJson(value) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows secure credential storage is unavailable.');
  }
  return safeStorage.encryptString(JSON.stringify(value)).toString('base64');
}

function decryptJson(encrypted) {
  if (!encrypted) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows secure credential storage is unavailable.');
  }
  const json = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  return JSON.parse(json);
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(payload, fallback) {
  if (!payload) return fallback;
  if (typeof payload === 'string') return payload.slice(0, 500);
  return (
    payload.error_description ||
    payload.error?.message ||
    payload.error?.error_summary ||
    payload.error ||
    payload.message ||
    fallback
  );
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await parseResponse(response);
  if (!response.ok) {
    const error = new Error(errorMessage(payload, `Cloud request failed with HTTP ${response.status}.`));
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function formBody(values) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') {
      form.set(key, String(value));
    }
  }
  return form;
}

function providerSettingsKey(provider) {
  if (provider === 'google-drive') return 'googleDrive';
  if (provider === 'onedrive') return 'oneDrive';
  if (provider === 'dropbox') return 'dropbox';
  if (provider === 'pcloud') return 'pCloud';
  throw new Error(`Unsupported OAuth provider: ${provider}`);
}

function persistTokenBundle(store, provider, bundle) {
  if (!store) return;
  const key = providerSettingsKey(provider);
  store.update((state) => {
    state.settings[key].tokenEncrypted = encryptJson(bundle);
  });
}

class OAuthTokenSession {
  constructor({ provider, encryptedToken, appConfig, store = null }) {
    this.provider = provider;
    this.appConfig = appConfig;
    this.store = store;
    this.bundle = decryptJson(encryptedToken);
    if (!this.bundle?.refreshToken && !this.bundle?.accessToken) {
      const providerName = provider === 'google-drive' ? 'Google Drive' : provider === 'onedrive' ? 'OneDrive' : provider === 'dropbox' ? 'Dropbox' : 'pCloud';
      throw new Error(`Connect ${providerName} in Settings first.`);
    }
  }

  async refresh() {
    let token;
    if (this.provider === 'google-drive') {
      token = await fetchJson('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({
          client_id: this.appConfig.clientId,
          client_secret: this.appConfig.clientSecret || undefined,
          refresh_token: this.bundle.refreshToken,
          grant_type: 'refresh_token'
        })
      });
    } else if (this.provider === 'onedrive') {
      token = await fetchJson('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({
          client_id: this.appConfig.clientId,
          refresh_token: this.bundle.refreshToken,
          grant_type: 'refresh_token',
          scope: 'openid profile email offline_access User.Read Files.ReadWrite.AppFolder'
        })
      });
    } else if (this.provider === 'dropbox') {
      token = await fetchJson('https://api.dropboxapi.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({
          client_id: this.appConfig.clientId,
          refresh_token: this.bundle.refreshToken,
          grant_type: 'refresh_token'
        })
      });
    } else {
      throw new Error(`Unsupported OAuth provider: ${this.provider}`);
    }

    this.bundle = {
      ...this.bundle,
      accessToken: token.access_token,
      refreshToken: token.refresh_token || this.bundle.refreshToken,
      expiresAt: Date.now() + Math.max(60, Number(token.expires_in || 3600)) * 1000
    };
    persistTokenBundle(this.store, this.provider, this.bundle);
    return this.bundle.accessToken;
  }

  async getAccessToken({ forceRefresh = false } = {}) {
    if (this.provider === 'pcloud') {
      if (this.bundle.accessToken && !forceRefresh) return this.bundle.accessToken;
      if (this.bundle.accessToken && forceRefresh) return this.bundle.accessToken;
      throw new Error('The pCloud session is unavailable. Reconnect the account in Settings.');
    }
    if (
      !forceRefresh &&
      this.bundle.accessToken &&
      Number(this.bundle.expiresAt || 0) > Date.now() + 60_000
    ) {
      return this.bundle.accessToken;
    }
    if (!this.bundle.refreshToken) {
      throw new Error('The cloud session expired. Reconnect the account in Settings.');
    }
    return this.refresh();
  }

  async authorizedFetch(url, options = {}) {
    let token = await this.getAccessToken();
    let response = await fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${token}`
      }
    });

    if (response.status === 401 && this.provider !== 'pcloud') {
      token = await this.getAccessToken({ forceRefresh: true });
      response = await fetch(url, {
        ...options,
        headers: {
          ...(options.headers || {}),
          Authorization: `Bearer ${token}`
        }
      });
    }
    return response;
  }

  async authorizedJson(url, options = {}) {
    const response = await this.authorizedFetch(url, options);
    const payload = await parseResponse(response);
    if (!response.ok) {
      const error = new Error(errorMessage(payload, `Cloud request failed with HTTP ${response.status}.`));
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }
}

module.exports = {
  OAuthTokenSession,
  base64Url,
  createPkce,
  decryptJson,
  encryptJson,
  errorMessage,
  fetchJson,
  formBody,
  parseResponse,
  persistTokenBundle,
  providerSettingsKey
};
