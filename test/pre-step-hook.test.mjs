import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { MAX_ARCHITECTURE_DOC_BYTES, appendArchitectureUpdate, renderArchitectureDoc } from '../src/architecture-doc.mjs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTextTokens } from '../src/util.mjs';

const sourcePath = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
const dshPeerPath = fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh-tools/package.json', import.meta.url));
const hasDshPeers = existsSync(dshPeerPath);

function createContext(apply, config = {}) {
  const listeners = new Map();
  const disposers = [];
  const definitions = new Map();
  const ctx = {
    logger: { warn() {}, info() {} },
    effect(generator) {
      const iterator = generator();
      let step = iterator.next();
      while (!step.done) {
        if (typeof step.value === 'function') disposers.push(step.value);
        step = iterator.next();
      }
    },
    commands: { register(definition) { definitions.set(definition.name, definition); return () => {}; } },
    tools: { register() { return () => {}; } },
    on(event, handler) {
      listeners.set(event, handler);
      return () => {};
    },
    listeners,
    definitions,
    dispose() {
      while (disposers.length > 0) disposers.pop()();
    },
  };
  apply(ctx, { autoIndex: false, architectureDocName: 'ARCHITECTURE.md', ...config });
  return ctx;
}

const agentFor = (cwd, id) => ({ session: { id, header: { cwd } } });
const decisionWith = (text) => ({ messages: [{ role: 'user', content: [{ type: 'text', text }] }] });

test('pre-step guards cancellation and isolates helper failures', () => {
  const source = readFileSync(sourcePath, 'utf8');
  const nextIndex = source.indexOf('const decision = await next();');
  assert.ok(nextIndex >= 0, 'pre-step decision await not found');
  const guardIndex = source.indexOf('if (preStepStopped(signal, decision)) {', nextIndex);
  assert.ok(guardIndex > nextIndex, 'the cancellation guard must follow next()');
  assert.ok(guardIndex - nextIndex < 400, 'the cancellation guard must not sit behind the architecture branch');
  assert.ok(source.slice(guardIndex, guardIndex + 120).includes('cancelQueuedIndex(stepCwd);'), 'a stopped step must drop the queued index build');

  const createIndex = source.indexOf('const created = createArchitectureDocument(askedCwd, scope);');
  assert.ok(createIndex > 0, 'document creation call not found');
  const createGuard = source.lastIndexOf('if (preStepStopped(signal, decision)) return decision;', createIndex);
  assert.ok(createGuard > guardIndex && createGuard < createIndex, 'creating a document must re-check cancellation');

  const reminderIndex = source.indexOf('mutateReminderState(askedCwd, cfg.indexDir,');
  assert.ok(reminderIndex > 0, 'reminder mutation call not found');
  const reminderGuard = source.lastIndexOf('if (preStepStopped(signal, decision)) return decision;', reminderIndex);
  assert.ok(reminderGuard > createIndex && reminderGuard < reminderIndex, 'reminder bookkeeping must re-check cancellation');

  const branchIndex = source.indexOf('if (cfg.architectureDoc && getGlobalState()?.enabled !== false && !isMasterDisabled()) {');
  const tryIndex = source.indexOf('try {', branchIndex);
  assert.ok(tryIndex > branchIndex, 'the architecture branch must be wrapped for isolation');
  assert.ok(source.includes('architecture pre-step failed'), 'helper failures must be logged, not thrown');
  assert.ok(source.includes('readArchitectureConsent(pending, last)'), 'consent must come from the policy module');
});

test('pre-step scope adoption never references a block-local target', () => {
  const source = readFileSync(sourcePath, 'utf8');
  const start = source.indexOf('const detection = detectTaskFolders');
  const end = source.indexOf('const knownScopes = new Set', start);
  assert.ok(start >= 0 && end > start, 'pre-step scope block not found');
  const region = source.slice(start, end);
  assert.ok(!region.includes('rememberArchitectureScope(agent, target.relativeDir)'));
  assert.ok(region.includes('const access = architectureDocAccess(askedCwd, target.relativeDir);'), 'the prompt path must check policy first');
  assert.ok(region.includes('const primaryAccess = architectureDocAccess(askedCwd, detection.primary.relativeDir);'), 'scope adoption must check policy first');
  assert.ok(region.includes('if (primaryAccess.ok === true) rememberArchitectureScope(agent, detection.primary.relativeDir);'), 'adoption must be conditional on an allowed scope');
  const createdIndex = source.indexOf('const created = createArchitectureDocument(askedCwd, scope);');
  const okCheckIndex = source.indexOf('if (created.ok !== true)', createdIndex);
  const rememberIndex = source.indexOf('rememberArchitectureScope(agent, scope);', okCheckIndex);
  assert.ok(createdIndex > 0 && okCheckIndex > createdIndex, 'a refused creation must be checked before any notice');
  assert.ok(rememberIndex > okCheckIndex, 'registration must happen only after the creation is allowed');
});

