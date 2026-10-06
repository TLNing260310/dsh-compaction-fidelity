import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateGate, fingerprintSidecarStatus, inspectFingerprintSidecars, migrateFingerprintSidecars } from "../scripts/migrate-fingerprint-sidecars.mjs";

const root = mkdtempSync(join(tmpdir(), "compaction-fidelity-privacy-"));
const indexDir = ".dsh/compaction-fidelity";
const fingerprints = join(root, indexDir, "fingerprints");
mkdirSync(fingerprints, { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

function legacyRecord() {
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    fidelity: { level: "L3", exactMissing: { paths: ["src/secret.ts"], commands: [], errors: [], identifiers: [], numbers: [] } },
    gate: { ok: false, failures: ["exactOverall<0.75"], exact: { hits: 0, total: 1, ratio: 0, misses: ["secret"] }, constraints: { verdicts: [{ text: "must not leak", verdict: "dropped" }] } },
    constraints: { verdicts: [{ text: "must not leak", verdict: "dropped" }], total: 1, preserved: 0, rewritten: 0, dropped: 1, preservedRatio: 0 },
  };
}

test("inspect and dry-run keep legacy sidecars unchanged", () => {
  writeFileSync(join(fingerprints, "legacy.json"), JSON.stringify(legacyRecord()), "utf8");
  writeFileSync(join(fingerprints, "clean.json"), JSON.stringify({ generatedAt: "2026-01-01T00:00:00.000Z", fidelity: { level: "L0", exactMissingCounts: {} } }), "utf8");
  const inspection = inspectFingerprintSidecars({ root, indexDir });
  assert.equal(inspection.files.length, 2);
  assert.equal(inspection.files.find((file) => file.name === "legacy.json").legacy, true);
  assert.equal(inspection.files.find((file) => file.name === "clean.json").legacy, false);

  const dryRun = migrateFingerprintSidecars({ root, indexDir });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.legacy, 1);
  assert.equal(dryRun.migrated, 0);
  assert.ok(readFileSync(join(fingerprints, "legacy.json"), "utf8").includes("src/secret.ts"));
});

test("apply backs up and rewrites only legacy sidecars", () => {
  const report = migrateFingerprintSidecars({ root, indexDir, apply: true });
  assert.equal(report.legacy, 1);
  assert.equal(report.migrated, 1);
  assert.ok(report.backupDir !== null);
  const sanitized = readFileSync(join(fingerprints, "legacy.json"), "utf8");
  assert.doesNotMatch(sanitized, /src\/secret\.ts/);
  assert.doesNotMatch(sanitized, /must not leak/);
  assert.equal(fingerprintSidecarStatus(JSON.parse(sanitized)).legacy, false);
  const backup = readFileSync(join(report.backupDir, "legacy.json"), "utf8");
  assert.match(backup, /src\/secret\.ts/);

  const second = migrateFingerprintSidecars({ root, indexDir, apply: true });
  assert.equal(second.legacy, 0);
  assert.equal(second.migrated, 0);
});

test("malformed sidecars are reported and skipped", () => {
  writeFileSync(join(fingerprints, "broken.json"), "{not json", "utf8");
  const inspection = inspectFingerprintSidecars({ root, indexDir });
  assert.ok(inspection.skipped.some((file) => file.name === "broken.json"));
});

