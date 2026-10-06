#!/usr/bin/env node
// Dry-run-first privacy migration for legacy fingerprint sidecars.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mutateArchitectureDocument, assertWorkspaceContained } from "../src/architecture-io.mjs";
import { isSafeRelativePath } from "../src/util.mjs";

import { randomUUID } from "node:crypto";
import { aggregateComparison, aggregateConstraints, aggregateGate } from "../src/fingerprint-privacy.mjs";

const DEFAULT_INDEX_DIR = ".dsh/compaction-fidelity";
const FINGERPRINT_DIR = "fingerprints";
const MAX_BYTES = 2 * 1024 * 1024;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (value, key) => isRecord(value) && Object.hasOwn(value, key);

export { aggregateComparison, aggregateConstraints, aggregateGate };

export function fingerprintSidecarStatus(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return { legacy: false, reasons: [] };
  const reasons = [];
  if (has(record.calibration?.finalFidelity, "exactMissing")) reasons.push("calibration.finalFidelity.exactMissing");
  if (record.fidelity && typeof record.fidelity === "object" && Object.prototype.hasOwnProperty.call(record.fidelity, "exactMissing")) {
    reasons.push("fidelity.exactMissing");
  }
  if (record.fidelityGate && typeof record.fidelityGate === "object") reasons.push("fidelityGate");
  if (record.gate && typeof record.gate === "object") {
    if (Array.isArray(record.gate.failures)) reasons.push("gate.failures");
    if (record.gate.exact && Object.prototype.hasOwnProperty.call(record.gate.exact, "misses")) reasons.push("gate.exact.misses");
    if (Array.isArray(record.gate.constraints?.verdicts)) reasons.push("gate.constraints.verdicts");
  }
  if (Array.isArray(record.constraints?.verdicts)) reasons.push("constraints.verdicts");
  return { legacy: reasons.length > 0, reasons };
}

export function sanitizeFingerprintRecord(record) {
  if (!isRecord(record)) throw new Error("fingerprint sidecar must be a JSON object");
  const copy = JSON.parse(JSON.stringify(record));
  if (copy.fidelity) copy.fidelity = aggregateComparison(copy.fidelity);
  if (copy.fidelityGate) {
    copy.gate = aggregateGate(copy.fidelityGate);
    delete copy.fidelityGate;
  }
  if (copy.gate) copy.gate = aggregateGate(copy.gate);
  if (copy.constraints) copy.constraints = aggregateConstraints(copy.constraints);
  if (copy.calibration?.finalFidelity) copy.calibration.finalFidelity = aggregateComparison(copy.calibration.finalFidelity);
  return copy;
}

function within(parent, target) {
  const rel = relative(parent, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("..\\") && !rel.startsWith("../"));
}

