import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJsonIfExists, writeJsonSync } from './util.mjs';

export const MASTER_STATE_KEY = Symbol.for('dsh-compaction-fidelity/state');
export const DEFAULT_INDEX_DIR = '.dsh/compaction-fidelity';
export const MIN_THRESHOLD_TOKENS = 1;
export const MAX_THRESHOLD_TOKENS = 1024 * 1024;
export const EFFECTIVE_MIN_THRESHOLD_TOKENS = 1024;

export const THRESHOLD_PRESETS = Object.freeze({
  '256k': 256 * 1024,
  '350k': 350 * 1024,
  '512k': 512 * 1024,
  '600k': 600 * 1024,
  '800k': 800 * 1024,
  '1m': MAX_THRESHOLD_TOKENS,
});

export function masterSwitchPath() {
  return join(resolveDshHome(), '.dsh-compaction-fidelity', 'disabled');
}

/** Hard external kill switch: env var or marker file. */
export function isMasterDisabled() {
  const env = String(process.env.DSH_COMPACTION_FIDELITY_DISABLED ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(env)) return true;
  try { return existsSync(masterSwitchPath()); } catch { return false; }
}

export function resolveDshHome() {
  const configured = process.env.DSH_HOME?.trim();
  return configured ? configured : join(homedir(), '.dsh');
}

export function parseTokenCount(raw) {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) throw new Error(`token count must be a positive number, got ${raw}`);
    return Math.floor(raw);
  }
  const text = String(raw ?? '').trim().toLowerCase().replace(/[_\s]/g, '');
  if (text.length === 0) throw new Error('token count must not be empty');
  const match = /^(\d+(?:\.\d+)?)([km])?$/.exec(text);
  if (match === null) throw new Error(`unsupported token count "${raw}"; use 256k, 350k, 512k, 600k, 800k, 1m, or an integer token count`);
  const value = Number(match[1]);
  const suffix = match[2];
  const multiplier = suffix === 'm' ? 1024 * 1024 : suffix === 'k' ? 1024 : 1;
  const tokens = Math.floor(value * multiplier);
  if (!Number.isFinite(tokens) || tokens <= 0) throw new Error(`token count "${raw}" is not positive`);
  return tokens;
}

export function assertThresholdTokens(tokens, raw = String(tokens)) {
  if (!Number.isInteger(tokens) || tokens < MIN_THRESHOLD_TOKENS || tokens > MAX_THRESHOLD_TOKENS) {
    throw new Error(`threshold "${raw}" must be between ${MIN_THRESHOLD_TOKENS} and ${MAX_THRESHOLD_TOKENS} tokens; 0 and values above 1M are invalid`);
  }
  return tokens;
}

export function normalizeThreshold(raw) {
  const text = String(raw ?? '350k').trim().toLowerCase();
  if (text === '80%' || text === '0.8' || text === 'official80' || text === 'official-80') {
    return { mode: 'full', tokens: MAX_THRESHOLD_TOKENS, label: '80%' };
  }
  if (text === 'full' || text === '1m' || text === 'auto') {
    return { mode: text === 'auto' ? 'auto' : 'full', tokens: MAX_THRESHOLD_TOKENS, label: text === 'auto' ? 'auto' : '1m' };
  }
  const tokens = assertThresholdTokens(parseTokenCount(text), text);
  for (const [name, value] of Object.entries(THRESHOLD_PRESETS)) {
    if (value === tokens) return { mode: 'tokens', tokens, label: name };
  }
  const label = tokens >= 1024 && tokens % 1024 === 0 ? `${tokens / 1024}k` : String(tokens);
  return { mode: 'tokens', tokens, label };
}

export function resolveRetainTokens(raw, thresholdTokens) {
  if (raw !== undefined && raw !== null && raw !== '') {
    const parsed = parseTokenCount(raw);
    return Math.max(EFFECTIVE_MIN_THRESHOLD_TOKENS, Math.min(parsed, MAX_THRESHOLD_TOKENS));
  }
  return Math.max(8192, Math.min(65536, Math.floor(thresholdTokens * 0.1)));
}

/**
 * Resolve an absolute threshold against one runtime model capacity.
 * `full`/`1m`/`auto` mean "let the official backend decide" and use the
 * effective pressure ceiling (window - completion - headroom).
 */
export function resolveThresholdPlan(raw, contextWindow, messageBudget) {
  const normalized = normalizeThreshold(raw);
  const capacity = Math.max(EFFECTIVE_MIN_THRESHOLD_TOKENS, Math.floor(Number.isFinite(messageBudget) && messageBudget > 0 ? messageBudget : contextWindow ?? Number.MAX_SAFE_INTEGER));
  if (normalized.mode === 'auto' || normalized.mode === 'full') {
    return { ...normalized, tokens: capacity, capped: false, messageBudget, contextWindow };
  }
  if (normalized.tokens >= capacity) {
    return { ...normalized, mode: 'full', tokens: capacity, capped: true, messageBudget, contextWindow };
  }
  return { ...normalized, capped: false, messageBudget, contextWindow };
}

/**
 * Resolve the configured absolute threshold against one routed model's
 * effective message budget. The threshold is capped by
 * `contextWindow - reservedCompletionTokens - headroomTokens` before the caller
 * compares it with the current measurement; the previous engine compared the
 * raw configured threshold first, which could stall above the model's real
 * capacity.
 *
 * @param runtime - runtime policy carrying the configured `threshold`.
 * @param contextWindow - routed model context window.
 * @param reservedCompletionTokens - effective request `maxTokens` reservation.
 * @param headroomTokens - additional pressure headroom.
 * @returns resolved plan and budgets, or null when capacity is unusable.
 */
