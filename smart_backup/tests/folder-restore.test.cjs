const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StateStore } = require('../electron/state-store.cjs');
const { BackupEngine } = require('../electron/backup-engine.cjs');
const { LocalVault } = require('../electron/storage/local-vault.cjs');
const {
  buildRestorePlan,
  executeRestorePlan,
  listBackupFolders,
  listFolderContent
} = require('../electron/restore-service.cjs');

test('folder snapshot restores nested structure and excludes files deleted before the latest snapshot', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-backup-folder-restore-'));
  const source = path.join(temp, 'xyz');
  const vaultPath = path.join(temp, 'vault');
  const restoreRoot = path.join(temp, 'restored');

  fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
  fs.mkdirSync(path.join(source, 'empty-folder'), { recursive: true });
  fs.writeFileSync(path.join(source, 'app.txt'), 'app-v1');
  fs.writeFileSync(path.join(source, 'nested', 'test.txt'), 'test-v1');
  fs.writeFileSync(path.join(source, 'remove-me.txt'), 'temporary');

  const store = new StateStore(path.join(temp, 'state.json'), {
    settings: { localVaultPath: vaultPath }
  });
  store.update((state) => {
    state.folders.push({ id: 'folder-xyz', name: 'xyz', path: source, addedAt: new Date().toISOString() });
  });

  const engine = new BackupEngine({
    store,
    appDataPath: temp,
    vaultFactory: () => new LocalVault(vaultPath)
  });

  const first = await engine.run();
  assert.equal(first.uploaded, 3);

  fs.unlinkSync(path.join(source, 'remove-me.txt'));
  const second = await engine.run();
  assert.equal(second.failed, 0);

  const folders = listBackupFolders(store.get());
  assert.equal(folders.length, 1);
  assert.equal(folders[0].name, 'xyz');
  assert.equal(folders[0].fileCount, 2);
  assert.equal(folders[0].hasCompleteSnapshot, true);

  const content = listFolderContent(store.get(), 'folder-xyz');
  assert.deepEqual(content.files.map((file) => file.relativePath), ['app.txt', 'nested/test.txt']);
  assert.ok(content.directories.includes('empty-folder'));
  assert.ok(content.directories.includes('nested'));

  const plan = buildRestorePlan(store.get(), ['folder-xyz'], restoreRoot);
  const result = await executeRestorePlan({
    plan,
    vault: new LocalVault(vaultPath),
    conflictPolicy: 'skip'
  });

  assert.equal(result.restored, 2);
  assert.equal(result.failed, 0);
  assert.equal(fs.readFileSync(path.join(restoreRoot, 'xyz', 'app.txt'), 'utf8'), 'app-v1');
  assert.equal(fs.readFileSync(path.join(restoreRoot, 'xyz', 'nested', 'test.txt'), 'utf8'), 'test-v1');
  assert.equal(fs.existsSync(path.join(restoreRoot, 'xyz', 'remove-me.txt')), false);
  assert.equal(fs.statSync(path.join(restoreRoot, 'xyz', 'empty-folder')).isDirectory(), true);
});

test('saved local vault location survives application restart', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-backup-state-'));
  const statePath = path.join(temp, 'state.json');
  const defaultVault = path.join(temp, 'default-vault');
  const customVault = path.join(temp, 'custom-vault');

  const first = new StateStore(statePath, { settings: { localVaultPath: defaultVault } });
  first.update((state) => {
    state.settings.localVaultPath = customVault;
  });

  const reopened = new StateStore(statePath, { settings: { localVaultPath: defaultVault } });
  assert.equal(reopened.get().settings.localVaultPath, customVault);
});

test('restores one nested backup folder without restoring unrelated files', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-backup-directory-restore-'));
  const source = path.join(temp, 'project');
  const vaultPath = path.join(temp, 'vault');
  const restoreRoot = path.join(temp, 'restored');

  fs.mkdirSync(path.join(source, 'src', 'empty-child'), { recursive: true });
  fs.writeFileSync(path.join(source, 'root.txt'), 'root');
  fs.writeFileSync(path.join(source, 'src', 'app.js'), 'app');

  const store = new StateStore(path.join(temp, 'state.json'), {
    settings: { localVaultPath: vaultPath }
  });
  store.update((state) => {
    state.folders.push({ id: 'folder-project', name: 'project', path: source, addedAt: new Date().toISOString() });
  });

  const engine = new BackupEngine({
    store,
    appDataPath: temp,
    vaultFactory: () => new LocalVault(vaultPath)
  });
  await engine.run();

  const { buildDirectoryRestorePlan } = require('../electron/restore-service.cjs');
  const plan = buildDirectoryRestorePlan(store.get(), 'folder-project', 'src', restoreRoot);
  const result = await executeRestorePlan({
    plan,
    vault: new LocalVault(vaultPath),
    conflictPolicy: 'skip'
  });

  assert.equal(result.restored, 1);
  assert.equal(fs.readFileSync(path.join(restoreRoot, 'src', 'app.js'), 'utf8'), 'app');
  assert.equal(fs.existsSync(path.join(restoreRoot, 'src', 'root.txt')), false);
  assert.equal(fs.statSync(path.join(restoreRoot, 'src', 'empty-child')).isDirectory(), true);
});