test('pre-step hook handles single-candidate consent, ambiguity, and decline', { skip: hasDshPeers ? false : 'DSH peer modules are not linked' }, async () => {
  const { apply } = await import('../src/index.mjs');
  const root = mkdtempSync(join(tmpdir(), 'compaction-fidelity-pre-step-'));
  const ambiguousRoot = mkdtempSync(join(tmpdir(), 'compaction-fidelity-pre-step-ambiguous-'));
  try {
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(join(root, 'app', 'index.ts'), 'export const app = 1;\n', 'utf8');
    const ctx = createContext(apply);
    const handler = ctx.listeners.get('agent/pre-step');
    assert.equal(typeof handler, 'function');
    const agent = agentFor(root, 'single-session');
    const first = await handler({ agent, signal: { aborted: false } }, async () => decisionWith('Please work in app'));
    assert.ok(JSON.stringify(first).includes('请先向用户确认'));
    assert.equal(existsSync(join(root, 'app', 'ARCHITECTURE.md')), false);
    assert.equal(existsSync(join(root, '.dsh', 'compaction-fidelity', 'architecture-scopes.json')), false);
    const second = await handler({ agent, signal: { aborted: false } }, async () => decisionWith('创建'));
    assert.ok(JSON.stringify(second).includes('已创建'));
    assert.equal(existsSync(join(root, 'app', 'ARCHITECTURE.md')), true);
    const registry = readFileSync(join(root, '.dsh', 'compaction-fidelity', 'architecture-scopes.json'), 'utf8');
    assert.ok(registry.includes('app'));

    mkdirSync(join(ambiguousRoot, 'app'), { recursive: true });
    mkdirSync(join(ambiguousRoot, 'pkg'), { recursive: true });
    writeFileSync(join(ambiguousRoot, 'app', 'index.ts'), 'export const a = 1;\n', 'utf8');
    writeFileSync(join(ambiguousRoot, 'pkg', 'index.ts'), 'export const p = 1;\n', 'utf8');
    const ctx2 = createContext(apply);
    const handler2 = ctx2.listeners.get('agent/pre-step');
    const agent2 = agentFor(ambiguousRoot, 'ambiguous-session');
    const ambiguous = await handler2({ agent: agent2, signal: { aborted: false } }, async () => decisionWith('Please work in app, in pkg'));
    assert.ok(JSON.stringify(ambiguous).includes('检测到多个候选任务文件夹'));
    assert.equal(existsSync(join(ambiguousRoot, '.dsh', 'compaction-fidelity', 'architecture-scopes.json')), false);
    const declined = await handler2({ agent: agent2, signal: { aborted: false } }, async () => decisionWith('不用'));
    assert.ok(JSON.stringify(declined).includes('检测到多个候选任务文件夹') || declined !== undefined);
    assert.equal(existsSync(join(ambiguousRoot, '.dsh', 'compaction-fidelity', 'architecture-scopes.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(ambiguousRoot, { recursive: true, force: true });
  }
});

test('disposing the plugin cancels an already queued index build', { skip: hasDshPeers ? false : 'DSH peer modules are not linked' }, async () => {
  const { apply } = await import('../src/index.mjs');
  const root = mkdtempSync(join(tmpdir(), 'compaction-fidelity-queued-index-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), 'export const value = 1;\n', 'utf8');
    const ctx = createContext(apply, { autoIndex: true });
    const handler = ctx.listeners.get('agent/pre-step');
    assert.equal(typeof handler, 'function');
    const agent = agentFor(root, 'queued-index-session');
    await handler({ agent, signal: { aborted: false } }, async () => decisionWith('hello'));
    ctx.dispose();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(existsSync(join(root, '.dsh', 'compaction-fidelity', 'index.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('architecture refresh uses one fresh snapshot for the document and baseline', { skip: hasDshPeers ? false : 'DSH peer modules are not linked' }, async () => {
  const { apply } = await import('../src/index.mjs');
  const root = mkdtempSync(join(tmpdir(), 'compaction-fidelity-refresh-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'app.ts'), 'export const app = 1;\n', 'utf8');
    const ctx = createContext(apply, { autoIndex: false });
    const command = ctx.definitions.get('compaction-fidelity');
    assert.equal(typeof command?.handler, 'function');
    const agent = agentFor(root, 'refresh-session');
    const created = await command.handler({ rawInput: 'architecture create .', agent });
    assert.equal(created.kind, 'success');
    writeFileSync(join(root, 'src', 'index.ts'), 'export const added = true;\n', 'utf8');
    const refreshed = await command.handler({ rawInput: 'architecture refresh .', agent });
    assert.equal(refreshed.kind, 'success');
    const doc = readFileSync(join(root, 'ARCHITECTURE.md'), 'utf8');
    assert.ok(doc.includes('src/index.ts'));
    const baseline = JSON.parse(readFileSync(join(root, '.dsh', 'compaction-fidelity', 'architecture-baseline.json'), 'utf8'));
    assert.ok(baseline.scopes['.'].files['src/index.ts'] !== undefined);
    writeFileSync(join(root, 'src', 'late.ts'), 'export const late = true;\n', 'utf8');
    const { detectSemanticChanges } = await import('../src/architecture-changes.mjs');
    const later = detectSemanticChanges(root, '.', { indexDir: '.dsh/compaction-fidelity', docName: 'ARCHITECTURE.md' });
    assert.ok(later.changedFiles.includes('src/late.ts'), 'the baseline must be the refresh-time snapshot');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('engine applies managed exclusions, runtime anchors, and the full pinned budget', { skip: hasDshPeers ? false : 'DSH peer modules are not linked' }, async () => {
  const [{ CompactionFidelityEngine }, { Context }, { buildIndex }, { retrievalPolicyFor }] = await Promise.all([
    import('../src/engine.mjs'),
    import('@deepseek-ai/cordis'),
    import('../src/project-index.mjs'),
    import('../src/architecture-registry.mjs'),
  ]);
  const root = mkdtempSync(join(tmpdir(), 'compaction-fidelity-engine-hooks-'));
  try {
    mkdirSync(join(root, 'module'), { recursive: true });
    mkdirSync(join(root, '.dsh', 'compaction-fidelity'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'engine-hook-fixture' }), 'utf8');
    writeFileSync(join(root, 'module', 'file.ts'), 'export const value = 1;\n', 'utf8');
    writeFileSync(join(root, 'module', 'ARCHITECTURE.md'), '# Module\n\nEXCLUDED_ARCHITECTURE_MARKER\n', 'utf8');
    mkdirSync(join(root, 'later'), { recursive: true });
    let thickDoc = renderArchitectureDoc({ scope: 'later' });
    for (let index = 0; index < 4; index += 1) {
      thickDoc = appendArchitectureUpdate(thickDoc, { scope: 'later', summary: 'filler-' + index + ' ' + 'x'.repeat(900) });
    }
    thickDoc = appendArchitectureUpdate(thickDoc, { scope: 'later', summary: 'NEWEST_ARCHITECTURE_UPDATE_MARKER' });
    writeFileSync(join(root, 'later', 'ARCHITECTURE.md'), thickDoc, 'utf8');
    writeFileSync(join(root, '.dsh', 'compaction-fidelity', 'architecture-scopes.json'), JSON.stringify({
      version: 2,
      scopes: {
        module: { doc: 'ARCHITECTURE.md', include: [], exclude: ['ARCHITECTURE.md'] },
        later: { doc: 'ARCHITECTURE.md', include: [], exclude: [] },
      },
    }), 'utf8');
    // Build the fixture index the way the plugin does: stamped with the current
    // read policy, so a policy-rejected cache cannot pass as plugin-produced.
    const fixturePolicy = retrievalPolicyFor(root, '.dsh/compaction-fidelity');
    buildIndex(root, {
      indexDir: '.dsh/compaction-fidelity',
      filterFile: fixturePolicy.filterFile,
      scopeFingerprint: fixturePolicy.fingerprint,
    });
    const agent = {
      session: {
        id: 'engine-hook-session',
        header: { cwd: root, id: 'engine-hook-session' },
        requestHeader: () => ({ config: { provider: 'test', model: 'test-model' } }),
        toolHistory: () => [],
      },
      options: { provider: 'test', model: 'test-model' },
    };

    let capturedPrompt = '';
    const llmService = {
      async resolveModelInfo() { return { context: { contextWindow: 1000000 }, defaultMaxTokens: 65536 }; },
      async *stream(options) {
        capturedPrompt = options.messages.at(-1).content[0].text;
        yield { type: 'text-delta', index: 0, text: 'summary without constraints' };
        yield { type: 'finish', reason: { kind: 'done' } };
      },
    };
    const engineCtx = new Context();
    engineCtx.provide('llm', llmService);
    engineCtx.provide('tokenMeter', { measure() { return { totalTokens: 0, nodes: [] }; } });
    engineCtx.provide('sessions', {});
    const engine = new CompactionFidelityEngine(engineCtx, {
      threshold: '256k',
      anchors: true,
      indexDir: '.dsh/compaction-fidelity',
      injectionMaxTokens: 16000,
      compensationMaxTokens: 128,
    });
    const runtime = engine.runtimeFor(agent);
    assert.equal(runtime.anchors, true);
    const result = await engine.summarizeFidelity({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'inspect module/file.ts. MUST use pnpm test' }] }],
      tools: [],
    }, agent, new AbortController().signal, runtime);
    assert.ok(capturedPrompt.includes('compaction_fidelity_project_brief'));
    assert.ok(!capturedPrompt.includes('EXCLUDED_ARCHITECTURE_MARKER'));
    // An appended update log used to be unreachable: the file head was injected,
    // so every later update fell outside the excerpt. The newest update must now
    // reach the prompt, and the section coordinates must survive with it.
    assert.ok(capturedPrompt.includes('NEWEST_ARCHITECTURE_UPDATE_MARKER'), 'the newest architecture update must be injected');
    assert.ok(capturedPrompt.includes('7. Update Log'), 'architecture section coordinates must survive the excerpt');
    assert.ok(result.summary.some((block) => block.type === 'text' && block.text.startsWith('<pinned_constraints>')));

    let budgetPrompt = '';
    const budgetCtx = new Context();
    budgetCtx.provide('llm', {
      async resolveModelInfo() { return { context: { contextWindow: 1000000 }, defaultMaxTokens: 65536 }; },
      async *stream(options) {
        budgetPrompt = options.messages.at(-1).content[0].text;
        yield { type: 'text-delta', index: 0, text: 'summary without constraints' };
        yield { type: 'finish', reason: { kind: 'done' } };
      },
    });
    budgetCtx.provide('tokenMeter', { measure() { return { totalTokens: 0, nodes: [] }; } });
    budgetCtx.provide('sessions', {});
    const budgetEngine = new CompactionFidelityEngine(budgetCtx, {
      threshold: '256k',
      anchors: false,
      indexDir: '.dsh/compaction-fidelity',
      injectionMaxTokens: 2048,
      compensationMaxTokens: 128,
    });
    const constraints = Array.from({ length: 80 }, (_value, index) => `MUST preserve exact value marker-${index}-alpha`).join('; ');
    const budgetResult = await budgetEngine.summarizeFidelity({
      messages: [{ role: 'user', content: [{ type: 'text', text: constraints }] }],
      tools: [],
    }, agent, new AbortController().signal, budgetEngine.runtimeFor(agent));
    const pinned = budgetResult.summary.find((block) => block.type === 'text' && block.text.startsWith('<pinned_constraints>'));
    assert.ok(pinned !== undefined);
    const instructionTokens = estimateTextTokens(budgetPrompt);
    const pinnedTokens = estimateTextTokens(pinned.text);
    assert.ok(instructionTokens + pinnedTokens <= 2048, `instruction=${instructionTokens} pinned=${pinnedTokens}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('pre-step checks policy before prompting, adopting, or creating', () => {
  const source = readFileSync(sourcePath, 'utf8');
  const detectionStart = source.indexOf('const detection = detectTaskFolders');
  const accessIndex = source.indexOf('const access = architectureDocAccess(askedCwd, target.relativeDir);', detectionStart);
  const adoptIndex = source.indexOf('const primaryAccess = architectureDocAccess', detectionStart);
  const rememberIndex = source.indexOf('rememberArchitectureScope(agent, detection.primary.relativeDir)', detectionStart);
  assert.ok(detectionStart > 0 && accessIndex > detectionStart, 'the single-candidate prompt must check policy first');
  assert.ok(adoptIndex > accessIndex && rememberIndex > adoptIndex, 'adoption must be gated by the policy check');
});

test('a refused scope never prompts, registers, or creates', { skip: hasDshPeers ? false : 'DSH peer modules are not linked' }, async () => {
  const { apply } = await import('../src/index.mjs');
  const root = mkdtempSync(join(tmpdir(), 'compaction-fidelity-pre-step-refused-'));
  try {
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(join(root, 'app', 'index.ts'), 'export const app = 1;\n', 'utf8');
    const registryPath = join(root, '.dsh', 'compaction-fidelity', 'architecture-scopes.json');
    mkdirSync(dirname(registryPath), { recursive: true });
    const registryText = JSON.stringify({ version: 2, scopes: { app: { doc: 'ARCHITECTURE.md', include: [], exclude: ['**'] } } }, null, 2);
    writeFileSync(registryPath, registryText, 'utf8');
    const ctx = createContext(apply);
    const handler = ctx.listeners.get('agent/pre-step');
    const agent = agentFor(root, 'refused-session');
    const first = await handler({ agent, signal: { aborted: false } }, async () => decisionWith('Please work in app'));
    assert.ok(!JSON.stringify(first).includes('请先向用户确认'), 'a refused scope must not be prompted');
    assert.equal(existsSync(join(root, 'app', 'ARCHITECTURE.md')), false);
    assert.equal(readFileSync(registryPath, 'utf8'), registryText);
    const second = await handler({ agent, signal: { aborted: false } }, async () => decisionWith('创建'));
    assert.equal(existsSync(join(root, 'app', 'ARCHITECTURE.md')), false, 'a refused scope must not be created later');
    assert.equal(readFileSync(registryPath, 'utf8'), registryText);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a granted creation prompt is re-checked before the write', { skip: hasDshPeers ? false : 'DSH peer modules are not linked' }, async () => {
  const { apply } = await import('../src/index.mjs');
  const root = mkdtempSync(join(tmpdir(), 'compaction-fidelity-pre-step-revoked-'));
  try {
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(join(root, 'app', 'index.ts'), 'export const app = 1;\n', 'utf8');
    const ctx = createContext(apply);
    const handler = ctx.listeners.get('agent/pre-step');
    const agent = agentFor(root, 'revoked-session');
    const first = await handler({ agent, signal: { aborted: false } }, async () => decisionWith('Please work in app'));
    assert.ok(JSON.stringify(first).includes('请先向用户确认'));
    const registryPath = join(root, '.dsh', 'compaction-fidelity', 'architecture-scopes.json');
    mkdirSync(dirname(registryPath), { recursive: true });
    writeFileSync(registryPath, JSON.stringify({ version: 2, scopes: { app: { doc: 'ARCHITECTURE.md', include: [], exclude: ['**'] } } }, null, 2), 'utf8');
    const second = await handler({ agent, signal: { aborted: false } }, async () => decisionWith('创建'));
    assert.equal(existsSync(join(root, 'app', 'ARCHITECTURE.md')), false, 'consent given before the rule change must not create a refused document');
    assert.ok(JSON.stringify(second).includes('无法创建'), 'the refusal must be reported instead of creating');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('a cancelled step schedules no index build', { skip: hasDshPeers ? false : 'DSH peer modules are not linked' }, async () => {
  const { apply } = await import('../src/index.mjs');
  const root = mkdtempSync(join(tmpdir(), 'compaction-fidelity-cancelled-queue-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), 'export const value = 1;\n', 'utf8');
    const ctx = createContext(apply, { autoIndex: true });
    const handler = ctx.listeners.get('agent/pre-step');
    const agent = agentFor(root, 'cancelled-queue-session');
    await handler({ agent, signal: { aborted: true } }, async () => decisionWith('hello'));
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(existsSync(join(root, '.dsh', 'compaction-fidelity', 'index.json')), false, 'a cancelled step must not build an index');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a rejected step drops the queued index build', { skip: hasDshPeers ? false : 'DSH peer modules are not linked' }, async () => {
  const { apply } = await import('../src/index.mjs');
  const root = mkdtempSync(join(tmpdir(), 'compaction-fidelity-rejected-queue-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), 'export const value = 1;\n', 'utf8');
    const ctx = createContext(apply, { autoIndex: true });
    const handler = ctx.listeners.get('agent/pre-step');
    const agent = agentFor(root, 'rejected-queue-session');
    await handler({ agent, signal: { aborted: false } }, async () => ({ kind: 'reject' }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(existsSync(join(root, '.dsh', 'compaction-fidelity', 'index.json')), false, 'a rejected step must not build an index');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a queued index re-reads the registry policy before scanning', { skip: hasDshPeers ? false : 'DSH peer modules are not linked' }, async () => {
  const { apply } = await import('../src/index.mjs');
  const root = mkdtempSync(join(tmpdir(), 'compaction-fidelity-queue-policy-'));
  try {
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(join(root, 'app', 'hidden.ts'), 'export const hidden = 1;\n', 'utf8');
    const ctx = createContext(apply, { autoIndex: true });
    const handler = ctx.listeners.get('agent/pre-step');
    const agent = agentFor(root, 'queue-policy-session');
    const running = handler({ agent, signal: { aborted: false } }, async () => decisionWith('hello'));
    const indexDir = join(root, '.dsh', 'compaction-fidelity');
    mkdirSync(indexDir, { recursive: true });
    writeFileSync(join(indexDir, 'architecture-scopes.json'), JSON.stringify({
      version: 2,
      scopes: { app: { doc: 'ARCHITECTURE.md', include: [], exclude: ['**'] } },
    }), 'utf8');
    await running;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const indexFile = join(indexDir, 'index.json');
    assert.equal(existsSync(indexFile), true, 'the queued index should still build under the current policy');
    const index = JSON.parse(readFileSync(indexFile, 'utf8'));
    assert.ok(index.files.every((entry) => !entry.p.startsWith('app/')), 'a stale enqueue-time policy must not be reused');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a too-large document is refused before any refresh mutation', { skip: hasDshPeers ? false : 'DSH peer modules are not linked' }, async () => {
  const { apply } = await import('../src/index.mjs');
  const root = mkdtempSync(join(tmpdir(), 'compaction-fidelity-too-large-refresh-'));
  try {
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(join(root, 'app', 'index.ts'), 'export const app = 1;\n', 'utf8');
    const docPath = join(root, 'app', 'ARCHITECTURE.md');
    const oversized = 'x'.repeat(MAX_ARCHITECTURE_DOC_BYTES + 1);
    writeFileSync(docPath, oversized, 'utf8');
    const ctx = createContext(apply);
    const command = ctx.definitions.get('compaction-fidelity');
    const agent = agentFor(root, 'too-large-refresh-session');
    const result = await command.handler({ rawInput: 'architecture refresh app', agent });
    assert.equal(result.kind, 'error');
    assert.ok(result.text.includes('超过大小限制'), result.text);
    assert.equal(readFileSync(docPath, 'utf8').length, oversized.length, 'an oversized document must not be replaced');
    assert.equal(existsSync(join(root, '.dsh', 'compaction-fidelity', 'architecture-baseline.json')), false, 'a refused refresh must not write a baseline');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('a slow rejection cannot leave a queued index behind', { skip: hasDshPeers ? false : 'DSH peer modules are not linked' }, async () => {
  const { apply } = await import('../src/index.mjs');
  const root = mkdtempSync(join(tmpdir(), 'compaction-fidelity-slow-reject-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), 'export const value = 1;\n', 'utf8');
    const ctx = createContext(apply, { autoIndex: true });
    const handler = ctx.listeners.get('agent/pre-step');
    const agent = agentFor(root, 'slow-reject-session');
    const startedAt = Date.now();
    const result = await handler({ agent, signal: { aborted: false } }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { kind: 'reject' };
    });
    assert.equal(result.kind, 'reject');
    assert.ok(Date.now() - startedAt >= 380, 'the host decision must be awaited');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(existsSync(join(root, '.dsh', 'compaction-fidelity', 'index.json')), false, 'a slow rejection must not schedule a scan');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a thrown host failure cannot schedule an index', { skip: hasDshPeers ? false : 'DSH peer modules are not linked' }, async () => {
  const { apply } = await import('../src/index.mjs');
  const root = mkdtempSync(join(tmpdir(), 'compaction-fidelity-throw-queue-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), 'export const value = 1;\n', 'utf8');
    const ctx = createContext(apply, { autoIndex: true });
    const handler = ctx.listeners.get('agent/pre-step');
    const agent = agentFor(root, 'throw-queue-session');
    await assert.rejects(
      () => handler({ agent, signal: { aborted: false } }, async () => { throw new Error('host failed'); }),
      /host failed/,
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(existsSync(join(root, '.dsh', 'compaction-fidelity', 'index.json')), false, 'a thrown decision must not schedule a scan');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
