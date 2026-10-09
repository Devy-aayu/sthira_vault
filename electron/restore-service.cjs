const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { sha256File } = require('./crypto-utils.cjs');
const { normalizeRelative, safeJoin } = require('./path-safety.cjs');

function compareNewestFirst(a, b) {
  return String(b.backedUpAt || '').localeCompare(String(a.backedUpAt || ''));
}

function latestRecordByPath(records) {
  const latest = new Map();
  for (const record of [...records].sort(compareNewestFirst)) {
    if (!latest.has(record.relativePath)) latest.set(record.relativePath, record);
  }
  return latest;
}

function folderIdsWithBackups(state) {
  const ids = new Set(Object.keys(state.folderSnapshots || {}));
  for (const file of state.files || []) ids.add(file.folderId);
  return [...ids];
}


function sourceRootFromRecord(record) {
  if (!record?.sourcePath || !record?.relativePath) return '';
  let root = record.sourcePath;
  const segments = normalizeRelative(record.relativePath).split('/');
  for (let index = 0; index < segments.length; index += 1) {
    root = path.dirname(root);
  }
  return root;
}

function folderMetadata(state, folderId) {
  const active = (state.folders || []).find((folder) => folder.id === folderId);
  const snapshot = state.folderSnapshots?.[folderId];
  const records = (state.files || []).filter((file) => file.folderId === folderId).sort(compareNewestFirst);
  const newest = records[0];

  return {
    id: folderId,
    name: active?.name || snapshot?.folderName || newest?.folderName || 'Backup folder',
    sourcePath: active?.path || snapshot?.sourcePath || (folderId === 'manual' ? '' : sourceRootFromRecord(newest)),
    snapshot,
    records
  };
}

function currentRecordsForFolder(state, folderId) {
  const { snapshot, records } = folderMetadata(state, folderId);
  const byVersion = new Map(records.map((record) => [record.versionId, record]));
  const fallbackByPath = latestRecordByPath(records);

  if (snapshot && Array.isArray(snapshot.entries)) {
    return snapshot.entries
      .map((entry) => byVersion.get(entry.versionId) || fallbackByPath.get(entry.relativePath))
      .filter(Boolean);
  }

  return [...fallbackByPath.values()];
}

function directoryPathsForFolder(state, folderId, currentRecords = currentRecordsForFolder(state, folderId)) {
  const snapshot = state.folderSnapshots?.[folderId];
  if (snapshot && Array.isArray(snapshot.directories)) {
    return [...new Set(snapshot.directories.map(normalizeRelative))].sort();
  }

  const directories = new Set();
  for (const record of currentRecords) {
    const parts = normalizeRelative(record.relativePath).split('/');
    parts.pop();
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      directories.add(current);
    }
  }
  return [...directories].sort();
}

