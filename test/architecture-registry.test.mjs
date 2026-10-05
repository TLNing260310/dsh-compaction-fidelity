import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeArchitectureBaseline, detectSemanticChanges, writeArchitectureBaseline } from "../src/architecture-changes.mjs";
import {
  globToRegExp,
  isValidScopePattern,
  createWorkspaceFileFilter,
  matchesScopeRules,
  readArchitectureRegistry,
  removeArchitectureScope,
  updateArchitectureScopeRules,
  writeArchitectureRegistry,
} from "../src/architecture-registry.mjs";

import { buildIndex } from "../src/project-index.mjs";
const root = mkdtempSync(join(tmpdir(), "compaction-fidelity-registry-"));
const indexDir = ".dsh/compaction-fidelity";
after(() => rmSync(root, { recursive: true, force: true }));

function write(rel, text) {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, text, "utf8");
}

test("glob patterns distinguish scope-relative include and exclude rules", () => {
  assert.equal(globToRegExp("src/**").test("src/a/b.ts"), true);
  assert.equal(globToRegExp("src/**").test("lib/a.ts"), false);
  assert.equal(globToRegExp("**/*.test.ts").test("src/a.test.ts"), true);
  assert.equal(globToRegExp("**/*.test.ts").test("src/a.ts"), false);
  assert.equal(matchesScopeRules("src/a.ts", { include: ["src/**"], exclude: ["**/*.test.ts"] }), true);
  assert.equal(matchesScopeRules("src/a.test.ts", { include: ["src/**"], exclude: ["**/*.test.ts"] }), false);
  assert.equal(matchesScopeRules("lib/a.ts", { include: ["src/**"], exclude: [] }), false);
});

test("workspace filter maps managed scope rules to workspace-relative files", () => {
  const registry = { version: 2, scopes: { "sub": { include: ["src/**"], exclude: ["**/*.test.ts"] } } };
  const filter = createWorkspaceFileFilter(registry, "sub");
  assert.equal(filter("sub/src/a.ts"), true);
  assert.equal(filter("sub/src/a.test.ts"), false);
  assert.equal(filter("sub/lib/a.ts"), false);
  assert.equal(filter("other/src/a.ts"), false);
});

test("legacy array registry migrates to managed scope entries", () => {
  const dir = join(root, indexDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "architecture-scopes.json"), JSON.stringify(["legacy-scope"]), "utf8");
  const registry = readArchitectureRegistry(root, indexDir);
  assert.deepEqual(Object.keys(registry.scopes), ["legacy-scope"]);
  assert.deepEqual(registry.scopes["legacy-scope"].include, []);
  writeArchitectureRegistry(root, indexDir, registry);
  const persisted = JSON.parse(readFileSync(join(dir, "architecture-scopes.json"), "utf8"));
  assert.equal(persisted.version, 2);
  assert.ok(persisted.scopes["legacy-scope"] !== undefined);
});

test("include/exclude updates persist and can be removed", () => {
  updateArchitectureScopeRules(root, indexDir, "sub", { include: ["src/**"], exclude: ["**/*.test.ts"] });
  let registry = readArchitectureRegistry(root, indexDir);
  assert.deepEqual(registry.scopes.sub.include, ["src/**"]);
  assert.deepEqual(registry.scopes.sub.exclude, ["**/*.test.ts"]);

  updateArchitectureScopeRules(root, indexDir, "sub", { removeExclude: ["**/*.test.ts"] });
  registry = readArchitectureRegistry(root, indexDir);
  assert.deepEqual(registry.scopes.sub.exclude, []);

  removeArchitectureScope(root, indexDir, "sub");
  registry = readArchitectureRegistry(root, indexDir);
  assert.equal(registry.scopes.sub, undefined);
});

test("architecture baseline respects managed scope filters", () => {
  write("managed/src/a.ts", "export const a = 1;\n");
  write("managed/src/a.test.ts", "export const test = 1;\n");
  write("managed/lib/b.ts", "export const b = 1;\n");
  updateArchitectureScopeRules(root, indexDir, "managed", { include: ["src/**"], exclude: ["**/*.test.ts"] });
  const registry = readArchitectureRegistry(root, indexDir);
  const filter = createWorkspaceFileFilter(registry, "managed");
  const baseline = computeArchitectureBaseline(root, "managed", { indexDir, filterFile: filter });
  assert.ok(baseline.files["managed/src/a.ts"] !== undefined);
  assert.equal(baseline.files["managed/src/a.test.ts"], undefined);
  assert.equal(baseline.files["managed/lib/b.ts"], undefined);
});

