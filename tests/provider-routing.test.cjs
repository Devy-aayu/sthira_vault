const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StateStore } = require('../electron/state-store.cjs');
const { BackupEngine } = require('../electron/backup-engine.cjs');
const { executeRestorePlan } = require('../electron/restore-service.cjs');
const { deleteBackupSelection } = require('../electron/delete-service.cjs');

test('retries reuse one remote object key and persist the provider storage reference', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-backup-provider-ref-'));
  const source = path.join(temp, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'file.txt'), 'provider-ref');

  const store = new StateStore(path.join(temp, 'state.json'));
  store.update((state) => {
    state.settings.provider = 'google-drive';
    state.folders.push({
      id: 'folder-1',
      name: 'source',
      path: source,
      addedAt: new Date().toISOString()
    });
  });

  const objectKeys = [];
  let attempts = 0;
  const vault = {
    async upload({ objectKey }) {
      objectKeys.push(objectKey);
      attempts += 1;
      if (attempts < 3) throw new Error('temporary cloud failure');
      return { objectKey, storageRef: 'google-file-id-123' };
    }
  };

  const engine = new BackupEngine({
    store,
    appDataPath: temp,
    vaultFactory: () => vault
  });

  const result = await engine.run();
  assert.equal(result.uploaded, 1);
  assert.equal(attempts, 3);
  assert.equal(new Set(objectKeys).size, 1);
  assert.equal(store.get().files[0].storageRef, 'google-file-id-123');
  assert.equal(store.get().files[0].provider, 'google-drive');
});

test('folder restore resolves the correct vault for each historical provider', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-backup-provider-restore-'));
  const destinationRoot = path.join(temp, 'restore');
  const folderRoot = path.join(destinationRoot, 'Recovered');
  const googlePath = path.join(folderRoot, 'google.txt');
  const oneDrivePath = path.join(folderRoot, 'onedrive.txt');

  const plan = {
    destinationRoot,
    totalFiles: 2,
    folders: [{
      folderId: 'folder-1',
      folderName: 'Recovered',
      folderRoot,
      directories: [],
      files: [
        {
          relativePath: 'google.txt',
          destinationPath: googlePath,
          record: {
            relativePath: 'google.txt',
            provider: 'google-drive',
            objectKey: 'google-key',
            storageRef: 'google-id'
          }
        },
        {
          relativePath: 'onedrive.txt',
          destinationPath: oneDrivePath,
          record: {
            relativePath: 'onedrive.txt',
            provider: 'onedrive',
            objectKey: 'onedrive-key',
            storageRef: 'onedrive-id'
          }
        }
      ]
    }]
  };

  const seen = [];
  const vaultResolver = (provider) => ({
    async restore({ storageRef, destinationPath }) {
      seen.push({ provider, storageRef });
      fs.writeFileSync(destinationPath, provider);
    }
  });

  const result = await executeRestorePlan({ plan, vaultResolver });
  assert.equal(result.restored, 2);
  assert.equal(fs.readFileSync(googlePath, 'utf8'), 'google-drive');
  assert.equal(fs.readFileSync(oneDrivePath, 'utf8'), 'onedrive');
  assert.deepEqual(seen, [
    { provider: 'google-drive', storageRef: 'google-id' },
    { provider: 'onedrive', storageRef: 'onedrive-id' }
  ]);
});

