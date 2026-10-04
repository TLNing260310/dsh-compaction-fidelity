import test from 'node:test';
import assert from 'node:assert/strict';
import { pickRetentionRange } from '../src/range.mjs';

const surface = [1, 2, 3, 4, 5];
const measured = surface.map((seq) => ({ seq, tokens: 100 }));

test('keeps the requested recent tail and returns the compactable prefix', () => {
  const range = pickRetentionRange({ surfaceNodes: surface, measuredNodes: measured, retainTokens: 200 });
  assert.deepEqual(range, { start: 1, end: 3, retainedFrom: 4 });
});

test('never compacts a leading system node', () => {
  const range = pickRetentionRange({
    surfaceNodes: surface,
    measuredNodes: measured,
    retainTokens: 100,
    eventTypeAt: (seq) => (seq === 1 ? 'system/message' : 'user/message'),
  });
  assert.deepEqual(range, { start: 2, end: 4, retainedFrom: 5 });
});

test('returns null when the whole surface must be retained', () => {
  const range = pickRetentionRange({ surfaceNodes: surface, measuredNodes: measured, retainTokens: 1000 });
  assert.equal(range, null);
});

test('moves the cut away from unbalanced tool pairs', () => {
  const range = pickRetentionRange({
    surfaceNodes: surface,
    measuredNodes: measured,
    retainTokens: 100,
    isBalancedAfter: (seq) => seq !== 4,
    isBalancedBefore: (seq) => seq >= 3,
  });
  assert.deepEqual(range, { start: 3, end: 3, retainedFrom: 4 });
});
