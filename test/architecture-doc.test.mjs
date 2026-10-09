import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ARCHITECTURE_DOC_BYTES, appendArchitectureUpdate, detectTaskFolders, preserveArchitectureUpdateLog, readArchitectureAttestation, readManagedArchitectureDoc, renderArchitectureDoc, resolveArchitectureDoc, validateArchitectureDoc, verifyArchitectureDoc } from "../src/architecture-doc.mjs";

const root = mkdtempSync(join(tmpdir(), "compaction-fidelity-architecture-"));
mkdirSync(join(root, "src", "feature"), { recursive: true });
writeFileSync(join(root, "src", "feature", "index.ts"), "export {};", "utf8");
after(() => rmSync(root, { recursive: true, force: true }));

test("detects an existing task folder from the user message", () => {
  const messages = [{ role: "user", content: [{ type: "text", text: "请在 src/feature 目录下修改 index.ts，并保持 API 不变。" }] }];
  const detection = detectTaskFolders(messages, root);
  assert.ok(detection.candidates.some((candidate) => candidate.relativeDir === "src/feature"));
});

test("renders and validates Markdown + DSML + JSON blocks", () => {
  const text = renderArchitectureDoc({
    scope: "src/feature",
    index: { archFiles: [{ p: "src/feature/index.ts", kind: "module", imports: [] }], files: [], commands: [], dbFiles: [] },
    constraints: [{ id: "c1", kind: "hard", text: "不要删除 index.ts" }],
  });
  assert.ok(text.startsWith("---"));
  assert.ok(text.includes("<architecture_retrieval"));
  const validation = validateArchitectureDoc(text);
  assert.equal(validation.ok, true);
  assert.ok(validation.jsonBlocks.length >= 4);
});

test("append-only update preserves the original and appends a structured update", () => {
  const original = renderArchitectureDoc({ scope: "src/feature", index: { archFiles: [], files: [], commands: [], dbFiles: [] } });
  const updated = appendArchitectureUpdate(original, { scope: "src/feature", summary: "新增缓存层，保留原 API", changedFiles: ["src/feature/cache.ts"] });
  assert.ok(updated.includes("# Architecture Retrieval Context"));
  assert.ok(updated.includes("<architecture_update"));
  assert.ok(updated.includes("schema: aoci-lite-architecture-retrieval"));
  assert.ok(updated.includes("新增缓存层"));
  const validation = validateArchitectureDoc(updated);
  assert.equal(validation.ok, true);
});



test("renders an attestation and verifies structure/update-log hashes", () => {
  const original = renderArchitectureDoc({ scope: "src/feature", index: { archFiles: [], files: [], commands: [], dbFiles: [] } });
  const attestation = readArchitectureAttestation(original);
  assert.ok(attestation !== null);
  assert.equal(attestation.entryCount, 0);
  const verification = verifyArchitectureDoc(original);
  assert.equal(verification.ok, true, JSON.stringify(verification.errors));

  const updated = appendArchitectureUpdate(original, { scope: "src/feature", summary: "attested update" });
  const after = verifyArchitectureDoc(updated);
  assert.equal(after.ok, true, JSON.stringify(after.errors));
  assert.equal(after.entryCount, 1);
});

test("verify detects a tampered update log", () => {
  const original = renderArchitectureDoc({ scope: "src/feature", index: { archFiles: [], files: [], commands: [], dbFiles: [] } });
  const updated = appendArchitectureUpdate(original, { scope: "src/feature", summary: "original summary" });
  const tampered = updated.replace("original summary", "tampered summary");
  const verification = verifyArchitectureDoc(tampered);
  assert.equal(verification.ok, false);
  assert.ok(verification.errors.some((error) => error.includes("updateLogHash")));
});

test("latest architecture update is appended after older updates", () => {
  const original = renderArchitectureDoc({ scope: "src/feature", index: { archFiles: [], files: [], commands: [], dbFiles: [] } });
  const first = appendArchitectureUpdate(original, { scope: "src/feature", summary: "first update", at: "2026-01-01T00:00:00.000Z" });
  const second = appendArchitectureUpdate(first, { scope: "src/feature", summary: "second update", at: "2026-02-01T00:00:00.000Z" });
  assert.ok(second.indexOf("second update") > second.indexOf("first update"));
});

