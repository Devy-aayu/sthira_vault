const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getOAuthApps, getOAuthAvailability } = require('../electron/oauth/oauth-apps.cjs');
const { StateStore } = require('../electron/state-store.cjs');

test('runtime provider application IDs activate every OAuth destination without editing the build file', () => {
  const runtime = {
    google: { clientId: 'desktop.apps.googleusercontent.com' },
    microsoft: { clientId: '00000000-0000-0000-0000-000000000000' },
    dropbox: { clientId: 'dropbox-app-key' },
    pcloud: { clientId: 'pcloud-client-id' }
  };

  const apps = getOAuthApps(runtime);
  assert.equal(apps.google.clientId, runtime.google.clientId);
  assert.equal(apps.microsoft.clientId, runtime.microsoft.clientId);
  assert.equal(apps.dropbox.clientId, runtime.dropbox.clientId);
  assert.equal(apps.pcloud.clientId, runtime.pcloud.clientId);
  assert.deepEqual(getOAuthAvailability(runtime), {
    googleDrive: true,
    oneDrive: true,
    dropbox: true,
    pCloud: true
  });
});

test('provider application configuration survives StateStore restart', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-backup-oauth-config-'));
  const statePath = path.join(directory, 'state.json');
  const first = new StateStore(statePath);

  first.update((state) => {
    state.settings.oauthApps.google.clientId = 'desktop.apps.googleusercontent.com';
    state.settings.oauthApps.microsoft.clientId = '00000000-0000-0000-0000-000000000000';
    state.settings.oauthApps.dropbox.clientId = 'dropbox-app-key';
    state.settings.oauthApps.pcloud.clientId = 'pcloud-client-id';
  });

  const second = new StateStore(statePath);
  assert.equal(second.get().settings.oauthApps.google.clientId, 'desktop.apps.googleusercontent.com');
  assert.equal(second.get().settings.oauthApps.microsoft.clientId, '00000000-0000-0000-0000-000000000000');
  assert.equal(second.get().settings.oauthApps.dropbox.clientId, 'dropbox-app-key');
  assert.equal(second.get().settings.oauthApps.pcloud.clientId, 'pcloud-client-id');
});
