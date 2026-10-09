const { normalizeRelative } = require('./path-safety.cjs');

function normalizeTargetPath(relativePath) {
  if (!relativePath) return '';
  return normalizeRelative(relativePath);
}

function recordMatches(record, selection) {
  if (record.folderId !== selection.folderId) return false;
  if (selection.kind === 'backup-folder') return true;

  const target = normalizeTargetPath(selection.relativePath);
  if (selection.kind === 'file') return record.relativePath === target;
  if (selection.kind === 'directory') {
    return record.relativePath.startsWith(`${target}/`);
  }
  return false;
}

function pathMatches(relativePath, selection) {
  const normalized = normalizeTargetPath(relativePath);
  const target = normalizeTargetPath(selection.relativePath);
  if (selection.kind === 'backup-folder') return true;
  if (selection.kind === 'file') return normalized === target;
  if (selection.kind === 'directory') {
    return normalized === target || normalized.startsWith(`${target}/`);
  }
  return false;
}

function describeDeleteSelection(state, selection) {
  if (!['backup-folder', 'directory', 'file'].includes(selection?.kind)) {
    throw new Error('Invalid backup item type.');
  }
  if (typeof selection?.folderId !== 'string' || !selection.folderId) {
    throw new Error('Invalid backup folder identifier.');
  }
  if (selection.kind !== 'backup-folder' && typeof selection.relativePath !== 'string') {
    throw new Error('Invalid backup item path.');
  }

  const records = (state.files || []).filter((record) => recordMatches(record, selection));
  const folder = (state.folders || []).find((item) => item.id === selection.folderId);
  const snapshot = state.folderSnapshots?.[selection.folderId];
  const newest = (state.files || [])
    .filter((record) => record.folderId === selection.folderId)
    .sort((a, b) => String(b.backedUpAt || '').localeCompare(String(a.backedUpAt || '')))[0];

  const folderName = folder?.name || snapshot?.folderName || newest?.folderName || 'Backup folder';
  const targetPath = normalizeTargetPath(selection.relativePath || '');
  const targetName = selection.kind === 'backup-folder'
    ? folderName
    : targetPath.split('/').at(-1) || targetPath;

  if (!records.length && selection.kind === 'file') {
    throw new Error('Backup file not found.');
  }
  if (!records.length && selection.kind === 'backup-folder' && !snapshot) {
    throw new Error('Backup folder not found.');
  }

  return {
    ...selection,
    relativePath: targetPath,
    folderName,
    targetName,
    records,
    versionCount: records.length,
    objectKeys: [...new Set(records.map((record) => record.objectKey).filter(Boolean))],
    objects: [...new Map(
      records
        .filter((record) => record.objectKey || record.storageRef)
        .map((record) => [
          `${record.storageRef || ''}:${record.objectKey || ''}`,
          { objectKey: record.objectKey, storageRef: record.storageRef || '' }
        ])
    ).values()],
    providers: [...new Set(records.map((record) => record.provider).filter(Boolean))]
  };
}

function removeFingerprintEntries(state, selection) {
  const prefix = `${selection.folderId}:`;
  for (const key of Object.keys(state.fingerprints || {})) {
    if (!key.startsWith(prefix)) continue;
    const relativePath = key.slice(prefix.length);
    if (pathMatches(relativePath, selection)) delete state.fingerprints[key];
  }
}

function updateSnapshot(state, selection) {
  if (selection.kind === 'backup-folder') {
    delete state.folderSnapshots[selection.folderId];
    return;
  }

  const snapshot = state.folderSnapshots?.[selection.folderId];
  if (!snapshot) return;

  snapshot.entries = (snapshot.entries || []).filter(
    (entry) => !pathMatches(entry.relativePath, selection)
  );

  if (selection.kind === 'directory') {
    snapshot.directories = (snapshot.directories || []).filter(
      (directory) => !pathMatches(directory, selection)
    );
  }

  snapshot.fileCount = snapshot.entries.length;
  snapshot.catalogEditedAt = new Date().toISOString();
}

async function deleteBackupSelection({ store, state, vault = null, vaultResolver = null, selection }) {
  const described = describeDeleteSelection(state, selection);

  if (described.objects.length) {
    const grouped = new Map();
    for (const record of described.records) {
      const provider = record.provider || 'local';
      const key = `${record.storageRef || ''}:${record.objectKey || ''}`;
      const providerObjects = grouped.get(provider) || new Map();
      providerObjects.set(key, {
        objectKey: record.objectKey,
        storageRef: record.storageRef || ''
      });
      grouped.set(provider, providerObjects);
    }

    for (const [provider, objectMap] of grouped) {
      const providerVault = vaultResolver ? vaultResolver(provider) : vault;
      if (!providerVault || typeof providerVault.deleteObjects !== 'function') {
        throw new Error(`The ${provider} storage provider does not support backup deletion.`);
      }
      const objects = [...objectMap.values()];
      await providerVault.deleteObjects({
        objects,
        objectKeys: objects.map((item) => item.objectKey).filter(Boolean)
      });
    }
  }

  store.update((draft) => {
    draft.files = (draft.files || []).filter((record) => !recordMatches(record, described));
    draft.interrupted = (draft.interrupted || []).filter((entry) => {
      if (entry.folderId !== described.folderId) return true;
      return !pathMatches(entry.relativePath, described);
    });
    removeFingerprintEntries(draft, described);
    updateSnapshot(draft, described);
  });

  return {
    deletedVersions: described.versionCount,
    deletedObjects: described.objects.length,
    targetName: described.targetName,
    kind: described.kind
  };
}

module.exports = {
  deleteBackupSelection,
  describeDeleteSelection,
  pathMatches,
  recordMatches
};
