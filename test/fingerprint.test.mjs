import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLanguageMix, buildCompensation, buildCompensationText, buildFingerprint, compareFingerprints } from '../src/fingerprint.mjs';

const message = (text) => [{ role: 'user', content: [{ type: 'text', text }] }];

test('buildFingerprint extracts exact values, CJK bigrams, and structure', () => {
  const fingerprint = buildFingerprint(message('请修改 D:\\workspace\\example-project\\src\\engine.mjs，端口 8080，token=ABC123。\n\n## 注意\n保留中文语义。'));
  assert.ok(fingerprint.exact.paths.length >= 1);
  assert.ok(fingerprint.exact.numbers.includes('8080'));
  assert.ok(fingerprint.exact.identifiers.includes('ABC123'));
  assert.ok(fingerprint.cjkBigrams.includes('中文'));
  assert.ok(fingerprint.headings.length >= 1);
  assert.ok(fingerprint.stats.cjkChars >= 10);
});

test('language mix reports dominant language and mixed ratio', () => {
  const zh = analyzeLanguageMix('保留中文语义，端口 8080。');
  assert.equal(zh.dominantLanguage, 'zh');
  assert.equal(zh.mixedRatio, 0);
  const en = analyzeLanguageMix('Keep the English summary and port 8080.');
  assert.equal(en.dominantLanguage, 'en');
  const mixed = analyzeLanguageMix('保留中文语义 keep english summary 端口 8080');
  assert.equal(mixed.dominantLanguage, 'mixed');
  assert.ok(mixed.mixedRatio > 0.3);
});

test('identical fingerprints stay at L0', () => {
  const before = buildFingerprint(message('保留中文语义，端口 8080。'));
  const after = buildFingerprint(message('保留中文语义，端口 8080。'));
  const comparison = compareFingerprints(before, after);
  assert.equal(comparison.level, 'L0');
  assert.equal(comparison.exactOverall, 1);
  assert.equal(comparison.cjkRecall, 1);
  assert.equal(buildCompensationText(comparison), '');
});

test('dropped exact values produce compensation text', () => {
  const before = buildFingerprint(message('部署路径 D:\\workspace\\example-project\\src\\engine.mjs，端口 8080，token=ABC123，保留中文语义。'));
  const after = buildFingerprint([{ role: 'assistant', content: [{ type: 'text', text: '已修改 engine.mjs，保留中文语义。' }] }]);
  const comparison = compareFingerprints(before, after);
  assert.ok(comparison.exactOverall < 1);
  assert.notEqual(comparison.level, 'L0');
  const compensation = buildCompensationText(comparison);
  assert.match(compensation, /fidelity_compensation/);
  assert.match(compensation, /8080/);
  assert.match(compensation, /ABC123/);
});

test('CJK loss lowers the fidelity level', () => {
  const before = buildFingerprint(message('上下文压缩保真与跨语言语义指纹校验，必须保留中文语义单元。'));
  const after = buildFingerprint([{ role: 'assistant', content: [{ type: 'text', text: 'Compacted context fidelity summary.' }] }]);
  const comparison = compareFingerprints(before, after);
  assert.ok(comparison.cjkRecall < 0.5);
  assert.ok(comparison.level === 'L2' || comparison.level === 'L3');
});


test("compensation budget is token-capped and never cuts an item", () => {
  const longPaths = Array.from({ length: 30 }, (_, index) => "src/模块/很长的实现文件-" + index + ".ts");
  const comparison = {
    level: "L3",
    exactOverall: 0.2,
    cjkRecall: 0.2,
    exactMissing: {
      paths: longPaths,
      commands: ["npm run build -- --long-flag"],
      errors: ["Error: ENOENT missing file"],
      identifiers: ["RemoteCompactionFidelityEngine"],
      numbers: ["1234567890"],
    },
  };
  const result = buildCompensation(comparison, { maxTokens: 256 });
  assert.ok(result.tokens <= 256);
  assert.equal(result.maxTokens, 256);
  assert.ok(result.truncated);
  assert.match(result.text, /truncated/);
  assert.ok(!result.text.includes("max_tokens"));
  const allValues = new Set([...longPaths, "npm run build -- --long-flag", "Error: ENOENT missing file", "RemoteCompactionFidelityEngine", "1234567890"]);
  for (const line of result.text.split("\n")) {
    if (!line.startsWith("  - ")) continue;
    assert.ok(allValues.has(line.slice(4)), "partial item emitted: " + line);
  }
});

test("compensation keeps higher-priority categories under a tiny budget", () => {
  const comparison = {
    level: "L3",
    exactOverall: 0.1,
    cjkRecall: 0.1,
    exactMissing: {
      paths: ["src/core/engine.ts"],
      commands: ["npm test"],
      errors: ["Error: boom"],
      identifiers: ["CompactionFidelityEngine"],
      numbers: ["8080"],
    },
  };
  const result = buildCompensation(comparison, { maxTokens: 128 });
  assert.ok(result.tokens <= 128);
  assert.ok(result.entriesByCategory.paths >= 1);
});



