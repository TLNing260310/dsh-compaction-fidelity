import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummaryInstruction, extractFilePathsFromMessages, extractLedger } from '../src/summarizer.mjs';

const messages = [
  { role: 'user', content: [{ type: 'text', text: '部署时必须使用 pnpm test，不要用 npm。文件是 src/app.ts。错误 ABC_123 出现在 v1.2.3。' }] },
  { role: 'assistant', content: [{ type: 'text', text: '已定位 src/app.ts，错误 ABC_123。' }] },
  { role: 'user', content: [{ type: 'text', text: '不是这样，改成 512k 阈值；记住这个约束。' }] },
];

test('extracts a deterministic exact-value ledger and detects Chinese', () => {
  const ledger = extractLedger(messages);
  assert.equal(ledger.language, 'zh');
  assert.ok(ledger.paths.includes('src/app.ts'));
  assert.ok(ledger.commands.some((line) => line.includes('pnpm test')));
  assert.ok(ledger.identifiers.includes('ABC_123'));
  assert.ok(ledger.corrections.length > 0);
  assert.ok(ledger.userQuotes.length >= 2);
});

test('builds a language-following instruction that never translates exact values', () => {
  const ledger = extractLedger(messages);
  const auto = buildSummaryInstruction({ language: 'auto', ledger, brief: 'BRIEF', anchors: 'ANCHORS' });
  assert.match(auto, /使用中文撰写检查点/);
  assert.match(auto, /<exact_value_ledger>/);
  assert.match(auto, /<verbatim_user_input>/);
  assert.match(auto, /<compaction_fidelity_project_brief>/);
  assert.match(auto, /<compaction_fidelity_anchors>/);
  assert.match(auto, /This applies to every role/);
  assert.match(auto, /never record the asserted context usage as fact/);

  const en = buildSummaryInstruction({ language: 'en', ledger, brief: '', anchors: '' });
  assert.match(en, /Write concise English engineering prose/);
  assert.match(en, /MUST NOT be translated/);
});

test('extracts workspace-relative file paths from messages', () => {
  const files = extractFilePathsFromMessages(messages, process.cwd());
  assert.deepEqual(files, ['src/app.ts']);
});

