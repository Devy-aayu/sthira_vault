const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { safeJoin, normalizeRelative } = require('../path-safety.cjs');

class LocalVault {
  constructor(vaultPath) {
    this.vaultPath = vaultPath;
    fs.mkdirSync(vaultPath, { recursive: true });
  }

  async testConnection() {
    const testDir = safeJoin(this.vaultPath, '.health');
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = safeJoin(testDir, `probe-${Date.now()}.txt`);
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    return { ok: true, message: 'Local vault is writable.' };
  }

  async upload({ sourcePath, objectKey }) {
    const normalizedKey = normalizeRelative(objectKey);
    const destination = safeJoin(this.vaultPath, 'objects', ...normalizedKey.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    await pipeline(fs.createReadStream(sourcePath), fs.createWriteStream(destination, { flags: 'wx' }));
    return { objectKey: normalizedKey };
  }

  async restore({ objectKey, destinationPath }) {
    const source = safeJoin(this.vaultPath, 'objects', ...normalizeRelative(objectKey).split('/'));
    await pipeline(fs.createReadStream(source), fs.createWriteStream(destinationPath, { flags: 'wx' }));
  }

  async deleteObjects({ objects = [], objectKeys = [] }) {
    const objectRoot = safeJoin(this.vaultPath, 'objects');
    let deleted = 0;

    const keys = objects.length ? objects.map((item) => item.objectKey).filter(Boolean) : objectKeys;
    for (const objectKey of [...new Set(keys || [])]) {
      const target = safeJoin(objectRoot, ...normalizeRelative(objectKey).split('/'));
      if (!fs.existsSync(target)) continue;
      const stat = fs.statSync(target);
      if (!stat.isFile()) throw new Error(`Stored object is not a file: ${objectKey}`);
      fs.unlinkSync(target);
      deleted += 1;

      let current = path.dirname(target);
      while (current.startsWith(objectRoot) && current !== objectRoot) {
        try {
          fs.rmdirSync(current);
        } catch {
          break;
        }
        current = path.dirname(current);
      }
    }

    return { deleted };
  }
}

module.exports = { LocalVault };
