const fs = require('node:fs');
const path = require('node:path');

function normalizeRelative(input = '') {
  return String(input).replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function isSameOrInside(parentPath, candidatePath) {
  if (!parentPath || !candidatePath) return false;
  const parent = path.resolve(parentPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function latestCompletedJobTime(state, now = Date.now()) {
  let latest = 0;
  const maximumReasonableTime = now + 60_000;
  for (const job of state.jobs || []) {
    const value = Date.parse(job.completedAt || '');
    if (Number.isFinite(value) && value <= maximumReasonableTime && value > latest) latest = value;
  }
  return latest;
}

class BackupAutomation {
  constructor({
    store,
    engine,
    emit = () => {},
    watchFactory = fs.watch,
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    intervalPollMs = 15_000
  }) {
    this.store = store;
    this.engine = engine;
    this.emit = emit;
    this.watchFactory = watchFactory;
    this.now = now;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.intervalPollMs = intervalPollMs;

    this.watchers = new Map();
    this.pending = new Map();
    this.intervalTimer = null;
    this.unsubscribe = null;
    this.started = false;
    this.paused = false;
    this.intervalAnchorAt = this.now();
    this.intervalSignature = '';
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.sync(this.store.get());
    if (typeof this.store.subscribe === 'function') {
      this.unsubscribe = this.store.subscribe((state) => this.sync(state));
    }
    this.intervalTimer = this.setIntervalFn(() => {
      this.tickInterval().catch((error) => {
        this.emit({ type: 'error', message: error.message });
      });
    }, this.intervalPollMs);
    this.intervalTimer?.unref?.();
  }

  setPaused(paused) {
    const next = Boolean(paused);
    if (this.paused === next) return;
    this.paused = next;

    if (next) {
      for (const entry of this.pending.values()) {
        if (entry.timer) this.clearTimeoutFn(entry.timer);
        entry.timer = null;
      }
      this.emit({
        type: 'automation-paused',
        message: 'Automatic backups are paused. Folder monitoring remains active.'
      });
      return;
    }

    const state = this.store.get();
    for (const folderId of this.pending.keys()) this.schedulePending(folderId, state);
    this.emit({
      type: 'automation-resumed',
      message: 'Automatic backups resumed.'
    });
  }

  isPaused() {
    return this.paused;
  }

  getStatus(state = this.store.get()) {
    const now = this.now();
    const settings = state.settings || {};
    const folders = state.folders || [];
    const intervalMinutes = Math.max(5, Math.min(1440, Number(settings.scheduleMinutes) || 30));
    const automaticConfigured = Boolean(settings.autoBackup || settings.watchChanges);
    const intervalBaselineAt = Math.max(this.intervalAnchorAt, latestCompletedJobTime(state, now));
    const nextIntervalAt = settings.autoBackup && folders.length && !this.paused
      ? intervalBaselineAt + intervalMinutes * 60_000
      : null;

    const pendingChanges = [...this.pending.entries()].map(([folderId, entry]) => {
      const folder = folders.find((item) => item.id === folderId);
      const waitMinutes = Math.max(1, Math.min(1440, Number(settings.changeDebounceMinutes) || 10));
      return {
        folderId,
        folderName: folder?.name || 'Protected folder',
        lastChangeAt: new Date(entry.lastChangeAt).toISOString(),
        runAt: new Date(entry.lastChangeAt + waitMinutes * 60_000).toISOString(),
        changedPathCount: entry.paths.size
      };
    });
    const nextChangeAt = pendingChanges.length
      ? Math.min(...pendingChanges.map((entry) => Date.parse(entry.runAt)).filter(Number.isFinite))
      : null;
    const candidates = [
      nextIntervalAt == null ? null : { at: nextIntervalAt, kind: 'interval' },
      nextChangeAt == null ? null : { at: nextChangeAt, kind: 'change' }
    ].filter(Boolean).sort((a, b) => a.at - b.at);
    const next = this.paused ? null : candidates[0] || null;

    return {
      now: new Date(now).toISOString(),
      started: this.started,
      paused: this.paused,
      running: Boolean(this.engine.running),
      automaticConfigured,
      autoBackup: Boolean(settings.autoBackup),
      watchChanges: Boolean(settings.watchChanges),
      intervalMinutes,
      intervalAnchorAt: new Date(this.intervalAnchorAt).toISOString(),
      nextIntervalAt: nextIntervalAt == null ? null : new Date(nextIntervalAt).toISOString(),
      nextChangeAt: nextChangeAt == null ? null : new Date(nextChangeAt).toISOString(),
      nextRunAt: next == null ? null : new Date(next.at).toISOString(),
      nextRunKind: next?.kind || null,
      watcherCount: this.watchers.size,
      pendingChangeCount: pendingChanges.length,
      pendingChanges
    };
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.intervalTimer) this.clearIntervalFn(this.intervalTimer);
    this.intervalTimer = null;

    for (const entry of this.watchers.values()) {
      try {
        entry.watcher.close();
      } catch {
        // Ignore watcher shutdown errors.
      }
    }
    this.watchers.clear();

    for (const entry of this.pending.values()) {
      if (entry.timer) this.clearTimeoutFn(entry.timer);
    }
    this.pending.clear();
  }

  sync(state = this.store.get()) {
    const intervalSignature = `${Boolean(state.settings.autoBackup)}:${Number(state.settings.scheduleMinutes) || 30}`;
    if (intervalSignature !== this.intervalSignature) {
      this.intervalSignature = intervalSignature;
      this.intervalAnchorAt = this.now();
    }

    const enabled = Boolean(state.settings.watchChanges);
    const desired = new Map((state.folders || []).map((folder) => [folder.id, folder]));

    for (const [folderId, entry] of this.watchers) {
      const folder = desired.get(folderId);
      if (!enabled || !folder || path.resolve(folder.path) !== entry.path) {
        try {
          entry.watcher.close();
        } catch {
          // Ignore watcher shutdown errors.
        }
        this.watchers.delete(folderId);
        this.clearPending(folderId);
      }
    }

    if (!enabled) return;

    for (const folder of desired.values()) {
      if (this.watchers.has(folder.id)) {
        this.reschedulePending(folder.id, state);
        continue;
      }
      if (!fs.existsSync(folder.path)) continue;
      this.createWatcher(folder);
    }
  }

  createWatcher(folder) {
    const resolvedPath = path.resolve(folder.path);
    let watcher;
    try {
      watcher = this.watchFactory(
        resolvedPath,
        { recursive: true, persistent: false },
        (eventType, filename) => this.handleChange(folder.id, eventType, filename)
      );
    } catch (error) {
      this.emit({
        type: 'error',
        message: `Could not watch ${folder.name}: ${error.message}`
      });
      return;
    }

    watcher.on?.('error', (error) => {
      this.emit({ type: 'error', message: `Folder watcher failed for ${folder.name}: ${error.message}` });
      try {
        watcher.close();
      } catch {
        // Ignore watcher shutdown errors.
      }
      this.watchers.delete(folder.id);
    });

    this.watchers.set(folder.id, { watcher, path: resolvedPath });
  }

  shouldIgnoreChange(state, folder, relativePath) {
    const normalized = normalizeRelative(relativePath);
    const segments = normalized.toLowerCase().split('/').filter(Boolean);
    const excluded = new Set((state.settings.exclusions || []).map((value) => String(value).toLowerCase()));
    if (segments.some((segment) => excluded.has(segment))) return true;

    if (state.settings.provider === 'local' && state.settings.localVaultPath) {
      const absolute = normalized ? path.resolve(folder.path, normalized) : path.resolve(folder.path);
      if (isSameOrInside(state.settings.localVaultPath, absolute)) return true;
    }

    return false;
  }

  handleChange(folderId, _eventType, filename) {
    if (!this.started) return;
    const state = this.store.get();
    if (!state.settings.watchChanges) return;
    const folder = state.folders.find((item) => item.id === folderId);
    if (!folder) return;

    const relativePath = filename == null ? '' : normalizeRelative(Buffer.isBuffer(filename) ? filename.toString() : filename);
    if (this.shouldIgnoreChange(state, folder, relativePath)) return;

    const existing = this.pending.get(folderId) || {
      lastChangeAt: 0,
      paths: new Set(),
      timer: null
    };
    existing.lastChangeAt = this.now();
    existing.paths.add(relativePath);
    if (existing.timer) this.clearTimeoutFn(existing.timer);
    this.pending.set(folderId, existing);
    this.schedulePending(folderId, state);

    const waitMinutes = Math.max(1, Math.min(1440, Number(state.settings.changeDebounceMinutes) || 10));
    this.emit({
      type: 'change-waiting',
      folderId,
      folderName: folder.name,
      changedPath: relativePath || folder.name,
      runAt: new Date(existing.lastChangeAt + waitMinutes * 60_000).toISOString(),
      message: `Change detected in ${folder.name}. Backup will run after ${waitMinutes} quiet minute${waitMinutes === 1 ? '' : 's'}.`
    });
  }

  schedulePending(folderId, state = this.store.get(), overrideDelayMs = null) {
    const entry = this.pending.get(folderId);
    if (!entry) return;
    if (entry.timer) this.clearTimeoutFn(entry.timer);
    entry.timer = null;
    if (this.paused) return;

    const waitMinutes = Math.max(1, Math.min(1440, Number(state.settings.changeDebounceMinutes) || 10));
    const dueAt = entry.lastChangeAt + waitMinutes * 60_000;
    const delay = overrideDelayMs == null ? Math.max(0, dueAt - this.now()) : overrideDelayMs;
    entry.timer = this.setTimeoutFn(() => {
      entry.timer = null;
      this.runPendingFolder(folderId).catch((error) => {
        this.emit({ type: 'error', message: error.message });
      });
    }, delay);
    entry.timer?.unref?.();
  }

  reschedulePending(folderId, state = this.store.get()) {
    const entry = this.pending.get(folderId);
    if (!entry) return;
    this.schedulePending(folderId, state);
  }

  clearPending(folderId) {
    const entry = this.pending.get(folderId);
    if (entry?.timer) this.clearTimeoutFn(entry.timer);
    this.pending.delete(folderId);
  }

  async runPendingFolder(folderId) {
    if (this.paused) return;
    const state = this.store.get();
    const folder = state.folders.find((item) => item.id === folderId);
    const pending = this.pending.get(folderId);
    if (!folder || !pending || !state.settings.watchChanges) {
      this.clearPending(folderId);
      return;
    }

    if (this.engine.running) {
      this.schedulePending(folderId, state, 30_000);
      return;
    }

    const runStartedAt = this.now();
    const changedPaths = [...pending.paths];
    this.emit({
      type: 'automation-start',
      folderId,
      message: `Changes in ${folder.name} stayed quiet. Starting incremental backup.`
    });

    try {
      const result = await this.engine.run({
        folderId,
        trigger: 'change',
        changedPaths
      });
      const current = this.pending.get(folderId);
      if (current && current.lastChangeAt <= runStartedAt) this.clearPending(folderId);
      else if (current) this.schedulePending(folderId, this.store.get());

      this.emit({
        type: 'automation-complete',
        folderId,
        message: `Automatic change backup finished: ${result.uploaded} uploaded, ${result.skipped} unchanged, ${result.failed} interrupted.`
      });
    } catch (error) {
      const current = this.pending.get(folderId);
      if (current) this.schedulePending(folderId, this.store.get(), 60_000);
      throw new Error(`Automatic change backup failed for ${folder.name}: ${error.message}`);
    }
  }

  async tickInterval() {
    if (!this.started || this.paused) return;
    const state = this.store.get();
    if (!state.settings.autoBackup || this.engine.running || !(state.folders || []).length) return;

    const minutes = Math.max(5, Math.min(1440, Number(state.settings.scheduleMinutes) || 30));
    const baseline = Math.max(this.intervalAnchorAt, latestCompletedJobTime(state, this.now()));
    if (this.now() - baseline < minutes * 60_000) return;

    const eligibleFolders = state.folders.filter((folder) => !this.pending.has(folder.id));
    if (!eligibleFolders.length) return;

    this.intervalAnchorAt = this.now();
    this.emit({
      type: 'automation-start',
      message: `Starting scheduled ${minutes}-minute backup. Folders waiting for their quiet period are deferred.`
    });
    try {
      const total = { uploaded: 0, skipped: 0, failed: 0 };
      if (eligibleFolders.length === state.folders.length) {
        const result = await this.engine.run({ trigger: 'interval' });
        total.uploaded += result.uploaded;
        total.skipped += result.skipped;
        total.failed += result.failed;
      } else {
        for (const folder of eligibleFolders) {
          const result = await this.engine.run({ folderId: folder.id, trigger: 'interval' });
          total.uploaded += result.uploaded;
          total.skipped += result.skipped;
          total.failed += result.failed;
        }
      }
      this.emit({
        type: 'automation-complete',
        message: `Scheduled backup finished: ${total.uploaded} uploaded, ${total.skipped} unchanged, ${total.failed} interrupted.`
      });
    } catch (error) {
      throw new Error(`Scheduled backup failed: ${error.message}`);
    }
  }
}

module.exports = {
  BackupAutomation,
  isSameOrInside,
  latestCompletedJobTime,
  normalizeRelative
};