function listBackupFolders(state, query = '') {
  const normalizedQuery = String(query || '').trim().toLowerCase();

  return folderIdsWithBackups(state)
    .map((folderId) => {
      const meta = folderMetadata(state, folderId);
      const current = currentRecordsForFolder(state, folderId);
      const allSearchText = [
        meta.name,
        meta.sourcePath,
        ...meta.records.map((record) => record.relativePath)
      ].join('\n').toLowerCase();

      if (normalizedQuery && !allSearchText.includes(normalizedQuery)) return null;

      const providers = [...new Set(meta.records.map((record) => record.provider).filter(Boolean))];
      const newest = meta.records[0];
      return {
        id: folderId,
        name: meta.name,
        sourcePath: meta.sourcePath,
        fileCount: current.length,
        directoryCount: directoryPathsForFolder(state, folderId, current).length,
        versionCount: meta.records.length,
        size: current.reduce((sum, record) => sum + Number(record.size || 0), 0),
        backedUpAt: meta.snapshot?.completedAt || newest?.backedUpAt || null,
        providers,
        hasCompleteSnapshot: Boolean(meta.snapshot)
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.backedUpAt || '').localeCompare(String(a.backedUpAt || '')));
}

function listFolderContent(state, folderId, query = '') {
  const meta = folderMetadata(state, folderId);
  if (!meta.snapshot && !meta.records.length) throw new Error('Backup folder not found.');

  const normalizedQuery = String(query || '').trim().toLowerCase();
  const current = currentRecordsForFolder(state, folderId);
  const currentByPath = new Map(current.map((record) => [record.relativePath, record]));
  const versionsByPath = new Map();

  for (const record of meta.records) {
    const versions = versionsByPath.get(record.relativePath) || [];
    versions.push(record);
    versionsByPath.set(record.relativePath, versions);
  }

  const files = [...currentByPath.entries()]
    .filter(([relativePath]) => !normalizedQuery || relativePath.toLowerCase().includes(normalizedQuery))
    .map(([relativePath, currentRecord]) => ({
      relativePath,
      currentVersionId: currentRecord.versionId,
      latest: currentRecord,
      versions: (versionsByPath.get(relativePath) || []).sort(compareNewestFirst)
    }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const directories = directoryPathsForFolder(state, folderId, current)
    .filter((directory) => !normalizedQuery || directory.toLowerCase().includes(normalizedQuery));

  return {
    folder: {
      id: folderId,
      name: meta.name,
      sourcePath: meta.sourcePath,
      backedUpAt: meta.snapshot?.completedAt || meta.records[0]?.backedUpAt || null,
      hasCompleteSnapshot: Boolean(meta.snapshot)
    },
    directories,
    files
  };
}

function sanitizeFolderName(name, fallback) {
  const sanitized = String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return sanitized || fallback;
}

function outputNamesForFolders(state, folderIds) {
  const baseNames = folderIds.map((folderId) => {
    const meta = folderMetadata(state, folderId);
    return sanitizeFolderName(meta.name, `backup-${folderId.slice(0, 8)}`);
  });
  const counts = new Map();
  for (const name of baseNames) counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) || 0) + 1);

  return new Map(folderIds.map((folderId, index) => {
    const base = baseNames[index];
    const unique = counts.get(base.toLowerCase()) > 1 ? `${base}-${folderId.slice(0, 8)}` : base;
    return [folderId, unique];
  }));
}

function buildRestorePlan(state, folderIds, destinationRoot) {
  const outputNames = outputNamesForFolders(state, folderIds);
  const folders = [];
  let existingCount = 0;
  let totalFiles = 0;

  for (const folderId of folderIds) {
    const meta = folderMetadata(state, folderId);
    const currentRecords = currentRecordsForFolder(state, folderId);
    const outputName = outputNames.get(folderId);
    const folderRoot = safeJoin(destinationRoot, outputName);
    const directories = directoryPathsForFolder(state, folderId, currentRecords).map((relativePath) => ({
      relativePath,
      destinationPath: safeJoin(folderRoot, ...normalizeRelative(relativePath).split('/'))
    }));
    const files = currentRecords.map((record) => {
      const relativePath = normalizeRelative(record.relativePath);
      const destinationPath = safeJoin(folderRoot, ...relativePath.split('/'));
      if (fs.existsSync(destinationPath)) existingCount += 1;
      totalFiles += 1;
      return { record, relativePath, destinationPath };
    });

    folders.push({
      folderId,
      folderName: meta.name,
      outputName,
      folderRoot,
      directories,
      files
    });
  }

  return { destinationRoot, folders, existingCount, totalFiles };
}


function buildDirectoryRestorePlan(state, folderId, relativeDirectoryPath, destinationRoot) {
  const normalizedDirectory = normalizeRelative(relativeDirectoryPath);
  const meta = folderMetadata(state, folderId);
  const currentRecords = currentRecordsForFolder(state, folderId).filter((record) =>
    record.relativePath.startsWith(`${normalizedDirectory}/`)
  );
  const outputName = sanitizeFolderName(
    normalizedDirectory.split('/').at(-1),
    `backup-${folderId.slice(0, 8)}`
  );
  const folderRoot = safeJoin(destinationRoot, outputName);
  const directoryPrefix = `${normalizedDirectory}/`;
  const directories = directoryPathsForFolder(state, folderId, currentRecords)
    .filter((directory) => directory.startsWith(directoryPrefix))
    .map((directory) => {
      const relativePath = directory.slice(directoryPrefix.length);
      return {
        relativePath,
        destinationPath: safeJoin(folderRoot, ...normalizeRelative(relativePath).split('/'))
      };
    });

  let existingCount = 0;
  const files = currentRecords.map((record) => {
    const relativePath = normalizeRelative(record.relativePath.slice(directoryPrefix.length));
    const destinationPath = safeJoin(folderRoot, ...relativePath.split('/'));
    if (fs.existsSync(destinationPath)) existingCount += 1;
    return { record, relativePath, destinationPath };
  });

  return {
    destinationRoot,
    existingCount,
    totalFiles: files.length,
    folders: [{
      folderId,
      folderName: `${meta.name}/${normalizedDirectory}`,
      outputName,
      folderRoot,
      directories,
      files
    }]
  };
}

