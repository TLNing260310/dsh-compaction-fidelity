import { BlockAssembler, contentHasImage } from '@deepseek-ai/dsh-llm';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction';
import { deepFreeze } from '@deepseek-ai/dsh-util-values';
import z from '@deepseek-ai/schemastery';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { anchorsForFile, briefForRoot, loadIndex, updateAnchorsForFiles } from './project-index.mjs';
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { buildCompensation, buildFingerprint, compareFingerprints } from './fingerprint.mjs';
import { compareConstraintLedger, extractConstraintLedger } from './constraint-ledger.mjs';
import { buildFidelitySample, calibrateFidelityLevel, recordFidelitySample } from './fidelity-calibration.mjs';
import { buildFidelityProbes, evaluateFidelityGate } from './fidelity-gate.mjs';
import { aggregateComparison as storedComparison, aggregateConstraints as storedConstraints, aggregateGate as storedGate } from './fingerprint-privacy.mjs';
import { readArchitectureDoc } from './architecture-doc.mjs';
import { managedDocTarget, readArchitectureRegistry, retrievalPolicyFor } from './architecture-registry.mjs';
import { ARCHITECTURE_VIEW_TOTAL_CHARS, DEFAULT_VIEW_CHARS, MIN_VIEW_CHARS, architectureActiveState, buildArchitectureView, parseArchitectureDocument } from './architecture-view.mjs';
import { assertWorkspaceContained } from './architecture-io.mjs';
import { pickRetentionRange } from './range.mjs';
import { mergeRuntimeState, normalizeThreshold, resolveAbsoluteThresholdPlan, resolveThresholdPlan } from './state.mjs';
import { DEFAULT_INJECTION_MAX_TOKENS, buildSummaryInstructionWithDiagnostics, extractFilePathsFromMessages, extractLedger } from './summarizer.mjs';
import { clampText, clampTextToTokens, estimateTextTokens, isSafeRelativePath } from './util.mjs';

const SUMMARY_LANGUAGES = new Set(['auto', 'zh', 'en', 'bilingual']);

const MAX_MODEL_INFO_CACHE = 128;
const MAX_CALIBRATION_CACHE = 256;
const MAX_FINGERPRINT_FILES = 500;
function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function estimateToolsTokensForHeader(header) {
  const tools = header?.tools;
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  return Math.ceil(JSON.stringify(tools).length / 4) + 4;
}

/**
 * Cancellation must terminate the operation. It is never a fallback condition:
 * treating an abort as "the plugin failed" would keep working after the caller
 * cancelled the step.
 */
function isCancellation(signal, error) {
  return signal?.aborted === true || error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function routedTarget(session) {
  const config = session?.requestHeader?.()?.config;
  if (config === undefined || typeof config.provider !== 'string' || typeof config.model !== 'string') return undefined;
  if (config.provider.length === 0 || config.model.length === 0) return undefined;
  return { provider: config.provider, model: config.model };
}

function conversationTarget(agent) {
  const routed = routedTarget(agent?.session);
  if (routed !== undefined) return routed;
  const provider = agent?.options?.provider;
  const model = agent?.options?.model;
  if (typeof provider !== 'string' || typeof model !== 'string' || provider.length === 0 || model.length === 0) return undefined;
  return { provider, model };
}

function reservedCompletionTokens(agent, defaultMaxTokens) {
  return agent?.session?.requestHeader?.()?.config?.maxTokens ?? defaultMaxTokens ?? 0;
}

function finishError(finish) {
  switch (finish?.kind) {
    case 'error':
    case 'aborted': {
      const failure = finish.failure ?? {};
      const error = new Error(failure.message ?? 'summarization failed');
      if (failure.code !== undefined) error.code = failure.code;
      return error;
    }
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)');
      error.code = 'MAX_TOKENS';
      return error;
    }
    default:
      return undefined;
  }
}

function summaryText(blocks) {
  const out = [];
  for (const block of blocks ?? []) {
    if (block?.type === 'image') throw new Error('compaction summary cannot contain image output');
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) out.push(block);
  }
  return out;
}

