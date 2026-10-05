// Git + content-hash change detection for folder-scoped architecture documents.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { architectureHash, atomicWriteArchitectureFile } from "./architecture-io.mjs";
import { countChangedFilesSince } from "./architecture-doc.mjs";
import { buildIndex } from "./project-index.mjs";

const SEMANTIC_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte",
  ".py", ".go", ".rs", ".java", ".kt", ".kts", ".cs", ".php", ".rb", ".swift",
  ".c", ".cc", ".cpp", ".h", ".hpp", ".sql", ".json", ".jsonc", ".yaml", ".yml",
  ".toml", ".ini", ".md", ".mdx", ".sh", ".ps1", ".bat", ".cmd",
]);
const IGNORE_DIRS = new Set(["node_modules", ".git", ".dsh", "dist", "build", "target", "coverage", ".next", ".cache"]);
const gitRepoCache = new Map();
const BASELINE_FILE = "architecture-baseline.json";
const MAX_GIT_REPO_CACHE = 128;

function normalizeRel(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function inScope(file, scope) {
  const normalizedFile = normalizeRel(file);
  const normalizedScope = normalizeRel(scope);
  return normalizedScope.length === 0 || normalizedScope === "." || normalizedFile === normalizedScope || normalizedFile.startsWith(normalizedScope + "/");
}

function isSemanticFile(file) {
  const name = basename(file).toLowerCase();
  if (name === "dockerfile" || name === "makefile") return true;
  const dot = name.lastIndexOf(".");
  const extension = dot >= 0 ? name.slice(dot) : "";
  return SEMANTIC_EXTENSIONS.has(extension);
}

export function fileWeight(file) {
  const path = normalizeRel(file).toLowerCase();
  if (/(^|\/)(schema|schemas|migration|migrations|prisma|models?)[\/._-]/.test(path)) return 5;
  if (/(^|\/)(package\.json|tsconfig\.json|go\.mod|cargo\.toml|pyproject\.toml|dockerfile|makefile)$/.test(path)) return 4;
  if (/(^|\/)(index|main|app|server|router|entry|cli)\.(ts|tsx|js|mjs|cjs|jsx|py|go|rs|java|cs)$/.test(path)) return 4;
  if (/(^|\/)(tests?|__tests__)\//.test(path) || /\.(test|spec)\.[^.]+$/.test(path)) return 2;
  if (/\.(md|mdx|txt|rst)$/.test(path)) return 1;
  return 3;
}

function gitOutput(root, args, timeoutMs = 5000) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

export function isGitRepository(root) {
  const key = resolve(root);
  if (gitRepoCache.has(key)) return gitRepoCache.get(key);
  const output = gitOutput(key, ["rev-parse", "--is-inside-work-tree"]);
  const value = output !== null && output.trim() === "true";
  gitRepoCache.set(key, value);
  if (!gitRepoCache.has(key) && gitRepoCache.size >= MAX_GIT_REPO_CACHE) {
    const oldest = gitRepoCache.keys().next().value;
    if (oldest !== undefined) gitRepoCache.delete(oldest);
  }
  gitRepoCache.set(key, value);
  return value;
}

function gitHead(root) {
  const output = gitOutput(root, ["rev-parse", "HEAD"]);
  return output !== null && output.trim().length > 0 ? output.trim() : null;
}

function gitContext(cwd, scope) {
  const normalizedScope = normalizeRel(scope);
  const scopeRoot = normalizedScope.length === 0 || normalizedScope === "." ? cwd : join(cwd, normalizedScope);
  const top = gitOutput(scopeRoot, ["rev-parse", "--show-toplevel"]);
  if (top === null || top.trim().length === 0) return null;
  const root = resolve(top.trim());
  const head = gitHead(root);
  return head === null ? null : { root, head };
}
function gitStatusPaths(root, scope) {
  const output = gitOutput(root, ["status", "--porcelain=v1", "-z"]);
  if (output === null) return [];
  const parts = output.split("\0");
  const files = [];
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const file = normalizeRel(entry.slice(3));
    if (inScope(file, scope) && isSemanticFile(file)) files.push(file);
    if (code.startsWith("R") || code.startsWith("C")) index += 1;
  }
  return files;
}

function gitDiffPaths(root, fromHead, scope) {
  const range = fromHead ? fromHead + "..HEAD" : "HEAD";
  const output = gitOutput(root, ["diff", "--name-only", range, "--", scope === "." ? "." : scope]);
  if (output === null) return [];
  return output.split(/\r?\n/).map(normalizeRel).filter((file) => file.length > 0 && inScope(file, scope) && isSemanticFile(file));
}

function gitNumstat(root, fromHead, scope) {
  const args = fromHead
    ? ["diff", "--numstat", fromHead + "..HEAD", "--", scope === "." ? "." : scope]
    : ["diff", "HEAD", "--numstat", "--", scope === "." ? "." : scope];
  const output = gitOutput(root, args);
  const map = new Map();
  if (output === null) return map;
  for (const line of output.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const added = Number.parseInt(parts[0], 10);
    const deleted = Number.parseInt(parts[1], 10);
    const file = normalizeRel(parts.slice(2).join("\t"));
    if (!inScope(file, scope) || !isSemanticFile(file)) continue;
    const lines = Number.isFinite(added) && Number.isFinite(deleted) ? added + deleted : 1;
    map.set(file, Math.max(map.get(file) ?? 0, lines));
  }
  return map;
}

function baselinePath(cwd, indexDir) {
  return join(cwd, indexDir, BASELINE_FILE);
}

function readBaselineStore(cwd, indexDir) {
  try {
    const file = baselinePath(cwd, indexDir);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed !== null && typeof parsed === "object" && parsed.scopes !== null && typeof parsed.scopes === "object") return parsed;
  } catch {
    // missing or invalid baseline is treated as no baseline
  }
  return { version: 1, scopes: {} };
}

