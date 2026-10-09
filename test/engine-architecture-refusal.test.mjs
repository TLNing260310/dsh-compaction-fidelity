import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dshPeerPath = fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh-compaction-basic/package.json', import.meta.url));
const hasDshPeers = existsSync(dshPeerPath);
const skipWithoutPeers = { skip: hasDshPeers ? false : 'DSH peer modules are not linked' };

function agentFor(root, id) {
  return {
    session: {
      id,
      header: { cwd: root, id },
      requestHeader: () => ({ config: { provider: 'test', model: 'test-model' } }),
      toolHistory: () => [],
    },
    options: { provider: 'test', model: 'test-model' },
  };
}

async function runEngineSummary(root, messages, sessionId) {
  const [{ CompactionFidelityEngine }, { Context }] = await Promise.all([
    import('../src/engine.mjs'),
    import('@deepseek-ai/cordis'),
  ]);
  let capturedPrompt = '';
  const engineCtx = new Context();
  engineCtx.provide('llm', {
    async resolveModelInfo() { return { context: { contextWindow: 1000000 }, defaultMaxTokens: 65536 }; },
    async *stream(options) {
      capturedPrompt = options.messages.at(-1).content[0].text;
      yield { type: 'text-delta', index: 0, text: 'engine refusal summary' };
      yield { type: 'finish', reason: { kind: 'done' } };
    },
  });
  engineCtx.provide('tokenMeter', { measure() { return { totalTokens: 0, nodes: [] }; } });
  engineCtx.provide('sessions', {});
  const engine = new CompactionFidelityEngine(engineCtx, {
    threshold: '256k',
    anchors: true,
    indexDir: '.dsh/compaction-fidelity',
    injectionMaxTokens: 16000,
    compensationMaxTokens: 128,
  });
  const agent = agentFor(root, sessionId);
  const result = await engine.summarizeFidelity({ messages, tools: [] }, agent, new AbortController().signal, engine.runtimeFor(agent));
  return { capturedPrompt, result };
}

