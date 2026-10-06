import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeArchitectureBaseline, detectSemanticChanges, gitRepoCacheSize, isGitRepository, readArchitectureBaseline, resetGitRepoCache, writeArchitectureBaseline } from "../src/architecture-changes.mjs";

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

test("hash mode reports deleted baseline files", () => {
  const cwd = mkdtempSync(join(tmpdir(), "compaction-fidelity-delete-"));
  try {
    const options = { indexDir: ".dsh/compaction-fidelity", docName: "ARCHITECTURE.md", maxFiles: 100, maxFileBytes: 1024 * 1024 };
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "app.ts"), "export const app = 1;\n", "utf8");
    writeArchitectureBaseline(cwd, ".", computeArchitectureBaseline(cwd, ".", options), options.indexDir);
    rmSync(join(cwd, "src", "app.ts"));
    const change = detectSemanticChanges(cwd, ".", options);
    assert.equal(change.method, "hash");
    assert.equal(change.incomplete, false);
    assert.ok(change.changedFiles.includes("src/app.ts"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("hash mode honors size and sensitive-file filters", () => {
  const cwd = mkdtempSync(join(tmpdir(), "compaction-fidelity-hash-budget-"));
  try {
    const options = { indexDir: ".dsh/compaction-fidelity", docName: "ARCHITECTURE.md", maxFiles: 100, maxFileBytes: 1024 * 1024 };
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "app.ts"), "export const app = 1;\n", "utf8");
    writeArchitectureBaseline(cwd, ".", computeArchitectureBaseline(cwd, ".", options), options.indexDir);
    writeFileSync(join(cwd, "large.json"), "x".repeat(2 * 1024 * 1024), "utf8");
    writeFileSync(join(cwd, "secrets.json"), "{\"token\":\"do-not-hash\"}\n", "utf8");
    const change = detectSemanticChanges(cwd, ".", { ...options, maxFileBytes: 64, maxHashBytes: 1024 });
    assert.equal(change.method, "hash");
    assert.equal(change.incomplete, true);
    assert.ok(!change.changedFiles.includes("large.json"));
    assert.ok(!change.changedFiles.includes("secrets.json"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("baseline writes reject a linked index directory instead of escaping the workspace", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "compaction-fidelity-baseline-link-"));
  const outside = mkdtempSync(join(tmpdir(), "compaction-fidelity-baseline-outside-"));
  try {
    const localOptions = { indexDir: ".dsh/compaction-fidelity", docName: "ARCHITECTURE.md", maxFiles: 100, maxFileBytes: 1024 * 1024 };
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "app.ts"), "export const app = 1;\n", "utf8");
    try {
      symlinkSync(outside, join(cwd, ".dsh"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error.code === "EPERM" || error.code === "EACCES") {
        t.skip("symlink creation is not permitted on this platform");
        return;
      }
      throw error;
    }
    assert.throws(
      () => writeArchitectureBaseline(cwd, ".", computeArchitectureBaseline(cwd, ".", localOptions), localOptions.indexDir),
      /symbolic link|junction|escapes workspace/,
    );
    assert.equal(existsSync(join(outside, "compaction-fidelity", "architecture-baseline.json")), false);
    assert.equal(readArchitectureBaseline(cwd, ".", localOptions.indexDir), null);
    assert.equal(detectSemanticChanges(cwd, ".", localOptions).baselineFound, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("baseline writes merge per-scope entries and leave no lock or temp files", () => {
  const cwd = mkdtempSync(join(tmpdir(), "compaction-fidelity-baseline-merge-"));
  try {
    const localOptions = { indexDir: ".dsh/compaction-fidelity", docName: "ARCHITECTURE.md", maxFiles: 100, maxFileBytes: 1024 * 1024 };
    mkdirSync(join(cwd, "src", "a"), { recursive: true });
    mkdirSync(join(cwd, "src", "b"), { recursive: true });
    writeFileSync(join(cwd, "src", "a", "a.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(join(cwd, "src", "b", "b.ts"), "export const b = 1;\n", "utf8");
    writeArchitectureBaseline(cwd, "src/a", computeArchitectureBaseline(cwd, "src/a", localOptions), localOptions.indexDir);
    writeArchitectureBaseline(cwd, "src/b", computeArchitectureBaseline(cwd, "src/b", localOptions), localOptions.indexDir);
    const storePath = join(cwd, localOptions.indexDir, "architecture-baseline.json");
    const store = JSON.parse(readFileSync(storePath, "utf8"));
    assert.deepEqual(Object.keys(store.scopes).sort(), ["src/a", "src/b"]);
    assert.notEqual(readArchitectureBaseline(cwd, "src/a", localOptions.indexDir), null);
    assert.equal(existsSync(storePath + ".lock"), false);
    assert.deepEqual(readdirSync(join(cwd, localOptions.indexDir)).filter((name) => name.includes(".tmp-")), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("git repository cache is bounded", () => {
  resetGitRepoCache();
  for (let index = 0; index < 130; index += 1) {
    isGitRepository(join(tmpdir(), `compaction-fidelity-missing-${index}`));
  }
  assert.ok(gitRepoCacheSize() <= 128, `cache=${gitRepoCacheSize()}`);
});
