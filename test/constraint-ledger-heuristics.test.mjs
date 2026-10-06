import test from "node:test";
import assert from "node:assert/strict";
import { extractConstraintLedger, compareConstraintLedger } from "../src/constraint-ledger.mjs";

const message = (text) => ({ role: "user", content: [{ type: "text", text }] });
const ledgerOf = (...texts) => extractConstraintLedger(texts.map(message));
const active = (ledger) => ledger.constraints.map((constraint) => constraint.text);

// Characterisation tests for a heuristic parser. Each one records the measured
// behaviour of a shape that a bare trigger regex gets wrong, so a later change to
// the parser has to be deliberate rather than accidental.

test("a question about a rule is not an instruction", () => {
  assert.deepEqual(active(ledgerOf("为什么不要使用 tabs？")), []);
});

test("a question that opens with the imperative itself still counts", () => {
  assert.deepEqual(active(ledgerOf("不要使用 tabs 可以吗？")), ["不要使用 tabs 可以吗？"]);
});

test("speech quoted from a third party is hearsay, not a rule", () => {
  assert.deepEqual(active(ledgerOf("用户之前说不要使用 tabs，我只是转述")), []);
  assert.deepEqual(active(ledgerOf("文档里写着必须用 pnpm 构建")), []);
});

test("a rule the user states directly is still collected", () => {
  assert.deepEqual(active(ledgerOf("必须使用 pnpm 构建")), ["必须使用 pnpm 构建"]);
});

test("a keep-the-rest withdrawal retires only its own target", () => {
  const ledger = ledgerOf("必须使用 pnpm 测试", "不要使用 tabs 缩进", "不再需要 tabs 这条，其他都保留");
  assert.deepEqual(active(ledger), ["必须使用 pnpm 测试"]);
  assert.deepEqual(ledger.retracted.map((item) => item.text), ["不要使用 tabs 缩进"]);
});

test("the English keep-the-rest withdrawal behaves the same way", () => {
  const ledger = ledgerOf("不要使用 tabs", "forget the tabs rule, keep everything else");
  assert.deepEqual(ledger.retracted.map((item) => item.text), ["不要使用 tabs"]);
});

test("the newest polarity of one object wins and the older one is retired", () => {
  const ledger = ledgerOf("必须使用 tabs 缩进", "不要使用 tabs 缩进");
  assert.deepEqual(active(ledger), ["不要使用 tabs 缩进"]);
  assert.deepEqual(ledger.superseded.map((item) => item.text), ["必须使用 tabs 缩进"]);
  const comparison = compareConstraintLedger(ledger, "a summary that mentions nothing");
  assert.equal(comparison.verdicts.some((v) => v.text === "必须使用 tabs 缩进"), false, "a superseded rule must not be re-pinned");
});

test("withdrawing an object that was never a rule is a no-op", () => {
  const ledger = ledgerOf("必须使用 pnpm 测试", "不再需要 docker 那条");
  assert.deepEqual(active(ledger), ["必须使用 pnpm 测试"]);
  assert.deepEqual(ledger.retracted, []);
});

test("mixed Chinese and English is kept verbatim", () => {
  assert.deepEqual(active(ledgerOf("不要 use tabs，改用 spaces")), ["不要 use tabs，改用 spaces"]);
});

test("a double negation is preserved instead of being normalised", () => {
  assert.deepEqual(active(ledgerOf("不是不要 tabs，是必须 tabs")), ["不是不要 tabs，是必须 tabs"]);
});

test("a pure conditional is dropped rather than pinned", () => {
  // Documented gap: the triggers only fire on modal words, so "if ... then ..." is
  // not collected. Dropping it is the safe direction today; pinning a conditional
  // as an unconditional rule would be worse.
  assert.deepEqual(active(ledgerOf("如果仓库用 tabs，就改成 spaces")), []);
});

test("a withdrawal that names two objects does not retire either yet", () => {
  // Documented gap, measured: coverage is computed against the whole withdrawal
  // phrase, so naming two objects dilutes it below the threshold.
  const ledger = ledgerOf("不要使用 docker 部署", "不再需要 docker 和 tabs");
  assert.deepEqual(active(ledger), ["不要使用 docker 部署"]);
  assert.deepEqual(ledger.retracted, []);
});
