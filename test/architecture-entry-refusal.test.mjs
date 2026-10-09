import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dshPeerPath = fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh-tools/package.json', import.meta.url));
const hasDshPeers = existsSync(dshPeerPath);
const skipWithoutPeers = { skip: hasDshPeers ? false : 'DSH peer modules are not linked' };

function createContext(apply, config = {}) {
  const listeners = new Map();
  const disposers = [];
  const definitions = new Map();
  const registeredTools = [];
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
    tools: { register(definition) { registeredTools.push(definition); return () => {}; } },
    on(event, handler) {
      listeners.set(event, handler);
      return () => {};
    },
    listeners,
    definitions,
    registeredTools,
    dispose() {
      while (disposers.length > 0) disposers.pop()();
    },
  };
  apply(ctx, { autoIndex: false, architectureDocName: 'ARCHITECTURE.md', ...config });
  return ctx;
}

const agentFor = (cwd, id) => ({ session: { id, header: { cwd } } });

function registryPathFor(root) {
  return join(root, '.dsh', 'compaction-fidelity', 'architecture-scopes.json');
}

function writeRegistry(root, scopes) {
  const file = registryPathFor(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 2, scopes }, null, 2), 'utf8');
  return file;
}

async function setupEntryTest() {
  const { apply } = await import('../src/index.mjs');
  const root = mkdtempSync(join(tmpdir(), 'compaction-fidelity-entry-'));
  const ctx = createContext(apply);
  const tool = ctx.registeredTools.find((item) => item?.name === 'compaction-fidelity-architecture') ?? ctx.registeredTools.at(-1);
  const command = ctx.definitions.get('compaction-fidelity');
  const agent = agentFor(root, 'entry-session');
  return { root, ctx, tool, command, agent };
}

function fixtureWorkspace(root, { doc = true } = {}) {
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, 'app', 'index.ts'), 'export const app = 1;\n', 'utf8');
  if (doc) writeFileSync(join(root, 'app', 'ARCHITECTURE.md'), '# App\n', 'utf8');
}

