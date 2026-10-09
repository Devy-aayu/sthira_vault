const path = require('node:path');
const fs = require('node:fs');

function normalizeAbsolute(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('A valid path is required.');
  }
  return path.resolve(input);
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertExistingDirectory(input) {
  const resolved = normalizeAbsolute(input);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error('Selected path is not a folder.');
  return fs.realpathSync(resolved);
}

function assertExistingFile(input) {
  const resolved = normalizeAbsolute(input);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error('Selected path is not a file.');
  return fs.realpathSync(resolved);
}

function safeJoin(parent, ...segments) {
  const base = path.resolve(parent);
  const candidate = path.resolve(base, ...segments);
  if (!isInside(base, candidate)) {
    throw new Error('Unsafe path rejected.');
  }
  return candidate;
}

function normalizeRelative(input) {
  const normalized = input.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) throw new Error('Invalid relative path.');
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..' || part === '.')) {
    throw new Error('Unsafe relative path rejected.');
  }
  return parts.join('/');
}

module.exports = {
  assertExistingDirectory,
  assertExistingFile,
  isInside,
  normalizeAbsolute,
  normalizeRelative,
  safeJoin
};
