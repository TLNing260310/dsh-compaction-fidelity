import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.go', '.py', '.rs', '.java', '.kt', '.kts',
  '.cs', '.rb', '.php', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.m', '.mm',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.env', '.md', '.mdx', '.txt',
  '.sql', '.graphql', '.gql', '.sh', '.ps1', '.bat', '.cmd', '.xml', '.gradle', '.properties',
]);

export const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.go', '.py', '.rs', '.java', '.kt', '.kts',
  '.cs', '.rb', '.php', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.m', '.mm',
]);

export const SKIP_EXTENSIONS = new Set([
  '.parquet', '.arrow', '.feather', '.csv', '.tsv', '.npy', '.npz', '.pkl', '.pickle',
  '.h5', '.hdf5', '.pt', '.pth', '.onnx', '.bin', '.dat', '.db', '.sqlite', '.sqlite3',
  '.dll', '.so', '.dylib', '.exe', '.wasm', '.class', '.jar', '.zip', '.tar', '.gz',
  '.7z', '.rar', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.woff',
  '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.avi', '.mkv',
]);

export const IGNORE_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.pnpm-store', '.yarn', 'dist', 'build', 'out',
  'target', 'vendor', 'coverage', '.next', '.nuxt', '.svelte-kit', '.cache', '__pycache__',
  '.venv', 'venv', 'env', '.tox', '.mypy_cache', '.pytest_cache', '.gradle', '.idea', '.vscode',
  'bin', 'obj', '.terraform', '.dsh-compaction-fidelity-tmp',
]);

export const DEFAULT_INDEX_DIR = '.dsh/compaction-fidelity';

export function toPosix(value) {
  return value.split(sep).join('/');
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function ensureDirSync(dir) {
  mkdirSync(dir, { recursive: true });
}

export function writeFileAtomicSync(file, content) {
  ensureDirSync(dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}

export function readTextIfExists(file) {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

export function readJsonIfExists(file, fallback = null) {
  const text = readTextIfExists(file);
  if (text === null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function writeJsonSync(file, value) {
  writeFileAtomicSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function clampText(text, maxChars) {
  const value = String(text ?? '');
  if (!Number.isFinite(maxChars) || maxChars <= 0 || value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 20))}\n…[truncated]`;
}

export function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (key === undefined || key === null || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function isInsideWorkspace(root, file) {
  const rel = relative(resolve(root), resolve(file));
  return rel !== '' && !rel.startsWith('..') && !rel.includes(`..${sep}`);
}

export function normalizeRelPath(root, file) {
  const rel = relative(resolve(root), resolve(file));
  return toPosix(rel);
}

export function isSafeRelativePath(value) {
  if (typeof value !== "string") return false;
  const normalized = value.replace(/\\/g, "/").trim();
  if (normalized.length === 0) return false;
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.startsWith("~")) return false;
  if (normalized.includes("\0")) return false;
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
  return true;
}

export function joinWorkspace(root, relPath) {
  if (!isSafeRelativePath(relPath)) throw new Error(`unsafe workspace-relative path: ${String(relPath)}`);
  return join(root, ...toPosix(relPath).split("/"));
}

export function depthOf(relPath) {
  return toPosix(relPath).split('/').length - 1;
}

export function basenameNoExt(file) {
  const base = file.split('/').pop() ?? file;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

export function extnameLower(file) {
  const base = file.split('/').pop() ?? file;
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot).toLowerCase() : '';
}

export function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function parseJsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
