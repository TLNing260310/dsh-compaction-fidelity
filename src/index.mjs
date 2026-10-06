import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import {
  anchorsForFile,
  briefForRoot,
  buildIndex,
  ensureIndex,
  loadIndex,
  searchIndex,
  updateAnchorsForFiles,
  verifyIndex,
} from './project-index.mjs';
import {
  getGlobalState,
  isMasterDisabled,
  readPersistedState,
  normalizeThreshold,
  parseTokenCount,
  resolveDshHome,
  resolveRetainTokens,
  savePersistedState,
  setGlobalState,
  THRESHOLD_PRESETS,
  DEFAULT_INDEX_DIR,
} from './state.mjs';
import { clampText, isSafeRelativePath, normalizeRelPath, toPosix } from './util.mjs';
import { PLUGIN_NAME, PRODUCER_SOURCE } from './message-source.mjs';
import { appendArchitectureUpdate, detectTaskFolders, lastUserText, preserveArchitectureUpdateLog, readArchitectureDoc, renderArchitectureDoc, resolveArchitectureDoc, verifyArchitectureDoc } from './architecture-doc.mjs';

import { atomicWriteArchitectureFile, mutateArchitectureDocument } from './architecture-io.mjs';
import { computeArchitectureBaseline, detectSemanticChanges, writeArchitectureBaseline } from './architecture-changes.mjs';
export const name = PLUGIN_NAME;
import { architectureReminderKey, mutateReminderState, pruneReminderState, recordReminder, reminderDecision } from './reminder-state.mjs';
import { createWorkspaceFileFilter, isValidScopePattern, managedScopeRules, matchesScopeRules, readArchitectureRegistry, rememberArchitectureScope as rememberScopeInRegistry, removeArchitectureScope, updateArchitectureScopeRules } from './architecture-registry.mjs';
import { importFidelityCalibration, readFidelityCalibration, summarizeFidelityCalibration } from './fidelity-calibration.mjs';
export const inject = ['commands', 'tools'];

const TOOL_ID = 'dsh-compaction-fidelity#command';
const SUMMARY_LANGUAGES = new Set(['auto', 'zh', 'en', 'bilingual']);

function normalizeConfig(config = {}) {
  const indexDir = typeof config.indexDir === 'string' && config.indexDir.length > 0 ? config.indexDir : DEFAULT_INDEX_DIR;
  if (!isSafeRelativePath(indexDir)) throw new Error(`compaction-fidelity: indexDir "${indexDir}" must be a safe workspace-relative path`);
  const defaultThreshold = config.defaultThreshold !== undefined ? String(config.defaultThreshold) : String(config.threshold ?? '350k');
  if (defaultThreshold !== undefined) normalizeThreshold(defaultThreshold);
  const configuredRetain = config.defaultRetainTokens ?? config.retainTokens;
  if (configuredRetain !== undefined && defaultThreshold !== undefined && parseTokenCount(configuredRetain) >= normalizeThreshold(defaultThreshold).tokens) {
    throw new Error('compaction-fidelity: defaultRetainTokens must be lower than the configured threshold');
  }
  return {
    enabled: config.enabled !== false,
    autoIndex: config.autoIndex !== false,
    anchorInjection: config.anchorInjection !== false,
    architectureDoc: config.architectureDoc !== false,
    architectureDocName: typeof config.architectureDocName === 'string' && /^[\w.-]+\.md$/i.test(config.architectureDocName) ? config.architectureDocName : 'ARCHITECTURE.md',
    indexDir,
    defaultThreshold,
    defaultRetainTokens: config.defaultRetainTokens ?? config.retainTokens,
    defaultSummaryLanguage: SUMMARY_LANGUAGES.has(config.summaryLanguage) ? config.summaryLanguage : undefined,
    defaultSummaryMaxTokens: Number.isInteger(config.summaryMaxTokens) && config.summaryMaxTokens >= 1024 ? config.summaryMaxTokens : undefined,
    defaultCompactionRetries: Number.isInteger(config.compactionRetries) && config.compactionRetries >= 0 ? config.compactionRetries : undefined,
    anchorsPerFile: Number.isInteger(config.anchorsPerFile) && config.anchorsPerFile > 0 ? config.anchorsPerFile : 8,
    maxFiles: Number.isInteger(config.maxFiles) && config.maxFiles > 0 ? config.maxFiles : 20000,
    maxFileBytes: Number.isInteger(config.maxFileBytes) && config.maxFileBytes > 0 ? config.maxFileBytes : 1024 * 1024,
    archFilesLimit: Number.isInteger(config.archFilesLimit) && config.archFilesLimit > 0 ? config.archFilesLimit : 60,
    architectureRefreshThreshold: Number.isInteger(config.architectureRefreshThreshold) && config.architectureRefreshThreshold > 0 && config.architectureRefreshThreshold <= 100000 ? config.architectureRefreshThreshold : 30,
    architectureSingleFileChangeThreshold: Number.isInteger(config.architectureSingleFileChangeThreshold) && config.architectureSingleFileChangeThreshold > 0 ? config.architectureSingleFileChangeThreshold : 300,
  };
}

function workspaceOf(agent) {
  return agent?.session?.header?.cwd ?? process.cwd();
}

function sessionIdOf(agent) {
  return agent?.session?.header?.id ?? agent?.session?.id ?? 'unknown';
}

function modifiedFilePath(exec, result) {
  if (result?.isError === true) return null;
  const toolName = String(exec?.name ?? '');
  const args = exec?.arguments;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null;
  const cwd = exec?.agent?.session?.header?.cwd;
  const pickPath = () => {
    if (typeof args.file_path === 'string') return args.file_path;
    if (typeof args.filePath === 'string') return args.filePath;
    if (typeof args.path === 'string') return args.path;
    if (typeof args.filename === 'string') return args.filename;
    return null;
  };
  const relative = pickPath();
  if (relative === null || relative.trim().length === 0) return null;
  if (toolName === 'str_replace_editor') {
    const command = String(args.command ?? '');
    if (command === 'view' || command === 'undo_edit') return null;
  } else if (!['write', 'edit', 'multi_edit', 'create_file', 'replace_in_file'].includes(toolName)) {
    return null;
  }
  if (cwd === undefined || cwd === null || cwd.length === 0) return null;
  try {
    const rel = normalizeRelPath(cwd, resolve(cwd, relative));
    if (rel.startsWith('..')) return null;
    return toPosix(rel);
  } catch {
    return null;
  }
}

function formatAnchors(file, anchors) {
  if (anchors === null || anchors === undefined || anchors.length === 0) return `- ${file}: (no architecture anchors found)`;
  const parts = anchors.map((anchor) => `[${anchor.kind}${Number.isFinite(anchor.quality) ? ` q${anchor.quality}` : ''}] ${anchor.id ? `[${anchor.id}] ` : ''}${anchor.canonical ?? anchor.path} — ${anchor.reason}`);
  return `- ${file} → ${parts.join('; ')}`;
}

