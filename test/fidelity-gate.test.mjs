import test from "node:test";
import assert from "node:assert/strict";
import { buildConstraintProbes, compareConstraintLedger, extractConstraintLedger } from "../src/constraint-ledger.mjs";
import { buildFidelityProbes, evaluateFidelityGate } from "../src/fidelity-gate.mjs";

const messages = [
  { role: "user", content: [{ type: "text", text: "必须使用 pnpm test，不要用 npm。只在 src 目录操作。" }] },
  { role: "assistant", content: [{ type: "text", text: "好的。" }] },
  { role: "user", content: [{ type: "text", text: "Never delete files." }] },
];

test("extracts hard and soft constraints and classifies verdicts", () => {
  const ledger = extractConstraintLedger(messages);
  assert.ok(ledger.constraints.length >= 2);
  const summary = "必须使用 pnpm test，不要用 npm。";
  const comparison = compareConstraintLedger(ledger, summary);
  assert.ok(comparison.preserved >= 1);
  assert.ok(comparison.total === ledger.constraints.length);
});

test("builds constraint probes with a valid answer index", () => {
  const ledger = extractConstraintLedger(messages);
  const probes = buildConstraintProbes(ledger);
  assert.ok(probes.length >= 1);
  for (const probe of probes) {
    assert.ok(probe.options[probe.answerIndex] === probe.expected);
  }
});

test("gate passes when exact values and constraints survive", () => {
  const exactLedger = { exact: { paths: ["src/app.ts"], commands: ["pnpm test"], errors: [], identifiers: [], numbers: ["8080"] } };
  const probes = buildFidelityProbes(exactLedger);
  const constraints = extractConstraintLedger(messages);
  const summary = "必须使用 pnpm test，不要用 npm。src/app.ts 8080";
  const gate = evaluateFidelityGate({ fingerprint: { exactOverall: 1, cjkRecall: 1 }, constraints, probes, summaryText: summary });
  assert.ok(gate.exact.ratio >= 0.66);
  assert.ok(gate.constraints.preserved >= 1);
});

test("gate fails when a required exact value is missing", () => {
  const exactLedger = { exact: { paths: ["src/app.ts"], commands: [], errors: [], identifiers: [], numbers: ["8080"] } };
  const probes = buildFidelityProbes(exactLedger);
  const gate = evaluateFidelityGate({ fingerprint: { exactOverall: 0.4, cjkRecall: 0.4 }, constraints: null, probes, summaryText: "src/app.ts" });
  assert.equal(gate.ok, false);
  assert.ok(gate.failures.length >= 1);
});

