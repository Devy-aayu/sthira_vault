import React, { useEffect, useMemo, useRef, useState } from 'react';

const api = window.backupApp;

function formatBytes(bytes = 0) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function formatDate(value) {
  if (!value) return 'Never';
  return new Date(value).toLocaleString();
}


function parseTimestamp(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTime(value) {
  const timestamp = typeof value === 'number' ? value : parseTimestamp(value);
  if (timestamp == null) return '—';
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatCountdown(target, now = Date.now()) {
  const timestamp = typeof target === 'number' ? target : parseTimestamp(target);
  if (timestamp == null) return 'Not scheduled';
  const remaining = Math.max(0, timestamp - now);
  const totalSeconds = Math.floor(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

function triggerLabel(trigger) {
  if (trigger === 'interval') return 'Fixed interval';
  if (trigger === 'change') return 'After changes stopped';
  return 'Manual';
}

function latestCompletedJob(jobs = []) {
  return [...jobs]
    .filter((job) => job.completedAt && job.status !== 'running')
    .sort((a, b) => (parseTimestamp(b.completedAt) || 0) - (parseTimestamp(a.completedAt) || 0))[0] || null;
}

function activityEntryFromProgress(payload) {
  const timestamp = Date.now();
  if (!payload) return null;
  if (payload.type === 'file') {
    return {
      timestamp,
      tone: payload.status === 'retrying' ? 'warning' : 'info',
      label: payload.status === 'retrying' ? 'RETRY' : 'UPLOAD',
      message: payload.status === 'retrying'
        ? `Attempt ${payload.attempt}/3 · ${payload.path}`
        : payload.path
    };
  }
  if (payload.type === 'summary') {
    return {
      timestamp,
      tone: payload.failed ? 'warning' : 'muted',
      label: 'SCAN',
      message: `${payload.uploaded} uploaded · ${payload.skipped} unchanged · ${payload.excluded || 0} smart-skipped · ${payload.failed} interrupted`
    };
  }
  if (payload.type === 'change-waiting') {
    return { timestamp, tone: 'waiting', label: 'QUIET', message: payload.message };
  }
  if (payload.type === 'automation-start') {
    return { timestamp, tone: 'info', label: 'AUTO', message: payload.message };
  }
  if (payload.type === 'automation-complete') {
    return { timestamp, tone: 'success', label: 'DONE', message: payload.message };
  }
  if (payload.type === 'automation-paused') {
    return { timestamp, tone: 'warning', label: 'PAUSE', message: payload.message };
  }
  if (payload.type === 'automation-resumed') {
    return { timestamp, tone: 'success', label: 'RESUME', message: payload.message };
  }
  if (payload.type === 'error') {
    return { timestamp, tone: 'error', label: 'ERROR', message: payload.message };
  }
  return null;
}

function fileNameFromPath(relativePath = '') {
  return relativePath.split('/').at(-1) || relativePath;
}

function directoryFromPath(relativePath = '') {
  const parts = relativePath.split('/');
  parts.pop();
  return parts.join('/') || 'Folder root';
}

function StatusPill({ children, tone = 'neutral' }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

function buildFileTree(files, directoryPaths) {
  const root = { name: '', path: '', directories: new Map(), files: [] };

  function ensureDirectory(relativePath) {
    if (!relativePath) return root;
    const parts = relativePath.split('/').filter(Boolean);
    let current = root;
    let currentPath = '';
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!current.directories.has(part)) {
        current.directories.set(part, {
          name: part,
          path: currentPath,
          directories: new Map(),
          files: []
        });
      }
      current = current.directories.get(part);
    }
    return current;
  }

  for (const directoryPath of directoryPaths || []) ensureDirectory(directoryPath);

  for (const file of files || []) {
    const parts = file.relativePath.split('/');
    parts.pop();
    ensureDirectory(parts.join('/')).files.push(file);
  }

  function finalize(node) {
    return {
      ...node,
      directories: [...node.directories.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(finalize),
      files: [...node.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    };
  }

  return finalize(root);
}

function Icon({ name, size = 18, strokeWidth = 1.8, className = '' }) {
  const paths = {
    home: <><path d="m3 10 9-7 9 7"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-7h6v7"/></>,
    backup: <><ellipse cx="12" cy="5" rx="7.5" ry="3"/><path d="M4.5 5v5c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V5"/><path d="M4.5 10v5c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-5"/><path d="M4.5 15v4c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-4"/></>,
    folder: <><path d="M3.5 6.5h6l2 2h9v10.5H3.5z"/><path d="M3.5 6.5v-2h6l2 2"/></>,
    activity: <><path d="M3 12h4l2-6 4 12 2-6h6"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.8 1.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.2h-2.6v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1-1.8-1.8.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1h-.2v-2.6h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 1.8-1.8.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5v-.2h2.6v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1 1.8 1.8-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.2V14h-.2a1.7 1.7 0 0 0-1.5 1z"/></>,
    upload: <><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 15v5h14v-5"/></>,
    restore: <><path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v5h5"/></>,
    search: <><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></>,
    bell: <><path d="M18 9a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
    arrow: <><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    shield: <><path d="M12 3 20 6v5c0 5-3.4 8.3-8 10-4.6-1.7-8-5-8-10V6z"/><path d="m8.5 12 2.2 2.2 4.8-5"/></>,
    cloud: <><path d="M7.5 18h9a4.5 4.5 0 1 0-.7-8.9A5.5 5.5 0 0 0 5 10.5 3.5 3.5 0 0 0 7.5 18z"/></>,
    clock: <><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/></>,
    warning: <><path d="m12 4 9 16H3z"/><path d="M12 9v5M12 17h.01"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    menu: <><path d="M5 7h14M5 12h14M5 17h14"/></>,
    close: <><path d="m6 6 12 12M18 6 6 18"/></>,
    chevron: <path d="m8 10 4 4 4-4"/>,
    chart: <><path d="M4 19V5M4 19h16"/><path d="m7 15 3-4 3 2 4-6"/></>,
    lock: <><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
    database: <><ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5"/><path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></>,
    monitor: <><rect x="4" y="4" width="16" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></>
  };
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.home}</svg>;
}

function isProviderConnected(state, provider) {
  if (provider === 'local') return Boolean(state.settings.localVaultPath);
  if (provider === 's3') return Boolean(state.settings.s3?.endpoint && state.settings.s3?.bucket && state.settings.s3?.accessKeyId && state.settings.s3?.hasSecret);
  if (provider === 'webdav') return Boolean(state.settings.webdav?.baseUrl && state.settings.webdav?.username && state.settings.webdav?.hasPassword);
  const key = provider === 'google-drive' ? 'googleDrive'
    : provider === 'onedrive' ? 'oneDrive'
      : provider === 'dropbox' ? 'dropbox'
        : 'pCloud';
  return Boolean(state.settings[key]?.connected);
}

function providerDisplay(state, provider) {
  const item = STORAGE_PROVIDER_OPTIONS.find((entry) => entry.value === provider);
  if (!item) return { name: 'Backup storage', connected: false };
  return { name: item.name, connected: isProviderConnected(state, provider) };
}

function formatRelativeTime(value) {
  const timestamp = typeof value === 'number' ? value : parseTimestamp(value);
  if (timestamp == null) return 'Never';
  const diff = Math.max(0, Date.now() - timestamp);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'Just now';
  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))} min ago`;
  if (diff < day) return `${Math.floor(diff / hour)} hr ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} days ago`;
  return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function Dashboard({ state, refresh, setMessage, openBackupFiles, openInterrupted, openSettings }) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [automationStatus, setAutomationStatus] = useState(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const unsubscribe = api.onProgress((payload) => setProgress(payload));
    return unsubscribe;
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function readAutomationStatus() {
      try {
        const status = await api.getAutomationStatus();
        if (!cancelled) setAutomationStatus(status);
      } catch {
        if (!cancelled) setAutomationStatus(null);
      }
    }
    readAutomationStatus();
    const timer = setInterval(() => {
      setNow(Date.now());
      readAutomationStatus();
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const lastCompleted = useMemo(() => latestCompletedJob(state.jobs), [state.jobs]);
  const totalBytes = state.files.reduce((sum, file) => sum + Number(file.size || 0), 0);
  const completedJobs = useMemo(() => (state.jobs || []).filter((job) => job.completedAt && job.status !== 'running'), [state.jobs]);
  const successfulJobs = completedJobs.filter((job) => job.failed === 0 && job.status !== 'failed').length;
  const successRate = completedJobs.length ? Math.round((successfulJobs / completedJobs.length) * 1000) / 10 : null;
  const nextRunAt = parseTimestamp(automationStatus?.nextRunAt);
  const engineRunning = running || automationStatus?.running;
  const engineState = engineRunning ? 'Running' : automationStatus?.paused ? 'Paused' : automationStatus?.automaticConfigured ? 'Watching' : 'Manual';
  const provider = providerDisplay(state, state.settings.provider);

  const activitySeries = useMemo(() => {
    const days = Array.from({ length: 7 }, (_, index) => {
      const date = new Date();
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() - (6 - index));
      return { date, label: date.toLocaleDateString([], { month: 'short', day: 'numeric' }), count: 0, success: 0 };
    });
    completedJobs.forEach((job) => {
      const ts = parseTimestamp(job.completedAt);
      if (ts == null) return;
      const d = new Date(ts);
      d.setHours(0, 0, 0, 0);
      const item = days.find((day) => day.date.getTime() === d.getTime());
      if (item) {
        item.count += 1;
        if (job.failed === 0 && job.status !== 'failed') item.success += 1;
      }
    });
    return days;
  }, [completedJobs]);

  const maxSeries = Math.max(1, ...activitySeries.map((item) => item.count));
  const chartWidth = 680;
  const chartHeight = 190;
  const chartPoints = activitySeries.map((item, index) => {
    const x = 24 + (index * (chartWidth - 48)) / Math.max(1, activitySeries.length - 1);
    const y = chartHeight - 26 - ((item.count / maxSeries) * (chartHeight - 62));
    return { ...item, x, y };
  });
  const chartLine = chartPoints.map((point) => `${point.x},${point.y}`).join(' ');
  const chartArea = `M ${chartPoints[0].x} ${chartHeight - 26} L ${chartPoints.map((point) => `${point.x} ${point.y}`).join(' L ')} L ${chartPoints.at(-1).x} ${chartHeight - 26} Z`;

  const recentActivity = useMemo(() => [...(state.jobs || [])]
    .filter((job) => job.completedAt)
    .sort((a, b) => (parseTimestamp(b.completedAt) || 0) - (parseTimestamp(a.completedAt) || 0))
    .slice(0, 6), [state.jobs]);

  async function addFolder() {
    const folderPath = await api.selectFolder();
    if (!folderPath) return;
    await api.addFolder(folderPath);
    await refresh();
  }

  async function startBackup(folderId = null) {
    if (!folderId && state.folders.length === 0) {
      setMessage('Add at least one protected folder before starting a backup.');
      return;
    }
    setRunning(true);
    setMessage('');
    try {
      const result = await api.startBackup(folderId);
      setMessage(`Backup completed: ${result.uploaded} uploaded, ${result.skipped} unchanged, ${result.excluded || 0} smart-skipped, ${result.failed} interrupted.`);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setRunning(false);
    }
  }

  async function manualUpload() {
    const files = await api.selectFiles();
    if (!files.length) return;
    setRunning(true);
    try {
      const result = await api.manualUpload(files);
      setMessage(`Manual upload completed: ${result.uploaded} uploaded, ${result.failed} interrupted.`);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="dashboard-page">
      <header className="dashboard-heading">
        <div>
          <p className="section-kicker">OVERVIEW</p>
          <h1>{getGreeting()}, {state.deviceId ? 'your files are protected' : 'welcome back'}.</h1>
          <p>Monitor protection, storage, recent runs, and recovery health from one place.</p>
        </div>
        <div className="dashboard-heading-actions">
          <button className="secondary-action" onClick={openBackupFiles}><Icon name="backup" /> Browse backups</button>
          <button className="primary-action" disabled={running || state.folders.length === 0} onClick={() => startBackup()}><Icon name="backup" /> {running ? 'Backing up…' : 'Back up now'}</button>
        </div>
      </header>

      {state.interrupted.length > 0 && (
        <button className="attention-banner" onClick={openInterrupted} type="button">
          <span className="attention-icon"><Icon name="warning" /></span>
          <span className="attention-copy"><strong>{state.interrupted.length} file{state.interrupted.length === 1 ? '' : 's'} need attention</strong><small>Some uploads did not complete and are waiting for retry.</small></span>
          <span className="attention-link">Review <Icon name="arrow" size={16} /></span>
        </button>
      )}

      <section className="overview-grid">
        <article className="overview-card blue">
          <div className="overview-card-icon"><Icon name="folder" /></div>
          <div className="overview-card-copy"><span>Protected folders</span><strong>{state.folders.length}</strong><small>{automationStatus?.watcherCount ?? 0} actively watched</small></div>
          <button className="card-arrow" onClick={() => document.querySelector('.protected-folders-section')?.scrollIntoView({ behavior: 'smooth' })}><Icon name="arrow" size={16} /></button>
        </article>
        <article className="overview-card green">
          <div className="overview-card-icon"><Icon name="database" /></div>
          <div className="overview-card-copy"><span>Stored versions</span><strong>{state.files.length}</strong><small>{lastCompleted ? `Last run ${formatRelativeTime(lastCompleted.completedAt)}` : 'No completed runs yet'}</small></div>
          <button className="card-arrow" onClick={openBackupFiles}><Icon name="arrow" size={16} /></button>
        </article>
        <article className="overview-card purple">
          <div className="overview-card-icon"><Icon name="cloud" /></div>
          <div className="overview-card-copy"><span>Versioned data</span><strong>{formatBytes(totalBytes)}</strong><small>{provider.connected ? `${provider.name} connected` : `${provider.name} needs setup`}</small></div>
          <button className="card-arrow" onClick={openSettings}><Icon name="arrow" size={16} /></button>
        </article>
        <article className={`overview-card orange ${state.interrupted.length ? 'has-warning' : ''}`}>
          <div className="overview-card-icon"><Icon name={state.interrupted.length ? 'warning' : 'clock'} /></div>
          <div className="overview-card-copy"><span>{state.interrupted.length ? 'Needs attention' : 'Last backup'}</span><strong>{state.interrupted.length ? state.interrupted.length : formatRelativeTime(lastCompleted?.completedAt)}</strong><small>{state.interrupted.length ? 'Review interrupted uploads' : lastCompleted ? triggerLabel(lastCompleted.trigger) : 'Run your first backup'}</small></div>
          <button className="card-arrow" onClick={state.interrupted.length ? openInterrupted : () => startBackup()}><Icon name="arrow" size={16} /></button>
        </article>
      </section>

      <section className="dashboard-layout-grid">
        <div className="dashboard-main-column">
          <section className="surface-card activity-card">
            <div className="surface-card-header">
              <div><h2>Backup activity</h2><p>Completed backup runs over the last seven days.</p></div>
              <span className={`status-badge ${engineRunning ? 'blue-status' : 'green-status'}`}><span />{engineRunning ? 'Running now' : 'Monitoring'}</span>
            </div>
            <div className="chart-wrap">
              <svg className="activity-chart" viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label="Backup activity over the last seven days">
                <defs>
                  <linearGradient id="activityFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#5f8fff" stopOpacity="0.26"/><stop offset="100%" stopColor="#5f8fff" stopOpacity="0"/></linearGradient>
                </defs>
                {[0, 0.5, 1].map((ratio) => {
                  const y = chartHeight - 26 - ratio * (chartHeight - 62);
                  return <line key={ratio} x1="24" x2={chartWidth - 24} y1={y} y2={y} className="chart-grid" />;
                })}
                <path d={chartArea} fill="url(#activityFill)" />
                <polyline points={chartLine} className="chart-line" fill="none" />
                {chartPoints.map((point) => <circle key={point.label} cx={point.x} cy={point.y} r="4.5" className="chart-dot" />)}
                {chartPoints.map((point) => <text key={`${point.label}-label`} x={point.x} y={chartHeight - 5} textAnchor="middle" className="chart-label">{point.label}</text>)}
              </svg>
              <div className="chart-side-stat"><strong>{completedJobs.length}</strong><span>runs recorded</span><small>{successRate == null ? 'Awaiting first completed run' : `${successRate}% successful`}</small></div>
            </div>
          </section>

          <section className="surface-card provider-card">
            <div className="surface-card-header">
              <div><h2>Storage providers</h2><p>Backup destinations configured for this device.</p></div>
              <button className="text-action" onClick={openSettings}>Manage <Icon name="arrow" size={15} /></button>
            </div>
            <div className="provider-grid">
              {STORAGE_PROVIDER_OPTIONS
                .slice()
                .sort((a, b) => (a.value === state.settings.provider ? -1 : b.value === state.settings.provider ? 1 : 0))
                .slice(0, 4)
                .map((item) => {
                  const status = providerDisplay(state, item.value);
                  return (
                    <button key={item.value} className="provider-tile" onClick={openSettings} type="button">
                      <ProviderMark provider={item.value} />
                      <div><strong>{item.shortName}</strong><span className={status.connected ? 'provider-connected' : 'provider-not-connected'}>{status.connected ? 'Connected' : 'Not connected'}</span></div>
                      {item.value === state.settings.provider && <span className="provider-active-dot" title="Active destination" />}
                    </button>
                  );
                })}
            </div>
          </section>

          <section className="surface-card recent-card">
            <div className="surface-card-header">
              <div><h2>Recent activity</h2><p>The latest backup jobs from this device.</p></div>
              <button className="text-action" onClick={openBackupFiles}>View backups <Icon name="arrow" size={15} /></button>
            </div>
            {!recentActivity.length ? (
              <div className="empty-inline"><Icon name="activity" /><span>No backup runs recorded yet.</span></div>
            ) : (
              <div className="activity-table-wrap">
                <table className="activity-table"><thead><tr><th>Time</th><th>Trigger</th><th>Result</th><th>Uploaded</th><th>Skipped</th></tr></thead><tbody>
                  {recentActivity.map((job) => (
                    <tr key={job.id}>
                      <td><span className="activity-time">{formatRelativeTime(job.completedAt)}</span></td>
                      <td><span className="activity-type"><span className="activity-type-dot" />{triggerLabel(job.trigger)}</span></td>
                      <td><StatusPill tone={job.status === 'failed' ? 'warning' : job.failed ? 'warning' : 'success'}>{job.failed ? `${job.failed} interrupted` : 'Completed'}</StatusPill></td>
                      <td>{job.uploaded || 0}</td><td>{job.skipped || 0}</td>
                    </tr>
                  ))}
                </tbody></table>
              </div>
            )}
          </section>
        </div>

        <aside className="dashboard-side-column">
          <section className="surface-card engine-card">
            <div className="surface-card-header compact"><div><h2>Backup engine</h2><p>Protection state for this device.</p></div><StatusPill tone={engineState === 'Paused' ? 'warning' : engineState === 'Running' ? 'neutral' : 'success'}>{engineState}</StatusPill></div>
            <div className={`engine-health ${state.interrupted.length ? 'engine-health-warning' : ''}`}>
              <div className="engine-health-icon"><Icon name={state.interrupted.length ? 'warning' : 'shield'} /></div>
              <div><strong>{state.interrupted.length ? 'Attention required' : 'Running smoothly'}</strong><span>{state.interrupted.length ? 'Some files need retry.' : 'Your configured folders are protected.'}</span></div>
            </div>
            <div className="engine-details">
              <div><span>Destination</span><strong>{provider.name}</strong></div>
              <div><span>Mode</span><strong>{state.settings.watchChanges ? 'Smart change watch' : state.settings.autoBackup ? `Every ${state.settings.scheduleMinutes} min` : 'Manual'}</strong></div>
              <div><span>Next run</span><strong>{nextRunAt ? formatCountdown(nextRunAt, now) : 'Not scheduled'}</strong></div>
            </div>
            <div className="engine-actions"><button className="primary-action" disabled={running || state.folders.length === 0} onClick={() => startBackup()}><Icon name="backup" /> Run now</button><button className="secondary-action" onClick={openSettings}><Icon name="settings" /> Settings</button></div>
          </section>

          <section className="surface-card success-card">
            <div className="surface-card-header compact"><div><h2>Backup health</h2><p>Recent run success rate.</p></div><Icon name="activity" className="header-icon" /></div>
            <div className="health-ring" style={{ '--health-angle': `${Math.max(0, Math.min(100, successRate ?? 0)) * 3.6}deg` }}>
              <div><strong>{successRate == null ? '—' : `${successRate}%`}</strong><span>Success rate</span></div>
            </div>
            <div className="health-legend"><span><i className="green-dot" />Successful <b>{successfulJobs}</b></span><span><i className="amber-dot" />Warnings <b>{completedJobs.filter((job) => job.failed > 0).length}</b></span><span><i className="red-dot" />Failed <b>{completedJobs.filter((job) => job.status === 'failed').length}</b></span></div>
          </section>

          <section className="surface-card quick-card">
            <div className="surface-card-header compact"><div><h2>Quick actions</h2><p>Common backup tasks.</p></div><Icon name="plus" className="header-icon" /></div>
            <div className="quick-grid">
              <button onClick={addFolder}><span className="quick-icon blue-bg"><Icon name="folder" /></span><strong>Add folder</strong><small>Protect new data</small></button>
              <button onClick={manualUpload} disabled={running}><span className="quick-icon green-bg"><Icon name="upload" /></span><strong>Upload files</strong><small>Back up manually</small></button>
              <button onClick={openBackupFiles}><span className="quick-icon orange-bg"><Icon name="restore" /></span><strong>Restore</strong><small>Recover your data</small></button>
              <button onClick={openInterrupted}><span className="quick-icon purple-bg"><Icon name="warning" /></span><strong>Attention</strong><small>{state.interrupted.length ? `${state.interrupted.length} waiting` : 'All clear'}</small></button>
            </div>
          </section>
        </aside>
      </section>

      <section className="surface-card protected-folders-section">
        <div className="surface-card-header">
          <div><h2>Protected folders</h2><p>Folders monitored by the backup engine.</p></div>
          <button className="primary-action" onClick={addFolder}><Icon name="plus" /> Add folder</button>
        </div>
        {!state.folders.length ? (
          <button className="empty-state-button" onClick={addFolder}><Icon name="folder" /><strong>Add your first protected folder</strong><span>Choose a folder and Smart Backup will start tracking changes.</span></button>
        ) : (
          <div className="protected-folder-grid">{state.folders.map((folder) => (
            <div className="protected-folder-card" key={folder.id}>
              <div className="protected-folder-icon"><Icon name="folder" /></div>
              <div className="protected-folder-copy"><strong>{folder.name}</strong><span>{folder.path}</span></div>
              <span className="watch-badge"><i /> Watched</span>
              <button className="icon-button" title="Back up folder" disabled={running} onClick={() => startBackup(folder.id)}><Icon name="backup" size={16} /></button>
              <button className="icon-button danger" title="Remove folder" onClick={async () => { await api.removeFolder(folder.id); await refresh(); }}><Icon name="close" size={16} /></button>
            </div>
          ))}</div>
        )}
      </section>
    </div>
  );
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 5) return 'Good night';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function Interrupted({ state, refresh, setMessage }) {
  async function retry(id) {
    try {
      await api.retryInterrupted(id);
      setMessage('File backed up successfully.');
    } catch (error) {
      setMessage(error.message);
    }
    await refresh();
  }

  return (
    <section className="panel page-panel">
      <div className="panel-header">
        <div>
          <h1>Interrupted Files</h1>
          <p>Automatic retry stops after exactly three failed attempts.</p>
        </div>
        <button disabled={!state.interrupted.length} onClick={async () => {
          await api.retryAllInterrupted();
          await refresh();
        }}>Retry all</button>
      </div>
      {!state.interrupted.length ? (
        <div className="empty">No interrupted files.</div>
      ) : (
        <div className="rows">
          {state.interrupted.map((file) => (
            <div className="row" key={file.id}>
              <div className="file-icon warning">!</div>
              <div className="grow">
                <strong>{file.relativePath}</strong>
                <span>{formatBytes(file.size)} · {file.lastError}</span>
                <span className="path">{file.sourcePath}</span>
              </div>
              <StatusPill tone="warning">3 attempts</StatusPill>
              <button onClick={() => retry(file.id)}>Retry</button>
              <button className="danger-ghost" onClick={async () => {
                await api.clearInterrupted(file.id);
                await refresh();
              }}>Dismiss</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}



const STORAGE_PROVIDER_OPTIONS = [
  {
    value: 'google-drive',
    name: 'Google Drive',
    shortName: 'Drive',
    group: 'Easy sign-in',
    badge: 'Easy',
    tone: 'google',
    glyph: 'G',
    description: 'Sign in with Google and store backups in the app-managed Drive folder.',
    features: ['Browser sign-in', 'App-managed folder', 'Background refresh']
  },
  {
    value: 'onedrive',
    name: 'Microsoft OneDrive',
    shortName: 'OneDrive',
    group: 'Easy sign-in',
    badge: 'Easy',
    tone: 'microsoft',
    glyph: 'O',
    description: 'Sign in with Microsoft and use the dedicated OneDrive app folder.',
    features: ['Browser sign-in', 'App folder', 'Large-file upload']
  },
  {
    value: 'dropbox',
    name: 'Dropbox',
    shortName: 'Dropbox',
    group: 'Easy sign-in',
    badge: 'Easy',
    tone: 'dropbox',
    glyph: 'D',
    description: 'Sign in with Dropbox and store backup objects in the app folder.',
    features: ['Browser sign-in', 'App folder', 'Resumable upload']
  },
  {
    value: 'pcloud',
    name: 'pCloud',
    shortName: 'pCloud',
    group: 'Easy sign-in',
    badge: 'Easy',
    tone: 'pcloud',
    glyph: 'P',
    description: 'Sign in with pCloud and store backups in a Cloud Backup App folder.',
    features: ['Browser sign-in', 'Regional API', 'Direct restore']
  },
  {
    value: 's3',
    name: 'S3-compatible cloud',
    shortName: 'S3 cloud',
    group: 'Advanced cloud',
    badge: 'Advanced',
    tone: 's3',
    glyph: 'S3',
    description: 'AWS S3, Cloudflare R2, Backblaze B2 and compatible object storage.',
    features: ['Multipart upload', 'Version objects', 'Provider choice']
  },
  {
    value: 'webdav',
    name: 'WebDAV / Nextcloud',
    shortName: 'WebDAV',
    group: 'Advanced cloud',
    badge: 'Advanced',
    tone: 'webdav',
    glyph: 'W',
    description: 'Connect Nextcloud, ownCloud or another WebDAV-compatible storage folder.',
    features: ['Nextcloud', 'App passwords', 'Self-hosted']
  },
  {
    value: 'local',
    name: 'Local vault',
    shortName: 'Local vault',
    group: 'Offline storage',
    badge: 'Offline',
    tone: 'local',
    glyph: 'L',
    description: 'Store backup versions in a local folder or another connected disk.',
    features: ['No account', 'Fast restore', 'Offline']
  }
];

const OAUTH_PROVIDER_SETUP = Object.freeze({
  'google-drive': {
    settingsKey: 'google',
    title: 'Configure Google Drive',
    fieldLabel: 'Desktop OAuth client ID',
    placeholder: '1234567890-….apps.googleusercontent.com',
    secretLabel: 'Client secret (optional)',
    steps: [
      'Enable the Google Drive API in your Google Cloud project.',
      'Create an OAuth client with application type “Desktop app”.',
      'Paste the desktop client ID below, then connect the account.'
    ]
  },
  onedrive: {
    settingsKey: 'microsoft',
    title: 'Configure Microsoft OneDrive',
    fieldLabel: 'Application (client) ID',
    placeholder: '00000000-0000-0000-0000-000000000000',
    steps: [
      'Create an app registration in Microsoft Entra.',
      'Add the Mobile and desktop platform with http://localhost as the redirect URI.',
      'Allow personal Microsoft accounts when the app is intended for normal consumers.'
    ]
  },
  dropbox: {
    settingsKey: 'dropbox',
    title: 'Configure Dropbox',
    fieldLabel: 'Dropbox app key',
    placeholder: 'Your Dropbox app key',
    steps: [
      'Create a scoped Dropbox app with App Folder access.',
      'Enable account_info.read and file content/metadata read-write permissions.',
      'Paste the app key below, then connect the account.'
    ]
  },
  pcloud: {
    settingsKey: 'pcloud',
    title: 'Configure pCloud',
    fieldLabel: 'pCloud client ID',
    placeholder: 'Your pCloud application client ID',
    steps: [
      'Create a pCloud application in the pCloud developer console.',
      'Register the loopback callback described in CLOUD-PROVIDER-SETUP.md.',
      'Paste the client ID below, then connect the account.'
    ]
  }
});

function storageProviderName(provider) {
  return STORAGE_PROVIDER_OPTIONS.find((item) => item.value === provider)?.name || 'Backup storage';
}

function ProviderMark({ provider, large = false }) {
  const item = STORAGE_PROVIDER_OPTIONS.find((entry) => entry.value === provider)
    || STORAGE_PROVIDER_OPTIONS.at(-1);
  return (
    <span className={`provider-mark provider-mark-${item.tone} ${large ? 'large' : ''}`} aria-hidden="true">
      {item.glyph}
    </span>
  );
}

function ProviderDropdown({ value, onChange, statusForProvider }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const selected = STORAGE_PROVIDER_OPTIONS.find((item) => item.value === value)
    || STORAGE_PROVIDER_OPTIONS.at(-1);
  const selectedStatus = statusForProvider(value);
  const groups = [...new Set(STORAGE_PROVIDER_OPTIONS.map((item) => item.group))];

  useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => {
      if (!ref.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div className="provider-combobox" ref={ref}>
      <button
        type="button"
        className="provider-combobox-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <ProviderMark provider={selected.value} />
        <span className="provider-combobox-copy">
          <small>Backup destination</small>
          <strong>{selected.name}</strong>
        </span>
        <span className={`provider-state provider-state-${selectedStatus.tone}`}>
          <i />
          {selectedStatus.label}
        </span>
        <span className={`provider-chevron ${open ? 'open' : ''}`}>⌄</span>
      </button>

      {open && (
        <div className="provider-dropdown-menu" role="listbox" aria-label="Backup storage providers">
          {groups.map((group) => (
            <div className="provider-dropdown-group" key={group}>
              <span className="provider-dropdown-label">{group}</span>
              {STORAGE_PROVIDER_OPTIONS.filter((item) => item.group === group).map((item) => {
                const status = statusForProvider(item.value);
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={item.value === value}
                    className={`provider-option ${item.value === value ? 'selected' : ''}`}
                    key={item.value}
                    onClick={() => {
                      onChange(item.value);
                      setOpen(false);
                    }}
                  >
                    <ProviderMark provider={item.value} />
                    <span className="provider-option-copy">
                      <strong>{item.name}</strong>
                      <small>{item.description}</small>
                    </span>
                    <span className={`provider-option-status provider-state-${status.tone}`}>
                      <i />
                      {status.label}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CloudAccountPanel({
  provider,
  connected,
  accountName,
  accountEmail,
  available,
  busy,
  onConnect,
  onConfigure,
  onDisconnect
}) {
  const item = STORAGE_PROVIDER_OPTIONS.find((entry) => entry.value === provider);
  return (
    <div className={`cloud-account-panel cloud-account-${item.tone}`}>
      <div className="cloud-account-main">
        <ProviderMark provider={provider} large />
        <div className="cloud-account-copy">
          <div className="cloud-account-title">
            <strong>{connected ? `${item.name} is connected` : item.name}</strong>
            <span className={`provider-state provider-state-${connected ? 'success' : available ? 'ready' : 'setup'}`}>
              <i />
              {connected ? 'Connected' : available ? 'Ready' : 'Setup required'}
            </span>
          </div>
          <span>
            {connected
              ? accountEmail || accountName || 'Cloud account connected'
              : available
                ? 'Use the system browser to sign in. Your account password is never entered into this app.'
                : 'This build needs the provider application ID once. The setup button stays active so the publisher can configure it without editing source files.'}
          </span>
          <div className="provider-feature-list">
            {item.features.map((feature) => <span key={feature}>{feature}</span>)}
          </div>
        </div>
      </div>

      <div className="cloud-account-actions">
        {connected ? (
          <button type="button" disabled={busy} onClick={onDisconnect}>Disconnect</button>
        ) : available ? (
          <>
            <button type="button" disabled={busy} onClick={onConfigure}>App setup</button>
            <button className="primary provider-primary-action" type="button" disabled={busy} onClick={onConnect}>
              {busy ? 'Opening browser…' : `Connect ${item.shortName}`}
            </button>
          </>
        ) : (
          <button className="primary provider-primary-action" type="button" disabled={busy} onClick={onConfigure}>
            {busy ? 'Saving…' : `Set up & connect ${item.shortName}`}
          </button>
        )}
      </div>
    </div>
  );
}

function ProviderSetupModal({ provider, initialConfig, busy, onClose, onSaveAndConnect }) {
  const setup = OAUTH_PROVIDER_SETUP[provider];
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');

  useEffect(() => {
    setClientId(initialConfig?.clientId || '');
    setClientSecret('');
  }, [provider, initialConfig?.clientId]);

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [busy, onClose]);

  if (!setup) return null;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section className="provider-setup-modal" role="dialog" aria-modal="true" aria-labelledby="provider-setup-title">
        <div className="provider-setup-header">
          <div className="provider-setup-heading">
            <ProviderMark provider={provider} large />
            <div>
              <p className="eyebrow">ONE-TIME PUBLISHER SETUP</p>
              <h2 id="provider-setup-title">{setup.title}</h2>
            </div>
          </div>
          <button className="modal-close" type="button" disabled={busy} onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="provider-setup-body">
          <div className="provider-setup-steps">
            {setup.steps.map((step, index) => (
              <div key={step}>
                <span>{index + 1}</span>
                <p>{step}</p>
              </div>
            ))}
          </div>

          <label>
            {setup.fieldLabel}
            <input
              autoFocus
              value={clientId}
              placeholder={setup.placeholder}
              onChange={(event) => setClientId(event.target.value)}
            />
          </label>

          {provider === 'google-drive' && (
            <label>
              {setup.secretLabel}
              <input
                type="password"
                value={clientSecret}
                placeholder={initialConfig?.hasClientSecret ? 'Already stored — leave blank to keep it' : 'Optional for a desktop OAuth client'}
                onChange={(event) => setClientSecret(event.target.value)}
              />
            </label>
          )}

          <div className="provider-security-note">
            <strong>Not a cloud-account password</strong>
            <span>These values identify the desktop application. End users will still sign in safely in the provider’s own browser page.</span>
          </div>
        </div>

        <div className="provider-setup-footer">
          <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button
            className="primary"
            type="button"
            disabled={busy || !clientId.trim()}
            onClick={() => onSaveAndConnect({
              clientId: clientId.trim(),
              clientSecret: clientSecret.trim()
            })}
          >
            {busy ? 'Saving configuration…' : 'Save and connect'}
          </button>
        </div>
      </section>
    </div>
  );
}

function Settings({ state, refresh, setMessage }) {
  const [form, setForm] = useState(() => ({
    provider: state.settings.provider,
    localVaultPath: state.settings.localVaultPath,
    autoBackup: state.settings.autoBackup,
    scheduleMinutes: state.settings.scheduleMinutes,
    watchChanges: state.settings.watchChanges,
    changeDebounceMinutes: state.settings.changeDebounceMinutes,
    runInBackground: state.settings.runInBackground !== false,
    launchAtLogin: Boolean(state.settings.launchAtLogin),
    startMinimized: state.settings.startMinimized !== false,
    maxConcurrentUploads: state.settings.maxConcurrentUploads,
    smartBackup: {
      enabled: state.settings.smartBackup?.enabled !== false,
      profile: state.settings.smartBackup?.profile || 'balanced',
      maxFileSizeMB: state.settings.smartBackup?.maxFileSizeMB ?? 1024,
      includeLargeMedia: Boolean(state.settings.smartBackup?.includeLargeMedia),
      includeArchives: Boolean(state.settings.smartBackup?.includeArchives),
      skipTemporaryFiles: state.settings.smartBackup?.skipTemporaryFiles !== false,
      skipGeneratedFolders: state.settings.smartBackup?.skipGeneratedFolders !== false
    },
    exclusionsText: (state.settings.exclusions || []).join(', '),
    s3: {
      endpoint: state.settings.s3.endpoint,
      region: state.settings.s3.region,
      bucket: state.settings.s3.bucket,
      accessKeyId: state.settings.s3.accessKeyId,
      secretAccessKey: '',
      forcePathStyle: state.settings.s3.forcePathStyle
    },
    webdav: {
      baseUrl: state.settings.webdav?.baseUrl || '',
      username: state.settings.webdav?.username || '',
      password: ''
    }
  }));
  const [cloudBusy, setCloudBusy] = useState('');
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [smartAnalysis, setSmartAnalysis] = useState(null);
  const [setupProvider, setSetupProvider] = useState('');
  const [setupBusy, setSetupBusy] = useState(false);

  const availability = state.cloudProviderAvailability || {};
  const oauthApps = state.settings.oauthApps || {};
  const googleConnected = Boolean(state.settings.googleDrive?.connected);
  const oneDriveConnected = Boolean(state.settings.oneDrive?.connected);
  const dropboxConnected = Boolean(state.settings.dropbox?.connected);
  const pCloudConnected = Boolean(state.settings.pCloud?.connected);

  function update(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  function updateS3(name, value) {
    setForm((current) => ({ ...current, s3: { ...current.s3, [name]: value } }));
  }

  function updateWebdav(name, value) {
    setForm((current) => ({ ...current, webdav: { ...current.webdav, [name]: value } }));
  }

  function updateSmart(name, value) {
    setForm((current) => ({
      ...current,
      smartBackup: { ...current.smartBackup, [name]: value }
    }));
  }

  async function analyzeSmartBackup() {
    setAnalysisBusy(true);
    setMessage('');
    try {
      const draft = {
        ...form,
        exclusions: form.exclusionsText.split(',').map((item) => item.trim()).filter(Boolean)
      };
      await api.saveSettings(draft);
      const result = await api.analyzeSmartBackup();
      setSmartAnalysis(result);
      setMessage(`Smart analysis completed: ${result.total.includedFiles} included and ${result.total.excludedFiles} excluded.`);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setAnalysisBusy(false);
    }
  }

  async function save() {
    try {
      await api.saveSettings({
        ...form,
        exclusions: form.exclusionsText.split(',').map((item) => item.trim()).filter(Boolean)
      });
      setMessage('Settings saved.');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function test() {
    try {
      const result = await api.testStorage(form);
      setMessage(result.message);
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function connect(provider) {
    setCloudBusy(provider);
    setMessage('');
    try {
      const result = await api.connectCloudProvider(provider);
      const nextForm = { ...form, provider };
      setForm(nextForm);
      await api.saveSettings(nextForm);
      setMessage(result.message);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setCloudBusy('');
    }
  }

  async function disconnect(provider) {
    setCloudBusy(provider);
    setMessage('');
    try {
      await api.disconnectCloudProvider(provider);
      setForm((current) => ({
        ...current,
        provider: current.provider === provider ? 'local' : current.provider
      }));
      setMessage(`${storageProviderName(provider)} disconnected.`);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setCloudBusy('');
    }
  }

  async function saveProviderSetupAndConnect(provider, config) {
    setSetupBusy(true);
    setMessage('');
    try {
      await api.saveOAuthAppConfig(provider, config);
      setSetupProvider('');
      const result = await api.connectCloudProvider(provider);
      const nextForm = { ...form, provider };
      setForm(nextForm);
      await api.saveSettings(nextForm);
      setMessage(result.message);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setSetupBusy(false);
    }
  }

  function connectionFor(provider) {
    if (provider === 'google-drive') return googleConnected;
    if (provider === 'onedrive') return oneDriveConnected;
    if (provider === 'dropbox') return dropboxConnected;
    if (provider === 'pcloud') return pCloudConnected;
    return false;
  }

  function availabilityFor(provider) {
    if (provider === 'google-drive') return Boolean(availability.googleDrive);
    if (provider === 'onedrive') return Boolean(availability.oneDrive);
    if (provider === 'dropbox') return Boolean(availability.dropbox);
    if (provider === 'pcloud') return Boolean(availability.pCloud);
    return true;
  }

  function accountFor(provider) {
    if (provider === 'google-drive') return state.settings.googleDrive || {};
    if (provider === 'onedrive') return state.settings.oneDrive || {};
    if (provider === 'dropbox') return state.settings.dropbox || {};
    if (provider === 'pcloud') return state.settings.pCloud || {};
    return {};
  }

  function oauthConfigurationFor(provider) {
    const key = OAUTH_PROVIDER_SETUP[provider]?.settingsKey;
    return key ? oauthApps[key] || {} : {};
  }

  async function chooseLocalVault() {
    const selected = await api.selectFolder();
    if (selected) update('localVaultPath', selected);
  }

  function providerStatus(provider) {
    if (provider === 'google-drive') {
      return googleConnected
        ? { label: 'Connected', tone: 'success' }
        : availability.googleDrive
          ? { label: 'Ready', tone: 'ready' }
          : { label: 'Setup', tone: 'setup' };
    }
    if (provider === 'onedrive') {
      return oneDriveConnected
        ? { label: 'Connected', tone: 'success' }
        : availability.oneDrive
          ? { label: 'Ready', tone: 'ready' }
          : { label: 'Setup', tone: 'setup' };
    }
    if (provider === 'dropbox') {
      return dropboxConnected
        ? { label: 'Connected', tone: 'success' }
        : availability.dropbox
          ? { label: 'Ready', tone: 'ready' }
          : { label: 'Setup', tone: 'setup' };
    }
    if (provider === 'pcloud') {
      return pCloudConnected
        ? { label: 'Connected', tone: 'success' }
        : availability.pCloud
          ? { label: 'Ready', tone: 'ready' }
          : { label: 'Setup', tone: 'setup' };
    }
    if (provider === 's3') {
      return form.s3.bucket
        ? { label: 'Configured', tone: 'ready' }
        : { label: 'Setup', tone: 'setup' };
    }
    if (provider === 'webdav') {
      return form.webdav.baseUrl
        ? { label: 'Configured', tone: 'ready' }
        : { label: 'Setup', tone: 'setup' };
    }
    return { label: 'Ready', tone: 'neutral' };
  }

  const providerReady = (
    form.provider === 'local' ||
    form.provider === 's3' ||
    (form.provider === 'webdav' && Boolean(form.webdav.baseUrl) && Boolean(form.webdav.password || state.settings.webdav?.hasPassword)) ||
    (form.provider === 'google-drive' && googleConnected) ||
    (form.provider === 'onedrive' && oneDriveConnected) ||
    (form.provider === 'dropbox' && dropboxConnected) ||
    (form.provider === 'pcloud' && pCloudConnected)
  );

  const selectedProvider = STORAGE_PROVIDER_OPTIONS.find((item) => item.value === form.provider)
    || STORAGE_PROVIDER_OPTIONS.at(-1);

  const selectedProviderStatus = providerStatus(form.provider);

  const selectedProviderDetail = (() => {
    if (form.provider === 'google-drive') {
      return googleConnected
        ? state.settings.googleDrive.accountEmail || state.settings.googleDrive.accountName || 'Google Drive account'
        : availability.googleDrive ? 'Application configured — connect an account.' : 'One-time application setup is required.';
    }
    if (form.provider === 'onedrive') {
      return oneDriveConnected
        ? state.settings.oneDrive.accountEmail || state.settings.oneDrive.accountName || 'OneDrive account'
        : availability.oneDrive ? 'Application configured — connect an account.' : 'One-time application setup is required.';
    }
    if (form.provider === 'dropbox') {
      return dropboxConnected
        ? state.settings.dropbox.accountEmail || state.settings.dropbox.accountName || 'Dropbox account'
        : availability.dropbox ? 'Application configured — connect an account.' : 'One-time application setup is required.';
    }
    if (form.provider === 'pcloud') {
      return pCloudConnected
        ? state.settings.pCloud.accountEmail || state.settings.pCloud.accountName || 'pCloud account'
        : availability.pCloud ? 'Application configured — connect an account.' : 'One-time application setup is required.';
    }
    if (form.provider === 's3') return form.s3.bucket ? `Bucket: ${form.s3.bucket}` : 'Enter a bucket and restricted credentials.';
    if (form.provider === 'webdav') return form.webdav.baseUrl || 'Enter a WebDAV or Nextcloud folder URL.';
    return form.localVaultPath || 'Choose a local vault path.';
  })();

  return (
    <section className="panel page-panel settings settings-v2">
      <div className="settings-command-header">
        <div>
          <p className="eyebrow">SYSTEM CONFIGURATION</p>
          <h1>Control room</h1>
          <p>Storage, intelligence, automation and background behaviour in one place.</p>
        </div>
        <div className="settings-active-route">
          <small>ACTIVE ROUTE</small>
          <strong>{storageProviderName(form.provider)}</strong>
          <span className={`provider-state provider-state-${selectedProviderStatus.tone}`}><i />{selectedProviderStatus.label}</span>
        </div>
      </div>


      <div className="settings-section destination-section">
        <div className="settings-section-header destination-heading">
          <div>
            <p className="eyebrow">STORAGE ROUTING</p>
            <h2>Backup destination</h2>
            <p>Choose a destination from one compact menu. Account providers use browser sign-in; advanced providers show their own configuration only when selected.</p>
          </div>
          <span className="destination-count">{STORAGE_PROVIDER_OPTIONS.length} providers</span>
        </div>

        <ProviderDropdown
          value={form.provider}
          onChange={(provider) => update('provider', provider)}
          statusForProvider={providerStatus}
        />

        <div className={`selected-provider-overview selected-provider-${selectedProvider.tone}`} aria-live="polite">
          <div className="selected-provider-main">
            <ProviderMark provider={form.provider} large />
            <div>
              <div className="selected-provider-title">
                <strong>{selectedProvider.name}</strong>
                <span className="provider-badge">{selectedProvider.badge}</span>
              </div>
              <span>{selectedProvider.description}</span>
              <small>{selectedProviderDetail}</small>
            </div>
          </div>
          <span className={`provider-state provider-state-${selectedProviderStatus.tone}`}>
            <i />
            {selectedProviderStatus.label}
          </span>
        </div>

        {OAUTH_PROVIDER_SETUP[form.provider] && (
          <CloudAccountPanel
            provider={form.provider}
            connected={connectionFor(form.provider)}
            accountName={accountFor(form.provider).accountName}
            accountEmail={accountFor(form.provider).accountEmail}
            available={availabilityFor(form.provider)}
            busy={cloudBusy === form.provider || setupBusy}
            onConnect={() => connect(form.provider)}
            onConfigure={() => setSetupProvider(form.provider)}
            onDisconnect={() => disconnect(form.provider)}
          />
        )}

        {form.provider === 'local' && (
          <div className="provider-config-panel">
            <div className="provider-config-heading">
              <div>
                <strong>Local vault folder</strong>
                <span>Choose a folder on this PC or another connected disk.</span>
              </div>
              <StatusPill tone="neutral">Offline</StatusPill>
            </div>
            <div className="path-picker-row">
              <input
                aria-label="Local vault path"
                value={form.localVaultPath}
                onChange={(event) => update('localVaultPath', event.target.value)}
              />
              <button type="button" onClick={chooseLocalVault}>Choose folder</button>
            </div>
          </div>
        )}

        {form.provider === 's3' && (
          <div className="provider-config-panel">
            <div className="provider-config-heading">
              <div>
                <strong>S3 connection</strong>
                <span>Use AWS S3, Cloudflare R2, Backblaze B2 or another compatible service.</span>
              </div>
              <StatusPill tone="neutral">Advanced</StatusPill>
            </div>
            <div className="settings-grid">
              <label>
                Endpoint URL
                <input placeholder="Leave blank for standard AWS S3" value={form.s3.endpoint} onChange={(event) => updateS3('endpoint', event.target.value)} />
              </label>
              <label>
                Region
                <input placeholder="eu-north-1" value={form.s3.region} onChange={(event) => updateS3('region', event.target.value)} />
              </label>
              <label>
                Bucket
                <input value={form.s3.bucket} onChange={(event) => updateS3('bucket', event.target.value)} />
              </label>
              <label>
                Access key ID
                <input value={form.s3.accessKeyId} onChange={(event) => updateS3('accessKeyId', event.target.value)} />
              </label>
              <label className="span-two">
                Secret access key
                <input type="password" placeholder={state.settings.s3.hasSecret ? 'Stored securely — leave blank to keep it' : 'Enter secret'} value={form.s3.secretAccessKey} onChange={(event) => updateS3('secretAccessKey', event.target.value)} />
              </label>
              <label className="checkbox span-two">
                <input type="checkbox" checked={form.s3.forcePathStyle} onChange={(event) => updateS3('forcePathStyle', event.target.checked)} />
                Force path-style addressing
              </label>
            </div>
          </div>
        )}

        {form.provider === 'webdav' && (
          <div className="provider-config-panel">
            <div className="provider-config-heading">
              <div>
                <strong>WebDAV connection</strong>
                <span>Works with Nextcloud, ownCloud and compatible WebDAV servers.</span>
              </div>
              <StatusPill tone="neutral">Advanced</StatusPill>
            </div>
            <div className="settings-grid">
              <label className="span-two">
                WebDAV folder URL
                <input
                  placeholder="https://cloud.example.com/remote.php/dav/files/name/backups/"
                  value={form.webdav.baseUrl}
                  onChange={(event) => updateWebdav('baseUrl', event.target.value)}
                />
                <small>The app creates a “Cloud Backup App” folder inside this location.</small>
              </label>
              <label>
                Username
                <input value={form.webdav.username} onChange={(event) => updateWebdav('username', event.target.value)} />
              </label>
              <label>
                App password
                <input
                  type="password"
                  placeholder={state.settings.webdav?.hasPassword ? 'Stored securely — leave blank to keep it' : 'Use a provider app password'}
                  value={form.webdav.password}
                  onChange={(event) => updateWebdav('password', event.target.value)}
                />
              </label>
            </div>
          </div>
        )}

        <div className="destination-privacy-note">
          <span className="privacy-note-icon">↗</span>
          <div>
            <strong>{form.provider === 'local' ? 'Local-only storage' : 'Direct-to-provider transfer'}</strong>
            <span>
              {form.provider === 'local'
                ? 'Backup payloads remain in the selected local vault.'
                : 'Files stream directly to the selected provider. Only encrypted credentials and the small backup catalog remain locally.'}
            </span>
          </div>
        </div>
      </div>

      {setupProvider && (
        <ProviderSetupModal
          provider={setupProvider}
          initialConfig={oauthConfigurationFor(setupProvider)}
          busy={setupBusy}
          onClose={() => setSetupProvider('')}
          onSaveAndConnect={(config) => saveProviderSetupAndConnect(setupProvider, config)}
        />
      )}

      <div className="settings-section smart-backup-section">
        <div className="settings-section-header">
          <h2>Smart Backup Intelligence</h2>
          <p>Reduce wasted cloud space automatically while keeping each filtering decision visible and adjustable.</p>
        </div>

        <label className="checkbox background-setting">
          <input
            type="checkbox"
            checked={form.smartBackup.enabled}
            onChange={(event) => updateSmart('enabled', event.target.checked)}
          />
          <span>
            <strong>Use Smart Backup filtering</strong>
            <small>Skips temporary downloads, cache output and replaceable generated files before upload.</small>
          </span>
        </label>

        <div className="smart-profile-grid">
          {[
            ['essential', 'Essential', 'Documents, source code, databases, certificates and small important images.'],
            ['balanced', 'Balanced', 'Everyday files and photos, while avoiding large replaceable payloads.'],
            ['everything', 'Everything', 'All selected files except temporary and incomplete files.']
          ].map(([value, title, description]) => (
            <button
              type="button"
              key={value}
              disabled={!form.smartBackup.enabled}
              className={`smart-profile-card ${form.smartBackup.profile === value ? 'selected' : ''}`}
              onClick={() => updateSmart('profile', value)}
            >
              <strong>{title}</strong>
              <span>{description}</span>
            </button>
          ))}
        </div>

        <div className="settings-grid">
          <label>
            Maximum individual file size (MB)
            <input
              type="number"
              min="0"
              max="102400"
              disabled={!form.smartBackup.enabled}
              value={form.smartBackup.maxFileSizeMB}
              onChange={(event) => updateSmart('maxFileSizeMB', event.target.value)}
            />
            <small>Use 0 for no smart size limit.</small>
          </label>
          <label>
            Always excluded folder names
            <input
              value={form.exclusionsText}
              onChange={(event) => update('exclusionsText', event.target.value)}
              placeholder="node_modules, .git, .venv, dist"
            />
          </label>
          <label className="checkbox span-two">
            <input
              type="checkbox"
              disabled={!form.smartBackup.enabled}
              checked={form.smartBackup.includeLargeMedia}
              onChange={(event) => updateSmart('includeLargeMedia', event.target.checked)}
            />
            Include large video and audio files in Balanced mode
          </label>
          <label className="checkbox span-two">
            <input
              type="checkbox"
              disabled={!form.smartBackup.enabled}
              checked={form.smartBackup.includeArchives}
              onChange={(event) => updateSmart('includeArchives', event.target.checked)}
            />
            Include ZIP, RAR, 7z and other archives in Balanced mode
          </label>
          <label className="checkbox span-two">
            <input
              type="checkbox"
              disabled={!form.smartBackup.enabled}
              checked={form.smartBackup.skipTemporaryFiles}
              onChange={(event) => updateSmart('skipTemporaryFiles', event.target.checked)}
            />
            Skip temporary, lock and incomplete-download files
          </label>
          <label className="checkbox span-two">
            <input
              type="checkbox"
              disabled={!form.smartBackup.enabled}
              checked={form.smartBackup.skipGeneratedFolders}
              onChange={(event) => updateSmart('skipGeneratedFolders', event.target.checked)}
            />
            Skip generated dependency, cache and build folders
          </label>
        </div>

        <div className="smart-analysis-actions">
          <button disabled={analysisBusy || state.folders.length === 0} onClick={analyzeSmartBackup}>
            {analysisBusy ? 'Analyzing…' : 'Analyze protected folders'}
          </button>
          <span>This only scans metadata. It does not upload or delete anything.</span>
        </div>

        {smartAnalysis && (
          <div className="smart-analysis-result">
            <article><strong>{smartAnalysis.total.includedFiles}</strong><span>Files included</span></article>
            <article><strong>{formatBytes(smartAnalysis.total.includedBytes)}</strong><span>Included size</span></article>
            <article><strong>{smartAnalysis.total.excludedFiles}</strong><span>Files excluded</span></article>
            <article><strong>{formatBytes(smartAnalysis.total.excludedBytes)}</strong><span>Space avoided</span></article>
            <div className="smart-analysis-reasons">
              <strong>Top exclusion reasons</strong>
              {Object.entries(smartAnalysis.total.reasons || {}).length ? (
                Object.entries(smartAnalysis.total.reasons)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 5)
                  .map(([reason, count]) => <span key={reason}>{count} · {reason}</span>)
              ) : <span>No files were excluded by the current profile.</span>}
            </div>
          </div>
        )}
      </div>

      <div className="settings-section">
        <div className="settings-section-header">
          <h2>Automatic backup</h2>
          <p>Both automatic modes continue while the window is hidden in the Windows system tray.</p>
        </div>

        <div className="settings-grid">
          <label className="checkbox span-two">
            <input type="checkbox" checked={form.autoBackup} onChange={(event) => update('autoBackup', event.target.checked)} />
            Run a backup at a fixed interval
          </label>
          <label>
            Fixed interval (minutes)
            <input
              type="number"
              min="5"
              max="1440"
              disabled={!form.autoBackup}
              value={form.scheduleMinutes}
              onChange={(event) => update('scheduleMinutes', event.target.value)}
            />
          </label>
          <div className="setting-explanation">
            Example: 30 runs an incremental scan every 30 minutes. A folder currently waiting for its quiet period is deferred.
          </div>

          <label className="checkbox span-two">
            <input type="checkbox" checked={form.watchChanges} onChange={(event) => update('watchChanges', event.target.checked)} />
            Watch protected folders and back up after changes stop
          </label>
          <label>
            Quiet period after the last change (minutes)
            <input
              type="number"
              min="1"
              max="1440"
              disabled={!form.watchChanges}
              value={form.changeDebounceMinutes}
              onChange={(event) => update('changeDebounceMinutes', event.target.value)}
            />
          </label>
          <div className="setting-explanation">
            Every new edit, rename, creation or deletion restarts this timer. A backup begins only after the folder stays unchanged for the full period.
          </div>

          <label>
            Concurrent uploads
            <input type="number" min="1" max="6" value={form.maxConcurrentUploads} onChange={(event) => update('maxConcurrentUploads', event.target.value)} />
          </label>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-header">
          <h2>Background operation</h2>
          <p>Keep the backup engine available even when the main window is closed.</p>
        </div>

        <div className="background-setting-list">
          <label className="checkbox background-setting">
            <input
              type="checkbox"
              checked={form.runInBackground}
              onChange={(event) => update('runInBackground', event.target.checked)}
            />
            <span>
              <strong>Keep running in the system tray</strong>
              <small>Closing the window hides it instead of stopping folder watchers and scheduled backups.</small>
            </span>
          </label>

          <label className="checkbox background-setting">
            <input
              type="checkbox"
              checked={form.launchAtLogin}
              onChange={(event) => update('launchAtLogin', event.target.checked)}
            />
            <span>
              <strong>Start automatically when I sign in to Windows</strong>
              <small>Windows launches Cloud Backup after you sign in, so automatic protection does not depend on opening it manually.</small>
            </span>
          </label>

          <label className="checkbox background-setting">
            <input
              type="checkbox"
              disabled={!form.runInBackground || !form.launchAtLogin}
              checked={form.startMinimized}
              onChange={(event) => update('startMinimized', event.target.checked)}
            />
            <span>
              <strong>Start hidden in the system tray</strong>
              <small>The app starts quietly at Windows sign-in without opening the main window.</small>
            </span>
          </label>
        </div>

        <div className="setting-explanation background-note">
          Background backup stops when you select <strong>Exit</strong> from the tray menu, sign out, shut down the PC, or the PC is asleep. It resumes the next time the app starts.
        </div>
      </div>

      <div className="button-row">
        <button disabled={!providerReady || Boolean(cloudBusy)} onClick={test}>Test storage</button>
        <button className="primary" disabled={!providerReady || Boolean(cloudBusy)} onClick={save}>Save settings</button>
      </div>
    </section>
  );
}

function baseNameRelative(relativePath = '') {
  return relativePath.split('/').filter(Boolean).at(-1) || relativePath;
}

function parentRelative(relativePath = '') {
  const parts = relativePath.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function ActionMenu({ items, label = 'More actions' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const closeOnOutside = (event) => {
      if (!ref.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div
      className="action-menu"
      ref={ref}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <button
        className="kebab-button"
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        ⋯
      </button>
      {open && (
        <div className="action-menu-popover" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.danger ? 'danger-menu-item' : ''}
              disabled={item.disabled}
              onClick={async () => {
                setOpen(false);
                await item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FileDetails({ file, folderName, busy, onBack, restoreVersion, deleteFile }) {
  return (
    <div className="file-details">
      <div className="file-details-header">
        <button className="back-button" onClick={onBack}>← Back to folder</button>
        <div className="file-details-title">
          <div className="large-file-icon">B</div>
          <div className="grow">
            <p className="eyebrow">BACKUP FILE</p>
            <h2>{fileNameFromPath(file.relativePath)}</h2>
            <span className="path">{folderName}/{file.relativePath}</span>
          </div>
          <ActionMenu
            items={[
              {
                label: 'Restore file',
                disabled: busy,
                onSelect: () => restoreVersion(file.latest.id)
              },
              {
                label: 'Delete file',
                danger: true,
                disabled: busy,
                onSelect: deleteFile
              }
            ]}
          />
        </div>
      </div>

      <div className="file-detail-metrics">
        <article><strong>{formatBytes(file.latest.size)}</strong><span>Current size</span></article>
        <article><strong>{file.versions.length}</strong><span>Stored versions</span></article>
        <article><strong>{formatDate(file.latest.backedUpAt)}</strong><span>Latest backup</span></article>
      </div>

      <section className="version-panel">
        <div className="panel-header">
          <div>
            <h3>Version history</h3>
            <p>Double-clicking a file opens this history. Restore any stored version separately.</p>
          </div>
        </div>
        <div className="version-list">
          {file.versions.map((version) => (
            <div className="version-row" key={version.id}>
              <div className="file-icon">B</div>
              <div className="grow">
                <strong>{formatDate(version.backedUpAt)}</strong>
                <span>{formatBytes(version.size)}</span>
                <span className="path">SHA-256 {version.checksum}</span>
              </div>
              {version.versionId === file.currentVersionId && (
                <StatusPill tone="success">Current snapshot</StatusPill>
              )}
              <ActionMenu
                items={[
                  {
                    label: 'Restore this version',
                    disabled: busy,
                    onSelect: () => restoreVersion(version.id)
                  }
                ]}
                label="Version actions"
              />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function BackupFiles() {
  const [folders, setFolders] = useState([]);
  const [selectedFolder, setSelectedFolder] = useState(null);
  const [content, setContent] = useState(null);
  const [currentPath, setCurrentPath] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState(null);

  async function load(nextQuery = query, folder = selectedFolder) {
    setLoading(true);
    try {
      if (folder) {
        const nextContent = await api.listFolderContent(folder.id, nextQuery);
        setContent(nextContent);
        setSelectedFile((previous) => {
          if (!previous) return null;
          return nextContent.files.find((file) => file.relativePath === previous.relativePath) || null;
        });
      } else {
        setFolders(await api.listBackupFolders(nextQuery));
      }
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => api.onRestoreProgress(setRestoreProgress), []);

  useEffect(() => {
    load(query, selectedFolder);
    return api.onStateChanged(() => load(query, selectedFolder));
  }, [selectedFolder?.id, query]);

  function showRestoreResult(result) {
    if (result.canceled) return;
    const details = [
      `${result.restored} restored`,
      `${result.skipped} skipped`,
      `${result.failed} failed`
    ].join(' · ');
    setMessage(`Restore completed: ${details}. Destination: ${result.destinationRoot}`);
  }

  async function restoreVersion(fileId) {
    setBusy(true);
    setMessage('');
    try {
      const result = await api.restoreFile(fileId);
      if (!result.canceled) setMessage(`Restored to ${result.restoredTo}`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function restoreFolder(folderId) {
    setBusy(true);
    setMessage('');
    setRestoreProgress(null);
    try {
      showRestoreResult(await api.restoreFolder(folderId));
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function restoreDirectory(folderId, relativePath) {
    setBusy(true);
    setMessage('');
    setRestoreProgress(null);
    try {
      showRestoreResult(await api.restoreDirectory(folderId, relativePath));
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function restoreAll() {
    setBusy(true);
    setMessage('');
    setRestoreProgress(null);
    try {
      showRestoreResult(await api.restoreAll());
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteItem(selection, afterDelete) {
    setBusy(true);
    setMessage('');
    try {
      const result = await api.deleteBackupItem(selection);
      if (result.canceled) return;
      setMessage(`${result.targetName} deleted from backup storage (${result.deletedVersions} stored version${result.deletedVersions === 1 ? '' : 's'}).`);
      afterDelete?.();
      await load('', selection.kind === 'backup-folder' ? null : selectedFolder);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  function openRootFolder(folder) {
    setSelectedFolder(folder);
    setContent(null);
    setCurrentPath('');
    setSelectedFile(null);
    setQuery('');
    setMessage('');
  }

  function openDirectory(relativePath) {
    setCurrentPath(relativePath);
    setSelectedFile(null);
    setQuery('');
    setMessage('');
  }

  function returnToFolders() {
    setSelectedFolder(null);
    setContent(null);
    setCurrentPath('');
    setSelectedFile(null);
    setQuery('');
    setMessage('');
  }

  const visibleDirectories = useMemo(() => {
    if (!content) return [];
    if (query.trim()) return content.directories;
    return content.directories.filter((directory) => parentRelative(directory) === currentPath);
  }, [content, currentPath, query]);

  const visibleFiles = useMemo(() => {
    if (!content) return [];
    if (query.trim()) return content.files;
    return content.files.filter((file) => parentRelative(file.relativePath) === currentPath);
  }, [content, currentPath, query]);

  const breadcrumbs = useMemo(() => {
    if (!selectedFolder) return [];
    const pieces = currentPath.split('/').filter(Boolean);
    const result = [{ label: selectedFolder.name, path: '' }];
    let built = '';
    for (const piece of pieces) {
      built = built ? `${built}/${piece}` : piece;
      result.push({ label: piece, path: built });
    }
    return result;
  }, [selectedFolder, currentPath]);

  const currentTitle = selectedFile
    ? fileNameFromPath(selectedFile.relativePath)
    : selectedFolder
      ? (currentPath ? baseNameRelative(currentPath) : selectedFolder.name)
      : 'Backup Files';

  const currentFolderMenu = selectedFolder
    ? [
        {
          label: 'Restore folder',
          disabled: busy,
          onSelect: () => currentPath
            ? restoreDirectory(selectedFolder.id, currentPath)
            : restoreFolder(selectedFolder.id)
        },
        {
          label: 'Delete folder',
          danger: true,
          disabled: busy,
          onSelect: () => deleteItem(
            currentPath
              ? { kind: 'directory', folderId: selectedFolder.id, relativePath: currentPath }
              : { kind: 'backup-folder', folderId: selectedFolder.id },
            () => {
              if (currentPath) setCurrentPath(parentRelative(currentPath));
              else returnToFolders();
            }
          )
        }
      ]
    : [];

  return (
    <div className="backup-files-view">
      <header className="backup-files-header">
        <div className="backup-files-title-block">
          {selectedFolder && !selectedFile && (
            <div className="breadcrumbs" aria-label="Backup folder path">
              <button onClick={returnToFolders}>Backup Files</button>
              {breadcrumbs.map((crumb, index) => (
                <React.Fragment key={crumb.path || 'root'}>
                  <span>›</span>
                  <button
                    className={index === breadcrumbs.length - 1 ? 'current' : ''}
                    onClick={() => openDirectory(crumb.path)}
                  >
                    {crumb.label}
                  </button>
                </React.Fragment>
              ))}
            </div>
          )}
          <p className="eyebrow">BACKUP CATALOG</p>
          <div className="title-with-menu">
            <h1>{currentTitle}</h1>
            {selectedFolder && !selectedFile && <ActionMenu items={currentFolderMenu} label="Current folder actions" />}
          </div>
          <p className="muted">
            {selectedFile
              ? 'Stored versions and integrity details for this file.'
              : selectedFolder
                ? 'Double-click folders to enter them and double-click files to open their version history.'
                : 'Double-click a folder to open it. Use the three-dot menu for restore or deletion.'}
          </p>
        </div>

        {!selectedFile && (
          <div className="backup-files-toolbar">
            <input
              className="search"
              placeholder={selectedFolder ? 'Search inside this backup folder' : 'Search backup folders or paths'}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {!selectedFolder && (
              <button className="primary" disabled={busy || !folders.length} onClick={restoreAll}>
                {busy ? 'Working…' : 'Restore all'}
              </button>
            )}
          </div>
        )}
      </header>

      {message && (
        <div className="message">
          <span>{message}</span>
          <button onClick={() => setMessage('')}>×</button>
        </div>
      )}

      {restoreProgress && busy && (
        <section className="progress-card restore-progress">
          <div className="grow">
            <strong>{restoreProgress.status === 'skipped' ? 'Skipped existing file' : 'Restoring folder structure'}</strong>
            <span>{restoreProgress.folderName}/{restoreProgress.path}</span>
          </div>
          <span>{restoreProgress.restored} restored · {restoreProgress.skipped} skipped · {restoreProgress.failed} failed / {restoreProgress.total}</span>
        </section>
      )}

      <section className="panel backup-browser-panel">
        {loading ? (
          <div className="empty">Loading backup catalog…</div>
        ) : selectedFile ? (
          <FileDetails
            file={selectedFile}
            folderName={selectedFolder.name}
            busy={busy}
            onBack={() => setSelectedFile(null)}
            restoreVersion={restoreVersion}
            deleteFile={() => deleteItem(
              { kind: 'file', folderId: selectedFolder.id, relativePath: selectedFile.relativePath },
              () => setSelectedFile(null)
            )}
          />
        ) : !selectedFolder ? (
          !folders.length ? (
            <div className="empty">No backup folders found.</div>
          ) : (
            <div className="folder-catalog compact-catalog">
              {folders.map((folder) => (
                <article
                  className="folder-card interactive-card"
                  key={folder.id}
                  tabIndex={0}
                  title="Double-click to open folder"
                  onDoubleClick={() => openRootFolder(folder)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') openRootFolder(folder);
                  }}
                >
                  <div className="folder-card-main">
                    <div className="large-folder-icon">F</div>
                    <div className="grow">
                      <h2>{folder.name}</h2>
                      <span className="path">{folder.sourcePath || 'Manual upload collection'}</span>
                      <span>{folder.fileCount} current files · {folder.directoryCount} folders · {folder.versionCount} stored versions</span>
                      <span>{formatBytes(folder.size)} · Last backup {formatDate(folder.backedUpAt)}</span>
                    </div>
                  </div>
                  <div className="folder-card-corner">
                    <StatusPill tone={folder.hasCompleteSnapshot ? 'success' : 'warning'}>
                      {folder.hasCompleteSnapshot ? 'Complete snapshot' : 'Legacy catalog'}
                    </StatusPill>
                    <ActionMenu
                      items={[
                        { label: 'Open folder', onSelect: () => openRootFolder(folder) },
                        { label: 'Restore folder', disabled: busy, onSelect: () => restoreFolder(folder.id) },
                        {
                          label: 'Delete folder',
                          danger: true,
                          disabled: busy,
                          onSelect: () => deleteItem({ kind: 'backup-folder', folderId: folder.id })
                        }
                      ]}
                      label={`${folder.name} actions`}
                    />
                  </div>
                </article>
              ))}
            </div>
          )
        ) : content ? (
          <div className="file-manager-list">
            <div className="folder-location-summary">
              <div>
                <strong>{currentPath ? `${content.folder.name}/${currentPath}` : content.folder.name}</strong>
                <span className="path">Original location: {content.folder.sourcePath || 'Manual upload collection'}</span>
              </div>
              <StatusPill tone={content.folder.hasCompleteSnapshot ? 'success' : 'warning'}>
                {content.folder.hasCompleteSnapshot ? 'Complete snapshot' : 'Legacy catalog'}
              </StatusPill>
            </div>

            {visibleDirectories.map((directory) => {
              const prefix = `${directory}/`;
              const fileCount = content.files.filter((file) => file.relativePath.startsWith(prefix)).length;
              const folderCount = content.directories.filter((candidate) => candidate.startsWith(prefix)).length;
              return (
                <article
                  className="browser-item folder-browser-item"
                  key={directory}
                  tabIndex={0}
                  title="Double-click to open folder"
                  onDoubleClick={() => openDirectory(directory)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') openDirectory(directory);
                  }}
                >
                  <div className="file-icon folder-icon">F</div>
                  <div className="grow">
                    <strong>{baseNameRelative(directory)}</strong>
                    <span className="path">{directory}</span>
                    <span>{fileCount} files · {folderCount} nested folders</span>
                  </div>
                  <ActionMenu
                    items={[
                      { label: 'Open folder', onSelect: () => openDirectory(directory) },
                      { label: 'Restore folder', disabled: busy, onSelect: () => restoreDirectory(selectedFolder.id, directory) },
                      {
                        label: 'Delete folder',
                        danger: true,
                        disabled: busy,
                        onSelect: () => deleteItem({ kind: 'directory', folderId: selectedFolder.id, relativePath: directory })
                      }
                    ]}
                    label={`${baseNameRelative(directory)} actions`}
                  />
                </article>
              );
            })}

            {visibleFiles.map((file) => (
              <article
                className="browser-item file-browser-item"
                key={file.relativePath}
                tabIndex={0}
                title="Double-click to open file details"
                onDoubleClick={() => setSelectedFile(file)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') setSelectedFile(file);
                }}
              >
                <div className="file-icon">B</div>
                <div className="grow">
                  <strong>{fileNameFromPath(file.relativePath)}</strong>
                  <span className="path">{file.relativePath}</span>
                  <span>{formatBytes(file.latest.size)} · {file.versions.length} version{file.versions.length === 1 ? '' : 's'} · {formatDate(file.latest.backedUpAt)}</span>
                </div>
                <ActionMenu
                  items={[
                    { label: 'Open file', onSelect: () => setSelectedFile(file) },
                    { label: 'Restore file', disabled: busy, onSelect: () => restoreVersion(file.latest.id) },
                    {
                      label: 'Delete file',
                      danger: true,
                      disabled: busy,
                      onSelect: () => deleteItem({ kind: 'file', folderId: selectedFolder.id, relativePath: file.relativePath })
                    }
                  ]}
                  label={`${fileNameFromPath(file.relativePath)} actions`}
                />
              </article>
            ))}

            {!visibleDirectories.length && !visibleFiles.length && (
              <div className="empty">
                {query.trim() ? 'No matching files or folders.' : 'This backup folder is empty.'}
              </div>
            )}
          </div>
        ) : (
          <div className="empty">Loading folder…</div>
        )}
      </section>
    </div>
  );
}

export default function App() {
  const [state, setState] = useState(null);
  const [tab, setTab] = useState('dashboard');
  const [message, setMessage] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);

  async function refresh() {
    setState(await api.getState());
  }

  useEffect(() => {
    refresh();
    return api.onStateChanged((nextState) => setState(nextState));
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key === 'Escape') setSearchOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!state) return <div className="loading"><div className="loading-card"><div className="loading-mark"><Icon name="shield" size={24} /></div><strong>Starting Smart Backup</strong><span>Loading secure local state…</span></div></div>;

  const activeProvider = providerDisplay(state, state.settings.provider);
  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: 'home' },
    { id: 'backup-files', label: 'Backups', icon: 'backup' },
    { id: 'interrupted', label: 'Attention', icon: 'warning', count: state.interrupted.length },
    { id: 'settings', label: 'Settings', icon: 'settings' }
  ];
  const titleByTab = {
    dashboard: 'Dashboard',
    'backup-files': 'Backups',
    interrupted: 'Attention required',
    settings: 'Settings'
  };

  return (
    <div className="app-shell modern-shell">
      <aside className="sidebar modern-sidebar">
        <div className="brand modern-brand">
          <div className="brand-mark"><Icon name="shield" size={23} /></div>
          <div><strong>Smart Backup</strong><span>Desktop</span></div>
        </div>

        <div className="sidebar-section-label">Workspace</div>
        <nav className="main-nav" aria-label="Primary navigation">
          {navItems.map((item) => (
            <button key={item.id} className={`nav-item ${tab === item.id ? 'active' : ''}`} onClick={() => setTab(item.id)}>
              <span className="nav-label"><Icon name={item.icon} size={18} />{item.label}</span>
              {item.count > 0 && <span className="nav-count">{item.count}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-spacer" />

        <div className="sidebar-status-card">
          <div className="sidebar-status-row"><span className="status-dot live" /><span>Backup engine</span></div>
          <strong>{state.settings.autoBackup || state.settings.watchChanges ? 'Protection active' : 'Manual backup mode'}</strong>
          <small>{activeProvider.name} · {activeProvider.connected ? 'Connected' : 'Needs setup'}</small>
        </div>

        <div className="sidebar-user-card">
          <div className="avatar">SB</div>
          <div><strong>Local device</strong><span>Device {state.deviceId.slice(0, 8)}</span></div>
        </div>
      </aside>

      <main className="content modern-content">
        <header className="topbar">
          <div className="mobile-page-title"><span>{titleByTab[tab]}</span></div>
          <div className="global-search-shell">
            <button className="global-search" onClick={() => setSearchOpen(true)} type="button">
              <Icon name="search" size={17} /><span>Search backups, folders, or files</span><kbd>Ctrl K</kbd>
            </button>
          </div>
          <div className="topbar-actions">
            <button className="icon-button topbar-icon" onClick={() => setTab('interrupted')} title="Attention"><Icon name="bell" /></button>
            <button className="icon-button topbar-icon" onClick={() => document.documentElement.classList.toggle('soft-dark')} title="Toggle contrast"><Icon name="sun" /></button>
            <button className="profile-button" type="button"><span className="avatar">SB</span><span>Smart Backup</span><Icon name="chevron" size={15} /></button>
          </div>
        </header>

        {message && (
          <div className="message modern-message" role="status">
            <span>{message}</span><button onClick={() => setMessage('')} aria-label="Dismiss message"><Icon name="close" size={16} /></button>
          </div>
        )}

        {tab === 'dashboard' && <Dashboard state={state} refresh={refresh} setMessage={setMessage} openBackupFiles={() => setTab('backup-files')} openInterrupted={() => setTab('interrupted')} openSettings={() => setTab('settings')} />}
        {tab === 'interrupted' && <Interrupted state={state} refresh={refresh} setMessage={setMessage} />}
        {tab === 'backup-files' && <BackupFiles />}
        {tab === 'settings' && <Settings state={state} refresh={refresh} setMessage={setMessage} />}
      </main>

      {searchOpen && (
        <div className="search-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSearchOpen(false); }}>
          <section className="search-modal" role="dialog" aria-modal="true" aria-label="Search backups">
            <div className="search-modal-input"><Icon name="search" /><input autoFocus placeholder="Search backups, files, or folders…" onKeyDown={(event) => { if (event.key === 'Escape') setSearchOpen(false); }} /></div>
            <div className="search-shortcuts"><span>Quick navigation</span><button onClick={() => { setSearchOpen(false); setTab('backup-files'); }}>Open Backups <kbd>↵</kbd></button><button onClick={() => { setSearchOpen(false); setTab('settings'); }}>Open Settings <kbd>⌘</kbd></button></div>
          </section>
        </div>
      )}
    </div>
  );
}

