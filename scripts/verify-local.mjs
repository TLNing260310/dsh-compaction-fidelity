import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appNodeModules = process.env.DSH_APP_NODE_MODULES ?? "D:/DSH/DSH Desktop/resources/app/node_modules";
if (!existsSync(appNodeModules)) {
  console.error("DSH_APP_NODE_MODULES not found: " + appNodeModules);
  process.exit(2);
}
const junction = join(pkgRoot, "node_modules");
let createdJunction = false;
if (!existsSync(junction)) {
  symlinkSync(appNodeModules, junction, process.platform === "win32" ? "junction" : "dir");
  createdJunction = true;
}

const home = mkdtempSync(join(tmpdir(), "compaction-fidelity-verify-home-"));
const root = mkdtempSync(join(tmpdir(), "compaction-fidelity-verify-ws-"));
process.env.DSH_HOME = home;
try {
  const { Context } = await import("@deepseek-ai/cordis");
  const { CompactionFidelityEngine } = await import("../src/engine.mjs");
  const host = await import("../src/index.mjs");

  const engineCtx = new Context();
  engineCtx.provide("llm", {
    async resolveModelInfo() { return { context: { contextWindow: 1000000 }, defaultMaxTokens: 65536 }; },
    async *stream() { yield { type: "text-delta", index: 0, text: "ok" }; yield { type: "finish", reason: { kind: "done" } }; },
  });
  engineCtx.provide("tokenMeter", { measure() { return { totalTokens: 0, nodes: [] }; } });
  engineCtx.provide("sessions", {});
  const engine = new CompactionFidelityEngine(engineCtx, { threshold: "256k", anchors: false });
  assert.equal(engine.fidelityConfig.threshold, "256k");
  assert.equal(engine.config.thresholdRatio, 0.8);

  const commands = [];
  const tools = new Map();
  const hostCtx = new Context();
  hostCtx.provide("commands", { register(def) { commands.push(def); return () => {}; } });
  hostCtx.provide("tools", { register(def) { tools.set(def.name, def); return () => {}; } });
  host.apply(hostCtx, { enabled: true, autoIndex: false, anchorInjection: false, indexDir: ".dsh/compaction-fidelity" });
  assert.ok(commands.some((command) => command.name === "compaction-fidelity"));
  assert.ok(tools.has("compaction-fidelity-brief"));
  assert.ok(tools.has("compaction-fidelity-lookup"));

  const agent = {
    session: {
      id: "s1",
      header: { cwd: root, id: "s1" },
      surface: { nodes: [1, 2, 3], replaceGeneration: 0 },
      eventAt: (seq) => ({ seq, type: seq === 1 ? "system/message" : "user/message", data: {} }),
      requestHeader: () => ({ config: { provider: "test", model: "test-model" } }),
      toolHistory: () => [],
    },
    options: { provider: "test", model: "test-model" },
  };
  const summary = await engine.summarize({
    messages: [{ role: "user", content: [{ type: "text", text: "must use pnpm test; file src/app.ts" }] }],
    tools: [],
  }, agent, new AbortController().signal);
  assert.equal(summary.llmStreamCall, true);
  assert.equal(summary.summary[0].text, "ok");

  const calls = [];
  let pressure = { totalTokens: 900000, nodes: [1, 2, 3].map((seq) => ({ seq, tokens: 300000, heuristicTokens: 300000 })) };
  engineCtx.tokenMeter.measure = () => pressure;
  engine.compactRegion = async (start, end) => { calls.push({ start, end }); pressure = { totalTokens: 100000, nodes: [] }; return { shadowedSeqs: [] }; };
  await engine.compactByAbsoluteThreshold(agent, new AbortController().signal);
  assert.deepEqual(calls[0], { start: 2, end: 2 });
  // Provider-anchored calibration: heuristic deltas are inflated by the ratio
  // between the exact provider prompt at the anchor and the heuristic prefix.
  const calibrationMeasurement = {
    totalTokens: 100000,
    baseline: { kind: "usage", tokens: 80000 },
    surfaceDeltaTokens: 20000,
    nodes: [
      { seq: 101, heuristicTokens: 1000 },
      { seq: 102, heuristicTokens: 2000 },
      { seq: 103, heuristicTokens: 1000 },
    ],
  };
  const calibrationAgent = {
    session: {
      id: "s3",
      header: { cwd: root, id: "s3" },
      eventAt: (seq) => seq === 102
        ? { type: "assistant/message", data: { usage: { inputTokens: 50000, cacheReadTokens: 30000 } } }
        : { type: "user/message", data: {} },
      requestHeader: () => ({ config: { provider: "test", model: "test-model", maxTokens: 64000 } }),
    },
    options: {},
  };
  const calibrated = engine.calibrateMeasurement(calibrationAgent, calibrationMeasurement);
  assert.equal(calibrated.calibration.ratio, 4);
  assert.equal(calibrated.totalTokens, 160000);

  // Regression for the absolute-threshold stall: a configured threshold above
  // the model's effective budget must still fall back to the official policy once
  // the measurement exceeds that budget, even though it is below 512k.
  engineCtx.llm.resolveModelInfo = async () => ({ context: { contextWindow: 200000 }, defaultMaxTokens: 64000 });
  const smallAgent = {
    session: {
      id: "s2",
      header: { cwd: root, id: "s2" },
      surface: { nodes: [], replaceGeneration: 0 },
      eventAt: () => undefined,
      requestHeader: () => ({ config: { provider: "test", model: "small", maxTokens: 64000 } }),
      toolHistory: () => [],
    },
    options: { provider: "test", model: "small" },
  };
  let fallbackCalls = 0;
  engine.officialPressureFallback = async () => { fallbackCalls += 1; return null; };
  engineCtx.tokenMeter.measure = () => ({ totalTokens: 50000, baseline: { kind: "estimated", tokens: 50000 }, surfaceDeltaTokens: 0, nodes: [] });
  await engine.compactByAbsoluteThreshold(smallAgent, new AbortController().signal);
  assert.equal(fallbackCalls, 0);
  engineCtx.tokenMeter.measure = () => ({ totalTokens: 100000, baseline: { kind: "estimated", tokens: 100000 }, surfaceDeltaTokens: 0, nodes: [] });
  await engine.compactByAbsoluteThreshold(smallAgent, new AbortController().signal);
  assert.equal(fallbackCalls, 1);

  console.log("verify-local ok");
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  if (createdJunction) rmSync(junction, { recursive: true, force: true });
}


