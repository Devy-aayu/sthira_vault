const fs = require('node:fs');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { errorMessage, parseResponse } = require('../oauth/oauth-utils.cjs');

const SIMPLE_UPLOAD_LIMIT = 150 * 1024 * 1024;
const CHUNK_SIZE = 8 * 1024 * 1024;

function objectPath(objectKey) {
  const digest = crypto.createHash('sha256').update(objectKey).digest('hex');
  return `/${digest}.cbak`;
}

class DropboxVault {
  constructor({ tokenSession }) {
    this.tokenSession = tokenSession;
  }

  async api(url, options = {}) {
    const response = await this.tokenSession.authorizedFetch(url, options);
    const payload = await parseResponse(response);
    if (!response.ok) {
      const error = new Error(errorMessage(payload, `Dropbox request failed with HTTP ${response.status}.`));
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async getMetadata(pathOrId) {
    try {
      return await this.api('https://api.dropboxapi.com/2/files/get_metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: pathOrId,
          include_media_info: false,
          include_deleted: false
        })
      });
    } catch (error) {
      const summary = String(error.payload?.error_summary || error.message || '');
      if (error.status === 409 && summary.startsWith('path/not_found')) return null;
      throw error;
    }
  }

  async testConnection() {
    const usage = await this.api('https://api.dropboxapi.com/2/users/get_space_usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null'
    });
    const allocated = Number(usage?.allocation?.allocated || 0);
    const used = Number(usage?.used || 0);
    return {
      ok: true,
      message: 'Dropbox connection succeeded.',
      quota: allocated > 0 ? { total: allocated, used, remaining: Math.max(0, allocated - used) } : null
    };
  }

  async uploadSmall({ sourcePath, targetPath, size }) {
    const response = await this.tokenSession.authorizedFetch(
      'https://content.dropboxapi.com/2/files/upload',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(size),
          'Dropbox-API-Arg': JSON.stringify({
            path: targetPath,
            mode: 'add',
            autorename: false,
            mute: true,
            strict_conflict: true
          })
        },
        body: fs.createReadStream(sourcePath),
        duplex: 'half'
      }
    );
    const payload = await parseResponse(response);
    if (!response.ok) {
      throw new Error(errorMessage(payload, `Dropbox upload failed with HTTP ${response.status}.`));
    }
    return payload;
  }

  async uploadLarge({ sourcePath, targetPath, size }) {
    const handle = await fs.promises.open(sourcePath, 'r');
    try {
      let offset = 0;
      let sessionId = '';

      const firstLength = Math.min(CHUNK_SIZE, size);
      const firstBuffer = Buffer.allocUnsafe(firstLength);
      const firstRead = await handle.read(firstBuffer, 0, firstLength, 0);
      if (!firstRead.bytesRead && size > 0) throw new Error('Unexpected end of file during Dropbox upload.');
      const firstChunk = firstBuffer.subarray(0, firstRead.bytesRead);

      const started = await this.api('https://content.dropboxapi.com/2/files/upload_session/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Arg': JSON.stringify({ close: false })
        },
        body: firstChunk
      });
      sessionId = started?.session_id;
      if (!sessionId) throw new Error('Dropbox did not return an upload-session identifier.');
      offset = firstRead.bytesRead;

      while (size - offset > CHUNK_SIZE) {
        const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
        const { bytesRead } = await handle.read(buffer, 0, CHUNK_SIZE, offset);
        if (!bytesRead) throw new Error('Unexpected end of file during Dropbox upload.');
        const chunk = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
        await this.api('https://content.dropboxapi.com/2/files/upload_session/append_v2', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Dropbox-API-Arg': JSON.stringify({
              cursor: { session_id: sessionId, offset },
              close: false
            })
          },
          body: chunk
        });
        offset += bytesRead;
      }

      const finalLength = Math.max(0, size - offset);
      const finalBuffer = Buffer.allocUnsafe(finalLength);
      const finalRead = finalLength
        ? await handle.read(finalBuffer, 0, finalLength, offset)
        : { bytesRead: 0 };
      const finalChunk = finalBuffer.subarray(0, finalRead.bytesRead);
      const completed = await this.api('https://content.dropboxapi.com/2/files/upload_session/finish', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Arg': JSON.stringify({
            cursor: { session_id: sessionId, offset },
            commit: {
              path: targetPath,
              mode: 'add',
              autorename: false,
              mute: true,
              strict_conflict: true
            }
          })
        },
        body: finalChunk
      });
      return completed;
    } finally {
      await handle.close();
    }
  }

  async upload({ sourcePath, objectKey }) {
    const targetPath = objectPath(objectKey);
    const existing = await this.getMetadata(targetPath);
    if (existing?.id) return { objectKey, storageRef: existing.id, reused: true };

    const stat = await fs.promises.stat(sourcePath);
    const uploaded = stat.size <= SIMPLE_UPLOAD_LIMIT
      ? await this.uploadSmall({ sourcePath, targetPath, size: stat.size })
      : await this.uploadLarge({ sourcePath, targetPath, size: stat.size });

    if (!uploaded?.id) throw new Error('Dropbox did not return a stored file identifier.');
    return { objectKey, storageRef: uploaded.id };
  }

  async restore({ objectKey, storageRef, destinationPath }) {
    const target = storageRef || objectPath(objectKey);
    const response = await this.tokenSession.authorizedFetch(
      'https://content.dropboxapi.com/2/files/download',
      {
        method: 'POST',
        headers: { 'Dropbox-API-Arg': JSON.stringify({ path: target }) }
      }
    );
    if (!response.ok) {
      const payload = await parseResponse(response);
      throw new Error(errorMessage(payload, `Dropbox download failed with HTTP ${response.status}.`));
    }
    if (!response.body) throw new Error('Dropbox returned no file data.');
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destinationPath, { flags: 'wx' }));
  }

  async deleteObjects({ objects = [], objectKeys = [] }) {
    const inputs = objects.length ? objects : objectKeys.map((objectKey) => ({ objectKey }));
    let deleted = 0;
    for (const item of inputs) {
      const target = item.storageRef || objectPath(item.objectKey);
      try {
        await this.api('https://api.dropboxapi.com/2/files/delete_v2', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: target })
        });
        deleted += 1;
      } catch (error) {
        const summary = String(error.payload?.error_summary || error.message || '');
        if (error.status === 409 && summary.startsWith('path_lookup/not_found')) continue;
        throw error;
      }
    }
    return { deleted };
  }
}

module.exports = { DropboxVault, objectPath };
