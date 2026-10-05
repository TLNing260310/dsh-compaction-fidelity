import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFidelitySample, calibrateFidelityLevel, compositeFidelityScore, recordFidelitySample } from "../src/fidelity-calibration.mjs";

const root = mkdtempSync(join(tmpdir(), "compaction-fidelity-calibration-"));
after(() => rmSync(root, { recursive: true, force: true }));

function comparison(level, exactOverall, cjkRecall, headingRecall = 1, codeRecall = 1) {
  return { level, exactOverall, cjkRecall, headingRecall, codeRecall };
}

test("composite fidelity score rewards exact and CJK recall", () => {
  const high = compositeFidelityScore(comparison("L0", 1, 1));
  const low = compositeFidelityScore(comparison("L3", 0.2, 0.1, 0.2, 0.2));
  assert.ok(high > low);
  assert.ok(high <= 1);
  assert.ok(low >= 0);
});

test("calibration falls back to the raw level until enough samples exist", () => {
  const result = calibrateFidelityLevel(comparison("L2", 0.5, 0.5), [], "zh");
  assert.equal(result.level, "L2");
  assert.equal(result.calibrated, false);
  assert.equal(result.sampleCount, 0);
});

test("calibration maps scores to historical percentiles after enough samples", () => {
  const samples = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((finalScore) => ({ language: "zh", finalScore }));
  assert.equal(calibrateFidelityLevel(comparison("L3", 1, 1), samples, "zh").level, "L0");
  assert.equal(calibrateFidelityLevel(comparison("L3", 0.6, 0.6), samples, "zh").level, "L1");
  assert.equal(calibrateFidelityLevel(comparison("L3", 0.4, 0.4), samples, "zh").level, "L2");
  assert.equal(calibrateFidelityLevel(comparison("L3", 0.1, 0.1), samples, "zh").level, "L3");
});

test("A/B sample records whether compensation improved the final fingerprint", () => {
  const sample = buildFidelitySample({
    language: "zh",
    rawComparison: comparison("L2", 0.6, 0.5),
    finalComparison: comparison("L0", 0.95, 0.95),
    compensation: { tokens: 120, truncated: false },
    constraintComparison: { verdicts: [{ verdict: "preserved" }, { verdict: "dropped" }] },
    anchorQuality: { files: 1, entries: 3, chars: 200 },
    preFingerprint: { language: "zh", cjkBigrams: new Array(100), exact: { paths: new Array(5) }, stats: { chars: 1000 } },
  });
  assert.equal(sample.language, "zh");
  assert.equal(sample.improved, true);
  assert.ok(sample.delta > 0);
  assert.equal(sample.constraints.total, 2);
  assert.equal(sample.constraints.preserved, 1);
});

test("recordFidelitySample persists calibration data under the workspace index", () => {
  const sample = buildFidelitySample({
    language: "en",
    rawComparison: comparison("L1", 0.7, 0.8),
    finalComparison: comparison("L0", 0.99, 0.99),
    preFingerprint: { language: "en", cjkBigrams: [], exact: { paths: [] }, stats: { chars: 10 } },
  });
  const store = recordFidelitySample(root, ".dsh/compaction-fidelity", sample);
  assert.equal(store.samples.length, 1);
  assert.ok(existsSync(join(root, ".dsh", "compaction-fidelity", "fidelity-calibration.json")));
});
