// Deterministic fidelity gate: exact-value probes + constraint verdicts.
import { compareConstraintLedger } from "./constraint-ledger.mjs";

function normalize(text) {
  return String(text ?? "").toLowerCase().replace(/[\s\p{P}]+/gu, "");
}

export function buildFidelityProbes(ledger, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 40;
  const categories = ["paths", "commands", "errors", "identifiers", "numbers"];
  const probes = [];
  for (const category of categories) {
    const values = ledger?.exact?.[category] ?? [];
    for (const value of values) {
      if (probes.length >= limit) break;
      probes.push({ id: category + ":" + probes.length, category, expected: value, question: "Which exact value must be preserved?" });
    }
    if (probes.length >= limit) break;
  }
  return probes;
}

export function evaluateFidelityProbes(probes, summaryText) {
  const after = normalize(summaryText);
  const byCategory = {};
  const misses = [];
  let hits = 0;
  for (const probe of probes ?? []) {
    const ok = after.includes(normalize(probe.expected));
    if (!byCategory[probe.category]) byCategory[probe.category] = { hit: 0, total: 0 };
    byCategory[probe.category].total += 1;
    if (ok) { byCategory[probe.category].hit += 1; hits += 1; } else misses.push(probe);
  }
  const total = probes?.length ?? 0;
  return { hits, total, ratio: total === 0 ? 1 : hits / total, byCategory, misses };
}

export function evaluateFidelityGate({ fingerprint, constraints, probes, summaryText, thresholds = {} }) {
  const gate = { exactOverall: thresholds.exactOverall ?? 0.75, cjkRecall: thresholds.cjkRecall ?? 0.6, constraints: thresholds.constraints ?? 0.9 };
  const exact = evaluateFidelityProbes(probes ?? [], summaryText);
  const constraintResult = constraints ? compareConstraintLedger(constraints, summaryText) : { preservedRatio: 1, total: 0 };
  const failures = [];
  if (fingerprint && fingerprint.exactOverall < gate.exactOverall) failures.push("exactOverall<" + gate.exactOverall);
  if (fingerprint && fingerprint.cjkRecall < gate.cjkRecall) failures.push("cjkRecall<" + gate.cjkRecall);
  if (constraintResult.preservedRatio < gate.constraints) failures.push("constraints<" + gate.constraints);
  return { ok: failures.length === 0, thresholds: gate, exact, constraints: constraintResult, failures };
}