function commandTextList(lines) {
  return lines.filter((line) => line.length > 0).join('\n');
}

export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config);
  const indexOptions = {
    indexDir: cfg.indexDir,
    anchorsPerFile: cfg.anchorsPerFile,
    maxFiles: cfg.maxFiles,
    maxFileBytes: cfg.maxFileBytes,
    archFilesLimit: cfg.archFilesLimit,
    locale: getGlobalState()?.summaryLanguage ?? cfg.defaultSummaryLanguage ?? 'auto',
  };
  const recentFiles = new Map();
  const MAX_SESSION_FILES = 64;
  const MAX_ARCHITECTURE_CACHE = 200;
  const MAX_ARCHITECTURE_SESSIONS = 200;
  const ARCHITECTURE_CHECK_TTL_MS = 5000;
  const architectureCheckCache = new Map();
  const cachedArchitectureChange = (cwd, scope, options) => {
    const key = String(cwd) + "|" + String(scope) + "|" + String(options?.sinceMs ?? 0);
    const now = Date.now();
    const hit = architectureCheckCache.get(key);
    if (hit !== undefined && now - hit.at < ARCHITECTURE_CHECK_TTL_MS) return hit.change;
    const change = detectSemanticChanges(cwd, scope, options);
    architectureCheckCache.set(key, { at: now, change });
    if (architectureCheckCache.size > MAX_ARCHITECTURE_CACHE) {
      const oldest = architectureCheckCache.keys().next().value;
      if (oldest !== undefined) architectureCheckCache.delete(oldest);
    }
    return change;
  };
  const createArchitectureDocument = (cwd, scope) => {
    const target = resolveArchitectureDoc(cwd, scope, cfg.architectureDocName);
    const parentDir = join(target.absolute, "..");
    if (!existsSync(parentDir) || !statSync(parentDir).isDirectory()) throw new Error("scope folder does not exist: " + scope);
    const mutation = mutateArchitectureDocument(target.absolute, (current) => {
      if (current !== null) return null;
      const index = buildArchitectureIndex(cwd, scope);
      return renderArchitectureDoc({ scope, docName: cfg.architectureDocName, index });
    });
    if (mutation.changed) updateArchitectureBaseline(cwd, scope);
    return { created: mutation.changed, target };
  };
  const buildArchitectureIndex = (cwd, scope) => {
    const normalizedScope = toPosix(String(scope ?? ".")).replace(/\/+$/, "");
    const registry = readArchitectureRegistry(cwd, cfg.indexDir);
    const rules = managedScopeRules(registry, normalizedScope);
    const filterFile = rules === null || rules === undefined ? undefined : (relativeFile) => matchesScopeRules(relativeFile, rules);
    return normalizedScope.length === 0 || normalizedScope === "."
      ? ensureIndex(cwd, filterFile === undefined ? indexOptions : { ...indexOptions, filterFile })
      : buildIndex(join(cwd, normalizedScope), { ...indexOptions, write: false, ...(filterFile === undefined ? {} : { filterFile }) });
  };

  const architectureScopes = new Map();
  const getArchitectureRegistry = (cwd) => readArchitectureRegistry(cwd, cfg.indexDir);
  const rememberArchitectureScope = (agent, scope) => {
    const cwd = workspaceOf(agent);
    const session = String(agent?.session?.id ?? "session");
    const normalized = toPosix(String(scope ?? ".")).replace(/\/+$/, "") || ".";
    const registry = rememberScopeInRegistry(cwd, cfg.indexDir, normalized, { docName: cfg.architectureDocName });
    if (!architectureScopes.has(session) && architectureScopes.size >= MAX_ARCHITECTURE_SESSIONS) {
      const oldest = architectureScopes.keys().next().value;
      if (oldest !== undefined) architectureScopes.delete(oldest);
    }
    architectureScopes.set(session, new Set(Object.keys(registry.scopes)));
    return registry;
  };
  const architectureManagedFilter = (cwd, scope) => {
    const registry = getArchitectureRegistry(cwd);
    const rules = managedScopeRules(registry, scope);
    return rules === null || rules === undefined ? null : createWorkspaceFileFilter(registry, scope);
  };
  const architectureScopeRules = (cwd, scope) => managedScopeRules(getArchitectureRegistry(cwd), scope);
  const listArchitectureScopes = (cwd) => Object.keys(getArchitectureRegistry(cwd).scopes);

  const refreshArchitectureDocument = (cwd, scope) => {
    const target = resolveArchitectureDoc(cwd, scope, cfg.architectureDocName);
    let existed = false;
    const mutation = mutateArchitectureDocument(target.absolute, (current) => {
      existed = current !== null;
      const structure = renderArchitectureDoc({
        scope,
        docName: cfg.architectureDocName,
        index: buildArchitectureIndex(cwd, scope),
      });
      return current === null ? structure : preserveArchitectureUpdateLog(current, structure);
    });
    if (mutation.changed) updateArchitectureBaseline(cwd, scope);
    return { target, refreshed: mutation.changed && existed };
  };
  const updateArchitectureBaseline = (cwd, scope) => {
    try {
    architectureCheckCache.clear();
      const baseline = computeArchitectureBaseline(cwd, scope, {
        indexDir: cfg.indexDir,
        maxFiles: cfg.maxFiles,
        maxFileBytes: cfg.maxFileBytes,
        docName: cfg.architectureDocName,
        filterFile: architectureManagedFilter(cwd, scope) ?? undefined,
      });
      writeArchitectureBaseline(cwd, scope, baseline, cfg.indexDir);
    } catch (error) {
      ctx.logger?.warn?.("compaction-fidelity architecture baseline failed: " + (error instanceof Error ? error.message : String(error)));
    }
  };
  const queuedIndexes = new Set();
  const architectureAsked = new Set();
  const architecturePending = new Map();

  if (!cfg.enabled || isMasterDisabled()) {
    const persistedDisabled = readPersistedState({ indexDir: cfg.indexDir }).home ?? {};
    const disabled = {
      ...(persistedDisabled !== null && typeof persistedDisabled === 'object' ? persistedDisabled : {}),
      ...setGlobalState({ enabled: false }),
      enabled: false,
      indexDir: cfg.indexDir,
    };
    savePersistedState(disabled, { indexDir: cfg.indexDir });
    ctx.logger?.info?.('dsh-compaction-fidelity: master switch is off (config or external marker); no tools, commands, or listeners were registered');
    return;
  }

  const persisted = readPersistedState({ indexDir: cfg.indexDir }).home ?? {};
  const initial = {
    ...(persisted !== null && typeof persisted === 'object' ? persisted : {}),
    enabled: persisted?.enabled !== false,
    indexDir: cfg.indexDir,
  };
  if (cfg.defaultThreshold !== undefined && initial.threshold === undefined) initial.threshold = cfg.defaultThreshold;
  if (cfg.defaultRetainTokens !== undefined && initial.retainTokens === undefined) initial.retainTokens = cfg.defaultRetainTokens;
  if (cfg.defaultSummaryLanguage !== undefined && initial.summaryLanguage === undefined) initial.summaryLanguage = cfg.defaultSummaryLanguage;
  if (cfg.defaultSummaryMaxTokens !== undefined && initial.summaryMaxTokens === undefined) initial.summaryMaxTokens = cfg.defaultSummaryMaxTokens;
  if (cfg.defaultCompactionRetries !== undefined && initial.compactionRetries === undefined) initial.compactionRetries = cfg.defaultCompactionRetries;
  setGlobalState(initial);
  if (String(cfg.defaultThreshold ?? '') === '350k' && initial.threshold === '800k' && initial.defaultThresholdVersion !== '350k') {
    initial.threshold = '350k';
    initial.defaultThresholdVersion = '350k';
  }
  savePersistedState({ ...initial }, { indexDir: cfg.indexDir });

  const persist = (patch, cwd, { persist = true } = {}) => {
    const next = { ...setGlobalState(patch), ...patch };
    if (patch.summaryLanguage !== undefined) indexOptions.locale = patch.summaryLanguage;
    if (persist) savePersistedState(next, { cwd, indexDir: cfg.indexDir, writeWorkspace: cwd !== undefined });
    return next;
  };

  const queueIndex = (cwd, { force = false } = {}) => {
    const master = getGlobalState();
    if (!cfg.autoIndex || master?.enabled === false || isMasterDisabled() || cwd === undefined || cwd === null || queuedIndexes.has(cwd)) return;
    if (!force) {
      try {
        if (loadIndex(cwd, cfg.indexDir) !== null) return;
      } catch {
        // fall through and build
      }
    }
    queuedIndexes.add(cwd);
    setTimeout(() => {
      try {
        buildIndex(cwd, indexOptions);
        ctx.logger?.info?.(`dsh-compaction-fidelity: Compaction-Fidelity index built for ${cwd}`);
      } catch (error) {
        ctx.logger?.warn?.(`dsh-compaction-fidelity: Compaction-Fidelity index build failed for ${cwd}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        queuedIndexes.delete(cwd);
      }
    }, 250).unref?.();
  };

  const briefTool = defineTool({
    name: 'compaction-fidelity-brief',
    description: 'Return the persistent Compaction-Fidelity project brief for the current workspace: module map, architecture-level files, commands, and database structure anchors. Use it when you need a fast, exact overview of a large project without reading the whole repository.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(_args, exec) {
      const cwd = workspaceOf(exec.agent);
      if (getGlobalState()?.enabled === false || isMasterDisabled()) {
        return { text: 'Compaction-Fidelity is temporarily disabled. Run /compaction-fidelity on to re-enable it.' };
      }
      try {
        ensureIndex(cwd, indexOptions);
        const brief = briefForRoot(cwd, cfg.indexDir);
        return { text: brief === null ? `No Compaction-Fidelity index at ${cwd}/${cfg.indexDir}; run /compaction-fidelity init.` : brief };
      } catch (error) {
        return { text: `Compaction-Fidelity brief failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  });

  const lookupTool = defineTool({
    name: 'compaction-fidelity-lookup',
    description: 'Look up Compaction-Fidelity architecture anchors for a file, or search the persistent Compaction-Fidelity index by path/module/query. Returns exact file paths and why they matter. Use it before editing an unfamiliar file and after a context compaction when a fact may have been dropped.',
    parameters: {
      file: { type: 'string', description: 'Workspace-relative file path to look up anchors for.' },
      query: { type: 'string', description: 'Path, module, command, or keyword to search when file is omitted.' },
      limit: { type: 'integer', description: 'Maximum results (default 8).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const cwd = workspaceOf(exec.agent);
      if (getGlobalState()?.enabled === false || isMasterDisabled()) {
        return { text: 'Compaction-Fidelity is temporarily disabled. Run /compaction-fidelity on to re-enable it.' };
      }
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 50) : 8;
      try {
        const index = ensureIndex(cwd, indexOptions);
        if (typeof args.file === 'string' && args.file.trim().length > 0) {
          const rel = toPosix(args.file.trim());
          const anchors = anchorsForFile(cwd, cfg.indexDir, rel, limit) ?? [];
          return { text: commandTextList([
            `Compaction-Fidelity lookup for ${rel}:`,
            formatAnchors(rel, anchors),
            anchors.length === 0 ? 'No anchor recorded yet; run /compaction-fidelity reindex or inspect the file directly.' : `Exact content stays in the original files; anchors are retrieval pointers. Full map: ${cfg.indexDir}/anchors.md`,
          ]) };
        }
        if (typeof args.query === 'string' && args.query.trim().length > 0) {
          const results = searchIndex(index, args.query, limit);
          return { text: commandTextList([
            `Compaction-Fidelity search for "${args.query.trim()}":`,
            ...results.map((entry) => entry.path.length > 0 ? `- [${entry.kind}] ${entry.path} — ${entry.why}` : `- command: ${entry.why}`),
            results.length === 0 ? 'No match. Try a path fragment, module name, or command keyword.' : `Full map: ${cfg.indexDir}/anchors.md`,
          ]) };
        }
        return { text: 'Provide `file` for anchors or `query` for a search.' };
      } catch (error) {
        return { text: `Compaction-Fidelity lookup failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  });

  const architectureTool = defineTool({
    name: "compaction-fidelity-architecture",
    description: "Check, read, create, verify, or append updates to a folder-scoped ARCHITECTURE.md retrieval document, and manage scope include/exclude rules. Use only after asking the user whether to create the document.",
    parameters: {
      action: { type: "string", description: "check | read | create | refresh | status | verify | update | include | exclude | manage | unmanage" },
      scope: { type: "string", description: "Workspace-relative task folder. Defaults to the workspace root." },
      summary: { type: "string", description: "Structured update summary for action=update." },
      changedFiles: { type: "string", description: "Optional comma-separated changed files for action=update." },
      pattern: { type: "string", description: "Comma-separated glob pattern(s) for action=include, exclude, or unmanage." },
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    async execute(args, exec) {
      const cwd = workspaceOf(exec.agent);
      if (getGlobalState()?.enabled === false || isMasterDisabled()) return { text: "Compaction-Fidelity is disabled." };
      if (cfg.architectureDoc === false) return { text: "Architecture document support is disabled." };
      const action = String(args.action ?? "check").trim().toLowerCase();
      const scope = typeof args.scope === "string" && args.scope.trim().length > 0 ? args.scope.trim() : ".";
      try {
        const target = resolveArchitectureDoc(cwd, scope, cfg.architectureDocName);
        if (action === "check") {
          if (!existsSync(target.absolute)) return { text: "missing: " + target.relative };
          const doc = readArchitectureDoc(cwd, scope, cfg.architectureDocName);
          const stat = statSync(target.absolute);
          const change = detectSemanticChanges(cwd, scope, { indexDir: cfg.indexDir, docName: cfg.architectureDocName, singleFileChangeThreshold: cfg.architectureSingleFileChangeThreshold, maxFiles: cfg.maxFiles, sinceMs: stat.mtimeMs - 1000, filterFile: architectureManagedFilter(cwd, scope) ?? undefined });
          const verification = verifyArchitectureDoc(doc === null ? "" : doc.text);
          const aligned = !change.forced && change.score < cfg.architectureRefreshThreshold;
          return { text: "exists: " + target.relative + "; aligned=" + aligned + "; score=" + change.score + "; method=" + change.method + "; attestation=" + (verification.attestation === null ? "missing" : verification.attestation.revision) + "; consistent=" + verification.ok };
        }
        const patterns = String(args.pattern ?? "").split(/[,\s]+/).map((item) => item.trim()).filter((item) => item.length > 0);
        if (action === "manage") {
          const rules = architectureScopeRules(cwd, scope);
          return { text: rules === null ? "scope not managed: " + scope : "scope=" + scope + "; include=" + JSON.stringify(rules.include ?? []) + "; exclude=" + JSON.stringify(rules.exclude ?? []) };
        }
        if (action === "include" || action === "exclude" || action === "unmanage") {
          if ((action === "include" || action === "exclude") && patterns.some((pattern) => !isValidScopePattern(pattern))) return { text: "invalid scope pattern" };
          if (action !== "unmanage" && patterns.length === 0) return { text: "action=" + action + " requires pattern." };
          let rules = null;
          if (action === "unmanage" && patterns.length === 0) {
            removeArchitectureScope(cwd, cfg.indexDir, scope);
          } else {
            updateArchitectureScopeRules(cwd, cfg.indexDir, scope, { include: action === "include" ? patterns : [], exclude: action === "exclude" ? patterns : [], removeInclude: action === "unmanage" ? patterns : [], removeExclude: action === "unmanage" ? patterns : [] });
            rememberArchitectureScope(exec.agent, scope);
            rules = architectureScopeRules(cwd, scope);
            if (existsSync(target.absolute)) refreshArchitectureDocument(cwd, scope);
          }
          return { text: action + ": scope=" + scope + "; include=" + JSON.stringify(rules?.include ?? []) + "; exclude=" + JSON.stringify(rules?.exclude ?? []) };
        }
        if (action === "read") {
          const doc = readArchitectureDoc(cwd, scope, cfg.architectureDocName);
          return doc === null ? { text: "missing: " + target.relative } : { text: clampText(doc.text, 8000) };
        }
        if (action === "create") {
          const created = createArchitectureDocument(cwd, scope);
          rememberArchitectureScope(exec.agent, scope);
          return { text: created.created ? "created: " + created.target.relative : "already exists: " + created.target.relative };
        }
        if (action === "refresh") {
          const refreshed = refreshArchitectureDocument(cwd, scope);
          rememberArchitectureScope(exec.agent, scope);
          return { text: "refreshed: " + refreshed.target.relative };
        }
        if (action === "status") {
          const doc = readArchitectureDoc(cwd, scope, cfg.architectureDocName);
          if (doc === null) return { text: "missing: " + target.relative };
          const stat = statSync(target.absolute);
          const change = detectSemanticChanges(cwd, scope, { indexDir: cfg.indexDir, docName: cfg.architectureDocName, singleFileChangeThreshold: cfg.architectureSingleFileChangeThreshold, maxFiles: cfg.maxFiles, sinceMs: stat.mtimeMs - 1000, filterFile: architectureManagedFilter(cwd, scope) ?? undefined });
          const docVerification = verifyArchitectureDoc(doc.text);
          const aligned = !change.forced && change.score < cfg.architectureRefreshThreshold;
          return { text: "status: " + (aligned ? "aligned" : "stale") + "; score=" + change.score + "; method=" + change.method + "; forced=" + change.forced + "; threshold=" + cfg.architectureRefreshThreshold + "; updatedAt=" + new Date(stat.mtimeMs).toISOString() + "; attestation=" + (docVerification.attestation === null ? "missing" : docVerification.attestation.revision) + "; consistent=" + docVerification.ok + "; entries=" + docVerification.entryCount };
        }
        if (action === "verify") {
          const doc = readArchitectureDoc(cwd, scope, cfg.architectureDocName);
          if (doc === null) return { text: "missing: " + target.relative };
          const verification = verifyArchitectureDoc(doc.text);
          return { text: "verify: " + (verification.ok ? "ok" : "failed") + "; entries=" + verification.entryCount + "; structureHash=" + verification.structureHash + "; updateLogHash=" + verification.updateLogHash + "; errors=" + verification.errors.join(" | ") };
        }
        if (action === "update") {
          const doc = readArchitectureDoc(cwd, scope, cfg.architectureDocName);
          if (doc === null) return { text: "missing: " + target.relative };
          const summary = String(args.summary ?? "").trim();
          if (summary.length === 0) return { text: "action=update requires summary." };
          const changedFiles = String(args.changedFiles ?? "").split(",").map((item) => item.trim()).filter((item) => item.length > 0);
          const mutation = mutateArchitectureDocument(target.absolute, (current) => {
            if (current === null) return null;
            const next = appendArchitectureUpdate(current, { scope, summary, changedFiles });
            const validation = verifyArchitectureDoc(next);
            if (!validation.ok) throw new Error("invalid architecture doc: " + validation.errors.join("; "));
            return next;
          });
          if (!mutation.changed) return { text: "missing: " + target.relative };
          rememberArchitectureScope(exec.agent, scope);
          if (mutation.changed) updateArchitectureBaseline(cwd, scope);
          return { text: "updated: " + target.relative };
        }
        return { text: "Unknown action: " + action + " (use check | read | create | refresh | status | verify | update | include | exclude | manage | unmanage)." };
      } catch (error) {
        return { text: "architecture doc failed: " + (error instanceof Error ? error.message : String(error)) };
      }
    },
  });
  const handler = async (invocation) => {
    const cwd = workspaceOf(invocation.agent);
    const raw = invocation.rawInput.trim();
    const [sub = 'status', ...rest] = raw.length === 0 ? [] : raw.split(/\s+/);
    try {
      switch (sub) {
        case 'status':
          return { kind: 'success', text: statusText(cwd, invocation.agent) };
        case 'on':
          persist({ enabled: true }, cwd, { persist: true });
          return { kind: 'success', text: 'Compaction-Fidelity 压缩插件已完整启用（并恢复为全局默认启用）：绝对阈值压缩 + Compaction-Fidelity 锚点 + 回查工具生效。' };
        case 'off': {
          const persistent = rest.includes('--persist');
          persist({ enabled: false }, cwd, { persist: persistent });
          return {
            kind: 'success',
            text: persistent
              ? 'Compaction-Fidelity 压缩插件已持久关闭：重启后仍保持关闭；使用 /compaction-fidelity on 恢复全局默认启用。'
              : 'Compaction-Fidelity 压缩插件已临时关闭：当前进程/会话立即生效；重启 DSH 或执行 /compaction-fidelity on 即恢复全局默认启用。',
          };
        }
        case 'threshold': {
          if (rest.length === 0) {
            const state = getGlobalState() ?? {};
            const lastCustom = state.lastCustomThreshold;
            return { kind: 'success', text: `当前自动压缩阈值：${state.threshold ?? cfg.defaultThreshold ?? '350k'}（可选 256k / 350k / 512k / 800k / 自定义 256<值<800（K））${lastCustom ? `；上次自定义：${lastCustom}` : ''}` };
          }
          const value = rest.join(' ');
          const normalized = normalizeThreshold(value);
          const presetLabels = new Set(Object.keys(THRESHOLD_PRESETS));
          const isCustom = normalized.mode === 'tokens' && !presetLabels.has(normalized.label);
          const patch = { threshold: normalized.label };
          if (isCustom) patch.lastCustomThreshold = normalized.label;
          persist(patch, cwd);
          return { kind: 'success', text: `绝对压缩阈值已设为 ${normalized.label}。当前进程立即生效，并已持久化到 ${resolveDshHome()}/.dsh-compaction-fidelity/state.json。` };
        }
        case 'retain': {
          if (rest.length === 0) return { kind: 'error', text: '用法：/compaction-fidelity retain 65536（保留最近 N token 原文）' };
          const value = rest.join(' ');
          const tokens = parseTokenCount(value);
          const state = getGlobalState() ?? {};
          let thresholdInfo;
          try { thresholdInfo = normalizeThreshold(state.threshold ?? cfg.defaultThreshold ?? '350k'); }
          catch { thresholdInfo = normalizeThreshold('350k'); }
          if (tokens >= thresholdInfo.tokens) return { kind: 'error', text: `retainTokens 必须小于当前阈值 ${thresholdInfo.tokens} tokens。` };
          persist({ retainTokens: tokens }, cwd);
          return { kind: 'success', text: `压缩时保留的最近原文预算已设为 ${tokens} tokens。` };
        }
        case 'language': {
          const value = (rest[0] ?? '').toLowerCase();
          if (!SUMMARY_LANGUAGES.has(value)) return { kind: 'error', text: '用法：/compaction-fidelity language auto | zh | en | bilingual' };
          persist({ summaryLanguage: value }, cwd);
          return { kind: 'success', text: `摘要语言已设为 ${value}。auto=跟随会话语言，en=英文记要但原样保留用户原话，bilingual=英文结构+中文补充。` };
        }
        case 'calibration': {
          const action = (rest[0] ?? 'summary').toLowerCase();
          if (action === 'summary') {
            const store = readFidelityCalibration(cwd, cfg.indexDir);
            const groups = summarizeFidelityCalibration(store.samples);
            return { kind: 'success', text: commandTextList([
              `校准样本：${store.samples.length}（每组至少 8 条才显示校准分级；门控始终使用确定性 L0-L3）`,
              ...groups.map((group) => `${group.key}: n=${group.count}, improved=${group.improved}, ${group.calibrated ? 'calibrated' : 'insufficient'}, p25=${group.thresholds.p25}, p50=${group.thresholds.p50}, p75=${group.thresholds.p75}`),
            ]) };
          }
          if (action === 'import') {
            const source = rest.slice(1).join(' ');
            if (source.length === 0) return { kind: 'error', text: '用法：/compaction-fidelity calibration import <工作区内相对路径.json>' };
            const result = importFidelityCalibration(cwd, cfg.indexDir, source);
            return { kind: 'success', text: `校准导入完成：新增=${result.added}，重复=${result.duplicates}，当前保留=${result.retained}。` };
          }
          return { kind: 'error', text: '用法：/compaction-fidelity calibration summary | import <工作区内相对路径.json>' };
        }
        case 'init':
        case 'reindex': {
          const index = buildIndex(cwd, indexOptions);
          return { kind: 'success', text: `Compaction-Fidelity 索引已重建：${index.stats.files} 文件，架构锚点 ${index.archFiles.length} 个，目录 ${cwd}/${cfg.indexDir}。` };
        }
        case 'verify': {
          const result = verifyIndex(cwd, cfg.indexDir);
          if (result.ok) return { kind: 'success', text: `Compaction-Fidelity 索引与基线一致（${result.indexed} 文件，生成于 ${result.generatedAt}）。` };
          return { kind: 'success', text: commandTextList([
            `Compaction-Fidelity 索引需要刷新：changed=${result.changed?.length ?? 0}, missing=${result.missing?.length ?? 0}`,
            ...(result.changed ?? []).slice(0, 20).map((file) => `- changed: ${file}`),
            ...(result.missing ?? []).slice(0, 20).map((file) => `- missing: ${file}`),
          ]) };
        }
        case 'brief': {
          ensureIndex(cwd, indexOptions);
          const brief = briefForRoot(cwd, cfg.indexDir);
          return brief === null ? { kind: 'error', text: '索引不存在，请先运行 /compaction-fidelity init。' } : { kind: 'success', text: brief };
        }
        case 'anchors': {
          const file = rest[0];
          if (file === undefined) return { kind: 'error', text: '用法：/compaction-fidelity anchors <workspace-relative-file>' };
          const anchors = anchorsForFile(cwd, cfg.indexDir, file, 12);
          if (anchors === null) return { kind: 'error', text: `索引不存在或文件未索引：${file}。先运行 /compaction-fidelity reindex。` };
          return { kind: 'success', text: commandTextList([`Compaction-Fidelity anchors for ${file}:`, ...anchors.map((anchor) => `- [${anchor.kind}] ${anchor.path} — ${anchor.reason}`)]) };
        }
        case 'lookup': {
          const query = rest.join(' ');
          if (query.length === 0) return { kind: 'error', text: '用法：/compaction-fidelity lookup <path-or-keyword>' };
          const index = ensureIndex(cwd, indexOptions);
          const results = searchIndex(index, query, 12);
          return { kind: 'success', text: commandTextList([`Compaction-Fidelity lookup "${query}":`, ...results.map((entry) => entry.path.length > 0 ? `- [${entry.kind}] ${entry.path} — ${entry.why}` : `- command: ${entry.why}`)]) };
        }
        case 'architecture':
        case 'arch': {
          if (cfg.architectureDoc === false) return { kind: 'error', text: '架构文档功能已在配置中禁用。' };
          const action = (rest[0] ?? 'check').toLowerCase();
          const scope = rest[1] ?? '.';
          try {
            const target = resolveArchitectureDoc(cwd, scope, cfg.architectureDocName);
            if (action === 'check') {
              if (!existsSync(target.absolute)) return { kind: 'success', text: '不存在：' + target.relative };
              const doc = readArchitectureDoc(cwd, scope, cfg.architectureDocName);
              const stat = statSync(target.absolute);
              const change = detectSemanticChanges(cwd, scope, { indexDir: cfg.indexDir, docName: cfg.architectureDocName, singleFileChangeThreshold: cfg.architectureSingleFileChangeThreshold, maxFiles: cfg.maxFiles, sinceMs: stat.mtimeMs - 1000, filterFile: architectureManagedFilter(cwd, scope) ?? undefined });
              const verification = verifyArchitectureDoc(doc === null ? '' : doc.text);
              const aligned = !change.forced && change.score < cfg.architectureRefreshThreshold;
              return { kind: 'success', text: '已存在：' + target.relative + '；对齐=' + (aligned ? 'aligned' : 'stale') + '；变化分=' + change.score + '；检测=' + change.method + '；attestation=' + (verification.attestation === null ? 'missing' : verification.attestation.revision) + '；consistent=' + verification.ok };
            }
            const patterns = rest.slice(2).join(' ').split(/[,\s]+/).map((item) => item.trim()).filter((item) => item.length > 0);
            if (action === 'manage') {
              const rules = architectureScopeRules(cwd, scope);
              return { kind: 'success', text: rules === null ? 'scope 未受管：' + scope : 'scope=' + scope + '；include=' + JSON.stringify(rules.include ?? []) + '；exclude=' + JSON.stringify(rules.exclude ?? []) };
            }
            if (action === 'include' || action === 'exclude' || action === 'unmanage') {
              if ((action === 'include' || action === 'exclude') && patterns.some((pattern) => !isValidScopePattern(pattern))) return { kind: 'error', text: '无效的 scope pattern。' };
              if (action !== 'unmanage' && patterns.length === 0) return { kind: 'error', text: '用法：/compaction-fidelity architecture ' + action + ' <scope> <pattern>' };
              let rules = null;
              if (action === 'unmanage' && patterns.length === 0) {
                removeArchitectureScope(cwd, cfg.indexDir, scope);
              } else {
                updateArchitectureScopeRules(cwd, cfg.indexDir, scope, { include: action === 'include' ? patterns : [], exclude: action === 'exclude' ? patterns : [], removeInclude: action === 'unmanage' ? patterns : [], removeExclude: action === 'unmanage' ? patterns : [] });
                rules = architectureScopeRules(cwd, scope);
                if (existsSync(target.absolute)) refreshArchitectureDocument(cwd, scope);
                rememberArchitectureScope(invocation.agent, scope);
              }
              return { kind: 'success', text: action + '：scope=' + scope + '；include=' + JSON.stringify(rules?.include ?? []) + '；exclude=' + JSON.stringify(rules?.exclude ?? []) };
            }
            if (action === 'read') {
              const doc = readArchitectureDoc(cwd, scope, cfg.architectureDocName);
              return doc === null
                ? { kind: 'error', text: `不存在：${target.relative}` }
                : { kind: 'success', text: clampText(doc.text, 8000) };
            }
            if (action === 'create') {
              const created = createArchitectureDocument(cwd, scope);
              rememberArchitectureScope(invocation.agent, scope);
              return { kind: 'success', text: created.created ? `已创建：${created.target.relative}` : `已存在：${created.target.relative}` };
            }
            if (action === 'status') {
              const doc = readArchitectureDoc(cwd, scope, cfg.architectureDocName);
              if (doc === null) return { kind: 'error', text: `不存在：${target.relative}` };
              const stat = statSync(target.absolute);
              const change = detectSemanticChanges(cwd, scope, { indexDir: cfg.indexDir, docName: cfg.architectureDocName, singleFileChangeThreshold: cfg.architectureSingleFileChangeThreshold, maxFiles: cfg.maxFiles, sinceMs: stat.mtimeMs - 1000, filterFile: architectureManagedFilter(cwd, scope) ?? undefined });
              const docVerification = verifyArchitectureDoc(doc.text);
              const aligned = !change.forced && change.score < cfg.architectureRefreshThreshold;
              return { kind: 'success', text: `对齐状态：${aligned ? "aligned" : "stale"}；变化分=${change.score}；检测=${change.method}；强制=${change.forced}；阈值=${cfg.architectureRefreshThreshold}；更新时间=${new Date(stat.mtimeMs).toISOString()}；路径=${target.relative}；attestation=${docVerification.attestation === null ? "missing" : docVerification.attestation.revision}；consistent=${docVerification.ok}；entries=${docVerification.entryCount}` };
            }
            if (action === 'verify') {
              const doc = readArchitectureDoc(cwd, scope, cfg.architectureDocName);
              if (doc === null) return { kind: 'error', text: '不存在：' + target.relative };
              const verification = verifyArchitectureDoc(doc.text);
              return { kind: 'success', text: 'verify：' + (verification.ok ? 'ok' : 'failed') + '；entries=' + verification.entryCount + '；structureHash=' + verification.structureHash + '；updateLogHash=' + verification.updateLogHash + '；errors=' + verification.errors.join(' | ') };
            }
            if (action === 'refresh') {
              const refreshed = refreshArchitectureDocument(cwd, scope);
              rememberArchitectureScope(invocation.agent, scope);
              return { kind: 'success', text: `已刷新结构：${refreshed.target.relative}` };
            }
            if (action === 'update') {
              const doc = readArchitectureDoc(cwd, scope, cfg.architectureDocName);
              if (doc === null) return { kind: 'error', text: `不存在：${target.relative}` };
              const summary = rest.slice(2).join(' ').trim();
              if (summary.length === 0) return { kind: 'error', text: '用法：/compaction-fidelity architecture update <scope> <summary>' };
              const mutation = mutateArchitectureDocument(target.absolute, (current) => {
                if (current === null) return null;
                const next = appendArchitectureUpdate(current, { scope, summary, changedFiles: [] });
                const validation = verifyArchitectureDoc(next);
                if (!validation.ok) throw new Error('架构文档校验失败：' + validation.errors.join('; '));
                return next;
              });
              if (!mutation.changed) return { kind: 'error', text: `不存在：${target.relative}` };
              if (mutation.changed) updateArchitectureBaseline(cwd, scope);
              rememberArchitectureScope(invocation.agent, scope);
              return { kind: 'success', text: `已追加更新：${target.relative}` };
            }
            return { kind: 'error', text: '用法：/compaction-fidelity architecture check | read | create | refresh | status | verify | update | include | exclude | manage | unmanage <scope> [summary|pattern]' };
          } catch (error) {
            return { kind: 'error', text: `架构文档命令失败：${error instanceof Error ? error.message : String(error)}` };
          }
        }
        case 'purge': {
          if (!rest.includes('--yes')) return { kind: 'error', text: `这会删除 ${cwd}/${cfg.indexDir}。确认后运行 /compaction-fidelity purge --yes` };
          if (!isSafeRelativePath(cfg.indexDir)) return { kind: 'error', text: 'indexDir 不安全，拒绝删除。' };
          const target = resolve(cwd, cfg.indexDir);
          const rel = normalizeRelPath(cwd, target);
          if (rel.length === 0 || rel.startsWith('..')) return { kind: 'error', text: '目标不在工作区内，拒绝删除。' };
          if (existsSync(target) && lstatSync(target).isSymbolicLink()) return { kind: 'error', text: '目标是符号链接，拒绝删除。' };
          if (existsSync(target)) rmSync(target, { recursive: true, force: true });
          return { kind: 'success', text: `已删除 ${target}。` };
        }
        case 'help':
        default:
          return { kind: 'success', text: helpText() };
      }
    } catch (error) {
      return { kind: 'error', text: `Compaction-Fidelity 命令失败：${error instanceof Error ? error.message : String(error)}` };
    }
  };

  function statusText(cwd, agent) {
    const state = getGlobalState() ?? {};
    const sessionPreset = agent?.session?.header?.agentPreset ?? 'unknown';
    let index = null;
    try {
      index = loadIndex(cwd, cfg.indexDir);
    } catch {
      index = null;
    }
    return commandTextList([
      'Compaction-Fidelity 压缩插件状态',
      `- 总开关：${state.enabled === false ? 'off（DSH 官方压缩回退）' : 'on'}`,
      `- 绝对阈值：${state.threshold ?? cfg.defaultThreshold ?? '350k'}（插件默认 350k；256k/350k/512k/800k 为绝对线；800k 为官方默认，在 1M 窗口自动回退官方 80% 线；full/1m=官方动态线）`,
      `- 最近原文保留：${state.retainTokens ?? 'engine preset default'} tokens`,
      `- 摘要语言：${state.summaryLanguage ?? 'engine preset default'}`,
      `- 摘要输出上限：${state.summaryMaxTokens ?? 'engine preset default'} tokens`,
      `- 工作区：${cwd}`,
      `- Compaction-Fidelity 索引：${index === null ? '未建立（运行 /compaction-fidelity init）' : `${index.stats.files} 文件，生成于 ${index.generatedAt}`}`,
      `- 索引目录：${cwd}/${cfg.indexDir}`,
      `- 当前会话 preset：${sessionPreset}（已有会话保持启动时组合；修改 preset/插件后请新建会话）`,
      `- 预设：bundle patch 已覆盖内置 standard/cordis/ptc/minimal；插件启用时使用 Compaction-Fidelity engine，停用时保留官方 compaction 安全网`,
      '- 工具：compaction-fidelity-brief, compaction-fidelity-lookup, compaction-fidelity-architecture',
      '- 示例：/compaction-fidelity threshold 512k | /compaction-fidelity off | /compaction-fidelity reindex | /compaction-fidelity anchors src/index.ts',
    ]);
  }

  function helpText() {
    return commandTextList([
      'Compaction-Fidelity 压缩插件命令',
      '- /compaction-fidelity status',
      '- /compaction-fidelity on | off',
      '- /compaction-fidelity threshold 256k | 350k | 512k | 800k | <K 数值>',
      '- /compaction-fidelity retain <tokens>',
      '- /compaction-fidelity language auto | zh | en | bilingual',
      '- /compaction-fidelity calibration summary | import <workspace-relative-file.json>',
      '- /compaction-fidelity init | reindex',
      '- /compaction-fidelity verify',
      '- /compaction-fidelity brief',
      '- /compaction-fidelity anchors <file>',
      '- /compaction-fidelity lookup <query>',
      '- /compaction-fidelity architecture check | read | create | refresh | status | verify | update | include | exclude | manage | unmanage [scope] [summary|pattern]',
      '- /compaction-fidelity purge --yes',
      '模型工具：compaction-fidelity-brief, compaction-fidelity-lookup, compaction-fidelity-architecture',
    ]);
  }

  ctx.effect(function* lifecycle() {
    yield () => {
      recentFiles.clear();
      queuedIndexes.clear();
    };
    const commandDefinitions = [
      {
        definitionId: CommandDefinitionId(TOOL_ID),
        name: 'compaction-fidelity',
        description: 'dsh-compaction-fidelity 控制台：动态压缩线 + Compaction-Fidelity 项目认知锚点',
        handler,
      },
    ];
    for (const definition of commandDefinitions) {
      try {
        const disposer = ctx.commands.register(definition);
        if (typeof disposer === 'function') yield disposer;
      } catch (error) {
        ctx.logger?.warn?.(`dsh-compaction-fidelity: command /${definition.name} registration failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const toolDisposers = [ctx.tools.register(briefTool), ctx.tools.register(lookupTool), ctx.tools.register(architectureTool)];
    for (const disposer of toolDisposers) if (typeof disposer === 'function') yield disposer;

    ctx.on('tools/result', (exec, result) => {
      if (!cfg.anchorInjection) return;
      const rel = modifiedFilePath(exec, result);
      if (rel === null) return;
      const key = sessionIdOf(exec.agent);
      const set = recentFiles.get(key) ?? new Set();
      if (!set.has(rel) && set.size >= MAX_SESSION_FILES) {
        const oldest = set.values().next().value;
        if (oldest !== undefined) set.delete(oldest);
      }
      set.add(rel);
      recentFiles.set(key, set);
    });

    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      queueIndex(workspaceOf(agent));
      const decision = await next();
      if (cfg.architectureDoc && getGlobalState()?.enabled !== false && !isMasterDisabled()) {
        const askedCwd = workspaceOf(agent);
        const last = lastUserText(decision?.messages ?? []);
        const askedSession = String(agent?.session?.id ?? "session");
        if (askedCwd && last.length > 0) {
          const pending = architecturePending.get(askedSession);
          if (pending !== undefined) {
            const normalized = last.trim().toLowerCase();
            const declined = /^(不|不用|不需要|跳过|取消|no|skip|cancel)[。.!！?？\s]*$/.test(normalized);
            const consented = /^(创建|创建吧|可以|可以创建|好的|好|同意|确认|是|是的|yes|y|ok|okay|create|do it|go ahead)[。.!！?？\s]*$/.test(normalized);
            let chosen = null;
            if (pending.kind === "choose") {
              chosen = pending.candidates.find((item) => {
                const rel = item.relativeDir.toLowerCase();
                const base = rel.split("/").pop();
                return normalized.includes(rel) || (base !== undefined && normalized.includes(base));
              }) ?? null;
            }
            if (declined) {
              architectureAsked.add(pending.key);
              architecturePending.delete(askedSession);
            } else if ((pending.kind === "create" && consented) || chosen !== null) {
              const scope = pending.kind === "create" ? pending.scope : chosen.relativeDir;
              try {
                const created = createArchitectureDocument(askedCwd, scope);
                rememberArchitectureScope(agent, scope);
                architectureAsked.add(pending.key);
                architecturePending.delete(askedSession);
                const notice = created.created
                  ? "[Compaction-Fidelity] 已创建 " + created.target.relative + "。"
                  : "[Compaction-Fidelity] 已存在 " + created.target.relative + "。";
                const message = createUserMessage({ content: [{ type: "text", text: notice }], source: PRODUCER_SOURCE });
                return { ...decision, messages: [...(decision?.messages ?? []), message] };
              } catch (error) {
                ctx.logger?.warn?.("compaction-fidelity architecture create failed: " + (error instanceof Error ? error.message : String(error)));
              }
            }
          }
          const detection = detectTaskFolders([{ role: "user", content: [{ type: "text", text: last }] }], askedCwd, { docName: cfg.architectureDocName });
          const candidates = detection?.candidates ?? [];
          if (candidates.length > 0) {
            const choice = detection.ambiguous ? candidates.slice(0, 5) : [detection.primary];
            const key = askedSession + "|" + choice.map((item) => item.relativeDir).join("|");
            if (!architectureAsked.has(key)) {
              let text = "";
              if (detection.ambiguous) {
                text = "[Compaction-Fidelity] 检测到多个候选任务文件夹：" + choice.map((item) => item.relativeDir).join(" / ") + "。请先向用户确认主项目文件夹，再调用 compaction-fidelity-architecture 创建 " + cfg.architectureDocName + "。";
              } else {
                const target = detection.primary;
                const doc = resolveArchitectureDoc(askedCwd, target.relativeDir, cfg.architectureDocName);
                if (!existsSync(doc.absolute)) text = "[Compaction-Fidelity] 请先向用户确认：是否在 " + target.relativeDir + " 文件夹下创建 " + cfg.architectureDocName + " 用于记录项目架构和长期压缩工作细节上下文有损压缩后回查（该文件思路源于AOCI，建议在大型多处耦合项目或预计将执行多次修改时启用，有本次询问是因为你启用了dsh-compaction-fidelity）";
              }
                rememberArchitectureScope(agent, target.relativeDir);
              if (text.length > 0) {
                architectureAsked.add(key);
                if (architectureAsked.size > 500) {
                  const oldest = architectureAsked.values().next().value;
                  if (oldest !== undefined) architectureAsked.delete(oldest);
                }
                if (!architecturePending.has(askedSession) && architecturePending.size >= MAX_ARCHITECTURE_SESSIONS) {
                  const oldest = architecturePending.keys().next().value;
                  if (oldest !== undefined) architecturePending.delete(oldest);
                }
                architecturePending.set(askedSession, detection.ambiguous
                  ? { kind: "choose", candidates: choice, key }
                  : { kind: "create", scope: detection.primary.relativeDir, key });
                const message = createUserMessage({ content: [{ type: "text", text }], source: PRODUCER_SOURCE });
                return { ...decision, messages: [...(decision?.messages ?? []), message] };
              }
            }
          }
          const knownScopes = new Set(listArchitectureScopes(askedCwd));
          architectureScopes.set(askedSession, knownScopes);
          if (knownScopes.size > 0) {
            for (const scope of knownScopes) {
              const doc = resolveArchitectureDoc(askedCwd, scope, cfg.architectureDocName);
              if (!existsSync(doc.absolute)) continue;
              let docStat;
              try {
                docStat = statSync(doc.absolute);
              } catch {
                continue;
              }
              const change = cachedArchitectureChange(askedCwd, scope, { indexDir: cfg.indexDir, docName: cfg.architectureDocName, singleFileChangeThreshold: cfg.architectureSingleFileChangeThreshold, maxFiles: cfg.maxFiles, sinceMs: docStat.mtimeMs - 1000, filterFile: architectureManagedFilter(askedCwd, scope) ?? undefined });
              if (!change.forced && change.score < cfg.architectureRefreshThreshold) continue;
              const now = Date.now();
              const reminderKey = architectureReminderKey(askedCwd, scope, docStat.mtimeMs);
              let reminder = null;
              mutateReminderState(askedCwd, cfg.indexDir, (store) => {
                const entry = store.entries[reminderKey];
                const decisionForEntry = reminderDecision(entry, now);
                reminder = decisionForEntry;
                if (decisionForEntry.action !== "inject") return null;
                store.entries[reminderKey] = recordReminder(entry, now);
                pruneReminderState(store, now);
                return store;
              });
              if (reminder === null || reminder.action !== "inject") continue;
              const stageText = reminder.stage > 1 ? "，提醒阶段=" + reminder.stage : "";
              const text = "[Compaction-Fidelity] ARCHITECTURE.md 对齐检查（semantic_threshold）：scope=" + scope + "，语义变化分=" + change.score + "，检测方式=" + change.method + (change.forced ? "，单文件大变更强制触发" : "") + "，阈值=" + cfg.architectureRefreshThreshold + stageText + "。请在当前阶段完成后调用 compaction-fidelity-architecture action=refresh scope=" + scope + "，或执行 /compaction-fidelity architecture refresh " + scope + "。";
              const message = createUserMessage({ content: [{ type: "text", text }], source: PRODUCER_SOURCE });
              return { ...decision, messages: [...(decision?.messages ?? []), message] };
            }
          }
        }
      }
      if (!cfg.anchorInjection || signal?.aborted || decision?.kind === 'reject') return decision;
      if (getGlobalState()?.enabled === false || isMasterDisabled()) return decision;
      const key = sessionIdOf(agent);
      const pending = recentFiles.get(key);
      if (pending === undefined || pending.size === 0) return decision;
      const cwd = workspaceOf(agent);
      try {
        const index = loadIndex(cwd, cfg.indexDir);
        if (index === null) {
          queueIndex(cwd);
          return decision;
        }
        const files = [...pending].slice(0, 6);
        const lines = [];
        for (const file of files) {
          const anchors = anchorsForFile(cwd, cfg.indexDir, file, cfg.anchorsPerFile) ?? [];
          if (anchors.length === 0) continue;
          lines.push(`- ${file} → ${anchors.map((anchor) => `${anchor.id ? `[${anchor.id}] ` : ''}${anchor.canonical ?? anchor.path} (${anchor.kind}${Number.isFinite(anchor.quality) ? ", q" + anchor.quality : ""}: ${anchor.reason})`).join('; ')}`);
        }
        pending.clear();
        if (lines.length === 0) return decision;
        updateAnchorsForFiles(cwd, cfg.indexDir, files, { anchorsPerFile: cfg.anchorsPerFile });
        const text = clampText(commandTextList([
          '[Compaction-Fidelity 回查锚点 / retrieval anchors]',
          'Recently modified files and their architecture-level anchors:',
          ...lines,
          `Full map: ${cfg.indexDir}/anchors.md. Use compaction-fidelity-lookup(file="...") or compaction-fidelity-brief for exact retrieval after context loss.`,
        ]), 4000);
        const message = createUserMessage({
          content: [{ type: 'text', text }],
          source: PRODUCER_SOURCE,
        });
        return { ...decision, messages: [...decision.messages, message] };
      } catch (error) {
        pending.clear();
        ctx.logger?.warn?.(`dsh-compaction-fidelity anchor injection failed: ${error instanceof Error ? error.message : String(error)}`);
        return decision;
      }
    });

    ctx.logger?.info?.('dsh-compaction-fidelity: enabled (absolute threshold compaction + Compaction-Fidelity anchors)');
  }, 'compaction-fidelity lifecycle');
}

export default { name, inject, apply };


























