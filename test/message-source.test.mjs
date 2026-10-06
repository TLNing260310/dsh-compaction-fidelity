import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_NAME, PRODUCER_SOURCE, isProducerOwnedSource } from '../src/message-source.mjs';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));

test('injected messages carry a producer-owned source kind', () => {
  assert.equal(PLUGIN_NAME, 'compaction-fidelity');
  assert.equal(PRODUCER_SOURCE.kind, 'plugin:compaction-fidelity');
  // The v4 admission rule: non-empty string, and never the retired wrapper.
  assert.equal(isProducerOwnedSource(PRODUCER_SOURCE), true);
  assert.equal(isProducerOwnedSource({ kind: 'plugin', plugin: PLUGIN_NAME }), false);
  assert.equal(isProducerOwnedSource({ kind: '' }), false);
  assert.equal(isProducerOwnedSource({}), false);
  assert.equal(isProducerOwnedSource(null), false);
  assert.equal(isProducerOwnedSource(['plugin:x']), false);
});

test('the producer source is frozen, attribution-stable, and carries no retired plugin field', () => {
  assert.equal(Object.isFrozen(PRODUCER_SOURCE), true);
  assert.equal(Object.keys(PRODUCER_SOURCE).includes('plugin'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(PRODUCER_SOURCE)), { kind: 'plugin:compaction-fidelity' });
  // Same kind DSH's v3 -> v4 migration derives for the released plugin string
  // (producerKind() maps an unrenamed released plugin to `plugin:<string>`).
  assert.equal(PRODUCER_SOURCE.kind, 'plugin:' + PLUGIN_NAME);
});

test('no src module builds a plugin message source by hand any more', () => {
  const scripts = readdirSync(srcDir).filter((name) => name.endsWith('.mjs'));
  assert.ok(scripts.length > 0);
  const offenders = [];
  for (const name of scripts) {
    const text = readFileSync(join(srcDir, name), 'utf8');
    if (/source:\s*\{[^}]*kind:\s*['"]plugin['"]/.test(text)) offenders.push(name);
    if (/kind:\s*['"]plugin['"],\s*[\r\n]*\s*plugin:/.test(text)) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});

test('the injection sites reference the shared constant', () => {
  const index = readFileSync(join(srcDir, 'index.mjs'), 'utf8');
  const uses = index.match(/source:\s*PRODUCER_SOURCE/g) ?? [];
  const messages = index.match(/createUserMessage\(/g) ?? [];
  // Every plugin-authored message must declare the shared producer source, so
  // the two counts stay equal as new injection sites are added.
  assert.ok(messages.length >= 4, `expected at least 4 injected messages, got ${messages.length}`);
  assert.equal(uses.length, messages.length);
  assert.match(index, /import \{ PLUGIN_NAME, PRODUCER_SOURCE \} from '\.\/message-source\.mjs'/);
});


