// Per-language A/B calibration for the compaction fidelity fingerprint.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { assertWorkspaceContained, atomicWriteArchitectureFile, mutateArchitectureDocument } from "./architecture-io.mjs";
import { isSafeRelativePath } from "./util.mjs";

const MAX_SAMPLES = 500;
const MIN_SAMPLES = 8;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const LANGUAGE_KEY = /^(?:[a-z]{2,12}|mixed:[a-z]{2,12})$/;

export function compositeFidelityScore(comparison) {
  const exact = Number(comparison?.exactOverall ?? 0);
  const cjk = Number(comparison?.cjkRecall ?? 0);
  const structure = 0.6 * Number(comparison?.headingRecall ?? 0) + 0.4 * Number(comparison?.codeRecall ?? 0);
  return Number((0.5 * exact + 0.35 * cjk + 0.15 * structure).toFixed(4));
}

function filePath(cwd, indexDir) {
  if (!isSafeRelativePath(indexDir)) throw new Error("calibration indexDir must be workspace-relative");
  const file = join(cwd, indexDir, "fidelity-calibration.json");
  assertWorkspaceContained(cwd, file);
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error("calibration store rejects symlink files");
  return file;
}

function parseCalibrationText(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.samples)) return parsed;
  } catch {
    // A damaged evidence asset must never be silently replaced by an empty store.
  }
  throw new Error("invalid fidelity-calibration.json: expected an object with samples[]");
}

