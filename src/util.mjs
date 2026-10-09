import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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

export function estimateTextTokens(text) {
  let cjk = 0;
  let ascii = 0;
  let other = 0;
  for (const ch of String(text ?? '')) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff)) cjk += 1;
    else if (cp <= 0x7f) ascii += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 0.8 + other * 0.5 + ascii / 4);
}

export function clampTextToTokens(text, maxTokens) {
  const value = String(text ?? '');
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return '';
  if (estimateTextTokens(value) <= maxTokens) return value;
  const marker = '\n...[truncated]';
  let low = 0;
  let high = value.length;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = value.slice(0, mid) + marker;
    if (estimateTextTokens(candidate) <= maxTokens) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best > 0 ? value.slice(0, best) + marker : '';
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

export function pathEscapes(root, target) {
  const rel = relative(resolve(root), resolve(target));
  if (rel.length === 0) return false;
  if (isAbsolute(rel)) return true;
  return rel === '..' || rel.startsWith(`..${sep}`);
}

/**
 * Resolve and validate a path that must stay inside a workspace. Rejects
 * symlinked or junctioned path components, including linked parents such as a
 * workspace `.dsh` directory that points outside the workspace. The final
 * target itself does not need to exist; its nearest existing ancestor is
 * resolved and checked.
 */
export function assertWorkspaceContained(root, target) {
  const rootAbs = resolve(root);
  let rootReal;
  try {
    rootReal = realpathSync(rootAbs);
  } catch {
    throw new Error(`workspace root does not exist: ${rootAbs}`);
  }
  const targetAbs = resolve(target);
  if (pathEscapes(rootAbs, targetAbs)) throw new Error(`path escapes workspace: ${targetAbs}`);
  const rel = relative(rootAbs, targetAbs);
  const parts = rel.split(sep).filter((part) => part.length > 0);
  let cursor = rootAbs;
  for (const part of parts) {
    cursor = join(cursor, part);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      let linkedReal = cursor;
      try {
        linkedReal = realpathSync(cursor);
      } catch {
        linkedReal = cursor;
      }
      if (pathEscapes(rootReal, linkedReal)) throw new Error(`path escapes workspace through a linked parent: ${cursor}`);
      throw new Error(`path contains a symbolic link or junction; symlinks and junctions are not allowed: ${cursor}`);
    }
    if (cursor !== targetAbs && !stat.isDirectory()) throw new Error(`path component is not a directory: ${cursor}`);
  }
  let existing = targetAbs;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  let existingReal;
  try {
    existingReal = realpathSync(existing);
  } catch {
    throw new Error(`cannot resolve path: ${existing}`);
  }
  if (pathEscapes(rootReal, existingReal)) throw new Error(`path escapes workspace through a linked parent: ${targetAbs}`);
  return targetAbs;
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


/** A DOM-style abort error other modules can recognize without importing the host. */
export function createAbortError(message = 'operation aborted') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

export function throwIfAborted(signal) {
  if (signal?.aborted === true) throw createAbortError();
}
