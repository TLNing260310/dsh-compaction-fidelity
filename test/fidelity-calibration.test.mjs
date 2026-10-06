import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFidelitySample, calibrateFidelityLevel, compositeFidelityScore, importFidelityCalibration, readFidelityCalibration, recordFidelitySample, summarizeFidelityCalibration } from "../src/fidelity-calibration.mjs";

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

test("calibration keeps language groups isolated", () => {
  const samples = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((finalScore) => ({ language: "zh", finalScore }));
  const result = calibrateFidelityLevel(comparison("L2", 0.5, 0.5), samples, "en");
  assert.equal(result.calibrated, false);
  assert.equal(result.level, "L2");
  assert.equal(result.sampleCount, 0);
});

test("mixed-language samples get a dedicated calibration key", () => {
  const sample = buildFidelitySample({
    rawComparison: comparison("L2", 0.6, 0.5),
    finalComparison: comparison("L1", 0.8, 0.7),
    preFingerprint: {
      language: "zh",
      languageMix: { dominantLanguage: "zh", mixedRatio: 0.4, cjkRatio: 0.6, latinRatio: 0.4 },
      cjkBigrams: [],
      exact: { paths: [] },
      stats: { chars: 10 },
    },
  });
  assert.equal(sample.dominantLanguage, "zh");
  assert.equal(sample.mixedRatio, 0.4);
  assert.equal(sample.calibrationKey, "mixed:zh");
});

test("mixed-language samples never enter a pure-language percentile", () => {
  const samples = Array.from({ length: 8 }, (_, index) => ({
    language: "zh", calibrationKey: "mixed:zh", mixedRatio: 0.4, finalScore: (index + 1) / 10,
  }));
  assert.equal(calibrateFidelityLevel(comparison("L2", 0.5, 0.5), samples, "zh").sampleCount, 0);
  assert.equal(calibrateFidelityLevel(comparison("L2", 0.5, 0.5), samples, "mixed:zh").sampleCount, 8);
  assert.equal(summarizeFidelityCalibration(samples)[0].key, "mixed:zh");
});

test("calibration import validates, deduplicates, marks provenance, and preserves a damaged store", () => {
  const cwd = mkdtempSync(join(tmpdir(), "compaction-fidelity-import-"));
  const indexDir = ".dsh/compaction-fidelity";
  try {
    const source = "trusted-samples.json";
    const sample = {
      at: "2026-10-06T00:00:00.000Z", language: "zh", dominantLanguage: "zh",
      mixedRatio: 0.4, rawScore: 0.5, finalScore: 0.7,
    };
    writeFileSync(join(cwd, source), JSON.stringify({ version: 1, samples: [sample, { ...sample }] }));
    assert.deepEqual(importFidelityCalibration(cwd, indexDir, source), { added: 1, duplicates: 1, retained: 1 });
    assert.deepEqual(importFidelityCalibration(cwd, indexDir, source), { added: 0, duplicates: 2, retained: 1 });
    const imported = readFidelityCalibration(cwd, indexDir).samples[0];
    assert.equal(imported.importSource.file, source);
    assert.equal(summarizeFidelityCalibration([imported])[0].key, "mixed:zh");
    assert.throws(() => importFidelityCalibration(cwd, indexDir, "../trusted-samples.json"), /workspace-relative/);
    writeFileSync(join(cwd, source), JSON.stringify({ samples: [{ ...sample, finalScore: 2 }] }));
    assert.throws(() => importFidelityCalibration(cwd, indexDir, source), /finalScore/);
    writeFileSync(join(cwd, source), JSON.stringify({ samples: [{ ...sample, calibrationKey: "zh" }] }));
    assert.throws(() => importFidelityCalibration(cwd, indexDir, source), /calibrationKey disagrees/);
    assert.equal(readFidelityCalibration(cwd, indexDir).samples.length, 1);
    const storePath = join(cwd, indexDir, "fidelity-calibration.json");
    writeFileSync(storePath, "{damaged");
    assert.throws(() => recordFidelitySample(cwd, indexDir, sample), /invalid fidelity-calibration/);
    assert.equal(readFileSync(storePath, "utf8"), "{damaged");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
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

test("calibration stores reject traversal and linked parent escapes", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "compaction-fidelity-contained-"));
  const outside = mkdtempSync(join(tmpdir(), "compaction-fidelity-outside-"));
  try {
    assert.throws(() => recordFidelitySample(cwd, "../outside", {}), /workspace-relative/);
    try {
      symlinkSync(outside, join(cwd, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error.code === "EPERM" || error.code === "EACCES") { t.skip("symlink creation is not permitted"); return; }
      throw error;
    }
    assert.throws(() => recordFidelitySample(cwd, "linked/data", {}), /escapes workspace/);
    assert.equal(existsSync(join(outside, "data", "fidelity-calibration.json")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

