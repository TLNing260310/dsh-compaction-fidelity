import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  CODE_EXTENSIONS,
  DEFAULT_INDEX_DIR,
  IGNORE_DIRS,
  TEXT_EXTENSIONS,
  basenameNoExt,
  clampText,
  depthOf,
  ensureDirSync,
  extnameLower,
  formatBytes,
  assertWorkspaceContained,
  isSafeRelativePath,
  joinWorkspace,
  normalizeRelPath,
  readJsonIfExists,
  sha256,
  SKIP_EXTENSIONS,
  toPosix,
  uniqueBy,
  writeFileAtomicSync,
  writeJsonSync,
} from './util.mjs';

const INDEX_VERSION = 1;
const TOOL = 'dsh-compaction-fidelity';
const TOOL_VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; }
  catch { return '0.0.0'; }
})();
const MANIFEST_NAMES = new Set(['package.json', 'pnpm-workspace.yaml', 'go.mod', 'cargo.toml', 'pyproject.toml', 'requirements.txt', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'gemfile', 'dockerfile', 'makefile', 'cmakelists.txt']);
const ARCH_DOC_RE = /(^|\/)(architecture|arch|adr|design|overview|roadmap)([\/.-]|$)/i;
const ENTRY_NAMES = new Set(['main', 'index', 'app', 'server', 'cli', 'mod', 'lib', 'bootstrap', 'program']);
const TEST_RE = /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\./i;
const SCHEMA_RE = /(^|\/)(migrations?|schema|schemas|prisma|models?)(\/|$)|\.(sql|prisma)$/i;
const DB_HINT_RE = /(db|database|model|repository|repo|entity|schema|migration|sql)/i;
const SENSITIVE_FILE_RE = /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|id_rsa(\.pub)?|id_ed25519(\.pub)?|credentials(\..*)?|secrets?(\..*)?)$/i;
const SENSITIVE_EXT_RE = /\.(pem|key|p12|pfx|jks|keystore)$/i;
const PROJECT_INDEX_ROOT_VERSION = 1;

function isTextFile(relPath) {
  const ext = extnameLower(relPath);
  return TEXT_EXTENSIONS.has(ext) || ext === '';
}

function isCodeFile(relPath) {
  return CODE_EXTENSIONS.has(extnameLower(relPath));
}

export function isSensitiveIndexPath(relPath) {
  const value = String(relPath ?? "");
  return SENSITIVE_FILE_RE.test(value) || SENSITIVE_EXT_RE.test(value);
}

function assertSafeIndexDir(root, indexDir) {
  if (!isSafeRelativePath(indexDir)) throw new Error(`unsafe indexDir "${String(indexDir)}"`);
  const abs = join(resolve(root), ...indexDir.split('/'));
  assertWorkspaceContained(root, abs);
  return abs;
}

function trySafeIndexDir(root, indexDir) {
  try {
    return assertSafeIndexDir(root, indexDir);
  } catch {
    return null;
  }
}

function canonicalCodeId(relPath) {
  return `code:${relPath}`;
}