function normalizeEngineConfig(config = {}) {
  const summaryLanguage = SUMMARY_LANGUAGES.has(config.summaryLanguage) ? config.summaryLanguage : 'auto';
  const summaryProvider = typeof config.summaryProvider === 'string' ? config.summaryProvider.trim() : '';
  const summaryModel = typeof config.summaryModel === 'string' ? config.summaryModel.trim() : '';
  const threshold = typeof config.threshold === 'number' ? String(config.threshold) : String(config.threshold ?? '350k');
  const thresholdInfo = normalizeThreshold(threshold);
  const retainTokens = Number.isInteger(config.retainTokens) && config.retainTokens > 0 ? config.retainTokens : undefined;
  if (retainTokens !== undefined && retainTokens >= thresholdInfo.tokens) {
    throw new Error(`compaction-fidelity: retainTokens (${retainTokens}) must be lower than threshold (${thresholdInfo.tokens})`);
  }
  const indexDir = typeof config.indexDir === 'string' && config.indexDir.length > 0 ? config.indexDir : '.dsh/compaction-fidelity';
  if (!isSafeRelativePath(indexDir)) throw new Error(`compaction-fidelity: indexDir "${indexDir}" must be a safe workspace-relative path`);
  return {
    enabled: config.enabled !== false,
    threshold,
    thresholdTokens: thresholdInfo.tokens,
    retainTokens,
    summaryLanguage,
    summaryMaxTokens: Number.isInteger(config.summaryMaxTokens) && config.summaryMaxTokens >= 1024 ? config.summaryMaxTokens : 65536,
    compensationMaxTokens: Number.isInteger(config.compensationMaxTokens) && config.compensationMaxTokens >= 128 ? config.compensationMaxTokens : 2048,
    injectionMaxTokens: Number.isInteger(config.injectionMaxTokens) && config.injectionMaxTokens >= 2048 ? config.injectionMaxTokens : DEFAULT_INJECTION_MAX_TOKENS,
    summaryProvider: summaryProvider.length > 0 ? summaryProvider : undefined,
    summaryModel: summaryModel.length > 0 ? summaryModel : undefined,
    compactionRetries: Number.isInteger(config.compactionRetries) && config.compactionRetries >= 0 ? config.compactionRetries : 1,
    headroomTokens: Number.isInteger(config.headroomTokens) && config.headroomTokens >= 0 ? config.headroomTokens : 65536,
    calibration: config.calibration !== false,
    calibrationMinRatio: Number.isFinite(config.calibrationMinRatio) && config.calibrationMinRatio > 0 ? config.calibrationMinRatio : 1,
    calibrationMaxRatio: Number.isFinite(config.calibrationMaxRatio) && config.calibrationMaxRatio >= 1 ? config.calibrationMaxRatio : 4,
    ledger: config.ledger !== false,
    anchors: config.anchors !== false,
    anchorsPerFile: Number.isInteger(config.anchorsPerFile) && config.anchorsPerFile > 0 ? config.anchorsPerFile : 8,
    indexDir,
  };
}

function safeBalanced(session, fn, seq) {
  try {
    return fn(session, seq);
  } catch {
    return false;
  }
}

export class CompactionFidelityEngine extends BasicCompactionEngine {
  static Config = z.object({
    enabled: z.boolean().default(true),
    threshold: z.string().default('350k'),
    retainTokens: z.number().step(1).min(1024),
    summaryLanguage: z.string().default('auto'),
    summaryMaxTokens: z.number().step(1).min(1024).default(65536),
    compensationMaxTokens: z.number().step(1).min(256).default(2048),
    injectionMaxTokens: z.number().step(1).min(2048).default(DEFAULT_INJECTION_MAX_TOKENS),
    summaryProvider: z.string(),
    summaryModel: z.string(),
    compactionRetries: z.number().step(1).min(0).default(1),
    headroomTokens: z.number().step(1).min(0).default(65536),
    calibration: z.boolean().default(true),
    calibrationMinRatio: z.number().min(0.1).default(1),
    calibrationMaxRatio: z.number().min(1).default(4),
    ledger: z.boolean().default(true),
    anchors: z.boolean().default(true),
    anchorsPerFile: z.number().step(1).min(1).default(8),
    indexDir: z.string().default('.dsh/compaction-fidelity'),
  });

