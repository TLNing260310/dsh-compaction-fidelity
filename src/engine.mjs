import { BlockAssembler, contentHasImage } from '@deepseek-ai/dsh-llm';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction';
import { deepFreeze } from '@deepseek-ai/dsh-util-values';
import z from '@deepseek-ai/schemastery';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { anchorsForFile, briefForRoot, loadIndex, updateAnchorsForFiles } from './project-index.mjs';
import { buildCompensation, buildFingerprint, compareFingerprints } from './fingerprint.mjs';
import { compareConstraintLedger, extractConstraintLedger } from './constraint-ledger.mjs';
import { buildFidelityProbes, evaluateFidelityGate } from './fidelity-gate.mjs';
import { readArchitectureDoc } from './architecture-doc.mjs';
import { pickRetentionRange } from './range.mjs';
import { mergeRuntimeState, normalizeThreshold, resolveAbsoluteThresholdPlan, resolveThresholdPlan } from './state.mjs';
import { buildSummaryInstruction, extractFilePathsFromMessages, extractLedger } from './summarizer.mjs';
import { clampText, isSafeRelativePath } from './util.mjs';

const SUMMARY_LANGUAGES = new Set(['auto', 'zh', 'en', 'bilingual']);

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function estimateToolsTokensForHeader(header) {
  const tools = header?.tools;
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  return Math.ceil(JSON.stringify(tools).length / 4) + 4;
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
              ctx.logger?.warn?.("compaction-fidelity threshold check failed: " + (error instanceof Error ? error.message : String(error)) + "; falling back to official compaction");
              try {
                await engine.officialPressureFallback(agent, signal);
              } catch (fallbackError) {
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

  async persistFingerprint(agent, before, after, comparison, indexDir = this.fidelityConfig.indexDir, compensation = undefined, fidelityGate = undefined, constraintComparison = undefined) {
    try {
      const cwd = agent?.session?.header?.cwd ?? process.cwd();
      const sessionId = String(agent?.session?.id ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
      const dir = join(cwd, indexDir, 'fingerprints');
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
        fidelity: comparison,
        ...(compensation === undefined ? {} : { compensation: { maxTokens: compensation.maxTokens, tokens: compensation.tokens, truncated: compensation.truncated, entriesByCategory: compensation.entriesByCategory, omittedByCategory: compensation.omittedByCategory } }),
        ...(fidelityGate === undefined ? {} : { gate: fidelityGate }),
        ...(constraintComparison === undefined ? {} : { constraints: constraintComparison }),
        before: summarizeSide(before),
        after: summarizeSide(after),
      };
      await writeFile(join(dir, `${sessionId}-${Date.now()}.json`), JSON.stringify(record, null, 2), 'utf8');
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-compaction-fidelity fingerprint persist failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async summarize(input, agent, signal) {
    const runtime = this.runtimeFor(agent);
    if (!runtime.enabled) return super.summarize(input, agent, signal);
    return this.summarizeFidelity(input, agent, signal, runtime);
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
        const index = loadIndex(cwd, runtime.indexDir);
        if (index !== null) {
          brief = clampText(briefForRoot(cwd, runtime.indexDir) ?? index.brief ?? '', 3000);
          const lines = [];
          for (const file of referencedFiles.slice(0, 12)) {
            const anchors = anchorsForFile(cwd, runtime.indexDir, file, this.fidelityConfig.anchorsPerFile);
            if (anchors === null || anchors.length === 0) continue;
            lines.push(`- ${file}`);
            for (const anchor of anchors) lines.push(`  - [${anchor.kind}] ${anchor.path} — ${anchor.reason}`);
          }
          anchorText = lines.join('\n');
        }
        if (referencedFiles.length > 0) {
          updateAnchorsForFiles(cwd, runtime.indexDir, referencedFiles.slice(0, 24), { anchorsPerFile: this.fidelityConfig.anchorsPerFile });
        }
      } catch (error) {
        this.ctx.logger?.warn?.(`compaction-fidelity anchor lookup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    let architectureDocs = "";
    try {
      const seenDocs = new Set();
      const docLines = [];
      for (const file of referencedFiles.slice(0, 8)) {
        let dir = file;
        for (let depth = 0; depth < 6; depth += 1) {
          const parts = dir.split("/");
          parts.pop();
          dir = parts.join("/");
          if (dir.length === 0) dir = ".";
          const doc = readArchitectureDoc(cwd, dir, "ARCHITECTURE.md");
          if (doc !== null && !seenDocs.has(doc.relative)) {
            seenDocs.add(doc.relative);
            docLines.push("### " + doc.relative + "\n" + clampText(doc.text, 4000));
          }
          if (dir === ".") break;
        }
      }
      architectureDocs = docLines.join("\n\n");
    } catch (error) {
      this.ctx.logger?.warn?.("compaction-fidelity architecture doc lookup failed: " + (error instanceof Error ? error.message : String(error)));
    }
    const constraintLedger = extractConstraintLedger(input.messages ?? []);
    const instruction = buildSummaryInstruction({
      language: runtime.summaryLanguage,
      ledger,
      brief,
      anchors: anchorText,
      constraints: constraintLedger.constraints,
      architectureDocs,
    });
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
    const compensation = buildCompensation(fidelity, { maxTokens: this.fidelityConfig.compensationMaxTokens });
    if (compensation.text.length > 0) summary.push({ type: 'text', text: compensation.text });
    const summaryPlain = summary.map((block) => block.text).join("\n");
    const constraintComparison = compareConstraintLedger(constraintLedger, summaryPlain);
    const pinned = constraintComparison.verdicts.filter((verdict) => verdict.verdict !== "preserved");
    if (pinned.length > 0) {
      const pinnedText = pinned.map((verdict, index) => "- [" + (index + 1) + "] " + verdict.text).join("\n");
      summary.push({ type: 'text', text: "<pinned_constraints>\n" + pinnedText + "\n</pinned_constraints>" });
    }
    const gate = evaluateFidelityGate({ fingerprint: fidelity, constraints: constraintLedger, probes: buildFidelityProbes(preFingerprint), summaryText: summary.map((block) => block.text).join("\n") });
    if (!gate.ok) this.ctx.logger?.warn?.("compaction-fidelity gate: " + gate.failures.join(", "));
    await this.persistFingerprint(agent, preFingerprint, postFingerprint, fidelity, runtime.indexDir, compensation, gate, constraintComparison);
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