test('deleting a backed-up file removes all versions and forces a later re-backup', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-backup-delete-file-'));
  const source = path.join(temp, 'project');
  const vaultPath = path.join(temp, 'vault');
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(source, 'keep.txt'), 'keep-v1');
  fs.writeFileSync(path.join(source, 'nested', 'stay.txt'), 'stay');

  const store = new StateStore(path.join(temp, 'state.json'), {
    settings: { localVaultPath: vaultPath }
  });
  store.update((state) => {
    state.folders.push({ id: 'folder-delete', name: 'project', path: source, addedAt: new Date().toISOString() });
  });

  const engine = new BackupEngine({
    store,
    appDataPath: temp,
    vaultFactory: () => new LocalVault(vaultPath)
  });
  await engine.run();

  fs.writeFileSync(path.join(source, 'keep.txt'), 'keep-v2');
  const now = new Date(Date.now() + 2000);
  fs.utimesSync(path.join(source, 'keep.txt'), now, now);
  await engine.run();
  assert.equal(store.get().files.filter((record) => record.relativePath === 'keep.txt').length, 2);

  const { deleteBackupSelection } = require('../electron/delete-service.cjs');
  const stateBeforeDelete = store.get();
  const objectPaths = stateBeforeDelete.files
    .filter((record) => record.relativePath === 'keep.txt')
    .map((record) => path.join(vaultPath, 'objects', ...record.objectKey.split('/')));

  const deletion = await deleteBackupSelection({
    store,
    state: stateBeforeDelete,
    vault: new LocalVault(vaultPath),
    selection: { kind: 'file', folderId: 'folder-delete', relativePath: 'keep.txt' }
  });

  assert.equal(deletion.deletedVersions, 2);
  assert.equal(store.get().files.some((record) => record.relativePath === 'keep.txt'), false);
  assert.equal(store.get().folderSnapshots['folder-delete'].entries.some((entry) => entry.relativePath === 'keep.txt'), false);
  assert.equal(Boolean(store.get().fingerprints['folder-delete:keep.txt']), false);
  assert.equal(objectPaths.every((objectPath) => !fs.existsSync(objectPath)), true);

  const next = await engine.run();
  assert.equal(next.uploaded, 1);
  assert.equal(store.get().files.filter((record) => record.relativePath === 'keep.txt').length, 1);
});

test('deleting a nested backup folder removes its records and snapshot paths only', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-backup-delete-directory-'));
  const source = path.join(temp, 'project');
  const vaultPath = path.join(temp, 'vault');
  fs.mkdirSync(path.join(source, 'remove', 'child'), { recursive: true });
  fs.mkdirSync(path.join(source, 'keep'), { recursive: true });
  fs.writeFileSync(path.join(source, 'remove', 'child', 'gone.txt'), 'gone');
  fs.writeFileSync(path.join(source, 'keep', 'stay.txt'), 'stay');

  const store = new StateStore(path.join(temp, 'state.json'), {
    settings: { localVaultPath: vaultPath }
  });
  store.update((state) => {
    state.folders.push({ id: 'folder-dir-delete', name: 'project', path: source, addedAt: new Date().toISOString() });
  });

  const engine = new BackupEngine({
    store,
    appDataPath: temp,
    vaultFactory: () => new LocalVault(vaultPath)
  });
  await engine.run();

  const { deleteBackupSelection } = require('../electron/delete-service.cjs');
  await deleteBackupSelection({
    store,
    state: store.get(),
    vault: new LocalVault(vaultPath),
    selection: { kind: 'directory', folderId: 'folder-dir-delete', relativePath: 'remove' }
  });

  const state = store.get();
  assert.equal(state.files.some((record) => record.relativePath.startsWith('remove/')), false);
  assert.equal(state.files.some((record) => record.relativePath === 'keep/stay.txt'), true);
  assert.equal(state.folderSnapshots['folder-dir-delete'].directories.some((directory) => directory === 'remove' || directory.startsWith('remove/')), false);
  assert.equal(state.folderSnapshots['folder-dir-delete'].entries.some((entry) => entry.relativePath.startsWith('remove/')), false);
});