export function resolveAbsoluteThresholdPlan(runtime, contextWindow, reservedCompletionTokens, headroomTokens) {
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) return null;
  const messageBudget = contextWindow - reservedCompletionTokens;
  if (messageBudget <= 0) return null;
  const effectiveBudget = Math.max(EFFECTIVE_MIN_THRESHOLD_TOKENS, messageBudget - headroomTokens);
  const plan = resolveThresholdPlan(runtime.threshold, contextWindow, effectiveBudget);
  const effectiveThreshold = plan.mode === 'tokens' ? Math.min(plan.tokens, effectiveBudget) : effectiveBudget;
  return { plan, messageBudget, effectiveBudget, effectiveThreshold };
}

export function defaultRuntimeState(overrides = {}) {
  let normalized;
  try {
    normalized = normalizeThreshold(overrides.threshold ?? overrides.thresholdRaw ?? '350k');
  } catch {
    normalized = normalizeThreshold('350k');
  }
  return {
    enabled: overrides.enabled !== false,
    threshold: normalized.label,
    thresholdMode: normalized.mode,
    thresholdTokens: normalized.tokens,
    retainTokens: resolveRetainTokens(overrides.retainTokens, normalized.tokens),
    summaryLanguage: overrides.summaryLanguage ?? 'auto',
    summaryMaxTokens: Number.isInteger(overrides.summaryMaxTokens) && overrides.summaryMaxTokens > 0 ? overrides.summaryMaxTokens : 65536,
    compactionRetries: Number.isInteger(overrides.compactionRetries) && overrides.compactionRetries >= 0 ? overrides.compactionRetries : 1,
    indexDir: overrides.indexDir ?? DEFAULT_INDEX_DIR,
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  };
}

export function getGlobalState() {
  return globalThis[MASTER_STATE_KEY];
}

export function setGlobalState(patch) {
  const current = globalThis[MASTER_STATE_KEY] ?? {};
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  globalThis[MASTER_STATE_KEY] = Object.freeze(next);
  return next;
}

export function homeStatePath() {
  return join(resolveDshHome(), '.dsh-compaction-fidelity', 'state.json');
}

export function workspaceStatePath(cwd, indexDir = DEFAULT_INDEX_DIR) {
  return join(cwd, indexDir, 'state.json');
}

export function readPersistedState({ cwd, indexDir = DEFAULT_INDEX_DIR } = {}) {
  const home = readJsonIfExists(homeStatePath(), null);
  const workspace = cwd ? readJsonIfExists(workspaceStatePath(cwd, indexDir), null) : null;
  return { home, workspace };
}

export function savePersistedState(state, { cwd, indexDir = DEFAULT_INDEX_DIR, writeWorkspace = false } = {}) {
  writeJsonSync(homeStatePath(), state);
  if (writeWorkspace && cwd) writeJsonSync(workspaceStatePath(cwd, indexDir), state);
  return state;
}

function finalizeRuntimeState(base, { workspace, home, globalState }) {
  const baseDefaults = defaultRuntimeState(base);
  const merged = {
    ...baseDefaults,
    ...(workspace ?? {}),
    ...(home ?? {}),
    ...(globalState ?? {}),
  };
  let normalized;
  try {
    normalized = normalizeThreshold(merged.threshold ?? merged.thresholdRaw ?? base.threshold ?? baseDefaults.threshold ?? '350k');
  } catch {
    normalized = normalizeThreshold(base.threshold ?? '350k');
  }
  return {
    ...merged,
    threshold: normalized.label,
    thresholdMode: normalized.mode,
    thresholdTokens: normalized.tokens,
    retainTokens: resolveRetainTokens(merged.retainTokens ?? base.retainTokens, normalized.tokens),
    summaryLanguage: merged.summaryLanguage ?? base.summaryLanguage ?? baseDefaults.summaryLanguage ?? 'auto',
    summaryMaxTokens: Number.isInteger(merged.summaryMaxTokens) ? merged.summaryMaxTokens : (Number.isInteger(base.summaryMaxTokens) ? base.summaryMaxTokens : baseDefaults.summaryMaxTokens),
    compactionRetries: Number.isInteger(merged.compactionRetries) ? merged.compactionRetries : (Number.isInteger(base.compactionRetries) ? base.compactionRetries : baseDefaults.compactionRetries),
    summaryProvider: merged.summaryProvider ?? base.summaryProvider,
    summaryModel: merged.summaryModel ?? base.summaryModel,
    enabled: !isMasterDisabled() && merged.enabled !== false,
  };
}

/**
 * Resolve runtime policy. When the host plugin has already published process
 * state into the global slot, skip synchronous state-file reads entirely;
 * only hosts without the plugin (or cold engine construction) read disk.
 */
export function mergeRuntimeState(base = {}, { cwd, indexDir = DEFAULT_INDEX_DIR } = {}) {
  const globalState = getGlobalState();
  if (globalState !== undefined && globalState !== null && typeof globalState === 'object') {
    return finalizeRuntimeState(base, { workspace: null, home: null, globalState });
  }
  const persisted = readPersistedState({ cwd, indexDir });
  return finalizeRuntimeState(base, { ...persisted, globalState: null });
}