test('engine compaction completes when the registry is corrupt and skips architecture retrieval', skipWithoutPeers, async () => {
  const root = mkdtempSync(join(tmpdir(), 'compaction-fidelity-engine-corrupt-'));
  try {
    mkdirSync(join(root, 'module'), { recursive: true });
    mkdirSync(join(root, '.dsh', 'compaction-fidelity'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'engine-corrupt-fixture' }), 'utf8');
    writeFileSync(join(root, 'module', 'file.ts'), 'export const value = 1;\n', 'utf8');
    writeFileSync(join(root, 'ARCHITECTURE.md'), '# Root\n\nCORRUPT_FALLBACK_MARKER\n', 'utf8');
    const registryPath = join(root, '.dsh', 'compaction-fidelity', 'architecture-scopes.json');
    const corruptText = '{ not json';
    writeFileSync(registryPath, corruptText, 'utf8');
    const { capturedPrompt, result } = await runEngineSummary(root, [
      { role: 'user', content: [{ type: 'text', text: 'inspect module/file.ts' }] },
    ], 'engine-corrupt-session');
    assert.ok(result.summary.some((block) => block.type === 'text' && block.text.includes('engine refusal summary')), 'compaction must still produce a summary');
    assert.ok(!capturedPrompt.includes('CORRUPT_FALLBACK_MARKER'), 'a corrupt registry must not fall back to the default document');
    assert.equal(readFileSync(registryPath, 'utf8'), corruptText, 'a corrupt registry must not be rewritten');
    assert.equal(existsSync(join(root, '.dsh', 'compaction-fidelity', 'architecture-baseline.json')), false, 'refused retrieval must not write a baseline');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('engine compaction completes when an ancestor scope is denied and skips only that document', skipWithoutPeers, async () => {
  const root = mkdtempSync(join(tmpdir(), 'compaction-fidelity-engine-denied-ancestor-'));
  try {
    const { appendArchitectureUpdate, renderArchitectureDoc } = await import('../src/architecture-doc.mjs');
    mkdirSync(join(root, 'app'), { recursive: true });
    mkdirSync(join(root, '.dsh', 'compaction-fidelity'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'engine-denied-ancestor-fixture' }), 'utf8');
    writeFileSync(join(root, 'app', 'file.ts'), 'export const app = 1;\n', 'utf8');
    writeFileSync(join(root, 'app', 'ARCHITECTURE.md'), '# App\n\nDENIED_ANCESTOR_MARKER\n', 'utf8');
    const rootDoc = appendArchitectureUpdate(
      renderArchitectureDoc({ scope: '.', index: { archFiles: [], files: [], commands: [], dbFiles: [] } }),
      { scope: '.', summary: 'ROOT_ALLOWED_MARKER' },
    );
    writeFileSync(join(root, 'ARCHITECTURE.md'), rootDoc, 'utf8');
    writeFileSync(join(root, '.dsh', 'compaction-fidelity', 'architecture-scopes.json'), JSON.stringify({
      version: 2,
      scopes: { '.': { doc: 'ARCHITECTURE.md', include: [], exclude: ['app/**'] } },
    }), 'utf8');
    const { capturedPrompt, result } = await runEngineSummary(root, [
      { role: 'user', content: [{ type: 'text', text: 'inspect app/file.ts' }] },
    ], 'engine-denied-ancestor-session');
    assert.ok(result.summary.some((block) => block.type === 'text' && block.text.includes('engine refusal summary')), 'compaction must still produce a summary');
    assert.ok(!capturedPrompt.includes('DENIED_ANCESTOR_MARKER'), 'a denied ancestor scope must not inject its document');
    assert.ok(capturedPrompt.includes('ROOT_ALLOWED_MARKER'), 'the allowed root document must still be injected');
    assert.equal(existsSync(join(root, '.dsh', 'compaction-fidelity', 'architecture-baseline.json')), false, 'refused retrieval must not write a baseline');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


function createEngineProbe(EngineClass) {
  const engine = Object.create(EngineClass.prototype);
  engine.ctx = { logger: { warn() {}, info() {} } };
  engine.thresholdInFlight = new Set();
  return engine;
}

test('a cancelled threshold compaction terminates without the official fallback', skipWithoutPeers, async () => {
  const { CompactionFidelityEngine } = await import('../src/engine.mjs');
  const engine = createEngineProbe(CompactionFidelityEngine);
  const aborted = new Error('cancelled');
  aborted.name = 'AbortError';
  engine.compactByAbsoluteThreshold = async () => { throw aborted; };
  let fallbacks = 0;
  engine.officialPressureFallback = async () => { fallbacks += 1; };
  let nextCalls = 0;
  await assert.rejects(
    () => engine.handlePreStep({ session: { id: 'engine-cancel' } }, { aborted: false }, async () => { nextCalls += 1; return { kind: 'ok' }; }),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(fallbacks, 0, 'a cancellation must not enter the official fallback');
  assert.equal(nextCalls, 0, 'a cancelled step must not continue next()');
});

test('a non-cancellation threshold failure still reaches the official fallback', skipWithoutPeers, async () => {
  const { CompactionFidelityEngine } = await import('../src/engine.mjs');
  const engine = createEngineProbe(CompactionFidelityEngine);
  engine.compactByAbsoluteThreshold = async () => { throw new Error('boom'); };
  let fallbacks = 0;
  engine.officialPressureFallback = async () => { fallbacks += 1; return null; };
  let nextCalls = 0;
  const result = await engine.handlePreStep({ session: { id: 'engine-fallback' } }, { aborted: false }, async () => { nextCalls += 1; return { kind: 'ok' }; });
  assert.equal(fallbacks, 1);
  assert.equal(nextCalls, 1);
  assert.deepEqual(result, { kind: 'ok' });
});

test('a cancellation raised by the official fallback also propagates', skipWithoutPeers, async () => {
  const { CompactionFidelityEngine } = await import('../src/engine.mjs');
  const engine = createEngineProbe(CompactionFidelityEngine);
  const aborted = new Error('cancelled during fallback');
  aborted.name = 'AbortError';
  engine.compactByAbsoluteThreshold = async () => { throw new Error('boom'); };
  engine.officialPressureFallback = async () => { throw aborted; };
  await assert.rejects(
    () => engine.handlePreStep({ session: { id: 'engine-fallback-cancel' } }, { aborted: false }, async () => ({ kind: 'ok' })),
    (error) => error?.name === 'AbortError',
  );
});

test('the pre-step listener delegates to handlePreStep', skipWithoutPeers, async () => {
  const source = readFileSync(new URL('../src/engine.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('return engine.handlePreStep(agent, signal, next);'), 'the host listener must delegate to the testable hook body');
});
