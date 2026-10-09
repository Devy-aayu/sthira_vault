const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StateStore } = require('../electron/state-store.cjs');
const { BackupEngine } = require('../electron/backup-engine.cjs');
const { evaluateFile, classifyFile } = require('../electron/smart-policy.cjs');

test('smart policy classifies important and replaceable files', () => {
  assert.equal(classifyFile('src/app.jsx'), 'code');
  assert.equal(classifyFile('documents/report.pdf'), 'document');
  assert.equal(classifyFile('downloads/setup.exe'), 'installer');

  const essential = { enabled: true, profile: 'essential', maxFileSizeMB: 1024 };
  assert.equal(evaluateFile({ relativePath: 'src/app.jsx', size: 100 }, essential).include, true);
  assert.equal(evaluateFile({ relativePath: 'movie.mp4', size: 100 }, essential).include, false);

  const balanced = { enabled: true, profile: 'balanced', maxFileSizeMB: 1024 };
  assert.equal(evaluateFile({ relativePath: 'setup.exe', size: 100 }, balanced).include, false);
  assert.equal(evaluateFile({ relativePath: 'photo.png', size: 100 }, balanced).include, true);
  assert.equal(evaluateFile({ relativePath: 'download.crdownload', size: 100 }, balanced).include, false);
});

test('smart analysis reports included and excluded data without uploading', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-backup-smart-'));
  const source = path.join(temp, 'source');
  fs.mkdirSync(source);
  fs.mkdirSync(path.join(source, 'node_modules'));
  fs.writeFileSync(path.join(source, 'report.pdf'), 'important');
  fs.writeFileSync(path.join(source, 'setup.exe'), 'replaceable');
  fs.writeFileSync(path.join(source, 'download.crdownload'), 'partial');
  fs.writeFileSync(path.join(source, 'node_modules', 'package.js'), 'generated');

  const store = new StateStore(path.join(temp, 'state.json'));
  store.update((state) => {
    state.settings.smartBackup = {
      ...state.settings.smartBackup,
      enabled: true,
      profile: 'balanced',
      maxFileSizeMB: 1024
    };
    state.folders.push({ id: 'folder-1', name: 'source', path: source, addedAt: new Date().toISOString() });
  });

  let uploadCalls = 0;
  const engine = new BackupEngine({
    store,
    appDataPath: temp,
    vaultFactory: () => ({
      async upload() {
        uploadCalls += 1;
        return { objectKey: 'unused' };
      }
    })
  });

  const analysis = await engine.analyze();
  assert.equal(uploadCalls, 0);
  assert.equal(analysis.total.includedFiles, 1);
  assert.equal(analysis.total.excludedFiles, 2);
  assert.equal(analysis.total.categories.document, 1);
  assert.equal(analysis.total.categories.installer, 1);
  assert.equal(analysis.total.categories.temporary, 1);
});

test('backup result exposes smart exclusions and snapshot profile', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-backup-smart-run-'));
  const source = path.join(temp, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'notes.txt'), 'notes');
  fs.writeFileSync(path.join(source, 'installer.exe'), 'installer');

  const store = new StateStore(path.join(temp, 'state.json'));
  store.update((state) => {
    state.settings.provider = 'local';
    state.settings.localVaultPath = path.join(temp, 'vault');
    state.settings.smartBackup.profile = 'balanced';
    state.folders.push({ id: 'folder-1', name: 'source', path: source, addedAt: new Date().toISOString() });
  });
  const { LocalVault } = require('../electron/storage/local-vault.cjs');
  const engine = new BackupEngine({
    store,
    appDataPath: temp,
    vaultFactory: (state) => new LocalVault(state.settings.localVaultPath)
  });

  const result = await engine.run();
  assert.equal(result.uploaded, 1);
  assert.equal(result.excluded, 1);
  assert.equal(store.get().folderSnapshots['folder-1'].smartProfile, 'balanced');
});