test("buildIndex honors a managed filterFile callback", () => {
  const index = buildIndex(root, { indexDir, write: false, filterFile: (rel) => rel === "managed/src/a.ts" });
  assert.equal(index.files.length, 1);
  assert.equal(index.files[0].p, "managed/src/a.ts");
});

test("excluded changes are not tracked and re-include rebaselines the current state", () => {
  write("cycle/src/a.ts", "export const v = 1;\n");
  updateArchitectureScopeRules(root, indexDir, "cycle", { include: ["src/**"] });
  let registry = readArchitectureRegistry(root, indexDir);
  let filter = createWorkspaceFileFilter(registry, "cycle");
  writeArchitectureBaseline(root, "cycle", computeArchitectureBaseline(root, "cycle", { indexDir, filterFile: filter }), indexDir);
  let baseline = computeArchitectureBaseline(root, "cycle", { indexDir, filterFile: filter });
  assert.ok(baseline.files["cycle/src/a.ts"] !== undefined);

  updateArchitectureScopeRules(root, indexDir, "cycle", { exclude: ["src/**"] });
  registry = readArchitectureRegistry(root, indexDir);
  filter = createWorkspaceFileFilter(registry, "cycle");
  baseline = computeArchitectureBaseline(root, "cycle", { indexDir, filterFile: filter });
  assert.equal(baseline.files["cycle/src/a.ts"], undefined);
  writeArchitectureBaseline(root, "cycle", baseline, indexDir);

  write("cycle/src/a.ts", "export const v = 2;\n");
  const excludedChange = detectSemanticChanges(root, "cycle", { indexDir, filterFile: filter });
  assert.equal(excludedChange.score, 0);
  assert.equal(excludedChange.forced, false);

  updateArchitectureScopeRules(root, indexDir, "cycle", { removeExclude: ["src/**"] });
  registry = readArchitectureRegistry(root, indexDir);
  filter = createWorkspaceFileFilter(registry, "cycle");
  baseline = computeArchitectureBaseline(root, "cycle", { indexDir, filterFile: filter });
  assert.ok(baseline.files["cycle/src/a.ts"] !== undefined);
  writeArchitectureBaseline(root, "cycle", baseline, indexDir);
  const reincludeChange = detectSemanticChanges(root, "cycle", { indexDir, filterFile: filter });
  assert.equal(reincludeChange.score, 0);
  assert.equal(reincludeChange.forced, false);
});

test("unsafe scopes and invalid patterns are rejected", () => {
  assert.throws(() => updateArchitectureScopeRules(root, indexDir, "../outside", { include: ["src/**"] }));
  assert.equal(isValidScopePattern("../secret"), false);
  assert.equal(isValidScopePattern("/etc/passwd"), false);
  assert.equal(isValidScopePattern("C:/Windows"), false);
  assert.equal(isValidScopePattern("x".repeat(300)), false);
  assert.equal(isValidScopePattern("src/\u0000evil"), false);
  assert.equal(globToRegExp("src/\u0000evil"), null);
  assert.equal(matchesScopeRules("src/a.ts", { include: ["../**"], exclude: [] }), false);
});

test("unsafe registry keys are ignored and rule lists are capped", () => {
  const securityRoot = mkdtempSync(join(tmpdir(), "compaction-fidelity-security-"));
  try {
    mkdirSync(join(securityRoot, indexDir), { recursive: true });
    writeFileSync(join(securityRoot, indexDir, "architecture-scopes.json"), JSON.stringify({ version: 2, scopes: { "../evil": { include: ["**"] }, safe: { include: [] } } }), "utf8");
    let registry = readArchitectureRegistry(securityRoot, indexDir);
    assert.equal(registry.scopes["../evil"], undefined);
    assert.ok(registry.scopes.safe !== undefined);

    const patterns = [];
    for (let index = 0; index < 200; index += 1) patterns.push("src/f" + index + ".ts");
    updateArchitectureScopeRules(securityRoot, indexDir, "cap", { include: patterns });
    registry = readArchitectureRegistry(securityRoot, indexDir);
    assert.equal(registry.scopes.cap.include.length, 128);
  } finally {
    rmSync(securityRoot, { recursive: true, force: true });
  }
});

test("index wires managed filters and scheduling guards", () => {
  const source = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
  assert.match(source, /computeArchitectureBaseline\(cwd, scope, \{[\s\S]{0,500}?filterFile: architectureManagedFilter/);
  assert.match(source, /const cachedArchitectureChange =/);
  assert.match(source, /const MAX_SESSION_FILES = 64;/);
  assert.match(source, /architectureCheckCache\.clear\(\);/);
});