  constructor(ctx, config = {}) {
    const normalized = normalizeEngineConfig(config);
    super(ctx, {
      auto: true,
      thresholdRatio: 0.8,
      headroomTokens: 65536,
      retainRatio: 0.16,
      maxTokens: normalized.summaryMaxTokens,
      compactionRetries: normalized.compactionRetries,
      maxOverflowRetries: 1,
      ...(normalized.summaryProvider !== undefined && normalized.summaryModel !== undefined
        ? { summarizationProvider: normalized.summaryProvider, summarizationModel: normalized.summaryModel }
        : {}),
    });
    this.fidelityConfig = normalized;
    this.modelInfoCache = new Map();
    this.calibrationCache = new Map();
    this.thresholdInFlight = new Set();
    const engine = this;
    ctx.effect(function* lifecycle() {
      yield ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
        if (!signal?.aborted) {
          const sessionKey = String(agent?.session?.id ?? "session");
          if (!engine.thresholdInFlight.has(sessionKey)) {
            engine.thresholdInFlight.add(sessionKey);
            try {
              await engine.compactByAbsoluteThreshold(agent, signal);
            } catch (error) {
              // Cancellation terminates the operation; it is not a plugin
              // failure and must never enter the fallback path.
              if (isCancellation(signal, error)) throw error;
              ctx.logger?.warn?.("compaction-fidelity threshold check failed: " + (error instanceof Error ? error.message : String(error)) + "; falling back to official compaction");
              try {
                await engine.officialPressureFallback(agent, signal);
              } catch (fallbackError) {
                if (isCancellation(signal, fallbackError)) throw fallbackError;
                ctx.logger?.warn?.("compaction-fidelity official fallback failed: " + (fallbackError instanceof Error ? fallbackError.message : String(fallbackError)));
              }
            } finally {
              engine.thresholdInFlight.delete(sessionKey);
            }
          }
        }
        return next();
      });
    }, 'compaction-fidelity absolute-threshold pressure');
  }

  runtimeFor(agent) {
    const cwd = agent?.session?.header?.cwd ?? process.cwd();
    return mergeRuntimeState(
      {
        enabled: this.fidelityConfig.enabled,
        threshold: this.fidelityConfig.threshold,
        retainTokens: this.fidelityConfig.retainTokens,
        summaryLanguage: this.fidelityConfig.summaryLanguage,
        summaryMaxTokens: this.fidelityConfig.summaryMaxTokens,
        summaryProvider: this.fidelityConfig.summaryProvider,
        summaryModel: this.fidelityConfig.summaryModel,
        compactionRetries: this.fidelityConfig.compactionRetries,
        anchors: this.fidelityConfig.anchors !== false,
        anchorsPerFile: this.fidelityConfig.anchorsPerFile,
        indexDir: this.fidelityConfig.indexDir,
      },
      { cwd, indexDir: this.fidelityConfig.indexDir },
    );
  }

  /**
   * Official pressure hook override: keep the absolute-threshold policy in the
   * plugin listener, let `full`/`1m` defer to the official ceiling, and emulate
   * the official 80%-window policy while the master switch is off.
   */
  async compactIfNeeded(agent, trigger, signal) {
    if (trigger === "context-overflow") return super.compactIfNeeded(agent, trigger, signal);
    const runtime = this.runtimeFor(agent);
    // While Compaction-Fidelity is enabled, the plugin pre-step listener owns pressure. Returning
    // null here prevents the official listener from resolving model info or
    // measuring a second time each step.
    if (runtime.enabled) return null;
    const target = routedTarget(agent?.session) ?? conversationTarget(agent);
    if (target === undefined) return null;
    const info = await this.resolveModelInfoCached(target, signal);
    const contextWindow = info?.context?.contextWindow;
    const reserved = reservedCompletionTokens(agent, info?.defaultMaxTokens);
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) return null;
    const messageBudget = contextWindow - reserved;
    if (messageBudget <= 0) return null;
    const thresholdTokens = Math.max(1024, Math.min(Math.floor(contextWindow * 0.8), messageBudget - 65536));
    const retainTokens = Math.max(1024, Math.floor(messageBudget * 0.16));
    const retries = Number.isInteger(this.fidelityConfig.compactionRetries) ? this.fidelityConfig.compactionRetries : 1;
    return this.compactPressureWithPolicy(agent, signal, thresholdTokens, retainTokens, retries);
  }

  /** Route/model info is stable for the life of a session; cache it briefly. */
  async resolveModelInfoCached(target, signal) {
    const key = `${target.provider}/${target.model}`;
    const hit = this.modelInfoCache.get(key);
    if (hit !== undefined && Date.now() - hit.at < 60000) return hit.info;
    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
    if (!this.modelInfoCache.has(key) && this.modelInfoCache.size >= MAX_MODEL_INFO_CACHE) {
      const oldest = this.modelInfoCache.keys().next().value;
      if (oldest !== undefined) this.modelInfoCache.delete(oldest);
    }
    this.modelInfoCache.set(key, { at: Date.now(), info });
    return info;
  }

  /**
   * Absolute-threshold pressure path. The configured threshold is capped by the
   * routed model's effective message budget (window - completion - headroom)
   * before any comparison; failures fall back to the official pressure path
   * instead of silently stalling.
   */
  async compactByAbsoluteThreshold(agent, signal) {
    const runtime = this.runtimeFor(agent);
    if (!runtime.enabled) return null;
    const target = routedTarget(agent?.session) ?? conversationTarget(agent);
    if (target === undefined) return null;
    const meter = this.ctx.tokenMeter;
    if (meter === undefined || typeof meter.measure !== "function") {
      this.ctx.logger?.warn?.("compaction-fidelity: tokenMeter unavailable; falling back to official compaction");
      return this.officialPressureFallback(agent, signal);
    }
    const info = await this.resolveModelInfoCached(target, signal);
    const contextWindow = info?.context?.contextWindow;
    const reserved = reservedCompletionTokens(agent, info?.defaultMaxTokens);
    const headroom = Number.isInteger(this.fidelityConfig.headroomTokens) ? this.fidelityConfig.headroomTokens : 65536;
    const thresholdPlan = resolveAbsoluteThresholdPlan(runtime, contextWindow, reserved, headroom);
    if (thresholdPlan === null) return null;
    const measurement = this.calibrateMeasurement(agent, meter.measure(agent.session));
    if (measurement.totalTokens < thresholdPlan.effectiveThreshold) return null;
    if (thresholdPlan.plan.mode !== "tokens") return this.officialPressureFallback(agent, signal);
    const retries = Number.isInteger(runtime.compactionRetries) ? runtime.compactionRetries : 1;
    try {
      const result = await this.compactPressureWithPolicy(
        agent,
        signal,
        thresholdPlan.effectiveThreshold,
        runtime.retainTokens,
        retries,
        { measurement },
      );
      if (result !== null) return result;
    } catch (error) {
      if (isCancellation(signal, error)) throw error;
      this.ctx.logger?.warn?.(
        `compaction-fidelity absolute-threshold compaction failed: ${error instanceof Error ? error.message : String(error)}; falling back to official compaction`,
      );
    }
    return this.officialPressureFallback(agent, signal);
  }

  /** Reach the official policy even though `compactIfNeeded` is overridden above. */
  officialPressureFallback(agent, signal) {
    return super.compactIfNeeded(agent, "pressure", signal);
  }

  /**
   * Provider-anchored calibration for heuristic deltas.
   *
   * `measure()` reuses exact provider usage at the latest assistant anchor and
   * then prices everything appended after it heuristically. If that estimator
   * still undercounts, compare the provider prompt at the anchor with the
   * heuristic surface sum and scale the positive delta by the observed ratio.
   */
  calibrateMeasurement(agent, measurement) {
    try {
      if (!this.fidelityConfig.calibration) return measurement;
      if (measurement?.baseline?.kind !== "usage") return measurement;
      if (!(measurement.surfaceDeltaTokens > 0) || !Array.isArray(measurement.nodes)) return measurement;
      const session = agent?.session;
      if (session === undefined || typeof session.eventAt !== "function") return measurement;
      let anchorIndex = -1;
      let anchorSeq;
      let providerTotal = 0;
      for (let index = measurement.nodes.length - 1; index >= 0; index -= 1) {
        const node = measurement.nodes[index];
        const event = session.eventAt(node.seq);
        if (event?.type !== "assistant/message") continue;
        const usage = event.data?.usage;
        if (usage === undefined) continue;
        anchorIndex = index;
        anchorSeq = node.seq;
        providerTotal = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
        break;
      }
      if (anchorIndex < 0 || !(providerTotal > 0)) return measurement;
      const cacheKey = `${session.header?.id ?? session.id ?? "unknown"}:${anchorSeq}`;
      let ratio = this.calibrationCache.get(cacheKey);
      if (!(ratio > 0)) {
        let anchorHeuristic = estimateToolsTokensForHeader(session.requestHeader?.());
        for (let index = 0; index < anchorIndex; index += 1) {
          const node = measurement.nodes[index];
          anchorHeuristic += Number.isFinite(node.heuristicTokens) ? node.heuristicTokens : 0;
        }
        if (!(anchorHeuristic > 0)) return measurement;
        ratio = clampNumber(
          providerTotal / anchorHeuristic,
          this.fidelityConfig.calibrationMinRatio,
          this.fidelityConfig.calibrationMaxRatio,
        );
        if (!this.calibrationCache.has(cacheKey) && this.calibrationCache.size >= MAX_CALIBRATION_CACHE) {
          const oldest = this.calibrationCache.keys().next().value;
          if (oldest !== undefined) this.calibrationCache.delete(oldest);
        }
        this.calibrationCache.set(cacheKey, ratio);
      }
      if (!(ratio > 1.05)) return measurement;
      const calibratedTotal = Math.round(measurement.baseline.tokens + measurement.surfaceDeltaTokens * ratio);
      if (calibratedTotal <= measurement.totalTokens) return measurement;
      return {
        ...measurement,
        totalTokens: calibratedTotal,
        calibration: { ratio, anchorSeq, providerTotal, heuristicTotal: measurement.totalTokens },
      };
    } catch {
      return measurement;
    }
  }

  /** Shared pressure transaction: prune, select a balanced retained-tail range, compact, re-measure. */
  async compactPressureWithPolicy(agent, signal, thresholdTokens, retainTokens, retries, options = {}) {
    const meter = this.ctx.tokenMeter;
    let measurement = options.measurement ?? this.calibrateMeasurement(agent, meter.measure(agent.session));
    if (measurement.totalTokens < thresholdTokens) return null;
    const pruner = this.ctx.get("toolResultPruner");
    if (pruner !== undefined && typeof pruner.pruneSession === "function") {
      try {
        pruner.pruneSession(agent.session);
        measurement = this.calibrateMeasurement(agent, meter.measure(agent.session));
      } catch (error) {
        this.ctx.logger?.warn?.(`compaction-fidelity tool-result pruning failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (measurement.totalTokens < thresholdTokens) return null;
    const attempts = Number.isInteger(retries) && retries >= 0 ? retries : 1;
    let result = null;
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      const range = this.pickRange(agent, measurement, retainTokens);
      if (range === null) return result;
      result = await this.compactRegion(range.start, range.end, agent, signal);
      measurement = this.calibrateMeasurement(agent, meter.measure(agent.session));
      if (measurement.totalTokens < thresholdTokens) return result;
    }
    this.ctx.logger?.warn?.(`compaction-fidelity: pressure still above ${thresholdTokens} tokens after ${attempts + 1} attempt(s)`);
    return result;
  }
  pickRange(agent, measurement, retainTokens) {
    const session = agent.session;
    return pickRetentionRange({
      surfaceNodes: [...session.surface.nodes],
      measuredNodes: [...(measurement.nodes ?? [])],
      eventTypeAt: (seq) => session.eventAt(seq)?.type,
      isBalancedBefore: (seq) => safeBalanced(session, toolPairingBalancedBefore, seq),
      isBalancedAfter: (seq) => safeBalanced(session, toolPairingBalancedAfter, seq),
      retainTokens,
    });
  }

  async persistFingerprint(agent, before, after, comparison, indexDir = this.fidelityConfig.indexDir, compensation = undefined, fidelityGate = undefined, constraintComparison = undefined, calibration = undefined) {
    const cwd = agent?.session?.header?.cwd ?? process.cwd();
    const dir = join(cwd, indexDir, 'fingerprints');
    try {
      assertWorkspaceContained(cwd, join(dir, 'fingerprint.json'));
      const sessionId = String(agent?.session?.id ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
      await mkdir(dir, { recursive: true });
      const summarizeSide = (fingerprint) => ({
        language: fingerprint.language,
        stats: fingerprint.stats,
        exactCounts: Object.fromEntries(Object.entries(fingerprint.exact).map(([key, value]) => [key, value.length])),
        cjkBigrams: fingerprint.cjkBigrams.length,
        headings: fingerprint.headings.length,
        codeLanguages: fingerprint.codeLanguages.length,
      });
      const record = {
        generatedAt: new Date().toISOString(),
        sessionId,
        fidelity: storedComparison(comparison),
        ...(compensation === undefined ? {} : { compensation: { maxTokens: compensation.maxTokens, tokens: compensation.tokens, truncated: compensation.truncated, entriesByCategory: compensation.entriesByCategory, omittedByCategory: compensation.omittedByCategory } }),
        ...(fidelityGate === undefined ? {} : { gate: storedGate(fidelityGate) }),
        ...(constraintComparison === undefined ? {} : { constraints: storedConstraints(constraintComparison) }),
        ...(calibration === undefined || calibration === null ? {} : { calibration: { ...calibration, finalFidelity: storedComparison(calibration.finalFidelity) } }),
        before: summarizeSide(before),
        after: summarizeSide(after),
      };
      await writeFile(join(dir, `${sessionId}-${Date.now()}.json`), JSON.stringify(record, null, 2), 'utf8');
      try {
        const names = readdirSync(dir).filter((name) => name.endsWith(".json"));
        if (names.length > MAX_FINGERPRINT_FILES) {
          const files = names.map((name) => {
            try { return { name, mtimeMs: statSync(join(dir, name)).mtimeMs }; } catch { return null; }
          }).filter(Boolean).sort((left, right) => left.mtimeMs - right.mtimeMs);
          for (const file of files.slice(0, files.length - MAX_FINGERPRINT_FILES)) {
            try { unlinkSync(join(dir, file.name)); } catch { /* best effort */ }
          }
        }
      } catch {
        // pruning is best effort
      }
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-compaction-fidelity fingerprint persist failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async summarize(input, agent, signal) {
    const runtime = this.runtimeFor(agent);
    if (!runtime.enabled) return super.summarize(input, agent, signal);
    try {
      return await this.summarizeFidelity(input, agent, signal, runtime);
    } catch (error) {
      if (isCancellation(signal, error)) throw error;
      this.ctx.logger?.warn?.(`compaction-fidelity summary failed: ${error instanceof Error ? error.message : String(error)}; falling back to official summary`);
      return super.summarize(input, agent, signal);
    }
  }

  async summarizeFidelity(input, agent, signal, runtime) {
    const latest = agent?.session?.requestHeader?.()?.config;
    const configured = runtime.summaryProvider !== undefined && runtime.summaryModel !== undefined
      ? { provider: runtime.summaryProvider, model: runtime.summaryModel }
      : undefined;
    const agentTarget = typeof agent?.options?.provider === 'string' && agent.options.provider.length > 0 && typeof agent?.options?.model === 'string' && agent.options.model.length > 0
      ? { provider: agent.options.provider, model: agent.options.model }
      : undefined;
    const target = configured ?? latest ?? agentTarget;
    if (target === undefined || typeof target.provider !== 'string' || typeof target.model !== 'string') {
      throw new Error('compaction-fidelity: no provider/model available for summarization; route one request first or configure summaryProvider/summaryModel');
    }

    const cwd = agent?.session?.header?.cwd ?? process.cwd();
    const ledger = extractLedger(input.messages ?? []);
    const preFingerprint = buildFingerprint(input.messages ?? [], { ledger });
    const referencedFiles = extractFilePathsFromMessages(input.messages ?? [], cwd);
    let brief = '';
    let anchorText = '';
    if (runtime.anchors) {
      try {
        const policy = retrievalPolicyFor(cwd, runtime.indexDir);
        if (policy.blocked) throw new Error('the managed scope registry cannot be read; retrieval is blocked until it is repaired');
        const readOptions = { indexDir: runtime.indexDir, expectedFingerprint: policy.fingerprint };
        const index = loadIndex(cwd, readOptions);
        if (index !== null) {
          brief = clampText(briefForRoot(cwd, readOptions) ?? index.brief ?? '', 3000);
          const lines = [];
          for (const file of referencedFiles.slice(0, 12)) {
            const anchors = anchorsForFile(cwd, runtime.indexDir, file, this.fidelityConfig.anchorsPerFile, { expectedFingerprint: policy.fingerprint });
            if (anchors === null || anchors.length === 0) continue;
            lines.push(`- ${file}`);
            for (const anchor of anchors) lines.push(`  - [${anchor.kind}${Number.isFinite(anchor.quality) ? ` q${anchor.quality}` : ''}] ${anchor.path} — ${anchor.reason}`);
          }
          anchorText = lines.join('\n');
        } else if (existsSync(join(cwd, runtime.indexDir, 'index.json'))) {
          // The cache is present but was written under a different read policy,
          // so it is discarded instead of served. The next pre-step rebuilds it;
          // report that instead of silently dropping the summary context.
          this.ctx.logger?.warn?.('compaction-fidelity: the cached project index was built under a different read policy and is not being served; the next pre-step rebuilds it');
        }
        if (referencedFiles.length > 0) {
          updateAnchorsForFiles(cwd, runtime.indexDir, referencedFiles.slice(0, 24), { anchorsPerFile: this.fidelityConfig.anchorsPerFile, expectedFingerprint: policy.fingerprint });
        }
      } catch (error) {
        this.ctx.logger?.warn?.(`compaction-fidelity anchor lookup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    let architectureDocs = "";
    let cognitionRefreshScopes = [];
    try {
      const registry = readArchitectureRegistry(cwd, this.fidelityConfig.indexDir);
      const seenDocs = new Set();
      const refreshScopes = new Map();
      const entries = [];
      const addDoc = (doc, priority) => {
        if (doc === null || doc === undefined || seenDocs.has(doc.relative)) return;
        seenDocs.add(doc.relative);
        const scope = typeof doc.scope === "string" ? doc.scope : ".";
        const docName = typeof doc.docName === "string" ? doc.docName : "ARCHITECTURE.md";
        refreshScopes.set(scope, docName);
        if (doc.truncated === true) {
          this.ctx.logger?.warn?.("compaction-fidelity architecture document is too large to read: " + doc.relative);
          return;
        }
        entries.push({ text: doc.text, relative: doc.relative, priority });
      };
      const readManagedDoc = (scope, fallbackDoc = "ARCHITECTURE.md") => {
        try {
          const target = managedDocTarget(registry, scope, fallbackDoc);
          if (target === null) return null;
          return readArchitectureDoc(cwd, target.scope, target.docName);
        } catch (error) {
          this.ctx.logger?.warn?.("compaction-fidelity managed architecture doc skipped: " + (error instanceof Error ? error.message : String(error)));
          return null;
        }
      };
      for (const file of referencedFiles.slice(0, 8)) {
        let dir = file;
        for (let depth = 0; depth < 6; depth += 1) {
          const parts = dir.split("/");
          parts.pop();
          dir = parts.join("/");
          if (dir.length === 0) dir = ".";
          addDoc(readManagedDoc(dir), 0);
          if (dir === ".") break;
        }
      }
      const registeredScopes = Object.keys(registry?.scopes ?? {});
      if (registeredScopes.length > 0) {
        const ordered = registeredScopes
          .map((scope) => {
            const target = managedDocTarget(registry, scope);
            const doc = target === null ? null : readManagedDoc(target.scope, target.docName);
            let mtimeMs = 0;
            if (doc !== null) {
              try {
                mtimeMs = statSync(doc.absolute).mtimeMs;
              } catch {
                mtimeMs = 0;
              }
            }
            return { doc, mtimeMs };
          })
          .sort((left, right) => right.mtimeMs - left.mtimeMs);
        for (const item of ordered.slice(0, 12)) addDoc(item.doc, 1);
      }
      addDoc(readManagedDoc("."), 2);
      // Each document contributes a bounded excerpt of whole items, so the
      // newest update can never be pushed out by the head of the file and no
      // half block is emitted when the budget runs out.
      const maxTotal = ARCHITECTURE_VIEW_TOTAL_CHARS;
      const docLines = [];
      for (const entry of entries) {
        const remaining = maxTotal - (docLines.length === 0 ? 0 : docLines.join("\n\n").length + 2);
        if (remaining < MIN_VIEW_CHARS) {
          this.ctx.logger?.warn?.("compaction-fidelity architecture excerpt skipped: " + entry.relative + " (" + remaining + " chars of budget remain)");
          continue;
        }
        const parsed = parseArchitectureDocument(entry.text);
        if (parsed.ok !== true) {
          this.ctx.logger?.warn?.("compaction-fidelity architecture document skipped (" + parsed.reason + "): " + entry.relative);
          continue;
        }
        const state = architectureActiveState(parsed);
        const view = buildArchitectureView(entry.text, {
          parsed,
          relative: entry.relative,
          maxChars: Math.min(DEFAULT_VIEW_CHARS, remaining),
          activeConstraints: state.constraints,
          retiredCounts: { retracted: state.retracted.length, superseded: state.superseded.length },
        });
        if (view.ok !== true || view.text.length === 0) continue;
        docLines.push(view.text);
        if (view.incomplete) {
          this.ctx.logger?.warn?.("compaction-fidelity architecture excerpt for " + entry.relative + " omits " + view.omitted.length + " item(s)");
        }
      }
      architectureDocs = docLines.join("\n\n");
      cognitionRefreshScopes = [...refreshScopes.entries()].map(([scope, docName]) => ({ scope, docName }));
    } catch (error) {
      this.ctx.logger?.warn?.("compaction-fidelity architecture doc lookup failed: " + (error instanceof Error ? error.message : String(error)));
    }
    const constraintLedger = extractConstraintLedger(input.messages ?? []);
    const injectionBudget = this.fidelityConfig.injectionMaxTokens;
    const compensationReserve = Math.min(this.fidelityConfig.compensationMaxTokens, injectionBudget);
    const instructionResult = buildSummaryInstructionWithDiagnostics({
      language: runtime.summaryLanguage,
      ledger,
      brief,
      anchors: anchorText,
      constraints: constraintLedger.constraints,
      architectureDocs,
      cognitionRefreshScopes,
      maxTokens: injectionBudget,
      reserveTokens: compensationReserve,
    });
    if (instructionResult.diagnostics.truncated) {
      this.ctx.logger?.warn?.("compaction-fidelity injection budget truncated: dropped=[" + instructionResult.diagnostics.droppedBlocks.join(",") + "] shortened=[" + instructionResult.diagnostics.truncatedBlocks.map((item) => item.name).join(",") + "]");
    }
    const instruction = instructionResult.text;
    const messages = [
      ...(input.messages ?? []),
      deepFreeze({
        role: 'user',
        content: [{ type: 'text', text: instruction }],
      }),
    ];
    const maxTokens = runtime.summaryMaxTokens;
    const options = {
      provider: target.provider,
      model: target.model,
      messages,
      toolHistory: agent.session.toolHistory(),
      ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
      maxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...(signal === undefined ? {} : { signal }),
    };
    const assembler = new BlockAssembler();
    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk);
    const failure = finishError(assembler.finish);
    if (failure !== undefined) throw failure;
    const rawOutput = assembler.blocks();
    if (contentHasImage(rawOutput)) throw new Error('compaction-fidelity summary cannot contain image output');
    const summary = summaryText(rawOutput);
    if (!summary.some((block) => block.text.trim().length > 0)) throw new Error('compaction-fidelity summarization produced no text summary content');
    const postFingerprint = buildFingerprint([{ role: 'assistant', content: summary.map((block) => ({ type: 'text', text: block.text })) }]);
    const fidelity = compareFingerprints(preFingerprint, postFingerprint);
    // Raw snapshot: what the model produced on its own, before compensation and
    // before un-preserved constraints are re-injected.
    const rawSummaryText = summary.map((block) => block.text).join("\n");
    const rawConstraintComparison = compareConstraintLedger(constraintLedger, rawSummaryText);
    const pinned = rawConstraintComparison.verdicts.filter((verdict) => verdict.verdict !== "preserved");
    const pinnedText = pinned.map((verdict, index) => "- [" + (index + 1) + "] " + verdict.text).join("\n");
    const postInjectionBudget = Math.max(0, injectionBudget - instructionResult.diagnostics.estimatedTokens);
    const pinnedBlockOpen = "<pinned_constraints>\n";
    const pinnedBlockClose = "\n</pinned_constraints>";
    const pinnedTagTokens = estimateTextTokens(pinnedBlockOpen + pinnedBlockClose);
    const pinnedTokens = pinnedText.length > 0 ? estimateTextTokens(pinnedText) + pinnedTagTokens : 0;
    const pinnedReserved = pinnedText.length > 0 ? Math.min(pinnedTokens, Math.floor(postInjectionBudget / 2)) : 0;
    const compensationBudget = Math.min(this.fidelityConfig.compensationMaxTokens, Math.max(0, postInjectionBudget - pinnedReserved));
    const compensation = compensationBudget >= 128
      ? buildCompensation(fidelity, { maxTokens: compensationBudget })
      : { text: "", tokens: 0, maxTokens: compensationBudget, truncated: false, entriesByCategory: {}, omittedByCategory: {} };
    if (compensation.text.length > 0) summary.push({ type: 'text', text: compensation.text });
    if (pinnedText.length > 0) {
      const remainingAfterCompensation = Math.max(0, postInjectionBudget - estimateTextTokens(compensation.text));
      const pinnedBudget = Math.max(pinnedReserved, remainingAfterCompensation);
      const pinnedContentBudget = Math.max(0, pinnedBudget - pinnedTagTokens);
      const cappedPinnedText = clampTextToTokens(pinnedText, pinnedContentBudget);
      if (cappedPinnedText.length < pinnedText.length) {
        this.ctx.logger?.warn?.("compaction-fidelity pinned constraints truncated to fit the injection budget: " + cappedPinnedText.length + "/" + pinnedText.length + " chars");
      }
      if (cappedPinnedText.length > 0) {
        summary.push({ type: 'text', text: pinnedBlockOpen + cappedPinnedText + pinnedBlockClose });
      }
    }
    // Final snapshot: the summary actually delivered to the session. Constraints
    // are evaluated again after compensation, so a raw fingerprint is never
    // reported next to post-compensation constraints. The gate stays a
    // diagnostic: it is logged for calibration and never rewrites the summary.
    const finalFingerprint = buildFingerprint([{ role: "assistant", content: summary.map((block) => ({ type: "text", text: block.text })) }]);
    const finalFidelity = compareFingerprints(preFingerprint, finalFingerprint);
    const deliveredSummaryText = summary.map((block) => block.text).join("\n");
    const finalConstraintComparison = compareConstraintLedger(constraintLedger, deliveredSummaryText);
    const probes = buildFidelityProbes(preFingerprint);
    const rawGate = evaluateFidelityGate({ fingerprint: fidelity, constraints: constraintLedger, probes, summaryText: rawSummaryText });
    const finalGate = evaluateFidelityGate({ fingerprint: finalFidelity, constraints: constraintLedger, probes, summaryText: deliveredSummaryText });
    if (!rawGate.ok) this.ctx.logger?.warn?.("compaction-fidelity raw gate: " + rawGate.failures.join(", "));
    if (!finalGate.ok) this.ctx.logger?.warn?.("compaction-fidelity final gate: " + finalGate.failures.join(", "));
    const anchorQuality = {
      files: referencedFiles.length,
      entries: (anchorText.match(/^  - /gm) ?? []).length,
      chars: anchorText.length,
    };
    let calibration = null;
    try {
      const sample = buildFidelitySample({
        language: preFingerprint.language,
        rawComparison: fidelity,
        finalComparison: finalFidelity,
        compensation,
        constraintComparison: finalConstraintComparison,
        anchorQuality,
        preFingerprint,
      });
      const store = recordFidelitySample(cwd, runtime.indexDir, sample);
      const level = calibrateFidelityLevel(finalFidelity, store.samples, sample.calibrationKey ?? preFingerprint.language);
      calibration = { sample, level: level.level, calibrated: level.calibrated, score: level.score, sampleCount: level.sampleCount, thresholds: level.thresholds, finalFidelity };
    } catch (error) {
      this.ctx.logger?.warn?.("compaction-fidelity calibration failed: " + (error instanceof Error ? error.message : String(error)));
    }
    await this.persistFingerprint(agent, preFingerprint, postFingerprint, fidelity, runtime.indexDir, compensation, finalGate, finalConstraintComparison, calibration);
    return {
      summary,
      rawOutput,
      llmStreamCall: true,
      provider: options.provider,
      model: options.model,
      maxTokens,
      ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
    };
  }
}

export default CompactionFidelityEngine;
