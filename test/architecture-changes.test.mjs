import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobalWorkspaceFileFilter } from "../src/architecture-registry.mjs";
import { classifyAlignment, computeArchitectureBaseline, detectSemanticChanges, gitRepoCacheSize, isGitRepository, readArchitectureBaseline, resetGitRepoCache, writeArchitectureBaseline } from "../src/architecture-changes.mjs";

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
    assert.equal(change.ok, false);
    assert.equal(change.unknownReason, "budget-exhausted");
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
    const linkedBaseline = detectSemanticChanges(cwd, ".", localOptions);
    assert.equal(linkedBaseline.baselineFound, true);
    assert.equal(linkedBaseline.ok, false);
    assert.equal(linkedBaseline.unknownReason, "corrupt-baseline");
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


test("a filtered baseline scan never reads an excluded file", () => {
  const filteredRoot = mkdtempSync(join(tmpdir(), "compaction-fidelity-baseline-filter-"));
  try {
    mkdirSync(join(filteredRoot, "app"), { recursive: true });
    writeFileSync(join(filteredRoot, "app", "visible.ts"), "export const visible = 1;\n", "utf8");
    writeFileSync(join(filteredRoot, "app", "hidden.ts"), "export const hidden = 1;\n", "utf8");
    const reads = [];
    const filteredBaseline = computeArchitectureBaseline(filteredRoot, "app", {
      indexDir: options.indexDir,
      docName: options.docName,
      filterFile: (workspaceFile) => !workspaceFile.endsWith("hidden.ts"),
      readFile: (sourceFile, encoding) => {
        reads.push(String(sourceFile).slice(filteredRoot.length + 1).replace(/\\/g, "/"));
        return readFileSync(sourceFile, encoding);
      },
    });
    assert.ok(filteredBaseline.files["app/visible.ts"] !== undefined);
    assert.equal(filteredBaseline.files["app/hidden.ts"], undefined);
    assert.deepEqual(reads, ["app/visible.ts"], "an excluded file must not be read at all");
  } finally {
    rmSync(filteredRoot, { recursive: true, force: true });
  }
});


