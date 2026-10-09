const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT_STATE = Object.freeze({
  schemaVersion: 6,
  deviceId: '',
  folders: [],
  fingerprints: {},
  folderSnapshots: {},
  files: [],
  interrupted: [],
  jobs: [],
  settings: {
    provider: 'local',
    localVaultPath: '',
    autoBackup: false,
    scheduleMinutes: 30,
    watchChanges: false,
    changeDebounceMinutes: 10,
    runInBackground: true,
    launchAtLogin: false,
    startMinimized: true,
    maxConcurrentUploads: 3,
    smartBackup: {
      enabled: true,
      profile: 'balanced',
      maxFileSizeMB: 1024,
      includeLargeMedia: false,
      includeArchives: false,
      skipTemporaryFiles: true,
      skipGeneratedFolders: true
    },
    exclusions: [
      'node_modules',
      '.git',
      '.venv',
      'venv',
      '__pycache__',
      '.next',
      'dist',
      'build',
      'target'
    ],
    s3: {
      endpoint: '',
      region: 'auto',
      bucket: '',
      accessKeyId: '',
      secretEncrypted: '',
      forcePathStyle: false
    },
    oauthApps: {
      google: {
        clientId: '',
        clientSecretEncrypted: ''
      },
      microsoft: {
        clientId: ''
      },
      dropbox: {
        clientId: ''
      },
      pcloud: {
        clientId: ''
      }
    },
    googleDrive: {
      tokenEncrypted: '',
      accountName: '',
      accountEmail: ''
    },
    oneDrive: {
      tokenEncrypted: '',
      accountName: '',
      accountEmail: ''
    },
    dropbox: {
      tokenEncrypted: '',
      accountName: '',
      accountEmail: ''
    },
    pCloud: {
      tokenEncrypted: '',
      accountName: '',
      accountEmail: ''
    },
    webdav: {
      baseUrl: '',
      username: '',
      passwordEncrypted: ''
    }
  }
});

function cloneDefault() {
  return structuredClone(DEFAULT_STATE);
}

class StateStore {
  constructor(statePath, defaults = {}) {
    this.statePath = statePath;
    this.defaults = defaults;
    this.listeners = new Set();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    this.state = this.#load();
  }

  #load() {
    let state = cloneDefault();
    if (fs.existsSync(this.statePath)) {
      try {
        state = {
          ...state,
          ...JSON.parse(fs.readFileSync(this.statePath, 'utf8'))
        };
      } catch {
        const backupPath = `${this.statePath}.corrupt-${Date.now()}`;
        fs.copyFileSync(this.statePath, backupPath);
      }
    }

    state.deviceId ||= randomUUID();
    const defaultSettings = cloneDefault().settings;
    const configuredDefaults = this.defaults.settings || {};
    state.settings = {
      ...defaultSettings,
      ...configuredDefaults,
      ...(state.settings || {}),
      s3: {
        ...defaultSettings.s3,
        ...(configuredDefaults.s3 || {}),
        ...(state.settings?.s3 || {})
      },
      oauthApps: {
        ...defaultSettings.oauthApps,
        ...(configuredDefaults.oauthApps || {}),
        ...(state.settings?.oauthApps || {}),
        google: {
          ...defaultSettings.oauthApps.google,
          ...(configuredDefaults.oauthApps?.google || {}),
          ...(state.settings?.oauthApps?.google || {})
        },
        microsoft: {
          ...defaultSettings.oauthApps.microsoft,
          ...(configuredDefaults.oauthApps?.microsoft || {}),
          ...(state.settings?.oauthApps?.microsoft || {})
        },
        dropbox: {
          ...defaultSettings.oauthApps.dropbox,
          ...(configuredDefaults.oauthApps?.dropbox || {}),
          ...(state.settings?.oauthApps?.dropbox || {})
        },
        pcloud: {
          ...defaultSettings.oauthApps.pcloud,
          ...(configuredDefaults.oauthApps?.pcloud || {}),
          ...(state.settings?.oauthApps?.pcloud || {})
        }
      },
      googleDrive: {
        ...defaultSettings.googleDrive,
        ...(configuredDefaults.googleDrive || {}),
        ...(state.settings?.googleDrive || {})
      },
      oneDrive: {
        ...defaultSettings.oneDrive,
        ...(configuredDefaults.oneDrive || {}),
        ...(state.settings?.oneDrive || {})
      },
      dropbox: {
        ...defaultSettings.dropbox,
        ...(configuredDefaults.dropbox || {}),
        ...(state.settings?.dropbox || {})
      },
      pCloud: {
        ...defaultSettings.pCloud,
        ...(configuredDefaults.pCloud || {}),
        ...(state.settings?.pCloud || {})
      },
      webdav: {
        ...defaultSettings.webdav,
        ...(configuredDefaults.webdav || {}),
        ...(state.settings?.webdav || {})
      },
      smartBackup: {
        ...defaultSettings.smartBackup,
        ...(configuredDefaults.smartBackup || {}),
        ...(state.settings?.smartBackup || {})
      }
    };
    state.schemaVersion = 6;
    state.folders ||= [];
    state.fingerprints ||= {};
    state.folderSnapshots ||= {};
    state.files ||= [];
    state.interrupted ||= [];
    state.jobs ||= [];
    this.#write(state);
    return state;
  }

  #write(state) {
    const tempPath = `${this.statePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, this.statePath);
  }

  get() {
    return structuredClone(this.state);
  }

  update(mutator) {
    const draft = structuredClone(this.state);
    const result = mutator(draft) ?? draft;
    this.state = result;
    this.#write(this.state);
    const snapshot = this.get();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // State listeners must never break persistence.
      }
    }
    return snapshot;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('State listener must be a function.');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

module.exports = { StateStore };
