const fs = require('node:fs');
const path = require('node:path');

const configPath = path.join(__dirname, 'oauth-apps.json');

function readJsonConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

function clean(value) {
  const text = String(value || '').trim();
  return text.startsWith('YOUR_') ? '' : text;
}

function firstConfigured(...values) {
  for (const value of values) {
    const cleaned = clean(value);
    if (cleaned) return cleaned;
  }
  return '';
}

function getOAuthApps(runtime = {}) {
  const file = readJsonConfig();
  return {
    google: {
      clientId: firstConfigured(
        process.env.CLOUD_BACKUP_GOOGLE_CLIENT_ID,
        runtime.google?.clientId,
        file.google?.clientId
      ),
      clientSecret: firstConfigured(
        process.env.CLOUD_BACKUP_GOOGLE_CLIENT_SECRET,
        runtime.google?.clientSecret,
        file.google?.clientSecret
      )
    },
    microsoft: {
      clientId: firstConfigured(
        process.env.CLOUD_BACKUP_MICROSOFT_CLIENT_ID,
        runtime.microsoft?.clientId,
        file.microsoft?.clientId
      )
    },
    dropbox: {
      clientId: firstConfigured(
        process.env.CLOUD_BACKUP_DROPBOX_CLIENT_ID,
        runtime.dropbox?.clientId,
        file.dropbox?.clientId
      )
    },
    pcloud: {
      clientId: firstConfigured(
        process.env.CLOUD_BACKUP_PCLOUD_CLIENT_ID,
        runtime.pcloud?.clientId,
        file.pcloud?.clientId
      )
    }
  };
}

function getOAuthAvailability(runtime = {}) {
  const apps = getOAuthApps(runtime);
  return {
    googleDrive: Boolean(apps.google.clientId),
    oneDrive: Boolean(apps.microsoft.clientId),
    dropbox: Boolean(apps.dropbox.clientId),
    pCloud: Boolean(apps.pcloud.clientId)
  };
}

module.exports = { getOAuthApps, getOAuthAvailability, configPath };