async function restoreRecordToPath({ vault, record, destinationPath, overwrite = false }) {
  const parent = path.dirname(destinationPath);
  fs.mkdirSync(parent, { recursive: true });

  if (fs.existsSync(destinationPath) && !overwrite) {
    throw new Error('Destination file already exists.');
  }

  const temporaryPath = safeJoin(parent, `.${path.basename(destinationPath)}.cloudbackup-${randomUUID()}.tmp`);
  try {
    await vault.restore({ objectKey: record.objectKey, storageRef: record.storageRef, destinationPath: temporaryPath });
    if (record.checksum) {
      const restoredChecksum = await sha256File(temporaryPath);
      if (restoredChecksum !== record.checksum) {
        throw new Error(`Integrity check failed for ${record.relativePath}.`);
      }
    }

    if (fs.existsSync(destinationPath)) {
      const stat = fs.statSync(destinationPath);
      if (!stat.isFile()) throw new Error(`Cannot overwrite non-file path: ${destinationPath}`);
      fs.unlinkSync(destinationPath);
    }
    fs.renameSync(temporaryPath, destinationPath);
  } catch (error) {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

async function executeRestorePlan({ plan, vault, vaultResolver = null, conflictPolicy = 'skip', progress = () => {} }) {
  let restored = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  for (const folder of plan.folders) {
    fs.mkdirSync(folder.folderRoot, { recursive: true });
    for (const directory of folder.directories) {
      fs.mkdirSync(directory.destinationPath, { recursive: true });
    }

    for (const file of folder.files) {
      const exists = fs.existsSync(file.destinationPath);
      if (exists && conflictPolicy === 'skip') {
        skipped += 1;
        progress({
          type: 'restore',
          status: 'skipped',
          folderName: folder.folderName,
          path: file.relativePath,
          restored,
          skipped,
          failed,
          total: plan.totalFiles
        });
        continue;
      }

      try {
        progress({
          type: 'restore',
          status: 'restoring',
          folderName: folder.folderName,
          path: file.relativePath,
          restored,
          skipped,
          failed,
          total: plan.totalFiles
        });
        const recordVault = vaultResolver
          ? vaultResolver(file.record.provider || 'local')
          : vault;
        await restoreRecordToPath({
          vault: recordVault,
          record: file.record,
          destinationPath: file.destinationPath,
          overwrite: exists && conflictPolicy === 'overwrite'
        });
        restored += 1;
      } catch (error) {
        failed += 1;
        if (errors.length < 50) {
          errors.push({
            folderName: folder.folderName,
            relativePath: file.relativePath,
            message: error.message
          });
        }
      }

      progress({
        type: 'restore',
        status: 'progress',
        folderName: folder.folderName,
        path: file.relativePath,
        restored,
        skipped,
        failed,
        total: plan.totalFiles
      });
    }
  }

  return {
    restored,
    skipped,
    failed,
    total: plan.totalFiles,
    destinationRoot: plan.destinationRoot,
    folders: plan.folders.map((folder) => ({
      folderId: folder.folderId,
      folderName: folder.folderName,
      restoredTo: folder.folderRoot
    })),
    errors
  };
}

module.exports = {
  buildDirectoryRestorePlan,
  buildRestorePlan,
  currentRecordsForFolder,
  executeRestorePlan,
  listBackupFolders,
  listFolderContent,
  restoreRecordToPath
};
