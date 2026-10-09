const fs = require('node:fs');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const APP_FOLDER_NAME = 'Cloud Backup App';

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function objectName(objectKey) {
  return `${crypto.createHash('sha256').update(objectKey).digest('hex')}.cbak`;
}

class PCloudVault {
  constructor({ tokenSession }) {
    this.tokenSession = tokenSession;
    this.apiHost = ['api.pcloud.com', 'eapi.pcloud.com'].includes(tokenSession.bundle?.apiHost)
      ? tokenSession.bundle.apiHost
      : 'api.pcloud.com';
    this.rootFolderId = null;
  }

  async api(method, params = {}, options = {}, allowedResults = []) {
    const url = new URL(`https://${this.apiHost}/${method}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const response = await this.tokenSession.authorizedFetch(url, options);
    const payload = await parseResponse(response);
    const resultCode = Number(payload?.result || 0);
    if (!response.ok || (resultCode !== 0 && !allowedResults.includes(resultCode))) {
      const error = new Error(payload?.error || `pCloud request failed with HTTP ${response.status}.`);
      error.status = response.status;
      error.result = resultCode;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async ensureRoot() {
    if (this.rootFolderId) return this.rootFolderId;
    const result = await this.api('createfolderifnotexists', { folderid: 0, name: APP_FOLDER_NAME });
    const folderId = result?.metadata?.folderid;
    if (folderId === undefined || folderId === null) throw new Error('pCloud did not return the backup folder identifier.');
    this.rootFolderId = String(folderId);
    return this.rootFolderId;
  }

  async findFile(objectKey) {
    const name = objectName(objectKey);
    const payload = await this.api('stat', { path: `/${APP_FOLDER_NAME}/${name}` }, {}, [2009]);
    if (Number(payload?.result || 0) === 2009) return null;
    return payload?.metadata || null;
  }

  async testConnection() {
    const user = await this.api('userinfo');
    await this.ensureRoot();
    const total = Number(user?.quota || 0);
    const used = Number(user?.usedquota || 0);
    return {
      ok: true,
      message: 'pCloud connection succeeded.',
      quota: total > 0 ? { total, used, remaining: Math.max(0, total - used) } : null
    };
  }

  async upload({ sourcePath, objectKey }) {
    const existing = await this.findFile(objectKey);
    if (existing?.fileid !== undefined) {
      return { objectKey, storageRef: String(existing.fileid), reused: true };
    }

    const folderId = await this.ensureRoot();
    const stat = await fs.promises.stat(sourcePath);
    const url = new URL(`https://${this.apiHost}/uploadfile`);
    url.searchParams.set('folderid', folderId);
    url.searchParams.set('filename', objectName(objectKey));
    url.searchParams.set('nopartial', '1');

    const response = await this.tokenSession.authorizedFetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(stat.size)
      },
      body: fs.createReadStream(sourcePath),
      duplex: 'half'
    });
    const payload = await parseResponse(response);
    if (!response.ok || Number(payload?.result || 0) !== 0) {
      throw new Error(payload?.error || `pCloud upload failed with HTTP ${response.status}.`);
    }
    const fileId = payload?.fileids?.[0] ?? payload?.metadata?.[0]?.fileid;
    if (fileId === undefined || fileId === null) throw new Error('pCloud did not return a stored file identifier.');
    return { objectKey, storageRef: String(fileId) };
  }

  async restore({ objectKey, storageRef, destinationPath }) {
    let fileId = storageRef;
    if (!fileId) fileId = String((await this.findFile(objectKey))?.fileid || '');
    if (!fileId) throw new Error('pCloud backup object was not found.');

    const link = await this.api('getfilelink', { fileid: fileId, forcedownload: 1 });
    if (!link?.hosts?.[0] || !link?.path) throw new Error('pCloud did not return a download link.');
    const response = await fetch(`https://${link.hosts[0]}${link.path}`);
    if (!response.ok) throw new Error(`pCloud download failed with HTTP ${response.status}.`);
    if (!response.body) throw new Error('pCloud returned no file data.');
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destinationPath, { flags: 'wx' }));
  }

  async deleteObjects({ objects = [], objectKeys = [] }) {
    const inputs = objects.length ? objects : objectKeys.map((objectKey) => ({ objectKey }));
    let deleted = 0;
    for (const item of inputs) {
      let fileId = item.storageRef;
      if (!fileId) fileId = String((await this.findFile(item.objectKey))?.fileid || '');
      if (!fileId) continue;
      const payload = await this.api('deletefile', { fileid: fileId }, {}, [2009]);
      if (Number(payload?.result || 0) === 2009) continue;
      deleted += 1;
    }
    return { deleted };
  }
}

module.exports = { PCloudVault, objectName };
