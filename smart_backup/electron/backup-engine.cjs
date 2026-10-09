const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { sha256File } = require('./crypto-utils.cjs');
const { assertExistingDirectory, assertExistingFile, isInside, normalizeRelative } = require('./path-safety.cjs');
const { addDecision, emptySummary, evaluateFile, mergeSummaries, shouldSkipDirectory } = require('./smart-policy.cjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class BackupEngine {
  constructor({ store, vaultFactory, appDataPath, progress = () => {}, stateChanged = () => {} }) {
    this.store = store;
    this.vaultFactory = vaultFactory;
    this.appDataPath = appDataPath;
    this.progress = progress;
    this.stateChanged = stateChanged;
    this.running = false;
  }

  async scanFolder(folder, exclusions, absoluteExclusions = [], smartSettings = {}) {
    const root = assertExistingDirectory(folder.path);
    const files = [];
    const directories = new Set();
    const excluded = new Set(exclusions.map((item) => String(item).toLowerCase()));
    const smartSummary = emptySummary();

    const visit = async (directory) => {
      const entries = await fs.promises.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const lowerName = entry.name.toLowerCase();
        if (excluded.has(lowerName)) continue;
        if (entry.isSymbolicLink()) continue;

        const absolutePath = path.join(directory, entry.name);
        if (absoluteExclusions.some((excludedPath) => isInside(path.resolve(excludedPath), path.resolve(absolutePath)))) {
          continue;
        }
        if (entry.isDirectory()) {
          if (shouldSkipDirectory(entry.name, smartSettings)) continue;
          directories.add(normalizeRelative(path.relative(root, absolutePath)));
          await visit(absolutePath);
        } else if (entry.isFile()) {
          const stat = await fs.promises.stat(absolutePath);
          const relativePath = normalizeRelative(path.relative(root, absolutePath));
          const file = {
            absolutePath,
            relativePath,
            size: stat.size,
            mtimeMs: stat.mtimeMs
          };
          const decision = evaluateFile(file, smartSettings);
          addDecision(smartSummary, file, decision);
          if (decision.include) {
            files.push({
              ...file,
              smartCategory: decision.category,
              smartPriority: decision.priority
            });
          }
        }
      }
    };

    await visit(root);
    return { files, directories: [...directories].sort(), smartSummary };
  }

  async analyze({ folderId = null } = {}) {
    const state = this.store.get();
    const folders = folderId
      ? state.folders.filter((folder) => folder.id === folderId)
      : state.folders;
    if (!folders.length) throw new Error('Add at least one folder first.');

    const total = emptySummary();
    const perFolder = [];
    for (const folder of folders) {
      const absoluteExclusions = state.settings.provider === 'local' && state.settings.localVaultPath
        ? [state.settings.localVaultPath]
        : [];
      const scan = await this.scanFolder(
        folder,
        state.settings.exclusions,
        absoluteExclusions,
        state.settings.smartBackup
      );
      mergeSummaries(total, scan.smartSummary);
      perFolder.push({
        folderId: folder.id,
        folderName: folder.name,
        sourcePath: folder.path,
        ...scan.smartSummary
      });
    }
    return {
      profile: state.settings.smartBackup?.enabled === false
        ? 'disabled'
        : state.settings.smartBackup?.profile || 'balanced',
      total,
      perFolder,
      analyzedAt: new Date().toISOString()
    };
  }

  async isChanged(folderId, file, changedPaths = []) {
    const fingerprint = this.store.get().fingerprints[`${folderId}:${file.relativePath}`];
    if (!fingerprint || fingerprint.size !== file.size || fingerprint.mtimeMs !== file.mtimeMs) {
      return true;
    }

    const forced = changedPaths.some((input) => {
      const changedPath = String(input || '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
      if (!changedPath) return true;
      return file.relativePath === changedPath || file.relativePath.startsWith(`${changedPath}/`);
    });
    if (!forced) return false;

    file.checksum = await sha256File(file.absolutePath);
    return file.checksum !== fingerprint.checksum;
  }

  async uploadWithRetries(task, vault) {
    const versionId = task.versionId || `${Date.now()}-${randomUUID()}`;
    const safeRelative = task.relativePath.split('/').map(encodeURIComponent).join('/');
    const objectKey = task.objectKey || `devices/${task.deviceId}/folders/${task.folderId}/versions/${versionId}/${safeRelative}`;
    const preparedTask = { ...task, versionId, objectKey };

    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        this.progress({
          type: 'file',
          status: attempt === 1 ? 'uploading' : 'retrying',
          attempt,
          path: preparedTask.relativePath
        });
        return await this.uploadOne(preparedTask, vault);
      } catch (error) {
        lastError = error;
        if (attempt < 3) await sleep(attempt * 1500);
      }
    }
    throw Object.assign(new Error(lastError?.message || 'Upload failed.'), { attempts: 3 });
  }

  async uploadOne(task, vault) {
    const checksum = task.checksum || await sha256File(task.absolutePath);
    const versionId = task.versionId;
    const objectKey = task.objectKey;

    const stored = await vault.upload({
      sourcePath: task.absolutePath,
      objectKey
    });

    const record = {
      id: randomUUID(),
      folderId: task.folderId,
      folderName: task.folderName,
      relativePath: task.relativePath,
      sourcePath: task.absolutePath,
      size: task.size,
      mtimeMs: task.mtimeMs,
      checksum,
      objectKey,
      storageRef: stored?.storageRef || stored?.objectKey || objectKey,
      versionId,
      provider: task.provider,
      backedUpAt: new Date().toISOString(),
      smartCategory: task.smartCategory || 'other',
      smartPriority: task.smartPriority || 'normal'
    };

    this.store.update((state) => {
      state.files.push(record);
      state.fingerprints[`${task.folderId}:${task.relativePath}`] = {
        size: task.size,
        mtimeMs: task.mtimeMs,
        checksum,
        lastBackedUpAt: record.backedUpAt,
        versionId
      };
      state.interrupted = state.interrupted.filter(
        (entry) => !(entry.folderId === task.folderId && entry.relativePath === task.relativePath)
      );
    });
    this.stateChanged();
    return record;
  }

  recordInterrupted(task, error) {
    this.store.update((state) => {
      state.interrupted = state.interrupted.filter(
        (entry) => !(entry.folderId === task.folderId && entry.relativePath === task.relativePath)
      );
      state.interrupted.push({
        id: randomUUID(),
        folderId: task.folderId,
        folderName: task.folderName,
        sourcePath: task.absolutePath,
        relativePath: task.relativePath,
        size: task.size,
        mtimeMs: task.mtimeMs,
        attempts: 3,
        lastError: error.message,
        failedAt: new Date().toISOString()
      });
    });
    this.stateChanged();
  }

  async run({ folderId = null, trigger = 'manual', changedPaths = [] } = {}) {
    if (this.running) throw new Error('A backup is already running.');
    this.running = true;
    const startedAt = new Date().toISOString();
    const jobId = randomUUID();
    let uploaded = 0;
    let skipped = 0;
    let failed = 0;
    let excluded = 0;
    let excludedBytes = 0;

    try {
      const state = this.store.get();
      const vault = this.vaultFactory(state, this.appDataPath, { store: this.store });
      const folders = folderId
        ? state.folders.filter((folder) => folder.id === folderId)
        : state.folders;

      if (!folders.length) throw new Error('Add at least one folder first.');

      this.store.update((draft) => {
        draft.jobs.push({
          id: jobId,
          startedAt,
          completedAt: null,
          status: 'running',
          uploaded: 0,
          skipped: 0,
          failed: 0,
          excluded: 0,
          excludedBytes: 0,
          trigger,
          folderId
        });
      });

      for (const folder of folders) {
        const absoluteExclusions = state.settings.provider === 'local' && state.settings.localVaultPath
          ? [state.settings.localVaultPath]
          : [];
        const scan = await this.scanFolder(
          folder,
          state.settings.exclusions,
          absoluteExclusions,
          state.settings.smartBackup
        );
        excluded += scan.smartSummary.excludedFiles;
        excludedBytes += scan.smartSummary.excludedBytes;
        const scanned = scan.files;
        let folderSkipped = 0;
        let folderFailed = 0;
        const tasks = [];
        const forcedPaths = folderId === folder.id ? changedPaths : [];

        for (const file of scanned) {
          if (await this.isChanged(folder.id, file, forcedPaths)) {
            tasks.push({
              ...file,
              folderId: folder.id,
              folderName: folder.name,
              deviceId: state.deviceId,
              provider: state.settings.provider
            });
          } else {
            skipped += 1;
            folderSkipped += 1;
          }
        }

        const concurrency = Math.max(1, Math.min(6, state.settings.maxConcurrentUploads || 3));
        let cursor = 0;
        const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
          while (cursor < tasks.length) {
            const task = tasks[cursor++];
            try {
              await this.uploadWithRetries(task, vault);
              uploaded += 1;
            } catch (error) {
              failed += 1;
              folderFailed += 1;
              this.recordInterrupted(task, error);
            }
            this.progress({
              type: 'summary',
              uploaded,
              skipped,
              failed,
              excluded,
              excludedBytes,
              total: scanned.length + scan.smartSummary.excludedFiles
            });
          }
        });
        await Promise.all(workers);

        // Publish a folder snapshot only when every changed file was stored successfully.
        // This makes "Restore folder" represent one complete folder state rather than a mix
        // of partially uploaded files from different runs.
        if (folderFailed === 0) {
          this.store.update((draft) => {
            const entries = scanned
              .map((file) => {
                const fingerprint = draft.fingerprints[`${folder.id}:${file.relativePath}`];
                return fingerprint?.versionId
                  ? { relativePath: file.relativePath, versionId: fingerprint.versionId }
                  : null;
              })
              .filter(Boolean);

            const activePaths = new Set(scanned.map((file) => file.relativePath));
            const prefix = `${folder.id}:`;
            for (const key of Object.keys(draft.fingerprints)) {
              if (key.startsWith(prefix) && !activePaths.has(key.slice(prefix.length))) {
                delete draft.fingerprints[key];
              }
            }

            draft.folderSnapshots[folder.id] = {
              folderId: folder.id,
              folderName: folder.name,
              sourcePath: folder.path,
              completedAt: new Date().toISOString(),
              fileCount: entries.length,
              skipped: folderSkipped,
              directories: scan.directories,
              smartSummary: scan.smartSummary,
              smartProfile: state.settings.smartBackup?.enabled === false ? 'disabled' : state.settings.smartBackup?.profile || 'balanced',
              entries
            };
          });
          this.stateChanged();
        }
      }

      this.store.update((draft) => {
        const job = draft.jobs.find((item) => item.id === jobId);
        if (job) {
          job.completedAt = new Date().toISOString();
          job.status = failed ? 'completed_with_warnings' : 'completed';
          job.uploaded = uploaded;
          job.skipped = skipped;
          job.failed = failed;
          job.excluded = excluded;
          job.excludedBytes = excludedBytes;
        }
      });
      this.stateChanged();
      return { uploaded, skipped, failed, excluded, excludedBytes };
    } catch (error) {
      this.store.update((draft) => {
        const job = draft.jobs.find((item) => item.id === jobId);
        if (job) {
          job.completedAt = new Date().toISOString();
          job.status = 'failed';
          job.uploaded = uploaded;
          job.skipped = skipped;
          job.failed = failed;
          job.excluded = excluded;
          job.excludedBytes = excludedBytes;
          job.error = error.message;
        }
      });
      this.stateChanged();
      throw error;
    } finally {
      this.running = false;
    }
  }

  async manualUpload(filePaths) {
    const state = this.store.get();
    const vault = this.vaultFactory(state, this.appDataPath, { store: this.store });
    let uploaded = 0;
    let failed = 0;

    for (const input of filePaths) {
      const absolutePath = assertExistingFile(input);
      const stat = await fs.promises.stat(absolutePath);
      const task = {
        absolutePath,
        relativePath: path.basename(absolutePath),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        folderId: 'manual',
        folderName: 'Manual Uploads',
        deviceId: state.deviceId,
        provider: state.settings.provider
      };
      try {
        await this.uploadWithRetries(task, vault);
        uploaded += 1;
      } catch (error) {
        failed += 1;
        this.recordInterrupted(task, error);
      }
    }
    return { uploaded, failed };
  }

  async retry(interruptedId) {
    const state = this.store.get();
    const entry = state.interrupted.find((item) => item.id === interruptedId);
    if (!entry) throw new Error('Interrupted file no longer exists.');
    const absolutePath = assertExistingFile(entry.sourcePath);
    const stat = await fs.promises.stat(absolutePath);
    const vault = this.vaultFactory(state, this.appDataPath, { store: this.store });
    const task = {
      absolutePath,
      relativePath: entry.relativePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      folderId: entry.folderId,
      folderName: entry.folderName,
      deviceId: state.deviceId,
      provider: state.settings.provider
    };
    try {
      await this.uploadWithRetries(task, vault);
      return { ok: true };
    } catch (error) {
      this.recordInterrupted(task, error);
      throw error;
    }
  }
}

module.exports = { BackupEngine };