function extractTableNames(relPath, text) {
  const names = [];
  if (/\.sql$/i.test(relPath)) {
    const regex = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+["\`\[]?([A-Za-z_][\w.$]*)["\`\]]?/gi;
    let match;
    while ((match = regex.exec(text)) !== null) names.push(match[1]);
  }
  if (/\.prisma$/i.test(relPath)) {
    const regex = /^\s*model\s+([A-Za-z_]\w*)/gm;
    let match;
    while ((match = regex.exec(text)) !== null) names.push(match[1]);
  }
  return uniqueBy(names, (value) => value).slice(0, 200);
}

function classifyFile(relPath, text) {
  const lower = relPath.toLowerCase();
  const base = lower.split('/').pop() ?? lower;
  const baseNoExt = basenameNoExt(base);
  if (MANIFEST_NAMES.has(base)) return 'manifest';
  if (/^readme(\.|$)/i.test(base)) return 'arch-doc';
  if (ARCH_DOC_RE.test(lower) || /^(architecture|design|overview|roadmap)\./i.test(base)) return 'arch-doc';
  if (/\.(md|mdx)$/i.test(base) || /(^|\/)docs?(\/|$)/i.test(lower)) return 'doc';
  if (TEST_RE.test(lower)) return 'test';
  if (/\.(sql|prisma)$/i.test(base) || /(^|\/)migrations?(\/|$)/i.test(lower)) return 'migration';
  if (/(^|\/)(schema|schemas)(\/|$)/i.test(lower) || /^schema\./i.test(base)) return 'schema';
  if (ENTRY_NAMES.has(baseNoExt) && isCodeFile(relPath)) return 'entry';
  if (/(^|\/)(config|configs|conf)\./i.test(lower) || /^(tsconfig|vite\.config|webpack\.config|rollup\.config|jest\.config|vitest\.config|eslint|prettier|babel)/i.test(base)) return 'config';
  if (isCodeFile(relPath)) return 'code';
  if (/(docker-compose|dockerfile)/i.test(base)) return 'config';
  if (isTextFile(relPath)) return 'other';
  return 'binary';
}

function parseImportSpecifiers(relPath, text) {
  const ext = extnameLower(relPath);
  const specs = [];
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    const regexes = [
      /(?:^|\n)\s*import\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g,
      /(?:^|\n)\s*export\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g,
      /require\(\s*['"]([^'"]+)['"]\s*\)/g,
      /import\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];
    for (const regex of regexes) {
      let match;
      while ((match = regex.exec(text)) !== null) specs.push(match[1]);
    }
    return uniqueBy(specs, (value) => value).slice(0, 200);
  }
  if (ext === '.py') {
    const regex = /^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w, ]+))/gm;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const raw = (match[1] ?? match[2] ?? '').split(',')[0].trim();
      if (raw.length > 0) specs.push(raw);
    }
    return uniqueBy(specs, (value) => value).slice(0, 200);
  }
  if (ext === '.go') {
    const moduleMatch = /module\s+([^\s]+)/.exec(text);
    const block = /import\s*\(([\s\S]*?)\)/.exec(text);
    const singles = [...text.matchAll(/^\s*import\s+"([^"]+)"/gm)].map((match) => match[1]);
    const lines = block === null ? [] : [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    for (const spec of [...lines, ...singles]) {
      if (moduleMatch === null || spec.startsWith(moduleMatch[1])) specs.push(spec);
    }
    return uniqueBy(specs, (value) => value).slice(0, 200);
  }
  if (ext === '.rs') {
    const regexes = [/^\s*mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gm, /^\s*use\s+crate::([A-Za-z0-9_:]+)/gm];
    for (const regex of regexes) {
      let match;
      while ((match = regex.exec(text)) !== null) specs.push(match[1].replace(/::/g, '/'));
    }
    return uniqueBy(specs, (value) => value).slice(0, 200);
  }
  return specs;
}

function resolveCandidate(fileSet, root, baseDir, candidate) {
  const candidates = [candidate];
  const ext = extnameLower(candidate);
  if (ext === '') {
    for (const suffix of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.json']) candidates.push(candidate + suffix);
    for (const suffix of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs']) candidates.push(`${candidate}${suffix === '.py' ? '/__init__.py' : '/index' + suffix}`);
  }
  for (const value of candidates) {
    const normalized = toPosix(resolve(baseDir, value));
    const workspaceRel = normalizeRelPath(root, normalized);
    if (fileSet.has(workspaceRel)) return workspaceRel;
  }
  return null;
}

function resolveImports(root, files) {
  const fileSet = new Set(files.map((file) => file.p));
  for (const file of files) {
    const resolved = [];
    for (const spec of file.rawImports ?? []) {
      if (spec.startsWith('.') || spec.startsWith('/')) {
        const candidate = resolveCandidate(fileSet, root, dirname(join(root, file.p)), spec);
        if (candidate !== null) resolved.push(candidate);
        continue;
      }
      // Package imports: keep the specifier as a symbolic anchor, resolved to
      // same-workspace workspace package directories when a matching folder exists.
      const first = spec.split('/')[0];
      const packageCandidates = [`${first}/package.json`, `packages/${first}/package.json`, `apps/${first}/package.json`];
      for (const candidate of packageCandidates) {
        if (fileSet.has(candidate)) {
          resolved.push(candidate);
          break;
        }
      }
    }
    file.imports = uniqueBy(resolved, (value) => value).slice(0, 200);
    delete file.rawImports;
  }
}

function walkWorkspace(root, options) {
  const out = [];
  const maxFiles = options.maxFiles;
  const maxFileBytes = options.maxFileBytes;
  const readFile = typeof options.readFile === 'function' ? options.readFile : readFileSync;
  const stack = [''];
  while (stack.length > 0 && out.length < maxFiles) {
    const relDir = stack.pop();
    const absDir = relDir.length === 0 ? root : join(root, relDir);
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      const rel = toPosix(relDir.length === 0 ? entry.name : `${relDir}/${entry.name}`);
      if (SKIP_EXTENSIONS.has(extnameLower(rel))) continue;
      if (SENSITIVE_FILE_RE.test(rel) || SENSITIVE_EXT_RE.test(rel)) continue;
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        stack.push(rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (typeof options.filterFile === 'function' && !options.filterFile(rel)) continue;
      let stat;
      try {
        stat = statSync(join(root, rel));
      } catch {
        continue;
      }
      if (stat.size > maxFileBytes) continue;
      let text = '';
      if (isTextFile(rel)) {
        try {
          text = readFile(join(root, rel), 'utf8');
        } catch {
          text = '';
        }
      }
      const kind = classifyFile(rel, text);
      const tables = kind === 'schema' || kind === 'migration' || /\.(sql|prisma)$/i.test(rel)
        ? extractTableNames(rel, text)
        : undefined;
      out.push({
        p: rel,
        kind,
        lang: extnameLower(rel) || 'none',
        bytes: Buffer.byteLength(text, 'utf8') || stat.size,
        lines: text.length === 0 ? 0 : text.split(/\r?\n/).length,
        hash: text.length > 0 ? sha256(text) : '',
        tables,
        imports: [],
        rawImports: isCodeFile(rel) ? parseImportSpecifiers(rel, text) : [],
      });
    }
  }
  return out;
}

function buildModules(files) {
  const map = new Map();
  for (const file of files) {
    const parts = file.p.split('/');
    const key = parts.length === 1 ? '(root)' : parts[0];
    const entry = map.get(key) ?? { path: key, files: 0, languages: {}, keyFiles: [] };
    entry.files += 1;
    entry.languages[file.lang] = (entry.languages[file.lang] ?? 0) + 1;
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => b.files - a.files);
}

function detectCommands(root, files) {
  const commands = [];
  const packageFile = files.find((file) => file.p === 'package.json');
  if (packageFile !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      for (const [name, value] of Object.entries(parsed.scripts ?? {})) commands.push(`npm run ${name} — ${String(value)}`);
      if (parsed.packageManager) commands.unshift(`packageManager: ${parsed.packageManager}`);
    } catch {
      // ignore malformed manifest
    }
  }
  const goMod = files.find((file) => file.p === 'go.mod');
  if (goMod !== undefined) {
    try {
      const match = /^module\s+(\S+)/m.exec(readFileSync(join(root, 'go.mod'), 'utf8'));
      if (match !== null) commands.push(`go module: ${match[1]}`);
      commands.push('go test ./...', 'go build ./...');
    } catch {
      // ignore
    }
  }
  const makefile = files.find((file) => /(^|\/)Makefile$/i.test(file.p));
  if (makefile !== undefined) {
    try {
      const text = readFileSync(join(root, makefile.p), 'utf8');
      const targets = [...text.matchAll(/^([A-Za-z0-9_.-]+):(?:\s|$)/gm)].map((match) => match[1]).slice(0, 30);
      for (const target of targets) commands.push(`make ${target}`);
    } catch {
      // ignore
    }
  }
  return uniqueBy(commands, (value) => value).slice(0, 60);
}

function detectDatabaseFiles(files) {
  const out = [];
  for (const file of files) {
    if (file.kind === 'schema' || file.kind === 'migration' || /\.(sql|prisma)$/i.test(file.p)) {
      out.push({
        p: file.p,
        kind: file.kind,
        reason: file.kind === 'migration' ? 'database migration' : 'database schema',
        tables: file.tables ?? [],
      });
    }
  }
  return out;
}

function scoreArchitectureFiles(files, importedBy) {
  const scored = [];
  for (const file of files) {
    if (file.kind === 'test' || file.kind === 'binary' || file.kind === 'large') continue;
    const fanIn = importedBy.get(file.p)?.length ?? 0;
    let score = 0;
    const reasons = [];
    if (file.kind === 'arch-doc') { score += 120; reasons.push('architecture document'); }
    else if (file.kind === 'manifest') { score += 100; reasons.push('project manifest'); }
    else if (file.kind === 'entry') { score += 75; reasons.push('entry point'); }
    else if (file.kind === 'config') { score += 55; reasons.push('build/runtime configuration'); }
    else if (file.kind === 'schema' || file.kind === 'migration') { score += 50; reasons.push('database structure'); }
    if (fanIn > 0) {
      score += Math.min(80, fanIn * 5);
      reasons.push(`${fanIn} file(s) import this`);
    }
    if (file.kind === 'code' && ENTRY_NAMES.has(basenameNoExt(file.p))) {
      score += 25;
      reasons.push('module entry/index name');
    }
    score -= Math.min(20, depthOf(file.p) * 2);
    if (score > 0) scored.push({ p: file.p, kind: file.kind, score, reasons: reasons.length > 0 ? reasons : ['structural anchor'] });
  }
  return scored.sort((a, b) => b.score - a.score);
}

function buildBrief(index) {
  const lines = [];
  lines.push(`# Compaction-Fidelity Project Brief — ${index.root.split(/[\\/]/).pop() || index.root}`);
  lines.push('');
  lines.push(`- Generated: ${index.generatedAt}`);
  lines.push(`- Tool: ${TOOL} ${TOOL_VERSION}`);
  lines.push(`- Files indexed: ${index.stats.files} (${formatBytes(index.stats.bytes)})`);
  lines.push(`- Languages: ${index.stats.languages.slice(0, 8).map(([lang, count]) => `${lang}:${count}`).join(', ')}`);
  lines.push(`- ID scheme: CF-MOD-#### / CF-ARCH-#### / CF-DB-####; canonical file identity: code:<path>`);
  lines.push('');
  lines.push('## Modules');
  for (const module of index.modules.slice(0, 20)) {
    lines.push(`- [${module.id}] \`${module.path}\` — ${module.files} file(s); ${Object.entries(module.languages).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([lang, count]) => `${lang}:${count}`).join(', ')}`);
  }
  lines.push('');
  lines.push('## Architecture-level files');
  for (const file of index.archFiles.slice(0, 25)) lines.push(`- [${file.id}] \`${canonicalCodeId(file.p)}\` — ${file.reasons.join('; ')}`);
  if (index.commands.length > 0) {
    lines.push('');
    lines.push('## Commands and conventions');
    for (const command of index.commands.slice(0, 25)) lines.push(`- ${command}`);
  }
  if (index.dbFiles.length > 0) {
    lines.push('');
    lines.push('## Database structure files');
    for (const file of index.dbFiles.slice(0, 20)) {
      const tables = (file.tables ?? []).slice(0, 12).join(', ');
      lines.push(`- [${file.id}] \`${canonicalCodeId(file.p)}\` tables=${tables.length > 0 ? tables : '-'} — ${file.reason}`);
    }
  }
  return clampText(lines.join('\n'), 6000);
}

function renderMeta(index) {
  const lines = [
    `#CF-META-VOLUME: 1`,
    `#Format-Version: dsh-compaction-fidelity/v${INDEX_VERSION}`,
    `#Generated-By: ${TOOL} ${TOOL_VERSION}`,
    `#Locale: ${index.locale ?? 'auto'}`,
    `#Root: ${index.root}`,
    `#Generated-At: ${index.generatedAt}`,
    `#Files: ${index.stats.files}`,
    `#Bytes: ${index.stats.bytes}`,
    '#Admission: deterministic-anchor-only; this volume is an index, not semantic truth',
    '#ID-Scheme: CF-MOD-#### / CF-ARCH-#### / CF-DB-####; canonical file identity code:<path>',
    '#Quotas: anchors<=8 per file; anchor message<=4000 chars; brief<=6000 chars',
    '#FRAS-Note: F/R/A/S semantic entries are intentionally not machine-authored in this version',
    '',
    '#Languages:',
  ];
  for (const [lang, count] of index.stats.languages) lines.push(`#  ${lang}: ${count}`);
  return `${lines.join('\n')}\n`;
}

function renderCode(index) {
  const lines = [`#CF-CODE-VOLUME: 1`, `#Generated-By: ${TOOL} ${TOOL_VERSION}`, `#Locale: ${index.locale ?? 'auto'}`, ''];
  for (const module of index.modules) {
    lines.push(`[${module.id}] [${module.path}] files=${module.files} languages=${Object.entries(module.languages).sort((a, b) => b[1] - a[1]).map(([lang, count]) => `${lang}:${count}`).join(',')}`);
    for (const file of index.archFiles.filter((entry) => (module.path === '(root)' ? !entry.p.includes('/') : entry.p.startsWith(`${module.path}/`))).slice(0, 8)) {
      lines.push(`  - [${file.id}] [${canonicalCodeId(file.p)}] — ${file.reasons.join('; ')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function renderArch(index) {
  const lines = [`#CF-ARCH-VOLUME: 1`, `#Generated-By: ${TOOL} ${TOOL_VERSION}`, `#Locale: ${index.locale ?? 'auto'}`, ''];
  for (const file of index.archFiles) lines.push(`- [${file.id}] [${canonicalCodeId(file.p)}] [${file.kind}, score=${file.score}] — ${file.reasons.join('; ')}`);
  return `${lines.join('\n')}\n`;
}

function renderDatabase(index) {
  const lines = [`#CF-DATABASE-VOLUME: 1`, `#Generated-By: ${TOOL} ${TOOL_VERSION}`, `#Locale: ${index.locale ?? 'auto'}`, ''];
  if (index.dbFiles.length === 0) lines.push('(none detected; file-level evidence only, no live database connection)');
  for (const file of index.dbFiles) {
    const tables = (file.tables ?? []).slice(0, 40).join(', ');
    lines.push(`- [${file.id}] [${canonicalCodeId(file.p)}] tables=${tables.length > 0 ? tables : '-'} — ${file.reason}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderRoot(index) {
  return [
    `#COMPACTION-FIDELITY-ROOT-MANIFEST: ${PROJECT_INDEX_ROOT_VERSION}`,
    `#Format-Version: dsh-compaction-fidelity/v${INDEX_VERSION}`,
    `#Generated-By: ${TOOL} ${TOOL_VERSION}`,
    `#Locale: ${index.locale ?? 'auto'}`,
    `#Project: ${index.root.split(/[\\/]/).pop() || index.root}`,
    '#Global-Invariants: index-only; source files remain the source of truth',
    `#Volume: id=meta kind=meta path=project.meta.txt format=dsh-meta-v1 depends=- state=enabled`,
    `#Volume: id=arch kind=arch path=project.arch.txt format=dsh-arch-v1 depends=meta state=enabled`,
    `#Volume: id=code kind=code path=project.code.txt format=dsh-code-v1 depends=meta state=enabled`,
    `#Volume: id=database kind=database path=project.database.txt format=dsh-database-v1 depends=meta state=enabled`,
    '',
  ].join('\n') + '\n';
}

function buildIndexData(root, options = {}) {
  const indexDir = options.indexDir ?? DEFAULT_INDEX_DIR;
  const files = walkWorkspace(root, {
    maxFiles: options.maxFiles ?? 20000,
    maxFileBytes: options.maxFileBytes ?? 1024 * 1024,
    ...(typeof options.filterFile === 'function' ? { filterFile: options.filterFile } : {}),
    ...(typeof options.readFile === 'function' ? { readFile: options.readFile } : {}),
  });
  resolveImports(root, files);
  const importedBy = new Map();
  for (const file of files) {
    for (const target of file.imports ?? []) {
      const list = importedBy.get(target) ?? [];
      list.push(file.p);
      importedBy.set(target, list);
    }
  }
  const modules = buildModules(files).map((module, index) => ({
    ...module,
    id: `CF-MOD-${String(index + 1).padStart(4, '0')}`,
  }));
  const commands = detectCommands(root, files);
  const dbFiles = detectDatabaseFiles(files).map((file, index) => ({
    ...file,
    id: `CF-DB-${String(index + 1).padStart(4, '0')}`,
  }));
  const archRanked = scoreArchitectureFiles(files, importedBy)
    .slice(0, options.archFilesLimit ?? 60)
    .map((file, index) => ({ ...file, id: `CF-ARCH-${String(index + 1).padStart(4, '0')}` }));
  const archSet = new Set(archRanked.map((file) => file.p));
  for (const module of modules) {
    module.keyFiles = archRanked.filter((file) => (module.path === '(root)' ? !file.p.includes('/') : file.p.startsWith(`${module.path}/`))).slice(0, 8).map((file) => file.p);
  }
  const languageCounts = new Map();
  let bytes = 0;
  for (const file of files) {
    bytes += file.bytes;
    languageCounts.set(file.lang, (languageCounts.get(file.lang) ?? 0) + 1);
  }
  const index = {
    version: INDEX_VERSION,
    tool: TOOL,
    toolVersion: TOOL_VERSION,
    locale: options.locale ?? 'auto',
    root,
    indexDir,
    generatedAt: new Date().toISOString(),
    options: {
      maxFiles: options.maxFiles ?? 20000,
      maxFileBytes: options.maxFileBytes ?? 1024 * 1024,
      archFilesLimit: options.archFilesLimit ?? 60,
      anchorsPerFile: options.anchorsPerFile ?? 8,
    },
    stats: {
      files: files.length,
      bytes,
      languages: [...languageCounts.entries()].sort((a, b) => b[1] - a[1]),
    },
    files: files.map((file) => ({ p: file.p, lang: file.lang, kind: file.kind, bytes: file.bytes, lines: file.lines, hash: file.hash, tables: file.tables, imports: file.imports })),
    importedBy: Object.fromEntries([...importedBy.entries()].map(([key, value]) => [key, uniqueBy(value, (item) => item)])),
    archFiles: archRanked,
    modules,
    commands,
    dbFiles,
  };
  index.brief = buildBrief(index);
  return index;
}

function hydrateIndex(index) {
  index.filesByPath = new Map((index.files ?? []).map((entry) => [entry.p, entry]));
  index.importedByMap = new Map(Object.entries(index.importedBy ?? {}));
  index.archSet = new Set((index.archFiles ?? []).map((entry) => entry.p));
  return index;
}

const RETRIEVAL_SCOPE_FILE = 'retrieval-scope.json';
/** Files whose presence marks a directory as a plugin-managed index. */
const MANAGED_INDEX_MARKERS = ['index.json', RETRIEVAL_SCOPE_FILE, 'PROJECT.md'];

function normalizeReadOptions(options) {
  return typeof options === 'string' || options === null || options === undefined
    ? { indexDir: options ?? DEFAULT_INDEX_DIR }
    : options;
}

/**
 * Cached retrieval artifacts record the read policy they were built under, so a
 * rule change invalidates them instead of serving content the current rules no
 * longer allow. Callers that enforce a policy pass `expectedFingerprint`; an
 * artifact whose recorded policy is missing or different counts as absent.
 */
function policyAllowsCached(dir, options) {
  const expected = options?.expectedFingerprint;
  if (typeof expected !== 'string' || expected.length === 0) return true;
  const manifest = readJsonIfExists(join(dir, RETRIEVAL_SCOPE_FILE), null);
  return manifest !== null && typeof manifest === 'object' && manifest.fingerprint === expected;
}

export function buildIndex(root, options = {}) {
  const index = buildIndexData(resolve(root), options);
  if (options.write === false) return hydrateIndex(index);
  const indexDir = assertSafeIndexDir(index.root, index.indexDir);
  ensureDirSync(indexDir);
  writeJsonSync(join(indexDir, 'index.json'), index);
  writeJsonSync(join(indexDir, 'baseline.json'), {
    version: INDEX_VERSION,
    generatedAt: index.generatedAt,
    files: Object.fromEntries(index.files.filter((file) => file.hash.length > 0).map((file) => [file.p, file.hash])),
  });
  writeJsonSync(join(indexDir, 'anchors.json'), { version: INDEX_VERSION, generatedAt: index.generatedAt, byFile: {}, archFiles: index.archFiles });
  writeJsonSync(join(indexDir, RETRIEVAL_SCOPE_FILE), {
    version: 1,
    fingerprint: typeof options.scopeFingerprint === 'string' ? options.scopeFingerprint : '',
    generatedAt: index.generatedAt,
  });
  writeFileAtomicSync(join(indexDir, 'project.txt'), renderRoot(index));
  writeFileAtomicSync(join(indexDir, 'project.meta.txt'), renderMeta(index));
  writeFileAtomicSync(join(indexDir, 'project.code.txt'), renderCode(index));
  writeFileAtomicSync(join(indexDir, 'project.arch.txt'), renderArch(index));
  writeFileAtomicSync(join(indexDir, 'project.database.txt'), renderDatabase(index));
  writeFileAtomicSync(join(indexDir, 'PROJECT.md'), `${index.brief}\n`);
  writeFileAtomicSync(join(indexDir, 'anchors.md'), `# Compaction-Fidelity Anchor Map\n\nGenerated by ${TOOL}. Anchors are recomputed when files are modified and at compaction time.\n`);
  return hydrateIndex(index);
}

export function loadIndex(root, options = DEFAULT_INDEX_DIR) {
  const resolved = normalizeReadOptions(options);
  const dir = trySafeIndexDir(root, resolved.indexDir ?? DEFAULT_INDEX_DIR);
  if (dir === null) return null;
  if (!policyAllowsCached(dir, resolved)) return null;
  const file = join(dir, 'index.json');
  const index = readJsonIfExists(file, null);
  if (index === null || typeof index !== 'object') return null;
  return hydrateIndex(index);
}

export function ensureIndex(root, options = {}) {
  return loadIndex(root, options) ?? buildIndex(root, options);
}

function nearestAncestor(filesByPath, relPath, predicate) {
  let dir = dirname(relPath);
  while (dir !== '.' && dir !== '' && dir !== '/') {
    for (const file of filesByPath.values()) {
      if (file.p.startsWith(`${dir}/`) && predicate(file)) return file;
    }
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  for (const file of filesByPath.values()) if (predicate(file)) return file;
  return null;
}

function sameBasenameVariants(relPath) {
  const dir = dirname(relPath);
  const base = basenameNoExt(relPath);
  const variants = [`${base}.test`, `${base}.spec`, `${base}_test`];
  return variants.map((value) => (dir === '.' ? value : `${dir}/${value}`));
}

export function computeAnchors(index, relPath, limit = 8) {
  if (index === null || index === undefined) return [];
  const normalized = toPosix(relPath);
  const file = index.filesByPath?.get(normalized);
  if (file === undefined) return [];
  const candidates = [];
  const candidateKeys = new Set();
  const add = (path, kind, reason, weight) => {
    if (!path || path === normalized) return;
    const canonical = canonicalCodeId(path);
    if (candidateKeys.has(canonical)) return;
    candidateKeys.add(canonical);
    const target = index.filesByPath?.get(path);
    candidates.push({
      path,
      kind: target?.kind ?? kind,
      reason,
      weight,
      quality: weight,
      id: target?.id ?? null,
      canonical,
      sha256: typeof target?.hash === 'string' && target.hash.length >= 12 ? target.hash.slice(0, 12) : null,
    });
  };
  for (const imported of file.imports ?? []) {
    if (index.archSet.has(imported)) add(imported, 'architecture', 'imported by this file', 100);
  }
  for (const importer of index.importedByMap?.get(normalized) ?? []) {
    if (index.archSet.has(importer)) add(importer, 'architecture', 'imports this file', 95);
  }
  const moduleEntry = nearestAncestor(index.filesByPath, normalized, (candidate) => candidate.kind === 'entry' && dirname(candidate.p) === dirname(normalized));
  if (moduleEntry !== null) add(moduleEntry.p, moduleEntry.kind, 'nearest module entry', 80);
  const archDoc = nearestAncestor(index.filesByPath, normalized, (candidate) => candidate.kind === 'arch-doc' || candidate.kind === 'doc');
  if (archDoc !== null) add(archDoc.p, archDoc.kind, 'nearest architecture/documentation anchor', 75);
  const manifest = nearestAncestor(index.filesByPath, normalized, (candidate) => candidate.kind === 'manifest');
  if (manifest !== null) add(manifest.p, manifest.kind, 'governing manifest/configuration', 70);
  const selfBase = basenameNoExt(normalized);
  for (const candidate of index.filesByPath.values()) {
    if (candidate.kind !== 'test') continue;
    const testBase = basenameNoExt(candidate.p);
    if (testBase === selfBase || testBase.startsWith(`${selfBase}.`)) add(candidate.p, 'test', 'matching test anchor', 45);
  }
  if (DB_HINT_RE.test(normalized) || file.imports.some((imported) => DB_HINT_RE.test(imported))) {
    for (const dbFile of index.dbFiles ?? []) add(dbFile.p, dbFile.kind, 'database structure related to this file', 60);
  }
  if (index.archSet.has(normalized)) add(normalized, file.kind, 'this file is an architecture-level anchor', 1);
  const kindCaps = { test: 2, doc: 1, "arch-doc": 1, manifest: 1, db: 2, database: 2 };
  const kindCounts = new Map();
  const result = [];
  for (const candidate of uniqueBy(candidates, (item) => item.canonical ?? item.path)
    .filter((candidate) => candidate.path !== normalized)
    .sort((left, right) => (right.quality ?? right.weight) - (left.quality ?? left.weight))) {
    const cap = kindCaps[candidate.kind] ?? 3;
    const count = kindCounts.get(candidate.kind) ?? 0;
    if (count >= cap) continue;
    kindCounts.set(candidate.kind, count + 1);
    result.push(candidate);
    if (result.length >= limit) break;
  }
  return result;
}

function renderAnchorMap(anchorState) {
  const lines = [`# Compaction-Fidelity Anchor Map`, '', `Generated by ${TOOL} ${TOOL_VERSION}. Use \`compaction-fidelity-lookup\` for exact retrieval.`, ''];
  const entries = Object.entries(anchorState.byFile ?? {}).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [file, anchors] of entries) {
    lines.push(`## [${canonicalCodeId(file)}]`);
    if (anchors.length === 0) lines.push('- (no architecture anchors found)');
    for (const anchor of anchors) {
      const id = anchor.id ? `[${anchor.id}] ` : '';
      const sha = anchor.sha256 ? ` sha256:${anchor.sha256}` : '';
      lines.push(`- [${anchor.kind}] ${id}\`${anchor.canonical ?? anchor.path}\` — ${anchor.reason}${sha}`);
    }
    lines.push('');
  }
  return clampText(lines.join('\n'), 400000);
}

export function updateAnchorsForFiles(root, indexDir, files, options = {}) {
  const dir = assertSafeIndexDir(root, indexDir);
  if (!policyAllowsCached(dir, options)) return null;
  const index = loadIndex(root, indexDir);
  if (index === null) return null;
  const stateFile = join(dir, 'anchors.json');
  const anchorState = readJsonIfExists(stateFile, { version: INDEX_VERSION, generatedAt: index.generatedAt, byFile: {}, archFiles: index.archFiles });
  anchorState.byFile = anchorState.byFile ?? {};
  for (const file of files) {
    const rel = toPosix(file);
    if (!isSafeRelativePath(rel)) continue;
    if (index.filesByPath.has(rel) || index.archSet.has(rel)) {
      anchorState.byFile[rel] = computeAnchors(index, rel, options.anchorsPerFile ?? index.options?.anchorsPerFile ?? 8);
    }
  }
  anchorState.generatedAt = new Date().toISOString();
  writeJsonSync(stateFile, anchorState);
  writeFileAtomicSync(join(dir, 'anchors.md'), renderAnchorMap(anchorState));
  return anchorState;
}

export function anchorsForFile(root, indexDir, file, limit = 8, options = {}) {
  const dir = trySafeIndexDir(root, indexDir);
  if (dir === null) return null;
  if (!policyAllowsCached(dir, options)) return null;
  const index = loadIndex(root, indexDir);
  if (index === null) return null;
  const rel = toPosix(file);
  const stateFile = join(dir, 'anchors.json');
  const anchorState = readJsonIfExists(stateFile, { byFile: {} });
  const stored = anchorState.byFile?.[rel];
  if (Array.isArray(stored) && stored.length > 0 && stored.every((anchor) => Number.isFinite(anchor?.quality))) return stored;
  return computeAnchors(index, rel, limit);
}

export function searchIndex(index, query, limit = 12) {
  if (index === null) return [];
  const text = String(query ?? '').trim().toLowerCase();
  if (text.length === 0) return [];
  const results = [];
  for (const file of index.files ?? []) {
    const haystack = `${file.p} ${file.kind} ${file.lang} ${file.id ?? ''} ${canonicalCodeId(file.p)}`.toLowerCase();
    if (haystack.includes(text) || file.p.toLowerCase().split('/').some((part) => part.includes(text))) {
      results.push({ path: file.p, id: file.id ?? null, kind: file.kind, why: 'path/module/canonical-id match' });
    }
  }
  for (const file of index.archFiles ?? []) {
    const haystack = `${file.p} ${file.id ?? ''} ${canonicalCodeId(file.p)} ${file.reasons.join(' ')}`.toLowerCase();
    if (haystack.includes(text)) results.push({ path: file.p, id: file.id ?? null, kind: file.kind, why: file.reasons.join('; ') });
  }
  for (const command of index.commands ?? []) if (command.toLowerCase().includes(text)) results.push({ path: '', id: null, kind: 'command', why: command });
  return uniqueBy(results, (entry) => `${entry.path}|${entry.id}|${entry.kind}|${entry.why}`).slice(0, limit);
}

export function verifyIndex(root, options = DEFAULT_INDEX_DIR) {
  const resolved = normalizeReadOptions(options);
  const indexDir = resolved.indexDir ?? DEFAULT_INDEX_DIR;
  const dir = trySafeIndexDir(root, indexDir);
  if (dir === null) return { ok: false, reason: 'index missing' };
  if (!policyAllowsCached(dir, resolved)) return { ok: false, reason: 'index built under a different read policy' };
  const index = loadIndex(root, indexDir);
  if (index === null) return { ok: false, reason: 'index missing' };
  const baseline = readJsonIfExists(join(dir, 'baseline.json'), { files: {} });
  const changed = [];
  const missing = [];
  for (const [file, hash] of Object.entries(baseline.files ?? {})) {
    let abs;
    try { abs = joinWorkspace(root, file); } catch { missing.push(file); continue; }
    if (!existsSync(abs)) {
      missing.push(file);
      continue;
    }
    try {
      const text = readFileSync(abs, 'utf8');
      if (sha256(text) !== hash) changed.push(file);
    } catch {
      missing.push(file);
    }
  }
  return { ok: changed.length === 0 && missing.length === 0, generatedAt: index.generatedAt, changed, missing, indexed: index.stats.files };
}

export function briefForRoot(root, options = DEFAULT_INDEX_DIR) {
  const resolved = normalizeReadOptions(options);
  const indexDir = resolved.indexDir ?? DEFAULT_INDEX_DIR;
  const dir = trySafeIndexDir(root, indexDir);
  if (dir === null) return null;
  if (!policyAllowsCached(dir, resolved)) return null;
  const file = join(dir, 'PROJECT.md');
  if (existsSync(file)) return readFileSync(file, 'utf8');
  const index = loadIndex(root, indexDir);
  return index === null ? null : buildBrief(index);
}

export function purgeIndex(root, indexDir = DEFAULT_INDEX_DIR) {
  if (!isSafeRelativePath(indexDir)) throw new Error(`unsafe indexDir "${String(indexDir)}"`);
  const target = assertSafeIndexDir(root, indexDir);
  if (resolve(target) === resolve(root)) throw new Error('refusing to purge the workspace root');
  if (!existsSync(target)) return target;
  // A custom indexDir may point at an ordinary directory the user cares about.
  // Only remove directories this plugin actually manages.
  let entries;
  try {
    entries = readdirSync(target);
  } catch {
    throw new Error(`cannot read index directory: ${target}`);
  }
  if (!entries.some((name) => MANAGED_INDEX_MARKERS.includes(name))) {
    throw new Error(`refusing to purge ${target}: it does not look like a compaction-fidelity index directory`);
  }
  rmSync(target, { recursive: true, force: true });
  return target;
}