test('a change scan honors cancellation before reading further files', () => {
  const cwd = mkdtempSync(join(tmpdir(), "compaction-fidelity-scan-abort-"));
  try {
    const localOptions = { indexDir: ".dsh/compaction-fidelity", docName: "ARCHITECTURE.md", maxFiles: 100, maxFileBytes: 1024 * 1024 };
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(join(cwd, "src", "b.ts"), "export const b = 1;\n", "utf8");
    writeArchitectureBaseline(cwd, ".", computeArchitectureBaseline(cwd, ".", localOptions), localOptions.indexDir);
    const controller = new AbortController();
    assert.throws(
      () => detectSemanticChanges(cwd, ".", {
        ...localOptions,
        signal: controller.signal,
        filterFile: () => { controller.abort(); return true; },
      }),
      (error) => error?.name === "AbortError",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});


test("a missing baseline is an explicit unknown state", () => {
  const cwd = mkdtempSync(join(tmpdir(), "compaction-fidelity-no-baseline-"));
  try {
    writeFileSync(join(cwd, "app.ts"), "export const app = 1;\n", "utf8");
    const change = detectSemanticChanges(cwd, ".", { indexDir: ".dsh/compaction-fidelity", docName: "ARCHITECTURE.md" });
    assert.equal(change.ok, false);
    assert.equal(change.unknownReason, "missing-baseline");
    assert.equal(change.baselineFound, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a corrupt baseline is an explicit unknown state", () => {
  const cwd = mkdtempSync(join(tmpdir(), "compaction-fidelity-corrupt-baseline-"));
  try {
    writeFileSync(join(cwd, "app.ts"), "export const app = 1;\n", "utf8");
    mkdirSync(join(cwd, ".dsh", "compaction-fidelity"), { recursive: true });
    writeFileSync(join(cwd, ".dsh", "compaction-fidelity", "architecture-baseline.json"), "{ not json", "utf8");
    const change = detectSemanticChanges(cwd, ".", { indexDir: ".dsh/compaction-fidelity", docName: "ARCHITECTURE.md" });
    assert.equal(change.ok, false);
    assert.equal(change.unknownReason, "corrupt-baseline");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("alignment classification is tri-state and threshold-based", () => {
  assert.deepEqual(classifyAlignment({ ok: true, score: 0, forced: false }, 30), { status: "aligned", reason: null });
  assert.deepEqual(classifyAlignment({ ok: true, score: 45, forced: false }, 30), { status: "stale", reason: null });
  assert.deepEqual(classifyAlignment({ ok: true, score: 0, forced: true }, 30), { status: "stale", reason: null });
  assert.deepEqual(classifyAlignment({ ok: false, unknownReason: "git-failed" }, 30), { status: "unknown", reason: "git-failed" });
});

test("an exhausted hash budget is unknown, not stale", () => {
  const cwd = mkdtempSync(join(tmpdir(), "compaction-fidelity-budget-unknown-"));
  try {
    const localOptions = { indexDir: ".dsh/compaction-fidelity", docName: "ARCHITECTURE.md", maxFiles: 100, maxFileBytes: 1024 * 1024 };
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(join(cwd, "src", "b.ts"), "export const b = 1;\n", "utf8");
    writeArchitectureBaseline(cwd, ".", computeArchitectureBaseline(cwd, ".", localOptions), localOptions.indexDir);
    const change = detectSemanticChanges(cwd, ".", { ...localOptions, maxHashFiles: 1 });
    assert.equal(change.ok, false);
    assert.equal(change.unknownReason, "budget-exhausted");
    assert.equal(classifyAlignment(change, 30).status, "unknown");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("git mode ignores worktree changes already present in the baseline snapshot", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "compaction-fidelity-git-snapshot-"));
  try {
    try {
      execFileSync("git", ["-C", cwd, "init"], { stdio: "ignore" });
      execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"], { stdio: "ignore" });
      execFileSync("git", ["-C", cwd, "config", "user.name", "Test"], { stdio: "ignore" });
      writeFileSync(join(cwd, "app.ts"), "export const app = 1;\n", "utf8");
      execFileSync("git", ["-C", cwd, "add", "app.ts"], { stdio: "ignore" });
      execFileSync("git", ["-C", cwd, "commit", "-m", "init"], { stdio: "ignore" });
    } catch {
      t.skip("git is not available");
      return;
    }
    const localOptions = { indexDir: ".dsh/compaction-fidelity", docName: "ARCHITECTURE.md", maxFiles: 100, maxFileBytes: 1024 * 1024 };
    writeFileSync(join(cwd, "app.ts"), "export const app = 2;\n", "utf8");
    writeArchitectureBaseline(cwd, ".", computeArchitectureBaseline(cwd, ".", localOptions), localOptions.indexDir);
    const unchanged = detectSemanticChanges(cwd, ".", localOptions);
    assert.equal(unchanged.method, "git");
    assert.equal(unchanged.ok, true);
    assert.deepEqual(unchanged.changedFiles, []);
    assert.equal(unchanged.score, 0);
    writeFileSync(join(cwd, "app.ts"), "export const app = 3;\n", "utf8");
    const moved = detectSemanticChanges(cwd, ".", localOptions);
    assert.equal(moved.ok, true);
    assert.ok(moved.changedFiles.includes("app.ts"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a baseline whose git repository is gone reports git-unavailable", () => {
  const cwd = mkdtempSync(join(tmpdir(), "compaction-fidelity-git-gone-"));
  try {
    mkdirSync(join(cwd, "not-a-repo"), { recursive: true });
    writeFileSync(join(cwd, "app.ts"), "export const app = 1;\n", "utf8");
    writeArchitectureBaseline(cwd, ".", { at: Date.now(), head: "0123456789abcdef", gitRoot: join(cwd, "not-a-repo"), files: {} }, ".dsh/compaction-fidelity");
    const change = detectSemanticChanges(cwd, ".", { indexDir: ".dsh/compaction-fidelity", docName: "ARCHITECTURE.md" });
    assert.equal(change.ok, false);
    assert.equal(change.unknownReason, "git-unavailable");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a failing git query reports git-failed instead of an empty change set", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "compaction-fidelity-git-failed-"));
  try {
    try {
      execFileSync("git", ["-C", cwd, "init"], { stdio: "ignore" });
      execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"], { stdio: "ignore" });
      execFileSync("git", ["-C", cwd, "config", "user.name", "Test"], { stdio: "ignore" });
      writeFileSync(join(cwd, "app.ts"), "export const app = 1;\n", "utf8");
      execFileSync("git", ["-C", cwd, "add", "app.ts"], { stdio: "ignore" });
      execFileSync("git", ["-C", cwd, "commit", "-m", "init"], { stdio: "ignore" });
    } catch {
      t.skip("git is not available");
      return;
    }
    writeArchitectureBaseline(cwd, ".", {
      at: Date.now(),
      head: "0123456789abcdef0123456789abcdef01234567",
      gitRoot: cwd,
      files: { "app.ts": { hash: "deadbeef", size: 1 } },
    }, ".dsh/compaction-fidelity");
    const change = detectSemanticChanges(cwd, ".", { indexDir: ".dsh/compaction-fidelity", docName: "ARCHITECTURE.md" });
    assert.equal(change.ok, false);
    assert.equal(change.unknownReason, "git-failed");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});


test("a child scope's exclude is enforced before a root scan reads the file", () => {
  const cwd = mkdtempSync(join(tmpdir(), "compaction-fidelity-global-policy-"));
  try {
    const localOptions = { indexDir: ".dsh/compaction-fidelity", docName: "ARCHITECTURE.md", maxFiles: 100, maxFileBytes: 1024 * 1024 };
    mkdirSync(join(cwd, "app"), { recursive: true });
    writeFileSync(join(cwd, "app", "hidden.ts"), "export const hidden = 1;\n", "utf8");
    writeFileSync(join(cwd, "app", "visible.ts"), "export const visible = 1;\n", "utf8");
    const registry = { version: 2, scopes: { app: { doc: "ARCHITECTURE.md", include: [], exclude: ["hidden.ts"] } } };
    const filter = createGlobalWorkspaceFileFilter(registry);
    const baseline = computeArchitectureBaseline(cwd, ".", { ...localOptions, filterFile: filter });
    assert.ok(Object.keys(baseline.files).includes("app/visible.ts"), "a permitted file must be registered");
    assert.equal(Object.keys(baseline.files).includes("app/hidden.ts"), false, "an excluded file must not be registered");
    writeArchitectureBaseline(cwd, ".", baseline, localOptions.indexDir);
    writeFileSync(join(cwd, "app", "visible.ts"), "export const visible = 2;\n", "utf8");
    writeFileSync(join(cwd, "app", "hidden.ts"), "export const hidden = 2;\n", "utf8");
    let hiddenReads = 0;
    const change = detectSemanticChanges(cwd, ".", {
      ...localOptions,
      filterFile: filter,
      readFile: (file) => {
        if (String(file).includes("hidden.ts")) hiddenReads += 1;
        return readFileSync(file, "utf8");
      },
    });
    assert.equal(hiddenReads, 0, "a policy-excluded file must not be read");
    assert.ok(change.changedFiles.includes("app/visible.ts"));
    assert.equal(change.changedFiles.includes("app/hidden.ts"), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});


test("git mode detects a dirty-at-refresh snapshot restored to HEAD", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "compaction-fidelity-git-revert-"));
  try {
    try {
      execFileSync("git", ["-C", cwd, "init"], { stdio: "ignore" });
      execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"], { stdio: "ignore" });
      execFileSync("git", ["-C", cwd, "config", "user.name", "Test"], { stdio: "ignore" });
      mkdirSync(join(cwd, "src"), { recursive: true });
      for (let index = 1; index <= 12; index += 1) {
        writeFileSync(join(cwd, "src", "m" + String(index).padStart(2, "0") + ".ts"), "export const value = " + index + ";\n", "utf8");
      }
      execFileSync("git", ["-C", cwd, "add", "."], { stdio: "ignore" });
      execFileSync("git", ["-C", cwd, "commit", "-m", "init"], { stdio: "ignore" });
    } catch {
      t.skip("git is not available");
      return;
    }
    const localOptions = { indexDir: ".dsh/compaction-fidelity", docName: "ARCHITECTURE.md", maxFiles: 100, maxFileBytes: 1024 * 1024 };
    for (let index = 1; index <= 12; index += 1) {
      writeFileSync(join(cwd, "src", "m" + String(index).padStart(2, "0") + ".ts"), "export const value = " + (index + 100) + ";\n", "utf8");
    }
    writeArchitectureBaseline(cwd, ".", computeArchitectureBaseline(cwd, ".", localOptions), localOptions.indexDir);
    execFileSync("git", ["-C", cwd, "checkout", "--", "."], { stdio: "ignore" });
    const change = detectSemanticChanges(cwd, ".", localOptions);
    assert.equal(change.method, "git");
    assert.equal(change.ok, true);
    assert.equal(change.changedFiles.length, 12, JSON.stringify(change.changedFiles));
    assert.ok(change.score >= 30, "a restored snapshot must cross the refresh threshold, got " + change.score);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("git mode enumerates untracked files inside a new directory", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "compaction-fidelity-git-untracked-"));
  try {
    try {
      execFileSync("git", ["-C", cwd, "init"], { stdio: "ignore" });
      execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"], { stdio: "ignore" });
      execFileSync("git", ["-C", cwd, "config", "user.name", "Test"], { stdio: "ignore" });
      writeFileSync(join(cwd, "seed.ts"), "export const seed = 1;\n", "utf8");
      execFileSync("git", ["-C", cwd, "add", "."], { stdio: "ignore" });
      execFileSync("git", ["-C", cwd, "commit", "-m", "init"], { stdio: "ignore" });
    } catch {
      t.skip("git is not available");
      return;
    }
    const localOptions = { indexDir: ".dsh/compaction-fidelity", docName: "ARCHITECTURE.md", maxFiles: 100, maxFileBytes: 1024 * 1024 };
    writeArchitectureBaseline(cwd, ".", computeArchitectureBaseline(cwd, ".", localOptions), localOptions.indexDir);
    mkdirSync(join(cwd, "newdir"), { recursive: true });
    for (let index = 1; index <= 12; index += 1) {
      writeFileSync(join(cwd, "newdir", "index" + String(index).padStart(2, "0") + ".ts"), "export const added = " + index + ";\n", "utf8");
    }
    const change = detectSemanticChanges(cwd, ".", localOptions);
    assert.equal(change.method, "git");
    assert.equal(change.ok, true);
    assert.equal(change.changedFiles.length, 12, JSON.stringify(change.changedFiles));
    assert.ok(change.score >= 30, "untracked files must cross the refresh threshold, got " + change.score);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a scan stopping exactly at maxFiles is unknown, not aligned", () => {
  const cwd = mkdtempSync(join(tmpdir(), "compaction-fidelity-maxfiles-boundary-"));
  try {
    const localOptions = { indexDir: ".dsh/compaction-fidelity", docName: "ARCHITECTURE.md", maxFiles: 100, maxFileBytes: 1024 * 1024 };
    mkdirSync(join(cwd, "a"), { recursive: true });
    mkdirSync(join(cwd, "b"), { recursive: true });
    writeFileSync(join(cwd, "a", "one.ts"), "export const one = 1;\n", "utf8");
    writeFileSync(join(cwd, "b", "two.ts"), "export const two = 1;\n", "utf8");
    writeArchitectureBaseline(cwd, ".", computeArchitectureBaseline(cwd, ".", localOptions), localOptions.indexDir);
    const change = detectSemanticChanges(cwd, ".", { ...localOptions, maxFiles: 1 });
    assert.equal(change.ok, false);
    assert.equal(change.incomplete, true);
    assert.equal(change.unknownReason, "budget-exhausted");
    assert.equal(classifyAlignment(change, 30).status, "unknown");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a structurally corrupt baseline entry is unknown, not aligned", () => {
  const cwd = mkdtempSync(join(tmpdir(), "compaction-fidelity-baseline-schema-"));
  try {
    const indexDir = ".dsh/compaction-fidelity";
    mkdirSync(join(cwd, indexDir), { recursive: true });
    const file = join(cwd, indexDir, "architecture-baseline.json");
    const store = (entry) => JSON.stringify({ version: 1, scopes: { ".": entry } }, null, 2) + "\n";
    const localOptions = { indexDir, docName: "ARCHITECTURE.md", maxFiles: 100, maxFileBytes: 1024 * 1024 };
    const invalid = [
      [],
      {},
      { files: [] },
      { files: { "app.ts": { hash: 1, size: 1 } } },
      { files: { "app.ts": { hash: "abc" } } },
      { at: "not-a-date", files: {} },
    ];
    for (const entry of invalid) {
      writeFileSync(file, store(entry), "utf8");
      const change = detectSemanticChanges(cwd, ".", localOptions);
      assert.equal(change.ok, false, JSON.stringify(entry));
      assert.equal(change.unknownReason, "corrupt-baseline", JSON.stringify(entry));
    }
    writeFileSync(file, store({ at: Date.now(), files: {} }), "utf8");
    const empty = detectSemanticChanges(cwd, ".", localOptions);
    assert.equal(empty.ok, true, "a valid empty baseline in an empty tree stays valid");
    assert.equal(empty.score, 0);
    writeFileSync(file, JSON.stringify({ version: 99, scopes: { ".": { at: Date.now(), files: {} } } }), "utf8");
    const wrongVersion = detectSemanticChanges(cwd, ".", localOptions);
    assert.equal(wrongVersion.ok, false);
    assert.equal(wrongVersion.unknownReason, "corrupt-baseline");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
