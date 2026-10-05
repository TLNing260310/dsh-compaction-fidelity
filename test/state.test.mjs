import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultRuntimeState, isMasterDisabled, mergeRuntimeState, normalizeThreshold, parseTokenCount, resolveAbsoluteThresholdPlan, resolveRetainTokens, resolveThresholdPlan } from '../src/state.mjs';

test('parseTokenCount supports k/m and raw integers', () => {
  assert.equal(parseTokenCount('256k'), 256000);
  assert.equal(parseTokenCount('512K'), 512000);
  assert.equal(parseTokenCount('600k'), 600000);
  assert.equal(parseTokenCount('800k'), 800000);
  assert.equal(parseTokenCount('1m'), 1000000);
  assert.equal(parseTokenCount(300000), 300000);
  assert.throws(() => parseTokenCount('nope'), /unsupported token count/);
});

test('threshold hard bounds reject 0 and values above 1M', () => {
  assert.throws(() => normalizeThreshold(0), /positive|between|invalid/);
  assert.throws(() => normalizeThreshold('2m'), /between/);
  assert.throws(() => normalizeThreshold(1_048_577), /between/);
  assert.equal(normalizeThreshold(1_048_576).tokens, 1_048_576);
});

test('normalizeThreshold maps defaults', () => {
  assert.deepEqual(normalizeThreshold('256k'), { mode: 'tokens', tokens: 256000, label: '256k' });
  assert.deepEqual(normalizeThreshold('350k'), { mode: 'tokens', tokens: 350000, label: '350k' });
  assert.deepEqual(normalizeThreshold('600k'), { mode: 'tokens', tokens: 600000, label: '600k' });
  assert.deepEqual(normalizeThreshold('800k'), { mode: 'tokens', tokens: 800000, label: '800k' });
  assert.deepEqual(normalizeThreshold('1m'), { mode: 'full', tokens: 1048576, label: '1m' });
  assert.equal(normalizeThreshold(300000).mode, 'tokens');
});

test('80% preset maps to the official 80% window-line mode', () => {
  assert.deepEqual(normalizeThreshold('80%'), { mode: 'full', tokens: 1_048_576, label: '80%' });
  assert.equal(normalizeThreshold('0.8').label, '80%');
  const plan = resolveAbsoluteThresholdPlan({ threshold: '80%' }, 1_000_000, 256_000, 65_536);
  assert.equal(plan.plan.mode, 'full');
  assert.equal(plan.effectiveThreshold, 678_464);
});

test('800k preset is capped to the official window line on a 1M window', () => {
  const plan = resolveAbsoluteThresholdPlan({ threshold: '800k' }, 1_000_000, 256_000, 65_536);
  assert.equal(plan.plan.mode, 'full');
  assert.equal(plan.plan.capped, true);
  assert.equal(plan.effectiveThreshold, 678_464);
  assert.equal(plan.plan.label, '800k');
});

test('resolveThresholdPlan caps requested thresholds at capacity and preserves full mode', () => {
  const plan = resolveThresholdPlan('256k', 1_000_000, 900_000);
  assert.equal(plan.mode, 'tokens');
  assert.equal(plan.tokens, 256000);
  const capped = resolveThresholdPlan('512k', 1_000_000, 400_000);
  assert.equal(capped.mode, 'full');
  assert.equal(capped.capped, true);
  const full = resolveThresholdPlan('1m', 1_000_000, 900_000);
  assert.equal(full.mode, 'full');
});

test('resolveRetainTokens defaults to ten percent capped at 64Ki', () => {
  assert.equal(resolveRetainTokens(undefined, 256000), 25600);
  assert.equal(resolveRetainTokens(undefined, 1_048_576), 65536);
  assert.equal(resolveRetainTokens('32k', 1_048_576), 32000);
});

test('external master switch file disables runtime state', () => {
  const home = mkdtempSync(join(tmpdir(), 'compaction-fidelity-switch-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    mkdirSync(join(home, '.dsh-compaction-fidelity'), { recursive: true });
    writeFileSync(join(home, '.dsh-compaction-fidelity', 'disabled'), '', 'utf8');
    assert.equal(isMasterDisabled(), true);
    const runtime = mergeRuntimeState({ threshold: '512k' }, { cwd: home, indexDir: '.dsh/compaction-fidelity' });
    assert.equal(runtime.enabled, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

test('resolveAbsoluteThresholdPlan caps the configured threshold by the effective budget', () => {
  const large = resolveAbsoluteThresholdPlan({ threshold: '512k' }, 1_000_000, 256_000, 65_536);
  assert.equal(large.messageBudget, 744_000);
  assert.equal(large.effectiveBudget, 678_464);
  assert.equal(large.plan.mode, 'tokens');
  assert.equal(large.effectiveThreshold, 512_000);

  const small = resolveAbsoluteThresholdPlan({ threshold: '512k' }, 200_000, 64_000, 65_536);
  assert.equal(small.messageBudget, 136_000);
  assert.equal(small.effectiveBudget, 70_464);
  assert.equal(small.plan.mode, 'full');
  assert.equal(small.plan.capped, true);
  assert.equal(small.effectiveThreshold, 70_464);

  const oversized = resolveAbsoluteThresholdPlan({ threshold: '900k' }, 1_000_000, 256_000, 65_536);
  assert.equal(oversized.plan.mode, 'full');
  assert.equal(oversized.effectiveThreshold, 678_464);
});

test('resolveAbsoluteThresholdPlan rejects unusable capacity', () => {
  assert.equal(resolveAbsoluteThresholdPlan({ threshold: '512k' }, 0, 0, 0), null);
  assert.equal(resolveAbsoluteThresholdPlan({ threshold: '512k' }, 100_000, 100_000, 0), null);
});


test('default summary output budget matches official 65536', () => {
  assert.equal(defaultRuntimeState().summaryMaxTokens, 65536);
  assert.equal(defaultRuntimeState().threshold, '350k');
  assert.equal(resolveAbsoluteThresholdPlan({ threshold: '350k' }, 1_000_000, 256_000, 65_536).effectiveThreshold, 350000);
});



