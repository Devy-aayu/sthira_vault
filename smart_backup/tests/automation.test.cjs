const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StateStore } = require('../electron/state-store.cjs');
const { BackupAutomation } = require('../electron/backup-automation.cjs');

function createFakeTimers() {
  const timeouts = [];
  const intervals = [];
  return {
    timeouts,
    intervals,
    setTimeoutFn(fn, delay) {
      const timer = { fn, delay, cleared: false, unref() {} };
      timeouts.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) {
      timer.cleared = true;
    },
    setIntervalFn(fn, delay) {
      const timer = { fn, delay, cleared: false, unref() {} };
      intervals.push(timer);
      return timer;
    },
    clearIntervalFn(timer) {
      timer.cleared = true;
    }
  };
}

function createStoreWithFolder(temp, settings = {}) {
  const source = path.join(temp, 'source');
  fs.mkdirSync(source, { recursive: true });
  const store = new StateStore(path.join(temp, 'state.json'));
  store.update((state) => {
    state.folders.push({ id: 'folder-1', name: 'source', path: source, addedAt: new Date().toISOString() });
    Object.assign(state.settings, settings);
  });
  return { store, source };
}

test('change timer restarts after every new edit and runs only after the final quiet period', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-backup-automation-'));
  const { store } = createStoreWithFolder(temp, {
    watchChanges: true,
    changeDebounceMinutes: 10
  });
  const timers = createFakeTimers();
  let now = 1_000;
  const runs = [];
  const engine = {
    running: false,
    async run(options) {
      runs.push(options);
      return { uploaded: 1, skipped: 0, failed: 0 };
    }
  };

  const automation = new BackupAutomation({
    store,
    engine,
    now: () => now,
    watchFactory: () => ({ on() {}, close() {} }),
    ...timers
  });
  automation.start();

  automation.handleChange('folder-1', 'change', 'notes.txt');
  const firstTimer = timers.timeouts.at(-1);
  assert.equal(firstTimer.delay, 10 * 60_000);

  now += 5 * 60_000;
  automation.handleChange('folder-1', 'change', 'notes.txt');
  const secondTimer = timers.timeouts.at(-1);
  assert.equal(firstTimer.cleared, true);
  assert.equal(secondTimer.delay, 10 * 60_000);
  assert.equal(runs.length, 0);

  now += 10 * 60_000;
  await automation.runPendingFolder('folder-1');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].trigger, 'change');
  assert.deepEqual(runs[0].changedPaths, ['notes.txt']);
  assert.equal(automation.pending.has('folder-1'), false);
  automation.stop();
});

test('fixed interval waits for the selected duration before starting', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-backup-interval-'));
  const { store } = createStoreWithFolder(temp, {
    autoBackup: true,
    scheduleMinutes: 30
  });
  const timers = createFakeTimers();
  let now = 0;
  const runs = [];
  const engine = {
    running: false,
    async run(options) {
      runs.push(options);
      return { uploaded: 0, skipped: 1, failed: 0 };
    }
  };

  const automation = new BackupAutomation({
    store,
    engine,
    now: () => now,
    watchFactory: () => ({ on() {}, close() {} }),
    ...timers
  });
  automation.start();

  now = 29 * 60_000;
  await automation.tickInterval();
  assert.equal(runs.length, 0);

  now = 30 * 60_000;
  await automation.tickInterval();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].trigger, 'interval');
  automation.stop();
});

test('fixed interval does not bypass a folder quiet-period timer', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-backup-deferred-'));
  const { store } = createStoreWithFolder(temp, {
    autoBackup: true,
    scheduleMinutes: 30,
    watchChanges: true,
    changeDebounceMinutes: 10
  });
  const timers = createFakeTimers();
  let now = 0;
  const runs = [];
  const engine = {
    running: false,
    async run(options) {
      runs.push(options);
      return { uploaded: 0, skipped: 1, failed: 0 };
    }
  };

  const automation = new BackupAutomation({
    store,
    engine,
    now: () => now,
    watchFactory: () => ({ on() {}, close() {} }),
    ...timers
  });
  automation.start();
  automation.handleChange('folder-1', 'change', 'draft.txt');

  now = 30 * 60_000;
  await automation.tickInterval();
  assert.equal(runs.length, 0);

  await automation.runPendingFolder('folder-1');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].trigger, 'change');
  automation.stop();
});

