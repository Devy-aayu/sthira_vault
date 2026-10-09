const fs = require('node:fs');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { errorMessage, parseResponse } = require('../oauth/oauth-utils.cjs');

function objectName(objectKey) {
  return `${crypto.createHash('sha256').update(objectKey).digest('hex')}.cbak`;
}

function escapeDriveQuery(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

class GoogleDriveVault {
  constructor({ tokenSession }) {
    this.tokenSession = tokenSession;
    this.rootFolderId = null;
  }

  async request(url, options = {}) {
    const response = await this.tokenSession.authorizedFetch(url, options);
    const payload = await parseResponse(response);
    if (!response.ok) {
      const error = new Error(errorMessage(payload, `Google Drive request failed with HTTP ${response.status}.`));
      error.status = response.status;
      throw error;
    }
    return { response, payload };
  }

  async ensureRootFolder() {
    if (this.rootFolderId) return this.rootFolderId;
    const query = [
      `name='${escapeDriveQuery('Cloud Backup App')}'`,
      "mimeType='application/vnd.google-apps.folder'",
      'trashed=false'
    ].join(' and ');
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', query);
    url.searchParams.set('spaces', 'drive');
    url.searchParams.set('fields', 'files(id,name)');
    url.searchParams.set('pageSize', '10');

    const listed = await this.request(url.toString());
    const existing = listed.payload?.files?.[0];
    if (existing?.id) {
      this.rootFolderId = existing.id;
      return existing.id;
    }

    const created = await this.request('https://www.googleapis.com/drive/v3/files?fields=id,name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Cloud Backup App',
        mimeType: 'application/vnd.google-apps.folder',
        description: 'Backups created by Cloud Backup App'
      })
    });
    this.rootFolderId = created.payload.id;
    return this.rootFolderId;
  }

  async findFileId(objectKey) {
    const rootId = await this.ensureRootFolder();
    const name = objectName(objectKey);
    const query = [
      `name='${escapeDriveQuery(name)}'`,
      `'${escapeDriveQuery(rootId)}' in parents`,
      'trashed=false'
    ].join(' and ');
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', query);
    url.searchParams.set('spaces', 'drive');
    url.searchParams.set('fields', 'files(id,name)');
    url.searchParams.set('pageSize', '2');
    const result = await this.request(url.toString());
    return result.payload?.files?.[0]?.id || null;
  }

  async testConnection() {
    await this.ensureRootFolder();
    return { ok: true, message: 'Google Drive connection succeeded.' };
  }

  async upload({ sourcePath, objectKey, contentType = 'application/octet-stream' }) {
    const existingId = await this.findFileId(objectKey);
    if (existingId) return { objectKey, storageRef: existingId, reused: true };

    const rootId = await this.ensureRootFolder();
    const stat = await fs.promises.stat(sourcePath);
    const keyHash = crypto.createHash('sha256').update(objectKey).digest('hex');
    const metadata = {
      name: `${keyHash}.cbak`,
      parents: [rootId],
      description: 'Versioned backup object created by Cloud Backup App',
      appProperties: {
        cloudBackupKey: keyHash,
        cloudBackupSchema: '1'
      }
    };

    const session = await this.tokenSession.authorizedFetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': contentType,
          'X-Upload-Content-Length': String(stat.size)
        },
        body: JSON.stringify(metadata)
      }
    );
    if (!session.ok) {
      const payload = await parseResponse(session);
      throw new Error(errorMessage(payload, `Could not start Google Drive upload (HTTP ${session.status}).`));
    }

    const uploadUrl = session.headers.get('location');
    if (!uploadUrl) throw new Error('Google Drive did not return an upload session URL.');

    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(stat.size)
      },
      body: fs.createReadStream(sourcePath),
      duplex: 'half'
    });
    const uploaded = await parseResponse(uploadResponse);
    if (!uploadResponse.ok) {
      throw new Error(errorMessage(uploaded, `Google Drive upload failed with HTTP ${uploadResponse.status}.`));
    }
    if (!uploaded?.id) throw new Error('Google Drive did not return a stored file identifier.');
    return { objectKey, storageRef: uploaded.id };
  }

  async restore({ objectKey, storageRef, destinationPath }) {
    const fileId = storageRef || await this.findFileId(objectKey);
    if (!fileId) throw new Error('Google Drive backup object was not found.');

    const response = await this.tokenSession.authorizedFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`
    );
    if (!response.ok) {
      const payload = await parseResponse(response);
      throw new Error(errorMessage(payload, `Google Drive download failed with HTTP ${response.status}.`));
    }
    if (!response.body) throw new Error('Google Drive returned no file data.');
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destinationPath, { flags: 'wx' }));
  }

  async deleteObjects({ objects = [], objectKeys = [] }) {
    const inputs = objects.length
      ? objects
      : objectKeys.map((objectKey) => ({ objectKey }));
    let deleted = 0;

    for (const item of inputs) {
      const fileId = item.storageRef || await this.findFileId(item.objectKey);
      if (!fileId) continue;
      const response = await this.tokenSession.authorizedFetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
        { method: 'DELETE' }
      );
      if (response.status === 404) continue;
      if (!response.ok) {
        const payload = await parseResponse(response);
        throw new Error(errorMessage(payload, `Google Drive deletion failed with HTTP ${response.status}.`));
      }
      deleted += 1;
    }
    return { deleted };
  }
}

module.exports = { GoogleDriveVault, objectName };
