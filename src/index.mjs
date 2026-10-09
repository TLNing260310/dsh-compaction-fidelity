import { existsSync, statSync } from 'node:fs';
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
  purgeIndex,
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
import { appendArchitectureUpdate, detectTaskFolders, lastUserText, preserveArchitectureUpdateLog, readManagedArchitectureDoc, renderArchitectureDoc, resolveArchitectureDoc, verifyArchitectureDoc } from './architecture-doc.mjs';

import { mutateArchitectureDocument } from './architecture-io.mjs';
import { computeArchitectureBaseline, detectSemanticChanges, writeArchitectureBaseline } from './architecture-changes.mjs';
export const name = PLUGIN_NAME;
import { architectureReminderKey, mutateReminderState, pruneReminderState, recordReminder, reminderDecision } from './reminder-state.mjs';
import { classifyRegistryWriteError, createGlobalWorkspaceFileFilter, createWorkspaceFileFilter, isValidScopePattern, managedDocOutcomeFor, managedScopeRules, readArchitectureRegistry, registryFingerprint, rememberArchitectureScope as rememberScopeInRegistry, removeArchitectureScope, retrievalPolicyFor, updateArchitectureScopeRules } from './architecture-registry.mjs';
import { preStepStopped, readArchitectureConsent } from './step-policy.mjs';
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
  /**
   * Read policy shared by every retrieval entry point. A registry that cannot
   * be honored blocks retrieval instead of falling back to unfiltered defaults,
   * and a cached artifact built under different rules is never served: the
   * rules may have been tightened since it was written.
   */
  const retrievalContext = (cwd) => {
    const policy = retrievalPolicyFor(cwd, cfg.indexDir);
    return {
      blocked: policy.blocked,
      policy,
      options: {
        ...indexOptions,
        filterFile: policy.filterFile,
        scopeFingerprint: policy.fingerprint,
        expectedFingerprint: policy.fingerprint,
      },
    };
  };
  const RETRIEVAL_BLOCKED = 'Compaction-Fidelity retrieval is blocked because the managed scope registry cannot be read. Repair or remove '
    + cfg.indexDir + '/architecture-scopes.json, then run /compaction-fidelity reindex.';
  const recentFiles = new Map();
  const MAX_SESSION_FILES = 64;
  const MAX_SESSION_MAPS = 200;
  const setBoundedMap = (map, key, value, max) => {
    if (!map.has(key) && map.size >= max) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, value);
    return value;
  };
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
  const managedDocDeps = (cwd) => ({
    cwd,
    indexDir: cfg.indexDir,
    fallbackDoc: cfg.architectureDocName,
    loadRegistry: () => readArchitectureRegistry(cwd, cfg.indexDir),
  });
  // Fail-closed policy gate: outcome-layer refusals carry target: null, so no
  // caller below can resolve a path or fall back to the default document name.
  const architectureDocAccess = (cwd, scope) => managedDocOutcomeFor(scope, managedDocDeps(cwd));
  const readManagedDoc = (cwd, scope) => readManagedArchitectureDoc(scope, managedDocDeps(cwd));
  const architecturePathReason = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/symlink/i.test(message)) return "symlink";
    if (/not a safe|not safe|unsafe/i.test(message)) return "unsafe-path";
    return "unreadable";
  };
  const ARCHITECTURE_REFUSAL_TEXT = {
    "denied-scope": { en: "denied: this scope is excluded from managed architecture retrieval", zh: "该 scope 已被排除，无法访问架构文档" },
    "denied-ancestor": { en: "denied: an ancestor scope is excluded from managed architecture retrieval", zh: "该 scope 的上级目录已被排除，无法访问架构文档" },
    "corrupt-registry": { en: "refused: the architecture rule registry is corrupt; repair or restore it", zh: "架构规则文件损坏，无法判断权限；请检查或恢复 registry" },
    "invalid-scope": { en: "refused: scope is not a safe workspace-relative path", zh: "scope 格式无效" },
    "unsafe-path": { en: "refused: path safety check failed", zh: "路径安全检查未通过" },
    "symlink": { en: "refused: path safety check failed", zh: "路径安全检查未通过" },
    "too-large": { en: "refused: document exceeds the size limit", zh: "文档超过大小限制" },
    "unreadable": { en: "refused: document could not be read", zh: "文档无法读取" },
  };
  const architectureRefusalText = (reason, lang) => {
    const entry = ARCHITECTURE_REFUSAL_TEXT[reason];
    if (entry === undefined) return lang === "zh" ? "架构文档访问失败" : "architecture document access failed";
    return entry[lang];
  };
  const architectureFailureText = (failure, lang) => {
    const reason = failure?.reason ?? "unreadable";
    if (reason === "missing") {
      return (lang === "zh" ? "不存在：" : "missing: ") + String(failure?.target?.relative ?? "?");
    }
    return architectureRefusalText(reason, lang) + (failure?.target?.relative ? " (" + failure.target.relative + ")" : "");
  };
  const registryWriteReasonText = (reason, lang) => {
    const text = {
      "registry-write-failed": { en: "registry write failed", zh: "架构规则写入失败" },
      "registry-cas-conflict": { en: "registry changed concurrently; retry", zh: "架构规则已被其他操作修改，请重试" },
      "registry-locked": { en: "registry is locked by another operation; retry later", zh: "架构规则正在被其他操作占用，请稍后重试" },
      "corrupt-registry": { en: "registry is corrupt; repair or restore it", zh: "架构规则文件损坏；请检查或恢复 registry" },
    };
    return (text[reason] ?? text["registry-write-failed"])[lang];
  };

  const createArchitectureDocument = (cwd, scope) => {
    // Policy first: a refused scope must not check the parent directory, build
    // an index, write a document, write a baseline, or register anything.
    const access = architectureDocAccess(cwd, scope);
    if (access.ok !== true) {
      return { ok: false, reason: access.reason, created: false, target: null, baselineWritten: false, baselineReason: null };
    }
    let target;
    try {
      target = resolveArchitectureDoc(cwd, access.target.scope, access.target.docName);
    } catch (error) {
      return { ok: false, reason: architecturePathReason(error), created: false, target: null, baselineWritten: false, baselineReason: null };
    }
    const parentDir = join(target.absolute, "..");
    if (!existsSync(parentDir) || !statSync(parentDir).isDirectory()) throw new Error("scope folder does not exist: " + scope);
    // Re-check immediately before the mutation: consent may have been given
    // before the registry changed.
    const recheck = architectureDocAccess(cwd, scope);
    if (recheck.ok !== true) {
      return { ok: false, reason: recheck.reason, created: false, target: null, baselineWritten: false, baselineReason: null };
    }
    const docName = recheck.target.docName;
    const mutation = mutateArchitectureDocument(target.absolute, (current) => {
      if (current !== null) return null;
      const index = buildArchitectureIndex(cwd, scope);
      return renderArchitectureDoc({ scope, docName, index });
    });
    const baseline = mutation.changed ? updateArchitectureBaseline(cwd, scope) : { written: false, reason: null };
    return { ok: true, reason: null, created: mutation.changed, target, baselineWritten: baseline.written, baselineReason: baseline.reason };
  };
  const buildArchitectureIndex = (cwd, scope, { refresh = false } = {}) => {
    const normalizedScope = toPosix(String(scope ?? ".")).replace(/\/+$/, "");
    const registry = readArchitectureRegistry(cwd, cfg.indexDir);
    // The workspace index spans every sub-folder, so a rule registered for one
    // sub-scope must also constrain root-level retrieval.
    const workspaceFilter = createGlobalWorkspaceFileFilter(registry);
    const fingerprint = registryFingerprint(registry);
    if (normalizedScope.length === 0 || normalizedScope === ".") {
      const options = { ...indexOptions, filterFile: workspaceFilter, scopeFingerprint: fingerprint, expectedFingerprint: fingerprint };
      return refresh ? buildIndex(cwd, options) : ensureIndex(cwd, options);
    }
    // walkWorkspace reports paths relative to the scope root, so compare the
    // workspace-relative form when applying managed rules.
    const filterFile = (relativeFile) => workspaceFilter(`${normalizedScope}/${relativeFile}`);
    return buildIndex(join(cwd, normalizedScope), { ...indexOptions, write: false, filterFile });
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
    const access = architectureDocAccess(cwd, scope);
    if (access.ok !== true) {
      return { ok: false, reason: access.reason, target: null, mutationApplied: false, refreshed: false, baselineWritten: false, baselineReason: null };
    }
    let target;
    try {
      target = resolveArchitectureDoc(cwd, access.target.scope, access.target.docName);
    } catch (error) {
      return { ok: false, reason: architecturePathReason(error), target: null, mutationApplied: false, refreshed: false, baselineWritten: false, baselineReason: null };
    }
    const index = buildArchitectureIndex(cwd, scope, { refresh: true });
    // Re-check right before the mutation: writing with a target resolved under
    // an older registry would resurrect a document the current rules deny.
    const recheck = architectureDocAccess(cwd, scope);
    if (recheck.ok !== true) {
      return { ok: false, reason: recheck.reason, target: null, mutationApplied: false, refreshed: false, baselineWritten: false, baselineReason: null };
    }
    const docName = recheck.target.docName;
    let existed = false;
    const mutation = mutateArchitectureDocument(target.absolute, (current) => {
      existed = current !== null;
      const structure = renderArchitectureDoc({
        scope,
        docName,
        index,
      });
      return current === null ? structure : preserveArchitectureUpdateLog(current, structure);
    });
    let baseline = { written: false, reason: null };
    if (mutation.changed) {
      architectureCheckCache.clear();
      baseline = updateArchitectureBaseline(cwd, scope);
    }
    return {
      ok: true,
      reason: null,
      target,
      mutationApplied: mutation.changed,
      refreshed: mutation.changed && existed,
      baselineWritten: baseline.written,
      baselineReason: baseline.reason,
    };
  };
  const updateArchitectureBaseline = (cwd, scope) => {
    // The baseline must not resurrect a denied scope through the default
    // document name: check the policy before computing or writing anything.
    const access = architectureDocAccess(cwd, scope);
    if (access.ok !== true) return { written: false, reason: access.reason };
    try {
      architectureCheckCache.clear();
      const baseline = computeArchitectureBaseline(cwd, scope, {
        indexDir: cfg.indexDir,
        maxFiles: cfg.maxFiles,
        maxFileBytes: cfg.maxFileBytes,
        docName: access.target.docName,
        filterFile: architectureManagedFilter(cwd, scope) ?? undefined,
      });
      writeArchitectureBaseline(cwd, scope, baseline, cfg.indexDir);
      return { written: true, reason: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger?.warn?.("compaction-fidelity architecture baseline failed [" + scope + "]: " + message);
      return { written: false, reason: "baseline-write-failed" };
    }
  };
  let lifecycleDisposed = false;
  const queuedIndexes = new Set();
  const queuedIndexTimers = new Map();
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
    if (lifecycleDisposed) return;
    const master = getGlobalState();
    if (!cfg.autoIndex || master?.enabled === false || isMasterDisabled() || cwd === undefined || cwd === null || queuedIndexes.has(cwd)) return;
    const retrieval = retrievalContext(cwd);
    if (retrieval.blocked) return;
    if (!force) {
      try {
        if (loadIndex(cwd, retrieval.options) !== null) return;
      } catch {
        // fall through and build
      }
    }
    queuedIndexes.add(cwd);
    const timer = setTimeout(() => {
      queuedIndexTimers.delete(cwd);
      try {
        if (lifecycleDisposed || !cfg.autoIndex || getGlobalState()?.enabled === false || isMasterDisabled()) return;
        buildIndex(cwd, retrieval.options);
        ctx.logger?.info?.(`dsh-compaction-fidelity: Compaction-Fidelity index built for ${cwd}`);
      } catch (error) {
        ctx.logger?.warn?.(`dsh-compaction-fidelity: Compaction-Fidelity index build failed for ${cwd}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        queuedIndexes.delete(cwd);
      }
    }, 250);
    timer.unref?.();
    queuedIndexTimers.set(cwd, timer);
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
      const retrieval = retrievalContext(cwd);
      if (retrieval.blocked) return { text: RETRIEVAL_BLOCKED };
      try {
        ensureIndex(cwd, retrieval.options);
        const brief = briefForRoot(cwd, retrieval.options);
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
      const retrieval = retrievalContext(cwd);
      if (retrieval.blocked) return { text: RETRIEVAL_BLOCKED };
      try {
        const index = ensureIndex(cwd, retrieval.options);
        if (typeof args.file === 'string' && args.file.trim().length > 0) {
          const rel = toPosix(args.file.trim());
          const anchors = anchorsForFile(cwd, cfg.indexDir, rel, limit, { expectedFingerprint: retrieval.policy.fingerprint }) ?? [];
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
        const access = architectureDocAccess(cwd, scope);
        if (action === "manage") {
          if (access.reason === "invalid-scope") return { text: "invalid scope: " + scope };
          if (access.reason === "corrupt-registry") return { text: "refused: the architecture rule registry is corrupt; repair or restore it" };
          const rules = architectureScopeRules(cwd, scope);
          return { text: rules === null ? "scope not managed: " + scope : "scope=" + scope + "; include=" + JSON.stringify(rules.include ?? []) + "; exclude=" + JSON.stringify(rules.exclude ?? []) };
        }
        if (action === "include" || action === "exclude" || action === "unmanage") {
          if (access.reason === "invalid-scope") return { text: "invalid scope: " + scope };
          const patterns = String(args.pattern ?? "").split(/[,\s]+/).map((item) => item.trim()).filter((item) => item.length > 0);
          if ((action === "include" || action === "exclude") && patterns.some((pattern) => !isValidScopePattern(pattern))) return { text: "invalid scope pattern" };
          if (action !== "unmanage" && patterns.length === 0) return { text: "action=" + action + " requires pattern." };
          try {
            if (action === "unmanage" && patterns.length === 0) {
              removeArchitectureScope(cwd, cfg.indexDir, scope);
            } else {
              updateArchitectureScopeRules(cwd, cfg.indexDir, scope, { include: action === "include" ? patterns : [], exclude: action === "exclude" ? patterns : [], removeInclude: action === "unmanage" ? patterns : [], removeExclude: action === "unmanage" ? patterns : [] });
            }
          } catch (error) {
            const reason = classifyRegistryWriteError(error);
            return { text: "registry not updated: " + registryWriteReasonText(reason, "en") + "." };
          }
          // Re-read the registry instead of reusing the in-memory result, then
          // decide access and only then touch the document.
          const fresh = architectureDocAccess(cwd, scope);
          const rules = architectureScopeRules(cwd, scope);
          const summary = action + ": scope=" + scope + "; include=" + JSON.stringify(rules?.include ?? []) + "; exclude=" + JSON.stringify(rules?.exclude ?? []);
          if (fresh.ok !== true) return { text: summary + "; document access refused: " + architectureRefusalText(fresh.reason, "en") };
          rememberArchitectureScope(exec.agent, scope);
          const doc = readManagedDoc(cwd, scope);
          if (doc.ok !== true) return { text: summary };
          const refreshed = refreshArchitectureDocument(cwd, scope);
          return { text: summary + (refreshed.ok === true ? "; refreshed" : "; refresh failed: " + architectureRefusalText(refreshed.reason, "en")) };
        }
        if (access.ok !== true) return { text: architectureRefusalText(access.reason, "en") + " (" + scope + ")" };
        const failure = (result) => ({ text: architectureFailureText(result, "en") });
        if (action === "check") {
          const doc = readManagedDoc(cwd, scope);
          if (doc.ok !== true) return failure(doc);
          const stat = statSync(doc.target.absolute);
          const change = detectSemanticChanges(cwd, scope, { indexDir: cfg.indexDir, docName: access.target.docName, singleFileChangeThreshold: cfg.architectureSingleFileChangeThreshold, maxFiles: cfg.maxFiles, sinceMs: stat.mtimeMs - 1000, filterFile: architectureManagedFilter(cwd, scope) ?? undefined });
          const verification = verifyArchitectureDoc(doc.doc.text);
          const aligned = !change.forced && change.score < cfg.architectureRefreshThreshold;
          return { text: "exists: " + doc.target.relative + "; aligned=" + aligned + "; score=" + change.score + "; method=" + change.method + "; attestation=" + (verification.attestation === null ? "missing" : verification.attestation.revision) + "; consistent=" + verification.ok };
        }
        if (action === "read") {
          const doc = readManagedDoc(cwd, scope);
          return doc.ok !== true ? failure(doc) : { text: clampText(doc.doc.text, 8000) };
        }
        if (action === "create") {
          const created = createArchitectureDocument(cwd, scope);
          if (created.ok !== true) return { text: architectureRefusalText(created.reason, "en") + " (" + scope + ")" };
          rememberArchitectureScope(exec.agent, scope);
          return { text: created.created ? "created: " + created.target.relative : "already exists: " + created.target.relative };
        }
        if (action === "refresh") {
          const refreshed = refreshArchitectureDocument(cwd, scope);
          if (refreshed.ok !== true) return { text: architectureRefusalText(refreshed.reason, "en") + " (" + scope + ")" };
          rememberArchitectureScope(exec.agent, scope);
          return { text: "refreshed: " + refreshed.target.relative + (refreshed.baselineWritten === false && refreshed.baselineReason !== null ? "; document updated but the baseline record failed; check the log" : "") };
        }
        if (action === "status") {
          const doc = readManagedDoc(cwd, scope);
          if (doc.ok !== true) return failure(doc);
          const stat = statSync(doc.target.absolute);
          const change = detectSemanticChanges(cwd, scope, { indexDir: cfg.indexDir, docName: access.target.docName, singleFileChangeThreshold: cfg.architectureSingleFileChangeThreshold, maxFiles: cfg.maxFiles, sinceMs: stat.mtimeMs - 1000, filterFile: architectureManagedFilter(cwd, scope) ?? undefined });
          const docVerification = verifyArchitectureDoc(doc.doc.text);
          const aligned = !change.forced && change.score < cfg.architectureRefreshThreshold;
          return { text: "status: " + (aligned ? "aligned" : "stale") + "; score=" + change.score + "; method=" + change.method + "; forced=" + change.forced + "; threshold=" + cfg.architectureRefreshThreshold + "; updatedAt=" + new Date(stat.mtimeMs).toISOString() + "; attestation=" + (docVerification.attestation === null ? "missing" : docVerification.attestation.revision) + "; consistent=" + docVerification.ok + "; entries=" + docVerification.entryCount };
        }
        if (action === "verify") {
          const doc = readManagedDoc(cwd, scope);
          if (doc.ok !== true) return failure(doc);
          const verification = verifyArchitectureDoc(doc.doc.text);
          return { text: "verify: " + (verification.ok ? "ok" : "failed") + "; entries=" + verification.entryCount + "; structureHash=" + verification.structureHash + "; updateLogHash=" + verification.updateLogHash + "; errors=" + verification.errors.join(" | ") };
        }
        if (action === "update") {
          const doc = readManagedDoc(cwd, scope);
          if (doc.ok !== true) return failure(doc);
          const summary = String(args.summary ?? "").trim();
          if (summary.length === 0) return { text: "action=update requires summary." };
          const recheck = architectureDocAccess(cwd, scope);
          if (recheck.ok !== true) return { text: architectureRefusalText(recheck.reason, "en") + " (" + scope + ")" };
          const changedFiles = String(args.changedFiles ?? "").split(",").map((item) => item.trim()).filter((item) => item.length > 0);
          const mutation = mutateArchitectureDocument(doc.target.absolute, (current) => {
            if (current === null) return null;
            const next = appendArchitectureUpdate(current, { scope, summary, changedFiles });
            const validation = verifyArchitectureDoc(next);
            if (!validation.ok) throw new Error("invalid architecture doc: " + validation.errors.join("; "));
            return next;
          });
          if (!mutation.changed) return { text: "missing: " + doc.target.relative };
          const baseline = updateArchitectureBaseline(cwd, scope);
          rememberArchitectureScope(exec.agent, scope);
          return { text: "updated: " + doc.target.relative + (baseline.written === false && baseline.reason !== null ? "; document updated but the baseline record failed; check the log" : "") };
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
          const retrieval = retrievalContext(cwd);
          if (retrieval.blocked) return { kind: 'error', text: RETRIEVAL_BLOCKED };
          const index = buildIndex(cwd, retrieval.options);
          return { kind: 'success', text: `Compaction-Fidelity 索引已重建：${index.stats.files} 文件，架构锚点 ${index.archFiles.length} 个，目录 ${cwd}/${cfg.indexDir}。` };
        }
        case 'verify': {
          const retrieval = retrievalContext(cwd);
          if (retrieval.blocked) return { kind: 'error', text: RETRIEVAL_BLOCKED };
          const result = verifyIndex(cwd, { indexDir: cfg.indexDir, expectedFingerprint: retrieval.policy.fingerprint });
          if (result.ok) return { kind: 'success', text: `Compaction-Fidelity 索引与基线一致（${result.indexed} 文件，生成于 ${result.generatedAt}）。` };
          return { kind: 'success', text: commandTextList([
            `Compaction-Fidelity 索引需要刷新：changed=${result.changed?.length ?? 0}, missing=${result.missing?.length ?? 0}`,
            ...(result.changed ?? []).slice(0, 20).map((file) => `- changed: ${file}`),
            ...(result.missing ?? []).slice(0, 20).map((file) => `- missing: ${file}`),
          ]) };
        }
        case 'brief': {
          const retrieval = retrievalContext(cwd);
          if (retrieval.blocked) return { kind: 'error', text: RETRIEVAL_BLOCKED };
          ensureIndex(cwd, retrieval.options);
          const brief = briefForRoot(cwd, retrieval.options);
          return brief === null ? { kind: 'error', text: '索引不存在，请先运行 /compaction-fidelity init。' } : { kind: 'success', text: brief };
        }
        case 'anchors': {
          const file = rest[0];
          if (file === undefined) return { kind: 'error', text: '用法：/compaction-fidelity anchors <workspace-relative-file>' };
          const retrieval = retrievalContext(cwd);
          if (retrieval.blocked) return { kind: 'error', text: RETRIEVAL_BLOCKED };
          const anchors = anchorsForFile(cwd, cfg.indexDir, file, 12, { expectedFingerprint: retrieval.policy.fingerprint });
          if (anchors === null) return { kind: 'error', text: `索引不存在或文件未索引：${file}。先运行 /compaction-fidelity reindex。` };
          return { kind: 'success', text: commandTextList([`Compaction-Fidelity anchors for ${file}:`, ...anchors.map((anchor) => `- [${anchor.kind}] ${anchor.path} — ${anchor.reason}`)]) };
        }
        case 'lookup': {
          const query = rest.join(' ');
          if (query.length === 0) return { kind: 'error', text: '用法：/compaction-fidelity lookup <path-or-keyword>' };
          const retrieval = retrievalContext(cwd);
          if (retrieval.blocked) return { kind: 'error', text: RETRIEVAL_BLOCKED };
          const index = ensureIndex(cwd, retrieval.options);
          const results = searchIndex(index, query, 12);
          return { kind: 'success', text: commandTextList([`Compaction-Fidelity lookup "${query}":`, ...results.map((entry) => entry.path.length > 0 ? `- [${entry.kind}] ${entry.path} — ${entry.why}` : `- command: ${entry.why}`)]) };
        }
        case 'architecture':
        case 'arch': {
          if (cfg.architectureDoc === false) return { kind: 'error', text: '架构文档功能已在配置中禁用。' };
          const action = (rest[0] ?? 'check').toLowerCase();
          const scope = rest[1] ?? '.';
          try {
            const access = architectureDocAccess(cwd, scope);
            const patterns = rest.slice(2).join(' ').split(/[,\s]+/).map((item) => item.trim()).filter((item) => item.length > 0);
            if (action === 'manage') {
              if (access.reason === 'invalid-scope') return { kind: 'error', text: 'scope 格式无效：' + scope };
              if (access.reason === 'corrupt-registry') return { kind: 'error', text: '架构规则文件损坏，无法判断权限；请检查或恢复 registry。' };
              const rules = architectureScopeRules(cwd, scope);
              return { kind: 'success', text: rules === null ? 'scope 未受管：' + scope : 'scope=' + scope + '；include=' + JSON.stringify(rules.include ?? []) + '；exclude=' + JSON.stringify(rules.exclude ?? []) };
            }
            if (action === 'include' || action === 'exclude' || action === 'unmanage') {
              if (access.reason === 'invalid-scope') return { kind: 'error', text: 'scope 格式无效：' + scope };
              if ((action === 'include' || action === 'exclude') && patterns.some((pattern) => !isValidScopePattern(pattern))) return { kind: 'error', text: '无效的 scope pattern。' };
              if (action !== 'unmanage' && patterns.length === 0) return { kind: 'error', text: '用法：/compaction-fidelity architecture ' + action + ' <scope> <pattern>' };
              try {
                if (action === 'unmanage' && patterns.length === 0) {
                  removeArchitectureScope(cwd, cfg.indexDir, scope);
                } else {
                  updateArchitectureScopeRules(cwd, cfg.indexDir, scope, { include: action === 'include' ? patterns : [], exclude: action === 'exclude' ? patterns : [], removeInclude: action === 'unmanage' ? patterns : [], removeExclude: action === 'unmanage' ? patterns : [] });
                }
              } catch (error) {
                const reason = classifyRegistryWriteError(error);
                return { kind: 'error', text: '架构规则未更新：' + registryWriteReasonText(reason, 'zh') + '。' };
              }
              // Re-read the registry instead of reusing the in-memory result,
              // then decide access and only then touch the document.
              const fresh = architectureDocAccess(cwd, scope);
              const rules = architectureScopeRules(cwd, scope);
              const summary = action + '：scope=' + scope + '；include=' + JSON.stringify(rules?.include ?? []) + '；exclude=' + JSON.stringify(rules?.exclude ?? []);
              if (fresh.ok !== true) {
                return { kind: 'success', text: summary + '；架构文档访问已拒绝：' + architectureRefusalText(fresh.reason, 'zh') + '。' };
              }
              rememberArchitectureScope(invocation.agent, scope);
              const doc = readManagedDoc(cwd, scope);
              if (doc.ok !== true) return { kind: 'success', text: summary };
              const refreshed = refreshArchitectureDocument(cwd, scope);
              return { kind: 'success', text: summary + (refreshed.ok === true ? '；已刷新结构。' : '；刷新失败：' + architectureRefusalText(refreshed.reason, 'zh') + '。') };
            }
            if (access.ok !== true) return { kind: 'error', text: architectureRefusalText(access.reason, 'zh') + '（' + scope + '）' };
            const failure = (result) => ({ kind: 'error', text: architectureFailureText(result, 'zh') });
            if (action === 'check') {
              const doc = readManagedDoc(cwd, scope);
              if (doc.ok !== true) return failure(doc);
              const stat = statSync(doc.target.absolute);
              const change = detectSemanticChanges(cwd, scope, { indexDir: cfg.indexDir, docName: access.target.docName, singleFileChangeThreshold: cfg.architectureSingleFileChangeThreshold, maxFiles: cfg.maxFiles, sinceMs: stat.mtimeMs - 1000, filterFile: architectureManagedFilter(cwd, scope) ?? undefined });
              const verification = verifyArchitectureDoc(doc.doc.text);
              const aligned = !change.forced && change.score < cfg.architectureRefreshThreshold;
              return { kind: 'success', text: '已存在：' + doc.target.relative + '；对齐=' + (aligned ? 'aligned' : 'stale') + '；变化分=' + change.score + '；检测=' + change.method + '；attestation=' + (verification.attestation === null ? 'missing' : verification.attestation.revision) + '；consistent=' + verification.ok };
            }
            if (action === 'read') {
              const doc = readManagedDoc(cwd, scope);
              return doc.ok !== true ? failure(doc) : { kind: 'success', text: clampText(doc.doc.text, 8000) };
            }
            if (action === 'create') {
              const created = createArchitectureDocument(cwd, scope);
              if (created.ok !== true) return { kind: 'error', text: architectureRefusalText(created.reason, 'zh') + '（' + scope + '）' };
              rememberArchitectureScope(invocation.agent, scope);
              return { kind: 'success', text: created.created ? '已创建：' + created.target.relative : '已存在：' + created.target.relative };
            }
            if (action === 'status') {
              const doc = readManagedDoc(cwd, scope);
              if (doc.ok !== true) return failure(doc);
              const stat = statSync(doc.target.absolute);
              const change = detectSemanticChanges(cwd, scope, { indexDir: cfg.indexDir, docName: access.target.docName, singleFileChangeThreshold: cfg.architectureSingleFileChangeThreshold, maxFiles: cfg.maxFiles, sinceMs: stat.mtimeMs - 1000, filterFile: architectureManagedFilter(cwd, scope) ?? undefined });
              const docVerification = verifyArchitectureDoc(doc.doc.text);
              const aligned = !change.forced && change.score < cfg.architectureRefreshThreshold;
              return { kind: 'success', text: '对齐状态：' + (aligned ? "aligned" : "stale") + '；变化分=' + change.score + '；检测=' + change.method + '；强制=' + change.forced + '；阈值=' + cfg.architectureRefreshThreshold + '；更新时间=' + new Date(stat.mtimeMs).toISOString() + '；路径=' + doc.target.relative + '；attestation=' + (docVerification.attestation === null ? "missing" : docVerification.attestation.revision) + '；consistent=' + docVerification.ok + '；entries=' + docVerification.entryCount };
            }
            if (action === 'verify') {
              const doc = readManagedDoc(cwd, scope);
              if (doc.ok !== true) return failure(doc);
              const verification = verifyArchitectureDoc(doc.doc.text);
              return { kind: 'success', text: 'verify：' + (verification.ok ? 'ok' : 'failed') + '；entries=' + verification.entryCount + '；structureHash=' + verification.structureHash + '；updateLogHash=' + verification.updateLogHash + '；errors=' + verification.errors.join(' | ') };
            }
            if (action === 'refresh') {
              const refreshed = refreshArchitectureDocument(cwd, scope);
              if (refreshed.ok !== true) return { kind: 'error', text: architectureRefusalText(refreshed.reason, 'zh') + '（' + scope + '）' };
              rememberArchitectureScope(invocation.agent, scope);
              return { kind: 'success', text: '已刷新结构：' + refreshed.target.relative + (refreshed.baselineWritten === false && refreshed.baselineReason !== null ? '；文档已更新，但基线记录写入失败；请检查日志。' : '') };
            }
            if (action === 'update') {
              const doc = readManagedDoc(cwd, scope);
              if (doc.ok !== true) return failure(doc);
              const summary = rest.slice(2).join(' ').trim();
              if (summary.length === 0) return { kind: 'error', text: '用法：/compaction-fidelity architecture update <scope> <summary>' };
              const recheck = architectureDocAccess(cwd, scope);
              if (recheck.ok !== true) return { kind: 'error', text: architectureRefusalText(recheck.reason, 'zh') + '（' + scope + '）' };
              const mutation = mutateArchitectureDocument(doc.target.absolute, (current) => {
                if (current === null) return null;
                const next = appendArchitectureUpdate(current, { scope, summary, changedFiles: [] });
                const validation = verifyArchitectureDoc(next);
                if (!validation.ok) throw new Error('架构文档校验失败：' + validation.errors.join('; '));
                return next;
              });
              if (!mutation.changed) return { kind: 'error', text: '不存在：' + doc.target.relative };
              const baseline = updateArchitectureBaseline(cwd, scope);
              rememberArchitectureScope(invocation.agent, scope);
              return { kind: 'success', text: '已追加更新：' + doc.target.relative + (baseline.written === false && baseline.reason !== null ? '；文档已更新，但基线记录写入失败；请检查日志。' : '') };
            }
            return { kind: 'error', text: '用法：/compaction-fidelity architecture check | read | create | refresh | status | verify | update | include | exclude | manage | unmanage <scope> [summary|pattern]' };
          } catch (error) {
            return { kind: 'error', text: '架构文档命令失败：' + (error instanceof Error ? error.message : String(error)) };
          }
        }

        case 'purge': {
          if (!rest.includes('--yes')) return { kind: 'error', text: `这会删除 ${cwd}/${cfg.indexDir}。确认后运行 /compaction-fidelity purge --yes` };
          try {
            const target = purgeIndex(cwd, cfg.indexDir);
            return { kind: 'success', text: `已删除 ${target}。` };
          } catch (error) {
            return { kind: 'error', text: `拒绝删除：${error instanceof Error ? error.message : String(error)}` };
          }
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
      lifecycleDisposed = true;
      for (const timer of queuedIndexTimers.values()) clearTimeout(timer);
      queuedIndexTimers.clear();
      recentFiles.clear();
      queuedIndexes.clear();
      architectureScopes.clear();
      architecturePending.clear();
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
      setBoundedMap(recentFiles, key, set, MAX_SESSION_MAPS);
    });

    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      queueIndex(workspaceOf(agent));
      const decision = await next();
      // A cancelled or rejected step must not produce any further side effect:
      // the architecture branch below can create documents, register scopes, and
      // write reminder state.
      if (preStepStopped(signal, decision)) return decision;
      if (cfg.architectureDoc && getGlobalState()?.enabled !== false && !isMasterDisabled()) {
        // Helpers below are best effort: a failure must leave the host decision
        // untouched instead of breaking the agent step.
        try {
          const askedCwd = workspaceOf(agent);
          const last = lastUserText(decision?.messages ?? []);
          const askedSession = String(agent?.session?.id ?? "session");
          if (askedCwd && last.length > 0) {
            const pending = architecturePending.get(askedSession);
            if (pending !== undefined) {
              const outcome = readArchitectureConsent(pending, last);
              if (outcome.action === "decline") {
                architectureAsked.add(pending.key);
                architecturePending.delete(askedSession);
              } else if (outcome.action === "select") {
                // Naming a folder selects it; it does not authorise a write. Move
                // to an explicit create confirmation instead of creating now.
                architecturePending.set(askedSession, { kind: "create", scope: outcome.scope, key: askedSession + "|create|" + outcome.scope });
                const confirmation = createUserMessage({
                  content: [{ type: "text", text: "[Compaction-Fidelity] 已选择 " + outcome.scope + "。请确认是否在该文件夹下创建 " + cfg.architectureDocName + "。" }],
                  source: PRODUCER_SOURCE,
                });
                return { ...decision, messages: [...(decision?.messages ?? []), confirmation] };
              } else if (outcome.action === "create") {
                const scope = outcome.scope;
                if (preStepStopped(signal, decision)) return decision;
                try {
                  const created = createArchitectureDocument(askedCwd, scope);
                  architecturePending.delete(askedSession);
                  if (created.ok !== true) {
                    const refused = "[Compaction-Fidelity] 无法创建 " + scope + " 的架构文档：" + architectureRefusalText(created.reason, "zh") + "。";
                    const message = createUserMessage({ content: [{ type: "text", text: refused }], source: PRODUCER_SOURCE });
                    return { ...decision, messages: [...(decision?.messages ?? []), message] };
                  }
                  rememberArchitectureScope(agent, scope);
                  architectureAsked.add(pending.key);
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
                  const access = architectureDocAccess(askedCwd, target.relativeDir);
                  if (access.ok === true) {
                    const doc = readManagedDoc(askedCwd, target.relativeDir);
                    if (doc.ok !== true && doc.reason === "missing") text = "[Compaction-Fidelity] 请先向用户确认：是否在 " + target.relativeDir + " 文件夹下创建 " + cfg.architectureDocName + " 用于记录项目架构和长期压缩工作细节上下文有损压缩后回查（该文件思路源于AOCI，建议在大型多处耦合项目或预计将执行多次修改时启用，有本次询问是因为你启用了dsh-compaction-fidelity）";
                  }
                }
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
                if (!detection.ambiguous) {
                  const primaryAccess = architectureDocAccess(askedCwd, detection.primary.relativeDir);
                  if (primaryAccess.ok === true) rememberArchitectureScope(agent, detection.primary.relativeDir);
                }
              }
            }
            const knownScopes = new Set(listArchitectureScopes(askedCwd));
            setBoundedMap(architectureScopes, askedSession, knownScopes, MAX_ARCHITECTURE_SESSIONS);
            if (knownScopes.size > 0) {
              for (const scope of knownScopes) {
                const access = architectureDocAccess(askedCwd, scope);
                if (access.ok !== true) continue;
                const doc = readManagedDoc(askedCwd, scope);
                if (doc.ok !== true) continue;
                let docStat;
                try {
                  docStat = statSync(doc.target.absolute);
                } catch {
                  continue;
                }
                const change = cachedArchitectureChange(askedCwd, scope, { indexDir: cfg.indexDir, docName: access.target.docName, singleFileChangeThreshold: cfg.architectureSingleFileChangeThreshold, maxFiles: cfg.maxFiles, sinceMs: docStat.mtimeMs - 1000, filterFile: architectureManagedFilter(askedCwd, scope) ?? undefined });
                if (!change.forced && change.score < cfg.architectureRefreshThreshold) continue;
                const now = Date.now();
                const reminderKey = architectureReminderKey(askedCwd, scope, docStat.mtimeMs);
                let reminder = null;
                // Reminder bookkeeping is a write: re-check cancellation first.
                if (preStepStopped(signal, decision)) return decision;
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
        } catch (error) {
          ctx.logger?.warn?.('dsh-compaction-fidelity architecture pre-step failed: ' + (error instanceof Error ? error.message : String(error)));
        }
      }
      if (!cfg.anchorInjection || signal?.aborted || decision?.kind === 'reject') return decision;
      if (getGlobalState()?.enabled === false || isMasterDisabled()) return decision;
      const key = sessionIdOf(agent);
      const pending = recentFiles.get(key);
      if (pending === undefined || pending.size === 0) return decision;
      const cwd = workspaceOf(agent);
      const retrieval = retrievalContext(cwd);
      if (retrieval.blocked) return decision;
      try {
        const index = loadIndex(cwd, { indexDir: cfg.indexDir, expectedFingerprint: retrieval.policy.fingerprint });
        if (index === null) {
          queueIndex(cwd);
          return decision;
        }
        const files = [...pending].slice(0, 6);
        const lines = [];
        for (const file of files) {
          const anchors = anchorsForFile(cwd, cfg.indexDir, file, cfg.anchorsPerFile, { expectedFingerprint: retrieval.policy.fingerprint }) ?? [];
          if (anchors.length === 0) continue;
          lines.push(`- ${file} → ${anchors.map((anchor) => `${anchor.id ? `[${anchor.id}] ` : ''}${anchor.canonical ?? anchor.path} (${anchor.kind}${Number.isFinite(anchor.quality) ? ", q" + anchor.quality : ""}: ${anchor.reason})`).join('; ')}`);
        }
        pending.clear();
        if (lines.length === 0) return decision;
        updateAnchorsForFiles(cwd, cfg.indexDir, files, { anchorsPerFile: cfg.anchorsPerFile, expectedFingerprint: retrieval.policy.fingerprint });
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


























