const fs = require('node:fs');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { errorMessage, parseResponse } = require('../oauth/oauth-utils.cjs');

const SIMPLE_UPLOAD_LIMIT = 250 * 1024 * 1024;
const CHUNK_SIZE = 10 * 1024 * 1024; // 32 × 320 KiB.

function objectName(objectKey) {
  return `${crypto.createHash('sha256').update(objectKey).digest('hex')}.cbak`;
}

class OneDriveVault {
  constructor({ tokenSession }) {
    this.tokenSession = tokenSession;
    this.appRootId = null;
  }

  async graph(urlOrPath, options = {}) {
    const url = urlOrPath.startsWith('http')
      ? urlOrPath
      : `https://graph.microsoft.com/v1.0${urlOrPath}`;
    const response = await this.tokenSession.authorizedFetch(url, options);
    const payload = await parseResponse(response);
    if (!response.ok) {
      const error = new Error(errorMessage(payload, `OneDrive request failed with HTTP ${response.status}.`));
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async ensureAppRoot() {
    if (this.appRootId) return this.appRootId;
    const root = await this.graph('/me/drive/special/approot?$select=id,name');
    if (!root?.id) throw new Error('OneDrive did not return the application folder.');
    this.appRootId = root.id;
    return root.id;
  }

  async findFileId(objectKey) {
    const rootId = await this.ensureAppRoot();
    const name = encodeURIComponent(objectName(objectKey));
    try {
      const item = await this.graph(`/me/drive/items/${encodeURIComponent(rootId)}:/${name}?$select=id,name`);
      return item?.id || null;
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  async testConnection() {
    await this.ensureAppRoot();
    return { ok: true, message: 'OneDrive connection succeeded.' };
  }

  async uploadSmall({ sourcePath, rootId, fileName, size, contentType }) {
    const response = await this.tokenSession.authorizedFetch(
      `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(rootId)}:/${encodeURIComponent(fileName)}:/content`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(size)
        },
        body: fs.createReadStream(sourcePath),
        duplex: 'half'
      }
    );
    const payload = await parseResponse(response);
    if (!response.ok) {
      throw new Error(errorMessage(payload, `OneDrive upload failed with HTTP ${response.status}.`));
    }
    return payload;
  }

  async uploadLarge({ sourcePath, rootId, fileName, size }) {
    const session = await this.graph(
      `/me/drive/items/${encodeURIComponent(rootId)}:/${encodeURIComponent(fileName)}:/createUploadSession`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          item: {
            '@microsoft.graph.conflictBehavior': 'fail',
            name: fileName
          }
        })
      }
    );
    if (!session?.uploadUrl) throw new Error('OneDrive did not return an upload session URL.');

    const handle = await fs.promises.open(sourcePath, 'r');
    try {
      let offset = 0;
      let completed = null;
      while (offset < size) {
        const length = Math.min(CHUNK_SIZE, size - offset);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        if (!bytesRead) throw new Error('Unexpected end of file during OneDrive upload.');
        const chunk = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
        const end = offset + bytesRead - 1;

        const response = await fetch(session.uploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Length': String(bytesRead),
            'Content-Range': `bytes ${offset}-${end}/${size}`
          },
          body: chunk
        });
        const payload = await parseResponse(response);
        if (![200, 201, 202].includes(response.status)) {
          throw new Error(errorMessage(payload, `OneDrive upload failed with HTTP ${response.status}.`));
        }
        if (response.status === 200 || response.status === 201) completed = payload;
        offset += bytesRead;
      }
      return completed;
    } finally {
      await handle.close();
    }
  }

  async upload({ sourcePath, objectKey, contentType = 'application/octet-stream' }) {
    const existingId = await this.findFileId(objectKey);
    if (existingId) return { objectKey, storageRef: existingId, reused: true };

    const rootId = await this.ensureAppRoot();
    const stat = await fs.promises.stat(sourcePath);
    const fileName = objectName(objectKey);
    const uploaded = stat.size <= SIMPLE_UPLOAD_LIMIT
      ? await this.uploadSmall({
          sourcePath,
          rootId,
          fileName,
          size: stat.size,
          contentType
        })
      : await this.uploadLarge({
          sourcePath,
          rootId,
          fileName,
          size: stat.size
        });

    if (!uploaded?.id) throw new Error('OneDrive did not return a stored file identifier.');
    return { objectKey, storageRef: uploaded.id };
  }

  async restore({ objectKey, storageRef, destinationPath }) {
    const fileId = storageRef || await this.findFileId(objectKey);
    if (!fileId) throw new Error('OneDrive backup object was not found.');

    const response = await this.tokenSession.authorizedFetch(
      `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(fileId)}/content`
    );
    if (!response.ok) {
      const payload = await parseResponse(response);
      throw new Error(errorMessage(payload, `OneDrive download failed with HTTP ${response.status}.`));
    }
    if (!response.body) throw new Error('OneDrive returned no file data.');
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
        `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(fileId)}`,
        { method: 'DELETE' }
      );
      if (response.status === 404) continue;
      if (!response.ok) {
        const payload = await parseResponse(response);
        throw new Error(errorMessage(payload, `OneDrive deletion failed with HTTP ${response.status}.`));
      }
      deleted += 1;
    }
    return { deleted };
  }
}

module.exports = { OneDriveVault, objectName };
