const path = require('node:path');

const DOCUMENT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.pdf', '.rtf', '.doc', '.docx', '.odt',
  '.csv', '.tsv', '.xls', '.xlsx', '.ods', '.ppt', '.pptx', '.odp',
  '.epub', '.tex', '.bib', '.log'
]);

const CODE_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.jsonc', '.yaml', '.yml',
  '.toml', '.xml', '.html', '.htm', '.css', '.scss', '.sass', '.less', '.vue', '.svelte',
  '.py', '.pyi', '.ipynb', '.java', '.kt', '.kts', '.c', '.h', '.cc', '.cpp', '.cxx',
  '.hpp', '.cs', '.go', '.rs', '.rb', '.php', '.swift', '.dart', '.lua', '.sh', '.bash',
  '.zsh', '.fish', '.ps1', '.bat', '.cmd', '.sql', '.graphql', '.proto', '.gradle',
  '.properties', '.ini', '.cfg', '.conf', '.env.example'
]);

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.svg', '.heic', '.heif',
  '.tif', '.tiff', '.ico', '.avif', '.dng', '.cr2', '.nef', '.arw'
]);

const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.opus', '.wma'
]);

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v', '.wmv', '.flv', '.3gp'
]);

const ARCHIVE_EXTENSIONS = new Set([
  '.zip', '.7z', '.rar', '.tar', '.gz', '.bz2', '.xz', '.tgz', '.iso'
]);

const INSTALLER_EXTENSIONS = new Set([
  '.exe', '.msi', '.msix', '.appx', '.apk', '.dmg', '.pkg', '.deb', '.rpm'
]);

const DATABASE_EXTENSIONS = new Set([
  '.db', '.sqlite', '.sqlite3', '.mdb', '.accdb', '.dump', '.bak'
]);

const CERTIFICATE_EXTENSIONS = new Set([
  '.pem', '.crt', '.cer', '.p12', '.pfx', '.key', '.pub', '.gpg', '.asc'
]);

const DISK_IMAGE_EXTENSIONS = new Set([
  '.vhd', '.vhdx', '.vmdk', '.qcow', '.qcow2', '.img'
]);

const IMPORTANT_FILENAMES = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock',
  'requirements.txt', 'pyproject.toml', 'poetry.lock', 'pipfile', 'pipfile.lock',
  'cargo.toml', 'cargo.lock', 'go.mod', 'go.sum', 'composer.json', 'composer.lock',
  'dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'makefile',
  'readme', 'readme.md', 'license', 'license.md', '.gitignore', '.gitattributes',
  '.env', '.env.local', '.env.development', '.env.production', '.npmrc'
]);

const TEMPORARY_SUFFIXES = [
  '.tmp', '.temp', '.part', '.partial', '.crdownload', '.download', '.opdownload',
  '.swp', '.swo', '.lock', '.lck', '.dwl', '.dwl2', '.cache'
];

const TEMPORARY_NAMES = new Set([
  'thumbs.db', 'desktop.ini', '.ds_store', 'ehthumbs.db', 'iconcache.db'
]);

const SMART_GENERATED_DIRECTORIES = new Set([
  'node_modules', '.git', '.svn', '.hg', '.venv', 'venv', 'env', '__pycache__',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.nox', '.next', '.nuxt',
  '.svelte-kit', '.angular', '.cache', '.parcel-cache', '.turbo', '.gradle',
  '.idea/system', 'coverage', '.nyc_output', 'dist', 'build', 'out', 'target',
  '.dart_tool'
]);

function normalizeSettings(input = {}) {
  return {
    enabled: input.enabled !== false,
    profile: ['essential', 'balanced', 'everything'].includes(input.profile)
      ? input.profile
      : 'balanced',
    maxFileSizeMB: Number.isFinite(Number(input.maxFileSizeMB))
      ? Math.max(0, Math.min(102400, Number(input.maxFileSizeMB)))
      : 1024,
    includeLargeMedia: Boolean(input.includeLargeMedia),
    includeArchives: Boolean(input.includeArchives),
    skipTemporaryFiles: input.skipTemporaryFiles !== false,
    skipGeneratedFolders: input.skipGeneratedFolders !== false
  };
}

function classifyFile(relativePath) {
  const normalized = String(relativePath || '').replaceAll('\\', '/');
  const name = normalized.split('/').at(-1) || '';
  const lowerName = name.toLowerCase();
  const extension = path.extname(lowerName);

  if (IMPORTANT_FILENAMES.has(lowerName)) return 'code';
  if (CERTIFICATE_EXTENSIONS.has(extension)) return 'credentials';
  if (DATABASE_EXTENSIONS.has(extension)) return 'database';
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document';
  if (CODE_EXTENSIONS.has(extension)) return 'code';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (ARCHIVE_EXTENSIONS.has(extension)) return 'archive';
  if (INSTALLER_EXTENSIONS.has(extension)) return 'installer';
  if (DISK_IMAGE_EXTENSIONS.has(extension)) return 'disk-image';
  return 'other';
}