test("refresh helper preserves the update log", () => {
  const original = renderArchitectureDoc({ scope: "src/feature", index: { archFiles: [], files: [], commands: [], dbFiles: [] } });
  const updated = appendArchitectureUpdate(original, { scope: "src/feature", summary: "kept update" });
  const fresh = renderArchitectureDoc({ scope: "src/feature", index: { archFiles: [{ p: "src/feature/new.ts", kind: "module", imports: [] }], files: [], commands: [], dbFiles: [] } });
  const merged = preserveArchitectureUpdateLog(updated, fresh);
  assert.ok(merged.includes("kept update"));
  assert.ok(merged.includes("src/feature/new.ts"));
});

test("attestation hashes are stable across whitespace-only formatting differences", () => {
  const original = renderArchitectureDoc({ scope: "src/feature", index: { archFiles: [], files: [], commands: [], dbFiles: [] } });
  const reformatted = original.replace(/\n/g, "\r\n").replace(/[ \t]+$/gm, "");
  const verification = verifyArchitectureDoc(reformatted);
  assert.equal(verification.ok, true, JSON.stringify(verification.errors));
});

test("attestation revision is monotonic across append and refresh", () => {
  const original = renderArchitectureDoc({ scope: "src/feature", index: { archFiles: [], files: [], commands: [], dbFiles: [] } });
  const firstRevision = readArchitectureAttestation(original).revision;
  const updated = appendArchitectureUpdate(original, { scope: "src/feature", summary: "revision check" });
  const secondRevision = readArchitectureAttestation(updated).revision;
  const fresh = renderArchitectureDoc({ scope: "src/feature", index: { archFiles: [{ p: "src/feature/new.ts", kind: "module", imports: [] }], files: [], commands: [], dbFiles: [] } });
  const merged = preserveArchitectureUpdateLog(updated, fresh);
  const thirdRevision = readArchitectureAttestation(merged).revision;
  assert.ok(secondRevision > firstRevision);
  assert.ok(thirdRevision > secondRevision);
  assert.equal(verifyArchitectureDoc(merged).ok, true);
});

test("legacy document without attestation gets one on first update", () => {
  const original = renderArchitectureDoc({ scope: "src/feature", index: { archFiles: [], files: [], commands: [], dbFiles: [] } });
  const legacy = original.replace(/<architecture_attestation>[\s\S]*?<\/architecture_attestation>\s*/, "");
  assert.equal(readArchitectureAttestation(legacy), null);
  const upgraded = appendArchitectureUpdate(legacy, { scope: "src/feature", summary: "legacy upgrade" });
  const attestation = readArchitectureAttestation(upgraded);
  assert.ok(attestation !== null);
  assert.equal(attestation.revision, 1);
  assert.equal(attestation.entryCount, 1);
  const verification = verifyArchitectureDoc(upgraded);
  assert.equal(verification.ok, true, JSON.stringify(verification.errors));
});