function assertUnlinked(root, target) {
  if (!within(root, target)) throw new Error("migration path escapes workspace");
  assertWorkspaceContained(root, target);
  for (let current = target; current !== root; current = dirname(current)) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("migration path rejects symlinks/junctions");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function assertRegularSidecar(root, file) {
  assertUnlinked(root, file);
  const stat = lstatSync(file);
  if (!stat.isFile()) throw new Error("not a regular file");
  if (stat.nlink > 1) throw new Error("hard-linked file");
  if (stat.size > MAX_BYTES) throw new Error("sidecar exceeds 2 MiB limit");
}

function parseSidecar(text) {
  const record = JSON.parse(text);
  if (!isRecord(record)) throw new Error("fingerprint sidecar must be a JSON object");
  return record;
}

function fingerprintDirectory(root, indexDir) {
  if (!isSafeRelativePath(indexDir)) throw new Error("indexDir must be a safe workspace-relative path");
  const rootAbs = resolve(root);
  const dir = join(rootAbs, indexDir, FINGERPRINT_DIR);
  assertUnlinked(rootAbs, dir);
  return { rootAbs, dir };
}

export function inspectFingerprintSidecars({ root = process.cwd(), indexDir = DEFAULT_INDEX_DIR } = {}) {
  const { rootAbs, dir } = fingerprintDirectory(root, indexDir);
  const files = [];
  const skipped = [];
  if (!existsSync(dir)) return { dir, files, skipped };
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    try {
      assertRegularSidecar(rootAbs, file);
      const text = readFileSync(file, "utf8");
      const record = parseSidecar(text);
      const status = fingerprintSidecarStatus(record);
      files.push({ name, legacy: status.legacy, reasons: status.reasons, bytes: Buffer.byteLength(text, "utf8") });
    } catch (error) {
      skipped.push({ name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { dir, files, skipped };
}

export function migrateFingerprintSidecars({ root = process.cwd(), indexDir = DEFAULT_INDEX_DIR, apply = false, backupDir = undefined } = {}) {
  const { dir, files, skipped } = inspectFingerprintSidecars({ root, indexDir });
  const legacy = files.filter((file) => file.legacy);
  const result = {
    dir,
    apply,
    total: files.length,
    legacy: legacy.length,
    clean: files.length - legacy.length,
    skipped,
    migrated: 0,
    backupDir: null,
    dryRun: !apply,
  };
  if (!apply || legacy.length === 0) return result;
  const rootAbs = resolve(root);
  const fallbackBackup = join(rootAbs, indexDir, "fingerprint-privacy-backup", new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID());
  result.backupDir = backupDir === undefined ? fallbackBackup : resolve(rootAbs, backupDir);
  if (within(dir, result.backupDir) || within(result.backupDir, dir)) throw new Error("backup directory must be separate from fingerprints");
  assertUnlinked(rootAbs, result.backupDir);
  mkdirSync(dirname(result.backupDir), { recursive: true });
  // Never reuse or overwrite an existing backup directory.
  mkdirSync(result.backupDir, { mode: 0o700 });
  for (const file of legacy) {
    const absolute = join(dir, file.name);
    try {
      assertRegularSidecar(rootAbs, absolute);
      const changed = mutateArchitectureDocument(absolute, (text) => {
        assertRegularSidecar(rootAbs, absolute);
        const record = parseSidecar(text);
        if (!fingerprintSidecarStatus(record).legacy) return null;
        const sanitized = JSON.stringify(sanitizeFingerprintRecord(record), null, 2) + "\n";
        assertUnlinked(rootAbs, result.backupDir);
        // Save the exact CAS snapshot, exclusively; conflicting writers cause a skip.
        writeFileSync(join(result.backupDir, file.name), text, { flag: "wx", mode: 0o600 });
        return sanitized;
      }, { maxRetries: 0 });
      if (changed.changed) result.migrated += 1;
    } catch (error) {
      result.skipped.push({ name: file.name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

function parseArgs(argv) {
  const options = { root: process.cwd(), indexDir: DEFAULT_INDEX_DIR, apply: false, backupDir: undefined, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--root", "--index-dir", "--backup-dir"].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      options[{ "--root": "root", "--index-dir": "indexDir", "--backup-dir": "backupDir" }[arg]] = value;
    }
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/migrate-fingerprint-sidecars.mjs [--root <workspace>] [--index-dir <dir>] [--apply] [--backup-dir <dir>] [--json]");
    console.log("Default is a read-only dry run. Use --apply to back up and rewrite legacy sidecars.");
    return;
  }
  const report = migrateFingerprintSidecars(options);
  if (report.apply && report.skipped.length > 0) process.exitCode = 1;
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`fingerprints=${report.total} legacy=${report.legacy} clean=${report.clean} skipped=${report.skipped.length}`);
  console.log(`mode=${report.apply ? "apply" : "dry-run"} migrated=${report.migrated}${report.backupDir === null ? "" : ` backup=${report.backupDir}`}`);
  for (const file of report.skipped) console.log(`skipped: ${file.name} (${file.reason})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