function isTemporaryFile(relativePath) {
  const name = String(relativePath || '').replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() || '';
  if (!name) return false;
  if (TEMPORARY_NAMES.has(name)) return true;
  if (name.startsWith('~$') || name.endsWith('~')) return true;
  return TEMPORARY_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function shouldSkipDirectory(name, settingsInput = {}) {
  const settings = normalizeSettings(settingsInput);
  if (!settings.enabled || !settings.skipGeneratedFolders) return false;
  return SMART_GENERATED_DIRECTORIES.has(String(name || '').toLowerCase());
}

function evaluateFile(file, settingsInput = {}) {
  const settings = normalizeSettings(settingsInput);
  const category = classifyFile(file.relativePath);
  const maxBytes = settings.maxFileSizeMB > 0
    ? settings.maxFileSizeMB * 1024 * 1024
    : Infinity;

  if (!settings.enabled) {
    return { include: true, category, priority: 'normal', reason: 'Smart filtering disabled' };
  }

  if (settings.skipTemporaryFiles && isTemporaryFile(file.relativePath)) {
    return { include: false, category: 'temporary', priority: 'low', reason: 'Temporary or incomplete file' };
  }

  if (Number(file.size || 0) > maxBytes) {
    return {
      include: false,
      category,
      priority: 'low',
      reason: `Larger than the ${settings.maxFileSizeMB} MB smart limit`
    };
  }

  if (settings.profile === 'everything') {
    return { include: true, category, priority: 'normal', reason: 'Everything profile' };
  }

  const essentialCategories = new Set(['document', 'code', 'database', 'credentials']);
  if (settings.profile === 'essential') {
    if (essentialCategories.has(category)) {
      return { include: true, category, priority: 'high', reason: 'Important document or project data' };
    }
    if (category === 'image' && Number(file.size || 0) <= 25 * 1024 * 1024) {
      return { include: true, category, priority: 'normal', reason: 'Small image retained by Essential mode' };
    }
    return { include: false, category, priority: 'low', reason: 'Not selected by Essential mode' };
  }

  // Balanced mode protects everyday work and photos while avoiding large replaceable payloads.
  if (['installer', 'disk-image'].includes(category)) {
    return { include: false, category, priority: 'low', reason: 'Replaceable installer or disk image' };
  }
  if (category === 'archive' && !settings.includeArchives) {
    return { include: false, category, priority: 'low', reason: 'Archive excluded by Balanced mode' };
  }
  if (['video', 'audio'].includes(category) && !settings.includeLargeMedia) {
    const mediaLimit = category === 'video' ? 100 * 1024 * 1024 : 50 * 1024 * 1024;
    if (Number(file.size || 0) > mediaLimit) {
      return { include: false, category, priority: 'low', reason: 'Large media excluded by Balanced mode' };
    }
  }

  const priority = essentialCategories.has(category) ? 'high' : category === 'image' ? 'normal' : 'normal';
  return { include: true, category, priority, reason: 'Included by Balanced mode' };
}

function emptySummary() {
  return {
    includedFiles: 0,
    includedBytes: 0,
    excludedFiles: 0,
    excludedBytes: 0,
    categories: {},
    reasons: {}
  };
}

function addDecision(summary, file, decision) {
  const size = Number(file.size || 0);
  const countKey = decision.include ? 'includedFiles' : 'excludedFiles';
  const bytesKey = decision.include ? 'includedBytes' : 'excludedBytes';
  summary[countKey] += 1;
  summary[bytesKey] += size;
  summary.categories[decision.category] = (summary.categories[decision.category] || 0) + 1;
  if (!decision.include) {
    summary.reasons[decision.reason] = (summary.reasons[decision.reason] || 0) + 1;
  }
  return summary;
}

function mergeSummaries(target, input) {
  target.includedFiles += Number(input?.includedFiles || 0);
  target.includedBytes += Number(input?.includedBytes || 0);
  target.excludedFiles += Number(input?.excludedFiles || 0);
  target.excludedBytes += Number(input?.excludedBytes || 0);
  for (const [key, value] of Object.entries(input?.categories || {})) {
    target.categories[key] = (target.categories[key] || 0) + Number(value || 0);
  }
  for (const [key, value] of Object.entries(input?.reasons || {})) {
    target.reasons[key] = (target.reasons[key] || 0) + Number(value || 0);
  }
  return target;
}

module.exports = {
  SMART_GENERATED_DIRECTORIES,
  addDecision,
  classifyFile,
  emptySummary,
  evaluateFile,
  isTemporaryFile,
  mergeSummaries,
  normalizeSettings,
  shouldSkipDirectory
};
