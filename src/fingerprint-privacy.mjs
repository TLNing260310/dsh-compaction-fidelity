// Shared aggregate-only projection for new and migrated fingerprint sidecars.
const CATEGORIES = ["paths", "commands", "errors", "identifiers", "numbers"];
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value, fallback = 0) => Number.isInteger(value) && value >= 0 ? value : fallback;
const numericFields = (value, keys) => Object.fromEntries(keys
  .filter((key) => Number.isFinite(value?.[key]))
  .map((key) => [key, value[key]]));

export function aggregateComparison(comparison) {
  if (!isRecord(comparison)) return null;
  return {
    ...(/^L[0-3]$/.test(comparison.level) ? { level: comparison.level } : {}),
    exactRecall: numericFields(comparison.exactRecall, CATEGORIES),
    ...numericFields(comparison, ["exactOverall", "cjkRecall", "headingRecall", "codeRecall", "cjkMissingCount"]),
    exactMissingCounts: Object.fromEntries(CATEGORIES.map((key) => [key,
      count(comparison.exactMissingCounts?.[key], Array.isArray(comparison.exactMissing?.[key]) ? comparison.exactMissing[key].length : 0)])),
  };
}

export function aggregateConstraints(comparison) {
  if (!isRecord(comparison)) return null;
  const verdicts = Array.isArray(comparison.verdicts) ? comparison.verdicts : [];
  const preserved = count(comparison.preserved, verdicts.filter((item) => item?.verdict === "preserved").length);
  const rewritten = count(comparison.rewritten, verdicts.filter((item) => item?.verdict === "rewritten").length);
  const dropped = count(comparison.dropped, verdicts.filter((item) => item?.verdict === "dropped").length);
  const total = count(comparison.total, preserved + rewritten + dropped);
  return { total, preserved, rewritten, dropped,
    preservedRatio: Number.isFinite(comparison.preservedRatio) ? comparison.preservedRatio : total === 0 ? 1 : preserved / total };
}

export function aggregateGate(gate) {
  if (!isRecord(gate)) return null;
  return {
    ...(typeof gate.ok === "boolean" ? { ok: gate.ok } : {}),
    thresholds: numericFields(gate.thresholds, ["exactOverall", "cjkRecall", "constraints"]),
    failureCount: Array.isArray(gate.failures) ? gate.failures.length : count(gate.failureCount),
    exact: {
      hits: count(gate.exact?.hits), total: count(gate.exact?.total),
      ratio: Number.isFinite(gate.exact?.ratio) ? gate.exact.ratio : 1,
      byCategory: Object.fromEntries(CATEGORIES.filter((key) => isRecord(gate.exact?.byCategory?.[key]))
        .map((key) => [key, numericFields(gate.exact.byCategory[key], ["hit", "total"])])),
      missingCount: Array.isArray(gate.exact?.misses) ? gate.exact.misses.length : count(gate.exact?.missingCount),
    },
    constraints: aggregateConstraints(gate.constraints),
  };
}
