const fs = require('node:fs');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function normalizeBaseUrl(value) {
  const url = new URL(String(value || '').trim());
  const localHost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHost)) {
    throw new Error('WebDAV requires HTTPS. Plain HTTP is allowed only for localhost testing.');
  }
  url.hash = '';
  url.search = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

function objectName(objectKey) {
  return `${crypto.createHash('sha256').update(objectKey).digest('hex')}.cbak`;
}

class WebDavVault {
  constructor({ baseUrl, username = '', password = '' }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.rootUrl = new URL('Cloud%20Backup%20App/', this.baseUrl).toString();
    this.authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
    this.rootReady = false;
  }

  async request(url, options = {}) {
    return fetch(url, {
      ...options,
      headers: {
        Authorization: this.authorization,
        ...(options.headers || {})
      },
      duplex: options.body ? 'half' : undefined
    });
  }

  async ensureRoot() {
    if (this.rootReady) return;
    const probe = await this.request(this.rootUrl, {
      method: 'PROPFIND',
      headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
      body: '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>'
    });
    if (probe.ok || probe.status === 207) {
      this.rootReady = true;
      return;
    }
    if (probe.status !== 404) {
      throw new Error(`WebDAV folder check failed with HTTP ${probe.status}.`);
    }
    const created = await this.request(this.rootUrl, { method: 'MKCOL' });
    if (![200, 201, 204, 405].includes(created.status)) {
      throw new Error(`Could not create the WebDAV backup folder (HTTP ${created.status}).`);
    }
    this.rootReady = true;
  }

  objectUrl(objectKey) {
    return new URL(encodeURIComponent(objectName(objectKey)), this.rootUrl).toString();
  }

  async testConnection() {
    await this.ensureRoot();
    return { ok: true, message: 'WebDAV connection succeeded.' };
  }

  async upload({ sourcePath, objectKey }) {
    await this.ensureRoot();
    const target = this.objectUrl(objectKey);
    const existing = await this.request(target, { method: 'HEAD' });
    if (existing.ok) return { objectKey, storageRef: objectName(objectKey), reused: true };
    if (![404, 405].includes(existing.status)) {
      throw new Error(`WebDAV object check failed with HTTP ${existing.status}.`);
    }

    const stat = await fs.promises.stat(sourcePath);
    const response = await this.request(target, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(stat.size)
      },
      body: fs.createReadStream(sourcePath)
    });
    if (![200, 201, 204].includes(response.status)) {
      throw new Error(`WebDAV upload failed with HTTP ${response.status}.`);
    }
    return { objectKey, storageRef: objectName(objectKey) };
  }

  async restore({ objectKey, storageRef, destinationPath }) {
    await this.ensureRoot();
    const target = storageRef
      ? new URL(encodeURIComponent(storageRef), this.rootUrl).toString()
      : this.objectUrl(objectKey);
    const response = await this.request(target);
    if (response.status === 404) throw new Error('WebDAV backup object was not found.');
    if (!response.ok) throw new Error(`WebDAV download failed with HTTP ${response.status}.`);
    if (!response.body) throw new Error('WebDAV returned no file data.');
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destinationPath, { flags: 'wx' }));
  }

  async deleteObjects({ objects = [], objectKeys = [] }) {
    await this.ensureRoot();
    const inputs = objects.length ? objects : objectKeys.map((objectKey) => ({ objectKey }));
    let deleted = 0;
    for (const item of inputs) {
      const target = item.storageRef
        ? new URL(encodeURIComponent(item.storageRef), this.rootUrl).toString()
        : this.objectUrl(item.objectKey);
      const response = await this.request(target, { method: 'DELETE' });
      if (response.status === 404) continue;
      if (![200, 202, 204].includes(response.status)) {
        throw new Error(`WebDAV deletion failed with HTTP ${response.status}.`);
      }
      deleted += 1;
    }
    return { deleted };
  }
}

module.exports = { WebDavVault, normalizeBaseUrl, objectName };