function isolated(t) {
  const workspace = mkdtempSync(join(tmpdir(), "compaction-fidelity-migration-case-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const dir = join(workspace, indexDir, "fingerprints");
  mkdirSync(dir, { recursive: true });
  return { workspace, dir };
}

test("nested calibration-only legacy values migrate without changing calibration evidence", (t) => {
  const { workspace, dir } = isolated(t);
  const evidence = join(workspace, indexDir, "fidelity-calibration.json");
  writeFileSync(evidence, '{"samples":[{"note":"private evidence"}]}');
  writeFileSync(join(dir, "nested.json"), JSON.stringify({ calibration: { finalFidelity: legacyRecord().fidelity } }));
  assert.equal(migrateFingerprintSidecars({ root: workspace }).legacy, 1);
  const result = migrateFingerprintSidecars({ root: workspace, apply: true });
  assert.equal(result.migrated, 1);
  const migrated = JSON.parse(readFileSync(join(dir, "nested.json"), "utf8"));
  assert.equal(migrated.calibration.finalFidelity.exactMissingCounts.paths, 1);
  assert.doesNotMatch(JSON.stringify(migrated), /secret/);
  assert.equal(readFileSync(evidence, "utf8"), '{"samples":[{"note":"private evidence"}]}');
});

test("runtime and migration gate projection drops failure/probe details and unexpected fields", () => {
  const gate = legacyRecord().gate;
  gate.thresholds = { exactOverall: 0.75, detail: "private threshold" };
  gate.exact.byCategory = { paths: { hit: 0, total: 1, expected: "private path" }, secret: "private category" };
  const stored = aggregateGate(gate);
  assert.equal(stored.failureCount, 1);
  assert.equal(stored.exact.missingCount, 1);
  assert.deepEqual(stored.exact.byCategory, { paths: { hit: 0, total: 1 } });
  assert.doesNotMatch(JSON.stringify(stored), /private|secret|must not leak|exactOverall</);
  assert.deepEqual(aggregateGate(stored), stored);
});

test("backup cannot alias fingerprints or overwrite an existing backup", (t) => {
  const { workspace, dir } = isolated(t);
  const file = join(dir, "legacy.json");
  const before = JSON.stringify(legacyRecord());
  writeFileSync(file, before);
  for (const backupDir of [dir, join(dir, "nested"), workspace]) {
    assert.throws(() => migrateFingerprintSidecars({ root: workspace, apply: true, backupDir }), /separate/);
  }
  const priorBackup = join(workspace, "prior-backup");
  mkdirSync(priorBackup);
  writeFileSync(join(priorBackup, "legacy.json"), "existing backup");
  assert.throws(() => migrateFingerprintSidecars({ root: workspace, apply: true, backupDir: priorBackup }), /EEXIST/);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(readFileSync(join(priorBackup, "legacy.json"), "utf8"), "existing backup");
});

test("backup directory must remain in the workspace", (t) => {
  const { workspace, dir } = isolated(t);
  writeFileSync(join(dir, "legacy.json"), JSON.stringify(legacyRecord()));
  const outside = workspace + "-outside";
  assert.throws(() => migrateFingerprintSidecars({ root: workspace, apply: true, backupDir: outside }), /escapes/);
  assert.equal(existsSync(outside), false);
});

test("linked fingerprint and backup directories are rejected", (t) => {
  const { workspace, dir } = isolated(t);
  const target = join(workspace, "target");
  mkdirSync(target);
  writeFileSync(join(dir, "legacy.json"), JSON.stringify(legacyRecord()));
  const linkedBackup = join(workspace, "linked-backup");
  symlinkSync(target, linkedBackup, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => migrateFingerprintSidecars({ root: workspace, apply: true, backupDir: join(linkedBackup, "new") }), /symlinks/);
  rmSync(dir, { recursive: true });
  symlinkSync(target, dir, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => inspectFingerprintSidecars({ root: workspace }), /symlinks/);
});

test("non-object, oversized, directory, and hard-linked sidecars are skipped", (t) => {
  const { workspace, dir } = isolated(t);
  writeFileSync(join(dir, "array.json"), "[]");
  writeFileSync(join(dir, "null.json"), "null");
  writeFileSync(join(dir, "large.json"), " ".repeat(2 * 1024 * 1024 + 1));
  mkdirSync(join(dir, "directory.json"));
  const target = join(workspace, "hardlink-source.json");
  writeFileSync(target, JSON.stringify(legacyRecord()));
  linkSync(target, join(dir, "hardlink.json"));
  const result = inspectFingerprintSidecars({ root: workspace });
  assert.equal(result.files.length, 0);
  assert.equal(result.skipped.length, 5);
});

test("CLI rejects missing argument values and reports partial apply failure", (t) => {
  const { workspace, dir } = isolated(t);
  const script = new URL("../scripts/migrate-fingerprint-sidecars.mjs", import.meta.url);
  const missing = spawnSync(process.execPath, [fileURLToPath(script), "--root"], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /requires a value/);
  writeFileSync(join(dir, "broken.json"), "{");
  const partial = spawnSync(process.execPath, [fileURLToPath(script), "--root", workspace, "--apply", "--json"], { encoding: "utf8" });
  assert.equal(partial.status, 1);
  assert.equal(JSON.parse(partial.stdout).skipped.length, 1);
});
