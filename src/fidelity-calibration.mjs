// Per-language A/B calibration for the compaction fidelity fingerprint.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteArchitectureFile } from "./architecture-io.mjs";

const MAX_SAMPLES = 500;
const MIN_SAMPLES = 8;

export function compositeFidelityScore(comparison) {
  const exact = Number(comparison?.exactOverall ?? 0);
  const cjk = Number(comparison?.cjkRecall ?? 0);
  const structure = 0.6 * Number(comparison?.headingRecall ?? 0) + 0.4 * Number(comparison?.codeRecall ?? 0);
  return Number((0.5 * exact + 0.35 * cjk + 0.15 * structure).toFixed(4));
}

function filePath(cwd, indexDir) {
  return join(cwd, indexDir, "fidelity-calibration.json");
}

export function readFidelityCalibration(cwd, indexDir = ".dsh/compaction-fidelity") {
  try {
    const parsed = JSON.parse(readFileSync(filePath(cwd, indexDir), "utf8"));
    if (parsed !== null && typeof parsed === "object" && Array.isArray(parsed.samples)) return parsed;
  } catch {
    // missing or invalid calibration data starts from empty
  }
  return { version: 1, samples: [] };
}

export function writeFidelityCalibration(cwd, indexDir, store) {
  atomicWriteArchitectureFile(filePath(cwd, indexDir), JSON.stringify(store, null, 2));
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] * (upper - position) + sorted[upper] * (position - lower);
}

export function calibrateFidelityLevel(comparison, samples, language) {
  const score = compositeFidelityScore(comparison);
  const scoped = (Array.isArray(samples) ? samples : [])
    .filter((sample) => sample.language === language)
    .map((sample) => sample.finalScore)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (scoped.length < MIN_SAMPLES) {
    return { level: comparison?.level ?? "L3", calibrated: false, score, sampleCount: scoped.length, thresholds: null };
  }
  const thresholds = {
    p75: Number(quantile(scoped, 0.75).toFixed(4)),
    p50: Number(quantile(scoped, 0.5).toFixed(4)),
    p25: Number(quantile(scoped, 0.25).toFixed(4)),
  };
  let level = "L3";
  if (score >= thresholds.p75) level = "L0";
  else if (score >= thresholds.p50) level = "L1";
  else if (score >= thresholds.p25) level = "L2";
  return { level, calibrated: true, score, sampleCount: scoped.length, thresholds };
}

export function buildFidelitySample({ language, rawComparison, finalComparison, compensation, constraintComparison, anchorQuality, preFingerprint }) {
  const rawScore = compositeFidelityScore(rawComparison);
  const finalScore = compositeFidelityScore(finalComparison);
  return {
    at: new Date().toISOString(),
    language: language ?? preFingerprint?.language ?? "unknown",
    rawScore,
    finalScore,
    delta: Number((finalScore - rawScore).toFixed(4)),
    improved: finalScore > rawScore,
    rawLevel: rawComparison?.level ?? null,
    finalLevel: finalComparison?.level ?? null,
    exactOverall: finalComparison?.exactOverall ?? null,
    cjkRecall: finalComparison?.cjkRecall ?? null,
    headingRecall: finalComparison?.headingRecall ?? null,
    codeRecall: finalComparison?.codeRecall ?? null,
    compensation: compensation ? { tokens: compensation.tokens ?? 0, truncated: compensation.truncated === true } : null,
    constraints: constraintComparison
      ? {
          total: constraintComparison.verdicts?.length ?? 0,
          preserved: (constraintComparison.verdicts ?? []).filter((verdict) => verdict.verdict === "preserved").length,
        }
      : null,
    anchors: anchorQuality ?? null,
    pre: preFingerprint
      ? {
          language: preFingerprint.language ?? null,
          cjkBigrams: preFingerprint.cjkBigrams?.length ?? 0,
          exactPaths: preFingerprint.exact?.paths?.length ?? 0,
          chars: preFingerprint.stats?.chars ?? 0,
        }
      : null,
  };
}

export function recordFidelitySample(cwd, indexDir, sample) {
  const store = readFidelityCalibration(cwd, indexDir);
  store.samples.push(sample);
  if (store.samples.length > MAX_SAMPLES) store.samples = store.samples.slice(store.samples.length - MAX_SAMPLES);
  writeFidelityCalibration(cwd, indexDir, store);
  return store;
}
