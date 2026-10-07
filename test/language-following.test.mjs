import test from "node:test";
import assert from "node:assert/strict";
import { buildSummaryInstruction, classifyUserLanguage, extractLedger, languageProfile, resolveUserLanguage } from "../src/summarizer.mjs";

const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
const tool = (text) => ({ role: "tool", content: [{ type: "text", text }] });
const ENGLISH_NOISE = "The implementation keeps a retry policy and the anchors must be preserved for later retrieval. ".repeat(6);
const described = (role, text) => ({ role, text });

test("prose is counted separately from identifiers and code", () => {
  const mixed = languageProfile([SAMPLE_CODE_CJK]);
  assert.equal(mixed.cjk, 6, "CJK prose outside the code spans is counted");
  assert.equal(mixed.latinProse, 2, "pnpm and test are prose-shaped words");
  assert.equal(languageProfile([SAMPLE_PURE_CODE_CJK]).cjk, 3, "inline code is not prose");
  const withPath = languageProfile([SAMPLE_PATH_CJK]);
  assert.equal(withPath.latinProse, 1);
  assert.equal(withPath.latinIdentifiers, 1, "a path is an identifier, not a prose word");
});

test("the classifier keeps a Chinese request with English identifiers in Chinese", () => {
  assert.equal(classifyUserLanguage({ cjk: 21, latinProse: 2, latinIdentifiers: 3 }), "zh");
  assert.equal(classifyUserLanguage({ cjk: 5, latinProse: 0, latinIdentifiers: 0 }), "zh");
  assert.equal(classifyUserLanguage({ cjk: 0, latinProse: 9, latinIdentifiers: 1 }), "en");
  assert.equal(classifyUserLanguage({ cjk: 10, latinProse: 20, latinIdentifiers: 2 }), "en", "an English request quoting a Chinese error string is still English");
  assert.equal(classifyUserLanguage({ cjk: 9, latinProse: 11, latinIdentifiers: 0 }), "mixed");
  assert.equal(classifyUserLanguage({ cjk: 0, latinProse: 0, latinIdentifiers: 4 }), null, "no prose signal at all");
});

test("the language follows the user, not the assistant or tool output", () => {
  const chineseUser = extractLedger([user(CHINESE_REQUEST), assistant(ENGLISH_NOISE), tool(ENGLISH_NOISE)]);
  assert.equal(chineseUser.language, "zh");
  assert.equal(chineseUser.languageBasis, "recent-user");
  const englishUser = extractLedger([user(ENGLISH_REQUEST), assistant(ENGLISH_NOISE), tool(ENGLISH_NOISE)]);
  assert.equal(englishUser.language, "en");
});

test("a language switch is decided by the recent user window", () => {
  const texts = [...Array(12).fill(ENGLISH_REQUEST), SWITCH_TO_CHINESE, SWITCH_TO_CHINESE, SWITCH_TO_CHINESE];
  const ledger = extractLedger(texts.map((text) => user(text)));
  assert.equal(ledger.language, "zh", "the recent window follows the switch");
  assert.equal(ledger.languageBasis, "recent-user");
  assert.equal(classifyUserLanguage(languageProfile(texts)), "mixed", "the whole conversation would have looked bilingual instead");
});

test("the decision records which window produced it", () => {
  const fallback = resolveUserLanguage([described("tool", ENGLISH_NOISE)]);
  assert.equal(fallback.basis, "conversation-fallback");
  assert.equal(fallback.language, "en");
  const empty = resolveUserLanguage([]);
  assert.equal(empty.basis, "empty");
  assert.equal(empty.language, "en");
  const fromUser = resolveUserLanguage([described("user", SHORT_CHINESE)]);
  assert.equal(fromUser.basis, "recent-user");
  assert.equal(fromUser.language, "zh");
});

test("a bilingual ledger no longer forces an English narrative", () => {
  const base = { language: "mixed", languageBasis: "recent-user", userQuotes: [], corrections: [], paths: [], commands: [], errors: [], identifiers: [], numbers: [] };
  const instruction = buildSummaryInstruction({ language: "auto", ledger: base, brief: "", anchors: "" });
  assert.equal(instruction.includes("Write the main prose in English"), false);
  assert.match(instruction, /Match the language mixture the user actually writes/);
  assert.match(instruction, /most recent user message/);
  assert.match(instruction, /must never be translated/);

  const zh = buildSummaryInstruction({ language: "auto", ledger: { ...base, language: "zh" }, brief: "", anchors: "" });
  assert.match(zh, /使用中文撰写检查点/);
  const en = buildSummaryInstruction({ language: "auto", ledger: { ...base, language: "en" }, brief: "", anchors: "" });
  assert.match(en, /Write concise English engineering prose/);
  assert.match(en, /MUST NOT be translated/);
  const explicit = buildSummaryInstruction({ language: "en", ledger: { ...base, language: "zh" }, brief: "", anchors: "" });
  assert.match(explicit, /Write concise English engineering prose/, "an explicit setting still wins");
});

const SAMPLE_PURE_CODE_CJK = "请检查 `错误码`";
const SAMPLE_CODE_CJK = SAMPLE_PURE_CODE_CJK + " 然后跑 pnpm test";
const SAMPLE_PATH_CJK = "改 src/engine.mjs 的 retry";
const CHINESE_REQUEST = "请先用 pnpm test 跑一遍，再修 src/engine.mjs 里的重试逻辑，不要改公共接口。";
const ENGLISH_REQUEST = "Please run pnpm test first, then fix the retry logic in src/engine.mjs.";
const SWITCH_TO_CHINESE = "请保持重试策略不变，先跑失败的那个测试，然后再改代码。";
const SHORT_CHINESE = "只改这一个文件";
