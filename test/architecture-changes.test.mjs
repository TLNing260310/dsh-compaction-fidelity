import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeArchitectureBaseline, detectSemanticChanges, writeArchitectureBaseline } from "../src/architecture-changes.mjs";

const root = mkdtempSync(join(tmpdir(), "compaction-fidelity-architecture-changes-"));
const options = { indexDir: ".dsh/compaction-fidelity", docName: "ARCHITECTURE.md", maxFiles: 20000, maxFileBytes: 1024 * 1024 };
mkdirSync(join(root, "src", "feature"), { recursive: true });
const file = join(root, "src", "feature", "index.ts");
writeFileSync(file, "export const a = 1;\n", "utf8");
const baseline = computeArchitectureBaseline(root, "src/feature", options);
writeArchitectureBaseline(root, "src/feature", baseline, options.indexDir);
after(() => rmSync(root, { recursive: true, force: true }));

test("a clean scope reports zero semantic change", () => {
  const change = detectSemanticChanges(root, "src/feature", options);
  assert.equal(change.score, 0);
  assert.deepEqual(change.changedFiles, []);
  assert.equal(change.forced, false);
  assert.equal(change.baselineFound, true);
});

test("a touch with unchanged content does not create a semantic change", () => {
  const future = new Date(Date.now() + 60000);
  utimesSync(file, future, future);
  const change = detectSemanticChanges(root, "src/feature", options);
  assert.equal(change.score, 0);
  assert.deepEqual(change.changedFiles, []);
});

test("a content change with the same size and old mtime is detected by hash", () => {
  writeFileSync(file, "export const a = 2;\n", "utf8");
  const past = new Date(0);
  utimesSync(file, past, past);
  const change = detectSemanticChanges(root, "src/feature", options);
  assert.equal(change.method, "hash");
  assert.ok(change.changedFiles.includes("src/feature/index.ts"));
  assert.ok(change.score > 0);
});

test("a large single-file change forces a refresh even below the score threshold", () => {
  writeFileSync(file, "x".repeat(8000), "utf8");
  const change = detectSemanticChanges(root, "src/feature", { ...options, singleFileChangeThreshold: 300 });
  assert.equal(change.forced, true);
  assert.ok(change.score > 0);
});