test('the architecture tool refuses a denied scope without refreshing or writing a baseline', skipWithoutPeers, async () => {
  const { root, tool, agent } = await setupEntryTest();
  try {
    fixtureWorkspace(root);
    const included = await tool.execute({ action: 'include', scope: 'app', pattern: '**' }, { agent });
    assert.ok(included.text.startsWith('include:'), included.text);
    assert.ok(existsSync(join(root, 'app', 'ARCHITECTURE.md')));
    const docPath = join(root, 'app', 'ARCHITECTURE.md');
    writeFileSync(docPath, readFileSync(docPath, 'utf8') + '\n<!-- REFUSAL_SENTINEL -->\n', 'utf8');
    const baselinePath = join(root, '.dsh', 'compaction-fidelity', 'architecture-baseline.json');
    rmSync(baselinePath, { force: true });
    const excluded = await tool.execute({ action: 'exclude', scope: 'app', pattern: '**' }, { agent });
    assert.ok(excluded.text.includes('document access refused'), excluded.text);
    assert.ok(readFileSync(docPath, 'utf8').includes('REFUSAL_SENTINEL'), 'a refused scope must not be refreshed');
    assert.equal(existsSync(baselinePath), false, 'a refused scope must not write a baseline');
    const read = await tool.execute({ action: 'read', scope: 'app' }, { agent });
    assert.ok(read.text.includes('denied'), read.text);
    const refresh = await tool.execute({ action: 'refresh', scope: 'app' }, { agent });
    assert.ok(refresh.text.includes('denied'), refresh.text);
    const created = await tool.execute({ action: 'create', scope: 'app' }, { agent });
    assert.ok(created.text.includes('denied'), created.text);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the architecture tool separates a missing document from a denied scope', skipWithoutPeers, async () => {
  const { root, tool, agent } = await setupEntryTest();
  try {
    fixtureWorkspace(root, { doc: false });
    const missing = await tool.execute({ action: 'check', scope: 'app' }, { agent });
    assert.ok(missing.text.startsWith('missing: '), missing.text);
    const excluded = await tool.execute({ action: 'exclude', scope: 'app', pattern: '**' }, { agent });
    assert.ok(excluded.text.includes('document access refused'), excluded.text);
    const refused = await tool.execute({ action: 'check', scope: 'app' }, { agent });
    assert.ok(refused.text.includes('denied'), refused.text);
    assert.ok(!refused.text.startsWith('missing: '), refused.text);
    assert.equal(existsSync(join(root, 'app', 'ARCHITECTURE.md')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the architecture tool reports a corrupt registry instead of an empty rule set', skipWithoutPeers, async () => {
  const { root, tool, agent } = await setupEntryTest();
  try {
    fixtureWorkspace(root, { doc: false });
    const file = registryPathFor(root);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ broken', 'utf8');
    const manage = await tool.execute({ action: 'manage', scope: 'app' }, { agent });
    assert.ok(manage.text.includes('corrupt'), manage.text);
    const read = await tool.execute({ action: 'read', scope: 'app' }, { agent });
    assert.ok(read.text.includes('corrupt'), read.text);
    const created = await tool.execute({ action: 'create', scope: 'app' }, { agent });
    assert.ok(created.text.includes('corrupt'), created.text);
    assert.equal(existsSync(join(root, 'app', 'ARCHITECTURE.md')), false);
    assert.equal(readFileSync(file, 'utf8'), '{ broken');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a registry write failure is reported and leaves the registry unchanged', skipWithoutPeers, async () => {
  const { root, tool, agent } = await setupEntryTest();
  try {
    fixtureWorkspace(root);
    const file = writeRegistry(root, { app: { doc: 'ARCHITECTURE.md', include: [], exclude: [] } });
    const before = readFileSync(file, 'utf8');
    writeFileSync(file + '.lock', JSON.stringify({ pid: 1, at: Date.now(), token: 'held' }), 'utf8');
    const result = await tool.execute({ action: 'exclude', scope: 'app', pattern: '**' }, { agent });
    assert.ok(result.text.includes('registry not updated'), result.text);
    assert.ok(result.text.includes('locked'), result.text);
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a refresh reports partial completion when the baseline write fails', skipWithoutPeers, async () => {
  const { root, tool, agent } = await setupEntryTest();
  try {
    fixtureWorkspace(root, { doc: false });
    const created = await tool.execute({ action: 'create', scope: 'app' }, { agent });
    assert.ok(created.text.startsWith('created:'), created.text);
    const baselinePath = join(root, '.dsh', 'compaction-fidelity', 'architecture-baseline.json');
    rmSync(baselinePath, { force: true });
    mkdirSync(baselinePath, { recursive: true });
    const refreshed = await tool.execute({ action: 'refresh', scope: 'app' }, { agent });
    assert.ok(refreshed.text.startsWith('refreshed:'), refreshed.text);
    assert.ok(refreshed.text.includes('baseline record failed'), refreshed.text);
    assert.ok(existsSync(join(root, 'app', 'ARCHITECTURE.md')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the architecture command mirrors the refusal matrix', skipWithoutPeers, async () => {
  const { root, command, agent } = await setupEntryTest();
  try {
    fixtureWorkspace(root);
    const excluded = await command.handler({ rawInput: 'architecture exclude app **', agent });
    assert.equal(excluded.kind, 'success');
    assert.ok(excluded.text.includes('架构文档访问已拒绝'), excluded.text);
    assert.equal(existsSync(join(root, 'app', 'ARCHITECTURE.md')), true);
    const read = await command.handler({ rawInput: 'architecture read app', agent });
    assert.equal(read.kind, 'error');
    assert.ok(read.text.includes('已被排除'), read.text);
    const refresh = await command.handler({ rawInput: 'architecture refresh app', agent });
    assert.equal(refresh.kind, 'error');
    assert.ok(refresh.text.includes('已被排除'), refresh.text);
    const file = registryPathFor(root);
    writeFileSync(file, '{ broken', 'utf8');
    const manage = await command.handler({ rawInput: 'architecture manage app', agent });
    assert.equal(manage.kind, 'error');
    assert.ok(manage.text.includes('损坏'), manage.text);
    const created = await command.handler({ rawInput: 'architecture create app', agent });
    assert.equal(created.kind, 'error');
    assert.ok(created.text.includes('损坏'), created.text);
    assert.equal(readFileSync(file, 'utf8'), '{ broken');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the architecture command reports a missing document only when policy allows', skipWithoutPeers, async () => {
  const { root, command, agent } = await setupEntryTest();
  try {
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(join(root, 'app', 'index.ts'), 'export const app = 1;\n', 'utf8');
    const missing = await command.handler({ rawInput: 'architecture check app', agent });
    assert.equal(missing.kind, 'success');
    assert.ok(missing.text.startsWith('不存在：'), missing.text);
    const excluded = await command.handler({ rawInput: 'architecture exclude app **', agent });
    assert.equal(excluded.kind, 'success');
    const refused = await command.handler({ rawInput: 'architecture check app', agent });
    assert.equal(refused.kind, 'error');
    assert.ok(refused.text.includes('已被排除'), refused.text);
    assert.equal(existsSync(join(root, 'app', 'ARCHITECTURE.md')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