function writeBaselineStore(cwd, indexDir, store) {
  atomicWriteArchitectureFile(baselinePath(cwd, indexDir), JSON.stringify(store, null, 2));
}

export function readArchitectureBaseline(cwd, scope, indexDir = ".dsh/compaction-fidelity") {
  const store = readBaselineStore(cwd, indexDir);
  const entry = store.scopes[normalizeRel(scope)] ?? store.scopes[scope];
  return entry !== null && typeof entry === "object" ? entry : null;
}

export function writeArchitectureBaseline(cwd, scope, baseline, indexDir = ".dsh/compaction-fidelity") {
  const store = readBaselineStore(cwd, indexDir);
  store.scopes[normalizeRel(scope)] = baseline;
  writeBaselineStore(cwd, indexDir, store);
}

export function computeArchitectureBaseline(cwd, scope, options = {}) {
  const normalizedScope = normalizeRel(scope) || ".";
  const scopeRoot = normalizedScope === "." ? cwd : join(cwd, normalizedScope);
  const filter = typeof options.filterFile === "function" ? options.filterFile : null;
  const index = buildIndex(scopeRoot, {
    indexDir: options.indexDir ?? ".dsh/compaction-fidelity",
    maxFiles: options.maxFiles ?? 20000,
    maxFileBytes: options.maxFileBytes ?? 1024 * 1024,
    write: false,
  });
  const files = {};
  for (const file of index.files ?? []) {
    const relativeFile = normalizeRel(file.p);
    if (!isSemanticFile(relativeFile)) continue;
    if (options.docName && basename(relativeFile) === options.docName) continue;
    const workspaceFile = normalizedScope === "." ? relativeFile : normalizedScope + "/" + relativeFile;
    if (filter !== null && !filter(workspaceFile)) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(join(scopeRoot, relativeFile)).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    files[workspaceFile] = {
      hash: file.hash ?? "",
      size: file.bytes ?? 0,
      mtimeMs,
    };
  }
  const gitInfo = gitContext(cwd, normalizedScope);
  return { at: Date.now(), head: gitInfo?.head ?? null, gitRoot: gitInfo?.root ?? null, files };
}

function walkSemanticFiles(root, scope, maxFiles, filter) {
  const out = [];
  const base = scope === "." ? root : join(root, scope);
  const stack = [base];
  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        stack.push(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const relativeFile = normalizeRel(join(dir, entry.name).slice(root.length + 1));
      if (!isSemanticFile(relativeFile)) continue;
      if (typeof filter === "function" && !filter(relativeFile)) continue;
      try {
        const stat = statSync(join(dir, entry.name));
        out.push({ file: relativeFile, size: stat.size, mtimeMs: stat.mtimeMs, absolute: join(dir, entry.name) });
      } catch {
        // ignore unreadable files
      }
    }
  }
  return out;
}

