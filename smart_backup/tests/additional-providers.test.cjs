const test = require('node:test');
const assert = require('node:assert/strict');

const { objectName: pCloudObjectName } = require('../electron/storage/pcloud-vault.cjs');
const { normalizeBaseUrl, objectName: webDavObjectName } = require('../electron/storage/webdav-vault.cjs');

test('pCloud and WebDAV use deterministic opaque object names', () => {
  const key = 'devices/device/folders/folder/versions/version/file.txt';
  assert.equal(pCloudObjectName(key), pCloudObjectName(key));
  assert.equal(webDavObjectName(key), webDavObjectName(key));
  assert.match(pCloudObjectName(key), /^[a-f0-9]{64}\.cbak$/);
  assert.equal(pCloudObjectName(key), webDavObjectName(key));
});

test('WebDAV requires HTTPS except for localhost', () => {
  assert.equal(normalizeBaseUrl('https://cloud.example.com/dav'), 'https://cloud.example.com/dav/');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8080/dav'), 'http://127.0.0.1:8080/dav/');
  assert.throws(() => normalizeBaseUrl('http://cloud.example.com/dav'), /requires HTTPS/);
});