test("symlinked scope paths are rejected", (t) => {
  const outside = mkdtempSync(join(tmpdir(), "compaction-fidelity-outside-"));
  const sandbox = mkdtempSync(join(tmpdir(), "compaction-fidelity-symlink-"));
  const link = join(sandbox, "link");
  try {
    symlinkSync(outside, link, "dir");
  } catch {
    rmSync(outside, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
    t.skip("symlink creation is not permitted on this platform");
    return;
  }
  try {
    assert.throws(() => resolveArchitectureDoc(sandbox, "link"));
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});


test("readManagedArchitectureDoc reads an allowed document with an absolute target", () => {
  const dir = mkdtempSync(join(tmpdir(), "compaction-fidelity-managed-read-"));
  try {
    writeFileSync(join(dir, "ARCHITECTURE.md"), "# Root\n", "utf8");
    const result = readManagedArchitectureDoc(".", { cwd: dir, fallbackDoc: "ARCHITECTURE.md", loadRegistry: () => ({ version: 2, status: "valid", scopes: {} }) });
    assert.equal(result.ok, true);
    assert.equal(result.reason, null);
    assert.equal(result.target.relative, "ARCHITECTURE.md");
    assert.equal(result.target.absolute, join(dir, "ARCHITECTURE.md"));
    assert.equal(result.doc.text, "# Root\n");
    assert.equal(result.doc.truncated, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readManagedArchitectureDoc reports missing only after policy allows the scope", () => {
  const dir = mkdtempSync(join(tmpdir(), "compaction-fidelity-managed-missing-"));
  try {
    const result = readManagedArchitectureDoc("app", { cwd: dir, fallbackDoc: "ARCHITECTURE.md", loadRegistry: () => ({ version: 2, status: "valid", scopes: {} }) });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing");
    assert.deepEqual(result.target, { scope: "app", docName: "ARCHITECTURE.md", relative: "app/ARCHITECTURE.md" });
    assert.equal(result.doc, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an outcome refusal never touches the filesystem and reads the registry once", () => {
  let loads = 0;
  let resolves = 0;
  let exists = 0;
  let reads = 0;
  const result = readManagedArchitectureDoc("app", {
    fallbackDoc: "ARCHITECTURE.md",
    loadRegistry: () => { loads += 1; return { version: 2, status: "valid", scopes: { app: { include: [], exclude: ["**"] } } }; },
    resolveArchitectureDoc: () => { resolves += 1; throw new Error("must not resolve"); },
    architectureDocExists: () => { exists += 1; throw new Error("must not check"); },
    readArchitectureDoc: () => { reads += 1; throw new Error("must not read"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "denied-scope");
  assert.equal(result.target, null);
  assert.equal(result.doc, null);
  assert.deepEqual({ loads, resolves, exists, reads }, { loads: 1, resolves: 0, exists: 0, reads: 0 });
});

test("a refusal wins over a missing document", () => {
  const dir = mkdtempSync(join(tmpdir(), "compaction-fidelity-managed-refuse-"));
  try {
    const result = readManagedArchitectureDoc("app", { cwd: dir, fallbackDoc: "ARCHITECTURE.md", loadRegistry: () => ({ version: 2, status: "valid", scopes: { app: { include: [], exclude: ["**"] } } }) });
    assert.equal(result.reason, "denied-scope");
    assert.notEqual(result.reason, "missing");
    assert.equal(result.target, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readManagedArchitectureDoc reports too-large against MAX_ARCHITECTURE_DOC_BYTES", () => {
  const dir = mkdtempSync(join(tmpdir(), "compaction-fidelity-managed-large-"));
  try {
    writeFileSync(join(dir, "ARCHITECTURE.md"), "x".repeat(MAX_ARCHITECTURE_DOC_BYTES + 1), "utf8");
    const result = readManagedArchitectureDoc(".", { cwd: dir, fallbackDoc: "ARCHITECTURE.md", loadRegistry: () => ({ version: 2, status: "valid", scopes: {} }) });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "too-large");
    assert.equal(result.target.relative, "ARCHITECTURE.md");
    assert.equal(result.target.absolute, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("filesystem failures keep a source pointer that is not operable", () => {
  const dir = mkdtempSync(join(tmpdir(), "compaction-fidelity-managed-failure-"));
  try {
    writeFileSync(join(dir, "ARCHITECTURE.md"), "# Root\n", "utf8");
    const unreadable = readManagedArchitectureDoc(".", {
      cwd: dir,
      fallbackDoc: "ARCHITECTURE.md",
      loadRegistry: () => ({ version: 2, status: "valid", scopes: {} }),
      readArchitectureDoc: () => { throw new Error("EIO: cannot read"); },
    });
    assert.equal(unreadable.reason, "unreadable");
    assert.equal(unreadable.target.absolute, undefined);
    assert.equal(unreadable.target.relative, "ARCHITECTURE.md");

    const unsafe = readManagedArchitectureDoc(".", {
      cwd: dir,
      fallbackDoc: "ARCHITECTURE.md",
      loadRegistry: () => ({ version: 2, status: "valid", scopes: {} }),
      resolveArchitectureDoc: () => { throw new Error("architecture doc scope is not a safe workspace-relative path: x"); },
    });
    assert.equal(unsafe.reason, "unsafe-path");
    assert.equal(unsafe.target.relative, "ARCHITECTURE.md");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readManagedArchitectureDoc refuses a symlinked scope target", (t) => {
  const outside = mkdtempSync(join(tmpdir(), "compaction-fidelity-managed-outside-"));
  const sandbox = mkdtempSync(join(tmpdir(), "compaction-fidelity-managed-link-"));
  try {
    symlinkSync(outside, join(sandbox, "link"), "dir");
  } catch {
    rmSync(outside, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
    t.skip("symlink creation is not permitted on this platform");
    return;
  }
  try {
    const result = readManagedArchitectureDoc("link", { cwd: sandbox, fallbackDoc: "ARCHITECTURE.md", loadRegistry: () => ({ version: 2, status: "valid", scopes: {} }) });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "symlink");
    assert.equal(result.target.scope, "link");
    assert.equal(result.target.absolute, undefined);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});