function computeCurrentHashes(cwd, scope, baseline, options) {
  const maxHashFiles = options.maxHashFiles ?? 3000;
  const files = walkSemanticFiles(cwd, scope, options.maxFiles ?? 20000, options.filterFile);
  const current = new Map();
  for (const entry of files) {
    const previous = baseline.files?.[entry.file] ?? null;
    const sizeChanged = previous === null || previous.size !== entry.size;
    const mtimeChanged = previous === null || previous.mtimeMs === undefined || entry.mtimeMs > previous.mtimeMs + 1000;
    if (files.length > maxHashFiles && !sizeChanged && !mtimeChanged) continue;
    try {
      current.set(entry.file, { hash: architectureHash(readFileSync(entry.absolute, "utf8")), size: entry.size });
    } catch {
      // ignore unreadable files
    }
  }
  return current;
}

function scoreChangedFiles(changedFiles, lineMap, singleFileChangeThreshold) {
  let score = 0;
  let forced = false;
  for (const file of changedFiles) {
    const lines = lineMap.get(file) ?? 0;
    const weight = fileWeight(file);
    score += weight * (lines > 0 ? 1 + Math.min(Math.floor(lines / 50), 4) : 1);
    if (lines >= singleFileChangeThreshold && weight >= 3) forced = true;
  }
  return { score: Number(score.toFixed(2)), forced };
}

export function detectSemanticChanges(cwd, scope, options = {}) {
  const indexDir = options.indexDir ?? ".dsh/compaction-fidelity";
  const docName = options.docName ?? "ARCHITECTURE.md";
  const singleFileChangeThreshold = options.singleFileChangeThreshold ?? 300;
  const baseline = readArchitectureBaseline(cwd, scope, indexDir);
  const filter = typeof options.filterFile === "function" ? options.filterFile : null;
  if (baseline !== null) {
    if (baseline.gitRoot && baseline.head && isGitRepository(baseline.gitRoot)) {
      const lineMap = new Map();
      const toWorkspace = (file) => {
        const workspaceFile = normalizeRel(relative(cwd, join(baseline.gitRoot, normalizeRel(file))));
        return workspaceFile.startsWith("../") ? null : workspaceFile;
      };
      const addRepoPath = (file, lines) => {
        const workspaceFile = toWorkspace(file);
        if (workspaceFile === null || !inScope(workspaceFile, scope) || !isSemanticFile(workspaceFile)) return;
        if (filter !== null && !filter(workspaceFile)) return;
        lineMap.set(workspaceFile, Math.max(lineMap.get(workspaceFile) ?? 0, lines));
      };
      for (const file of gitStatusPaths(baseline.gitRoot, ".")) addRepoPath(file, 0);
      for (const file of gitDiffPaths(baseline.gitRoot, baseline.head, ".")) addRepoPath(file, 0);
      for (const [file, lines] of gitNumstat(baseline.gitRoot, baseline.head, ".")) addRepoPath(file, lines);
      for (const [file, lines] of gitNumstat(baseline.gitRoot, null, ".")) addRepoPath(file, lines);
      const changedFiles = [...lineMap.keys()].filter((file) => basename(file) !== docName);
      const scored = scoreChangedFiles(changedFiles, lineMap, singleFileChangeThreshold);
      return { method: "git", score: scored.score, changedFiles, forced: scored.forced, baselineFound: true };
    }
    const current = computeCurrentHashes(cwd, scope, baseline, options);
    const changedFiles = [];
    const lineMap = new Map();
    let forced = false;
    for (const [file, entry] of current) {
      const previous = baseline.files?.[file] ?? null;
      if (previous !== null && previous.hash === entry.hash) continue;
      changedFiles.push(file);
      lineMap.set(file, 0);
      if (previous !== null && fileWeight(file) >= 3 && Math.abs((entry.size ?? 0) - (previous.size ?? 0)) >= 4096) forced = true;
    }
    const scored = scoreChangedFiles(changedFiles, lineMap, singleFileChangeThreshold);
    return { method: "hash", score: scored.score, changedFiles, forced: forced || scored.forced, baselineFound: true };
  }
  const sinceMs = Number.isFinite(options.sinceMs) ? options.sinceMs : Date.now();
  const count = countChangedFilesSince(cwd, scope, sinceMs, { maxFiles: options.maxFiles, exclude: [docName], filterFile: filter });
  return { method: "mtime", score: count, changedFiles: [], forced: false, baselineFound: false };
}