test('pausing automatic backup keeps change tracking but prevents uploads until resumed', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-backup-paused-'));
  const { store } = createStoreWithFolder(temp, {
    autoBackup: true,
    scheduleMinutes: 5,
    watchChanges: true,
    changeDebounceMinutes: 10
  });
  const timers = createFakeTimers();
  let now = 0;
  const runs = [];
  const engine = {
    running: false,
    async run(options) {
      runs.push(options);
      return { uploaded: 1, skipped: 0, failed: 0 };
    }
  };

  const automation = new BackupAutomation({
    store,
    engine,
    now: () => now,
    watchFactory: () => ({ on() {}, close() {} }),
    ...timers
  });
  automation.start();
  automation.setPaused(true);

  automation.handleChange('folder-1', 'change', 'paused.txt');
  assert.equal(automation.pending.has('folder-1'), true);
  assert.equal(automation.pending.get('folder-1').timer, null);

  now = 10 * 60_000;
  await automation.runPendingFolder('folder-1');
  await automation.tickInterval();
  assert.equal(runs.length, 0);

  automation.setPaused(false);
  assert.notEqual(automation.pending.get('folder-1').timer, null);
  await automation.runPendingFolder('folder-1');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].trigger, 'change');
  automation.stop();
});

test('automation status exposes the exact next fixed-interval run and watcher count', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-backup-status-'));
  const { store } = createStoreWithFolder(temp, {
    autoBackup: true,
    scheduleMinutes: 30,
    watchChanges: true
  });
  const timers = createFakeTimers();
  let now = 5_000;
  const automation = new BackupAutomation({
    store,
    engine: { running: false, async run() { return { uploaded: 0, skipped: 0, failed: 0 }; } },
    now: () => now,
    watchFactory: () => ({ on() {}, close() {} }),
    ...timers
  });
  automation.start();

  const status = automation.getStatus();
  assert.equal(status.nextRunKind, 'interval');
  assert.equal(Date.parse(status.nextRunAt), now + 30 * 60_000);
  assert.equal(status.watcherCount, 1);
  assert.equal(status.automaticConfigured, true);
  automation.stop();
});

test('automation status prefers a pending quiet-period backup and updates after another edit', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-backup-status-change-'));
  const { store } = createStoreWithFolder(temp, {
    autoBackup: true,
    scheduleMinutes: 30,
    watchChanges: true,
    changeDebounceMinutes: 10
  });
  const timers = createFakeTimers();
  let now = 10_000;
  const automation = new BackupAutomation({
    store,
    engine: { running: false, async run() { return { uploaded: 0, skipped: 0, failed: 0 }; } },
    now: () => now,
    watchFactory: () => ({ on() {}, close() {} }),
    ...timers
  });
  automation.start();
  automation.handleChange('folder-1', 'change', 'draft.txt');
  const first = automation.getStatus();
  assert.equal(first.nextRunKind, 'change');
  assert.equal(Date.parse(first.nextRunAt), now + 10 * 60_000);

  now += 5 * 60_000;
  automation.handleChange('folder-1', 'change', 'draft.txt');
  const second = automation.getStatus();
  assert.equal(Date.parse(second.nextRunAt), now + 10 * 60_000);
  assert.equal(second.pendingChangeCount, 1);
  automation.stop();
});

test('future-dated completed jobs do not postpone the scheduler after a Windows clock change', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-backup-clock-shift-'));
  const { store } = createStoreWithFolder(temp, {
    autoBackup: true,
    scheduleMinutes: 30
  });
  const timers = createFakeTimers();
  let now = 1_000_000;
  store.update((state) => {
    state.jobs.push({
      id: 'future-job',
      startedAt: new Date(now + 9 * 60_000).toISOString(),
      completedAt: new Date(now + 10 * 60_000).toISOString(),
      status: 'completed',
      trigger: 'interval'
    });
  });
  const automation = new BackupAutomation({
    store,
    engine: { running: false, async run() { return { uploaded: 0, skipped: 0, failed: 0 }; } },
    now: () => now,
    watchFactory: () => ({ on() {}, close() {} }),
    ...timers
  });
  automation.start();
  const status = automation.getStatus();
  assert.equal(Date.parse(status.nextIntervalAt), now + 30 * 60_000);
  automation.stop();
});