test('deleting a mixed-provider backup routes each remote object to its original provider', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-backup-provider-delete-'));
  const store = new StateStore(path.join(temp, 'state.json'));
  store.update((state) => {
    state.files = [
      {
        id: 'g1',
        folderId: 'folder-1',
        folderName: 'Folder',
        relativePath: 'a.txt',
        provider: 'google-drive',
        objectKey: 'google-key',
        storageRef: 'google-id',
        backedUpAt: new Date().toISOString()
      },
      {
        id: 'o1',
        folderId: 'folder-1',
        folderName: 'Folder',
        relativePath: 'b.txt',
        provider: 'onedrive',
        objectKey: 'onedrive-key',
        storageRef: 'onedrive-id',
        backedUpAt: new Date().toISOString()
      }
    ];
  });

  const deleted = [];
  const state = store.get();
  const result = await deleteBackupSelection({
    store,
    state,
    selection: { kind: 'backup-folder', folderId: 'folder-1' },
    vaultResolver: (provider) => ({
      async deleteObjects({ objects }) {
        deleted.push({ provider, objects });
        return { deleted: objects.length };
      }
    })
  });

  assert.equal(result.deletedVersions, 2);
  assert.equal(store.get().files.length, 0);
  assert.deepEqual(deleted, [
    {
      provider: 'google-drive',
      objects: [{ objectKey: 'google-key', storageRef: 'google-id' }]
    },
    {
      provider: 'onedrive',
      objects: [{ objectKey: 'onedrive-key', storageRef: 'onedrive-id' }]
    }
  ]);
});

test('Dropbox records restore through the Dropbox provider route', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-backup-dropbox-route-'));
  const destinationRoot = path.join(temp, 'restore');
  const folderRoot = path.join(destinationRoot, 'Recovered');
  const destinationPath = path.join(folderRoot, 'dropbox.txt');
  const plan = {
    destinationRoot,
    totalFiles: 1,
    folders: [{
      folderId: 'folder-1',
      folderName: 'Recovered',
      folderRoot,
      directories: [],
      files: [{
        relativePath: 'dropbox.txt',
        destinationPath,
        record: {
          relativePath: 'dropbox.txt',
          provider: 'dropbox',
          objectKey: 'dropbox-key',
          storageRef: 'id:dropbox-file'
        }
      }]
    }]
  };

  const providers = [];
  await executeRestorePlan({
    plan,
    vaultResolver: (provider) => ({
      async restore({ destinationPath: target }) {
        providers.push(provider);
        fs.writeFileSync(target, 'dropbox');
      }
    })
  });
  assert.deepEqual(providers, ['dropbox']);
  assert.equal(fs.readFileSync(destinationPath, 'utf8'), 'dropbox');
});

test('interrupted retry preserves the original provider, version id, and object key', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-backup-interrupted-retry-'));
  const source = path.join(temp, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'retry.txt'), 'retry-me');

  const store = new StateStore(path.join(temp, 'state.json'));
  store.update((state) => {
    state.settings.provider = 'google-drive';
    state.folders.push({ id: 'folder-1', name: 'source', path: source, addedAt: new Date().toISOString() });
  });

  const calls = [];
  let shouldFail = true;
  const vaults = {
    'google-drive': {
      async upload({ objectKey }) {
        calls.push({ provider: 'google-drive', objectKey });
        if (shouldFail) throw new Error('cloud outage');
        return { objectKey, storageRef: 'google-id' };
      }
    },
    local: {
      async upload({ objectKey }) {
        calls.push({ provider: 'local', objectKey });
        return { objectKey, storageRef: 'local-ref' };
      }
    }
  };

  const engine = new BackupEngine({
    store,
    appDataPath: temp,
    vaultFactory: (state) => vaults[state.settings.provider]
  });

  const first = await engine.run();
  assert.equal(first.failed, 1);
  const interrupted = store.get().interrupted[0];
  assert.equal(interrupted.provider, 'google-drive');
  assert.ok(interrupted.versionId);
  assert.ok(interrupted.objectKey);

  store.update((state) => {
    state.settings.provider = 'local';
  });
  shouldFail = false;

  await engine.retry(interrupted.id);
  assert.equal(calls.at(-1).provider, 'google-drive');
  assert.equal(calls.at(-1).objectKey, interrupted.objectKey);
  assert.equal(store.get().interrupted.length, 0);
  assert.equal(store.get().files.at(-1).provider, 'google-drive');
});
