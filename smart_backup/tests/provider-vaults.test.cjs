const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { PCloudVault } = require('../electron/storage/pcloud-vault.cjs');
const { WebDavVault } = require('../electron/storage/webdav-vault.cjs');

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

test('pCloud vault uploads once, reuses deterministic objects, and deletes by provider reference', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcloud-vault-test-'));
  const source = path.join(temp, 'source.txt');
  fs.writeFileSync(source, 'pcloud-data');
  let uploaded = false;
  const calls = [];

  const tokenSession = {
    bundle: { apiHost: 'api.pcloud.com' },
    async authorizedFetch(url, options = {}) {
      const parsed = new URL(url);
      const method = parsed.pathname.slice(1);
      calls.push({ method, httpMethod: options.method || 'GET' });
      if (method === 'userinfo') return jsonResponse({ result: 0, quota: 1000, usedquota: 100 });
      if (method === 'createfolderifnotexists') return jsonResponse({ result: 0, metadata: { folderid: 42 } });
      if (method === 'stat') {
        return uploaded
          ? jsonResponse({ result: 0, metadata: { fileid: 7 } })
          : jsonResponse({ result: 2009, error: 'File not found' });
      }
      if (method === 'uploadfile') {
        uploaded = true;
        return jsonResponse({ result: 0, fileids: [7] });
      }
      if (method === 'deletefile') {
        uploaded = false;
        return jsonResponse({ result: 0, metadata: { fileid: 7, isdeleted: true } });
      }
      throw new Error(`Unexpected pCloud method: ${method}`);
    }
  };

  const vault = new PCloudVault({ tokenSession });
  const connection = await vault.testConnection();
  assert.equal(connection.ok, true);
  assert.deepEqual(connection.quota, { total: 1000, used: 100, remaining: 900 });

  const first = await vault.upload({ sourcePath: source, objectKey: 'same-object-key' });
  assert.equal(first.storageRef, '7');
  assert.equal(first.reused, undefined);

  const second = await vault.upload({ sourcePath: source, objectKey: 'same-object-key' });
  assert.equal(second.storageRef, '7');
  assert.equal(second.reused, true);
  assert.equal(calls.filter((call) => call.method === 'uploadfile').length, 1);

  const deleted = await vault.deleteObjects({ objects: [{ objectKey: 'same-object-key', storageRef: '7' }] });
  assert.equal(deleted.deleted, 1);
});

test('WebDAV vault creates its app collection and supports upload, restore, reuse, and delete', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'webdav-vault-test-'));
  const source = path.join(temp, 'source.txt');
  const restored = path.join(temp, 'restored.txt');
  fs.writeFileSync(source, 'webdav-data');

  let collectionExists = false;
  const objects = new Map();
  const expectedAuth = `Basic ${Buffer.from('user:app-password').toString('base64')}`;

  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, expectedAuth);
    const requestPath = request.url;
    const rootPath = '/dav/Cloud%20Backup%20App/';

    if (request.method === 'PROPFIND' && requestPath === rootPath) {
      response.writeHead(collectionExists ? 207 : 404);
      response.end();
      return;
    }
    if (request.method === 'MKCOL' && requestPath === rootPath) {
      collectionExists = true;
      response.writeHead(201);
      response.end();
      return;
    }
    if (request.method === 'HEAD') {
      response.writeHead(objects.has(requestPath) ? 200 : 404);
      response.end();
      return;
    }
    if (request.method === 'PUT') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        objects.set(requestPath, Buffer.concat(chunks));
        response.writeHead(201);
        response.end();
      });
      return;
    }
    if (request.method === 'GET') {
      if (!objects.has(requestPath)) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.end(objects.get(requestPath));
      return;
    }
    if (request.method === 'DELETE') {
      const existed = objects.delete(requestPath);
      response.writeHead(existed ? 204 : 404);
      response.end();
      return;
    }
    response.writeHead(405);
    response.end();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const { port } = server.address();
    const vault = new WebDavVault({
      baseUrl: `http://127.0.0.1:${port}/dav/`,
      username: 'user',
      password: 'app-password'
    });

    assert.equal((await vault.testConnection()).ok, true);
    const first = await vault.upload({ sourcePath: source, objectKey: 'webdav-object' });
    assert.match(first.storageRef, /^[a-f0-9]{64}\.cbak$/);
    const second = await vault.upload({ sourcePath: source, objectKey: 'webdav-object' });
    assert.equal(second.reused, true);

    await vault.restore({ objectKey: 'webdav-object', storageRef: first.storageRef, destinationPath: restored });
    assert.equal(fs.readFileSync(restored, 'utf8'), 'webdav-data');

    const deleted = await vault.deleteObjects({ objects: [{ objectKey: 'webdav-object', storageRef: first.storageRef }] });
    assert.equal(deleted.deleted, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
