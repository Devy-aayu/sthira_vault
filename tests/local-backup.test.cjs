const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StateStore } = require('../electron/state-store.cjs');
const { BackupEngine } = require('../electron/backup-engine.cjs');
const { LocalVault } = require('../electron/storage/local-vault.cjs');

test('backs up changed files and skips unchanged files', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-backup-test-'));
  const source = path.join(temp, 'source');
  const vaultPath = path.join(temp, 'vault');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'hello.txt'), 'hello');

  const store = new StateStore(path.join(temp, 'state.json'), {
    settings: { localVaultPath: vaultPath }
  });
  store.update((state) => {
    state.folders.push({ id: 'folder-1', name: 'source', path: source, addedAt: new Date().toISOString() });
  });

  const engine = new BackupEngine({
    store,
    appDataPath: temp,
    vaultFactory: () => new LocalVault(vaultPath)
  });

  const first = await engine.run();
  assert.equal(first.uploaded, 1);
  assert.equal(first.failed, 0);

  const second = await engine.run();
  assert.equal(second.uploaded, 0);
  assert.equal(second.skipped, 1);
});

test('moves a file to interrupted after exactly three failures', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-backup-failure-'));
  const source = path.join(temp, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'failure.txt'), 'failure');

  const store = new StateStore(path.join(temp, 'state.json'));
  store.update((state) => {
    state.folders.push({ id: 'folder-1', name: 'source', path: source, addedAt: new Date().toISOString() });
  });

  let attempts = 0;
  const engine = new BackupEngine({
    store,
    appDataPath: temp,
    vaultFactory: () => ({
      async upload() {
        attempts += 1;
        throw new Error('simulated outage');
      }
    })
  });

  const result = await engine.run();
  assert.equal(result.failed, 1);
  assert.equal(attempts, 3);
  assert.equal(store.get().interrupted[0].attempts, 3);
});

test('change-triggered backup hashes a watched file even when size and mtime fingerprint appear unchanged', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-backup-hash-change-'));
  const source = path.join(temp, 'source');
  const vaultPath = path.join(temp, 'vault');
  fs.mkdirSync(source);
  const filePath = path.join(source, 'same-size.txt');
  fs.writeFileSync(filePath, 'first');

  const store = new StateStore(path.join(temp, 'state.json'), {
    settings: { localVaultPath: vaultPath }
  });
  store.update((state) => {
    state.folders.push({ id: 'folder-1', name: 'source', path: source, addedAt: new Date().toISOString() });
  });

  const engine = new BackupEngine({
    store,
    appDataPath: temp,
    vaultFactory: () => new LocalVault(vaultPath)
  });

  const first = await engine.run();
  assert.equal(first.uploaded, 1);
  const oldFingerprint = store.get().fingerprints['folder-1:same-size.txt'];

  fs.writeFileSync(filePath, 'other');
  const currentStat = fs.statSync(filePath);
  store.update((state) => {
    state.fingerprints['folder-1:same-size.txt'] = {
      ...oldFingerprint,
      size: currentStat.size,
      mtimeMs: currentStat.mtimeMs
    };
  });

  const result = await engine.run({
    folderId: 'folder-1',
    trigger: 'change',
    changedPaths: ['same-size.txt']
  });
  assert.equal(result.uploaded, 1);
  assert.equal(store.get().files.length, 2);
  assert.notEqual(store.get().files.at(-1).checksum, oldFingerprint.checksum);
});

test('manual uploads with duplicate basenames remain distinct in the catalog', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-backup-manual-collision-'));
  const a = path.join(temp, 'a');
  const b = path.join(temp, 'b');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  const fileA = path.join(a, 'same.txt');
  const fileB = path.join(b, 'same.txt');
  fs.writeFileSync(fileA, 'A');
  fs.writeFileSync(fileB, 'B');

  const store = new StateStore(path.join(temp, 'state.json'));
  const uploadedKeys = [];
  const engine = new BackupEngine({
    store,
    appDataPath: temp,
    vaultFactory: () => ({
      async upload({ objectKey }) {
        uploadedKeys.push(objectKey);
        return { objectKey };
      }
    })
  });

  const result = await engine.manualUpload([fileA, fileB]);
  assert.equal(result.uploaded, 2);
  const records = store.get().files;
  assert.equal(records.length, 2);
  assert.notEqual(records[0].relativePath, records[1].relativePath);
  assert.equal(records[0].relativePath, 'same.txt');
  assert.match(records[1].relativePath, /^same~[a-f0-9]{10}\.txt$/);
  assert.equal(new Set(uploadedKeys).size, 2);
});
