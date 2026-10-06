import test from "node:test";
import assert from "node:assert/strict";
import { buildConstraintProbes, compareConstraintLedger, extractConstraintLedger } from "../src/constraint-ledger.mjs";

function userMessage(text, at) {
  return { role: "user", content: [{ type: "text", text }], ...(at === undefined ? {} : { at }) };
}

test("the newest constraints survive the cap instead of the oldest", () => {
  const messages = [];
  for (let index = 0; index < 40; index += 1) messages.push(userMessage(`MUST keep rule-${index}`));
  const ledger = extractConstraintLedger(messages);
  assert.equal(ledger.considered, 40);
  assert.equal(ledger.constraints.length, 32);
  assert.ok(ledger.constraints.some((constraint) => constraint.text.includes("rule-39")), "the newest rule must be kept");
  assert.equal(ledger.constraints.some((constraint) => constraint.text.includes("rule-0")), false, "the oldest rule is the one dropped");
});

test("provenance records where each surviving rule came from", () => {
  const messages = [userMessage("MUST keep alpha", "2026-01-01T00:00:00.000Z"), userMessage("MUST keep beta", "2026-01-02T00:00:00.000Z")];
  const ledger = extractConstraintLedger(messages);
  assert.equal(ledger.constraints[0].text, "MUST keep beta");
  const beta = ledger.constraints[0];
  assert.equal(beta.source.messageIndex, 1);
  assert.equal(beta.source.at, "2026-01-02T00:00:00.000Z");
  assert.equal(beta.status, "active");
});

test("a withdrawn rule is not in force and can never be re-pinned", () => {
  const messages = [userMessage("MUST use npm test"), userMessage("instead use pnpm test")];
  const ledger = extractConstraintLedger(messages);
  assert.equal(ledger.retracted.length, 1);
  assert.equal(ledger.constraints.length, 0);
  const comparison = compareConstraintLedger(ledger, "a summary that repeats none of it");
  assert.equal(comparison.total, 0);
  assert.deepEqual(comparison.verdicts, []);
  assert.equal(buildConstraintProbes(ledger).length, 0);
});

test("a withdrawal does not have to be phrased as a constraint itself", () => {
  const messages = [userMessage("不要使用 npm"), userMessage("不再需要 npm 的限制了")];
  const ledger = extractConstraintLedger(messages);
  assert.equal(ledger.constraints.length, 0);
  assert.equal(ledger.retracted.length, 1);
});

test("a blanket withdrawal retracts every earlier rule", () => {
  const messages = [userMessage("MUST keep alpha"), userMessage("不要使用 tabs"), userMessage("忽略之前所有的约束和要求")];
  const ledger = extractConstraintLedger(messages);
  assert.equal(ledger.retracted.length, 2);
  assert.deepEqual(ledger.constraints, []);
});

test("a later reversal of the same object supersedes the earlier rule", () => {
  const messages = [userMessage("必须使用 tabs 缩进"), userMessage("不要使用 tabs 缩进")];
  const ledger = extractConstraintLedger(messages);
  assert.equal(ledger.constraints.length, 1);
  assert.equal(ledger.constraints[0].text, "不要使用 tabs 缩进");
  assert.equal(ledger.superseded.length, 1);
  assert.equal(ledger.superseded[0].text, "必须使用 tabs 缩进");
});

test("sibling constraints that share wording are not treated as conflicts", () => {
  const messages = [userMessage("MUST preserve exact value marker-1-alpha; MUST preserve exact value marker-2-alpha")];
  const ledger = extractConstraintLedger(messages);
  assert.equal(ledger.constraints.length, 2);
  assert.deepEqual(ledger.superseded, []);
});

test("the most recent statement of a repeated rule wins", () => {
  const messages = [userMessage("MUST keep alpha"), userMessage("MUST keep beta"), userMessage("MUST keep alpha")];
  const ledger = extractConstraintLedger(messages);
  assert.equal(ledger.constraints.length, 2);
  assert.equal(ledger.constraints[0].text, "MUST keep alpha");
  assert.equal(ledger.constraints[0].source.messageIndex, 2);
});

test("verdicts and probes ignore constraints that are no longer active", () => {
  const ledger = {
    constraints: [
      { id: "c1", text: "MUST keep alpha", kind: "hard", status: "active" },
      { id: "c2", text: "MUST keep beta", kind: "hard", status: "revoked" },
      { id: "c3", text: "MUST keep gamma", kind: "hard", status: "superseded" },
    ],
  };
  const comparison = compareConstraintLedger(ledger, "MUST keep alpha");
  assert.equal(comparison.total, 1);
  assert.equal(comparison.verdicts[0].text, "MUST keep alpha");
  const probes = buildConstraintProbes(ledger);
  assert.equal(probes.length, 1);
  assert.equal(probes[0].expected, "MUST keep alpha");
});