export function readFidelityCalibration(cwd, indexDir = ".dsh/compaction-fidelity") {
  try {
    return parseCalibrationText(readFileSync(filePath(cwd, indexDir), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, samples: [] };
    throw error;
  }
}

export function mutateFidelityCalibration(cwd, indexDir, mutator) {
  let next = null;
  const result = mutateArchitectureDocument(filePath(cwd, indexDir), (text) => {
    const store = text === null || text.trim().length === 0 ? { version: 1, samples: [] } : parseCalibrationText(text);
    const value = mutator(store);
    if (value === null || value === undefined) return null;
    next = value;
    return JSON.stringify(value, null, 2);
  });
  return { changed: result.changed, store: next ?? readFidelityCalibration(cwd, indexDir) };
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

export function calibrationGroup(sample) {
  const explicit = sample?.calibrationKey;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const dominant = sample?.dominantLanguage ?? sample?.language;
  if (typeof dominant !== "string" || dominant.length === 0) return "unknown";
  return Number(sample?.mixedRatio ?? 0) >= 0.3 ? `mixed:${dominant}` : dominant;
}

function thresholdsFor(sorted) {
  return {
    p75: Number(quantile(sorted, 0.75).toFixed(4)),
    p50: Number(quantile(sorted, 0.5).toFixed(4)),
    p25: Number(quantile(sorted, 0.25).toFixed(4)),
  };
}

export function calibrateFidelityLevel(comparison, samples, language) {
  const score = compositeFidelityScore(comparison);
  const scoped = (Array.isArray(samples) ? samples : [])
    .filter((sample) => calibrationGroup(sample) === language)
    .map((sample) => sample.finalScore)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (scoped.length < MIN_SAMPLES) {
    return { level: comparison?.level ?? "L3", calibrated: false, score, sampleCount: scoped.length, thresholds: null };
  }
  const thresholds = thresholdsFor(scoped);
  let level = "L3";
  if (score >= thresholds.p75) level = "L0";
  else if (score >= thresholds.p50) level = "L1";
  else if (score >= thresholds.p25) level = "L2";
  return { level, calibrated: true, score, sampleCount: scoped.length, thresholds };
}

export function summarizeFidelityCalibration(samples) {
  const groups = new Map();
  for (const sample of Array.isArray(samples) ? samples : []) {
    if (!Number.isFinite(sample?.finalScore)) continue;
    const key = calibrationGroup(sample);
    if (!groups.has(key)) groups.set(key, { key, scores: [], improved: 0 });
    const group = groups.get(key);
    group.scores.push(sample.finalScore);
    if (sample.improved === true) group.improved += 1;
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)).map((group) => {
    group.scores.sort((a, b) => a - b);
    return {
      key: group.key,
      count: group.scores.length,
      calibrated: group.scores.length >= MIN_SAMPLES,
      improved: group.improved,
      thresholds: thresholdsFor(group.scores),
    };
  });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sampleIdentity(sample) {
  const { importSource, ...content } = sample;
  return createHash("sha256").update(stableJson(content)).digest("hex");
}

function validateImportedSample(sample, index) {
  const prefix = `sample ${index + 1}`;
  if (sample === null || typeof sample !== "object" || Array.isArray(sample)) throw new Error(`${prefix}: expected an object`);
  const key = calibrationGroup(sample);
  if (!LANGUAGE_KEY.test(key)) throw new Error(`${prefix}: invalid calibrationKey/language`);
  const dominant = sample.dominantLanguage ?? sample.language;
  if (typeof dominant !== "string" || !/^[a-z]{2,12}$/.test(dominant)) throw new Error(`${prefix}: invalid dominantLanguage/language`);
  if (sample.language !== undefined && sample.dominantLanguage !== undefined && sample.language !== sample.dominantLanguage) {
    throw new Error(`${prefix}: language and dominantLanguage disagree`);
  }
  const expectedKey = Number(sample.mixedRatio ?? 0) >= 0.3 ? `mixed:${dominant}` : dominant;
  if (key !== expectedKey) throw new Error(`${prefix}: calibrationKey disagrees with language mix`);
  if (typeof sample.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(sample.at) || !Number.isFinite(Date.parse(sample.at))) {
    throw new Error(`${prefix}: invalid at timestamp`);
  }
  for (const field of ["rawScore", "finalScore"]) {
    if (!Number.isFinite(sample[field]) || sample[field] < 0 || sample[field] > 1) throw new Error(`${prefix}: ${field} must be within [0, 1]`);
  }
  for (const field of ["mixedRatio", "cjkRatio", "latinRatio", "exactOverall", "cjkRecall", "headingRecall", "codeRecall"]) {
    const value = sample[field];
    if (value !== undefined && value !== null && (!Number.isFinite(value) || value < 0 || value > 1)) throw new Error(`${prefix}: ${field} must be within [0, 1]`);
  }
  const { importSource, ...content } = sample;
  return {
    ...content,
    language: dominant,
    dominantLanguage: dominant,
    calibrationKey: expectedKey,
    delta: Number((sample.finalScore - sample.rawScore).toFixed(4)),
    improved: sample.finalScore > sample.rawScore,
  };
}

export function importFidelityCalibration(cwd, indexDir, sourceRelativePath) {
  if (!isSafeRelativePath(sourceRelativePath) || extname(sourceRelativePath).toLowerCase() !== ".json") {
    throw new Error("import requires a workspace-relative .json file");
  }
  const root = realpathSync(resolve(cwd));
  const file = resolve(root, sourceRelativePath);
  if (lstatSync(file).isSymbolicLink()) throw new Error("calibration import rejects symlink files");
  const real = realpathSync(file);
  const rel = relative(root, real);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("calibration import file escapes workspace");
  const stat = statSync(real);
  if (!stat.isFile() || stat.size > MAX_IMPORT_BYTES) throw new Error(`calibration import requires a regular file no larger than ${MAX_IMPORT_BYTES} bytes`);
  const sourceText = readFileSync(real, "utf8");
  if (Buffer.byteLength(sourceText, "utf8") > MAX_IMPORT_BYTES) throw new Error("calibration import file exceeds byte limit");
  const parsed = parseCalibrationText(sourceText);
  if (parsed.samples.length > MAX_SAMPLES) throw new Error(`calibration import accepts at most ${MAX_SAMPLES} samples`);
  const incoming = parsed.samples.map(validateImportedSample);
  let added = 0;
  let duplicates = 0;
  const importedAt = new Date().toISOString();
  const { store } = mutateFidelityCalibration(cwd, indexDir, (current) => {
    const seen = new Set(current.samples.map(sampleIdentity));
    const next = [...current.samples];
    added = 0;
    duplicates = 0;
    for (const sample of incoming) {
      const id = sampleIdentity(sample);
      if (seen.has(id)) { duplicates += 1; continue; }
      seen.add(id);
      next.push({ ...sample, importSource: { file: sourceRelativePath.replaceAll("\\", "/"), importedAt } });
      added += 1;
    }
    if (added === 0) return null;
    return { ...current, samples: next.slice(-MAX_SAMPLES) };
  });
  return { added, duplicates, retained: store.samples.length };
}

export function buildFidelitySample({ language, rawComparison, finalComparison, compensation, constraintComparison, anchorQuality, preFingerprint }) {
  const rawScore = compositeFidelityScore(rawComparison);
  const finalScore = compositeFidelityScore(finalComparison);
  const mix = preFingerprint?.languageMix ?? null;
  const dominantLanguage = mix?.dominantLanguage ?? preFingerprint?.language ?? language ?? "unknown";
  const mixedRatio = Number.isFinite(mix?.mixedRatio) ? mix.mixedRatio : 0;
  const calibrationKey = mixedRatio >= 0.3 ? `mixed:${dominantLanguage}` : dominantLanguage;
  return {
    at: new Date().toISOString(),
    language: dominantLanguage,
    dominantLanguage,
    mixedRatio,
    cjkRatio: Number.isFinite(mix?.cjkRatio) ? mix.cjkRatio : null,
    latinRatio: Number.isFinite(mix?.latinRatio) ? mix.latinRatio : null,
    calibrationKey,
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
          languageMix: preFingerprint.languageMix ?? null,
          cjkBigrams: preFingerprint.cjkBigrams?.length ?? 0,
          exactPaths: preFingerprint.exact?.paths?.length ?? 0,
          chars: preFingerprint.stats?.chars ?? 0,
        }
      : null,
  };
}

export function recordFidelitySample(cwd, indexDir, sample) {
  return mutateFidelityCalibration(cwd, indexDir, (store) => {
    if (!Array.isArray(store.samples)) store.samples = [];
    store.samples.push(sample);
    if (store.samples.length > MAX_SAMPLES) store.samples = store.samples.slice(store.samples.length - MAX_SAMPLES);
    return store;
  }).store;
}


