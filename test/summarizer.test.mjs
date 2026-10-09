import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummaryInstruction, buildSummaryInstructionWithDiagnostics, extractFilePathsFromMessages, extractLedger } from '../src/summarizer.mjs';

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


test('adds an AOCI-style cognition refresh trigger for architecture scopes', () => {
  const ledger = extractLedger(messages);
  const text = buildSummaryInstruction({ language: 'en', ledger, brief: '', anchors: '', architectureDocs: 'DOC', cognitionRefreshScopes: ['dsh-researcher'] });
  assert.ok(text.includes('<cognition_refresh trigger="context_compaction">'));
  assert.ok(text.includes('dsh-researcher/ARCHITECTURE.md'));
});

test('enforces a global injection budget and keeps ledger and pinned constraints', () => {
  const ledger = extractLedger(messages);
  const result = buildSummaryInstructionWithDiagnostics({
    language: 'zh',
    ledger: { ...ledger, userQuotes: Array.from({ length: 40 }, (_, index) => `必须原样保留的用户原话 ${index} `.repeat(20)) },
    brief: 'B'.repeat(3000),
    anchors: 'A'.repeat(3000),
    constraints: [{ text: '必须保留的约束 '.repeat(200) }],
    architectureDocs: 'D'.repeat(8000),
    cognitionRefreshScopes: ['dsh-researcher'],
    maxTokens: 3000,
  });
  assert.equal(result.diagnostics.truncated, true);
  assert.ok(result.diagnostics.estimatedTokens <= 3000);
  assert.match(result.text, /<exact_value_ledger>/);
  assert.match(result.text, /<pinned_constraints>/);
  assert.doesNotMatch(result.text, /<cognition_refresh/);
  assert.match(result.text, /<compaction_fidelity_injection_budget dropped="\d+" truncated="\d+" \/>/);
  assert.ok(result.diagnostics.droppedBlocks.includes('cognition_refresh'));
  assert.ok(result.diagnostics.droppedBlocks.includes('project_brief'));
});

test('reserves compensation tokens from the instruction budget', () => {
  const ledger = extractLedger(messages);
  const result = buildSummaryInstructionWithDiagnostics({ language: 'en', ledger, maxTokens: 3000, reserveTokens: 1024 });
  assert.ok(result.diagnostics.estimatedTokens <= 3000 - 1024);
});


test('plugin-produced user messages do not decide the summary language', () => {
  const human = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Please inspect this repository and report the problems in English with clear evidence.' }] };
  const injected = { role: 'user', source: { kind: 'plugin:compaction-fidelity' }, content: [{ type: 'text', text: '请确认是否创建架构文档用于记录项目架构和长期压缩工作细节'.repeat(8) }] };
  assert.equal(extractLedger([human]).language, 'en');
  assert.equal(extractLedger([human, injected]).language, 'en');
  assert.equal(extractLedger([human, injected]).userQuotes.some((quote) => quote.includes('请确认')), false, 'plugin messages must not become user quotes');
});

test('CJK and structured tool-call paths are extracted', () => {
  const exactPath = 'src/模块/入口.ts';
  const fromProse = extractLedger([{ role: 'user', content: [{ type: 'text', text: exactPath }] }]);
  assert.ok(fromProse.paths.includes(exactPath), JSON.stringify(fromProse.paths));
  const fromTool = extractLedger([{ role: 'assistant', content: [{ type: 'tool-call', toolName: 'read_file', input: { path: exactPath } }] }]);
  assert.ok(fromTool.paths.includes(exactPath), JSON.stringify(fromTool.paths));
  const files = extractFilePathsFromMessages([{ role: 'assistant', content: [{ type: 'tool-call', toolName: 'read_file', input: { path: exactPath } }] }], process.cwd());
  assert.ok(files.includes(exactPath), JSON.stringify(files));
});
