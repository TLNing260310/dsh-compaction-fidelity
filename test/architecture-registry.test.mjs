import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeArchitectureBaseline, detectSemanticChanges, writeArchitectureBaseline } from "../src/architecture-changes.mjs";
import {
  globToRegExp,
  isValidScopePattern,
  createGlobalWorkspaceFileFilter,
  createWorkspaceFileFilter,
  managedDocTarget,
  managedScopeRules,
  matchesScopeRules,
  readArchitectureRegistry,
  registryFingerprint,
  retrievalPolicyFor,
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

test("rule lists are capped and an unusable registry fails closed", () => {
  const securityRoot = mkdtempSync(join(tmpdir(), "compaction-fidelity-security-"));
  try {
    const registryFile = join(securityRoot, indexDir, "architecture-scopes.json");
    mkdirSync(join(securityRoot, indexDir), { recursive: true });

    // A scope name we cannot honor must not be silently dropped: dropping an
    // entry widens reads relative to what the user asked for, so the whole
    // registry becomes corrupt instead of degrading to "no rules".
    writeFileSync(registryFile, JSON.stringify({ version: 2, scopes: { "../evil": { include: ["**"] }, safe: { include: [] } } }), "utf8");
    let registry = readArchitectureRegistry(securityRoot, indexDir);
    assert.equal(registry.status, "corrupt");
    assert.deepEqual(registry.scopes, {});
    assert.equal(createWorkspaceFileFilter(registry, "safe")("safe/a.ts"), false);
    assert.equal(managedScopeRules(registry, "safe").denyAll, true);
    assert.throws(() => updateArchitectureScopeRules(securityRoot, indexDir, "cap", { include: ["src/a.ts"] }), /corrupt/);

    rmSync(registryFile, { force: true });
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

test("a missing registry stays permissive but a corrupt registry denies every read", () => {
  const probeRoot = mkdtempSync(join(tmpdir(), "compaction-fidelity-corrupt-"));
  try {
    mkdirSync(join(probeRoot, indexDir), { recursive: true });
    const missing = readArchitectureRegistry(probeRoot, indexDir);
    assert.equal(missing.status, "missing");
    assert.equal(createWorkspaceFileFilter(missing, "safe")("safe/a.ts"), true);
    assert.equal(createGlobalWorkspaceFileFilter(missing)("safe/a.ts"), true);

    const registryFile = join(probeRoot, indexDir, "architecture-scopes.json");
    writeFileSync(registryFile, "{ \"version\": 2, \"scopes\": { \"safe\": { \"include\": [\"**\"] } }", "utf8");
    const truncated = readArchitectureRegistry(probeRoot, indexDir);
    assert.equal(truncated.status, "corrupt");
    assert.equal(createWorkspaceFileFilter(truncated, "safe")("safe/a.ts"), false);
    assert.equal(createGlobalWorkspaceFileFilter(truncated)("safe/a.ts"), false);
    assert.equal(managedDocTarget(truncated, "safe"), null);

    // A rule we cannot honor is not the same as no rule at all.
    writeFileSync(registryFile, JSON.stringify({ version: 2, scopes: { "safe": { include: [], exclude: ["/etc/**"] } } }), "utf8");
    const unusableExclude = readArchitectureRegistry(probeRoot, indexDir);
    assert.equal(unusableExclude.status, "corrupt");
    assert.equal(createWorkspaceFileFilter(unusableExclude, "safe")("safe/a.ts"), false);
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
});

test("the global filter applies every registered scope to workspace-relative paths", () => {
  const registry = {
    version: 2,
    status: "valid",
    scopes: {
      "app": { include: [], exclude: ["secrets/**"] },
      ".": { include: [], exclude: ["app/vendor/**"] },
    },
  };
  const filter = createGlobalWorkspaceFileFilter(registry);
  assert.equal(filter("app/src/a.ts"), true);
  assert.equal(filter("app/secrets/token.txt"), false);
  assert.equal(filter("app/vendor/lib.js"), false);
  assert.equal(filter("other/src/a.ts"), true);
  assert.equal(filter("../escape.ts"), false);
});

test("the registry fingerprint changes with rules and registry health", () => {
  const base = { version: 2, status: "valid", scopes: { app: { include: [], exclude: ["secrets/**"] } } };
  const same = { version: 2, status: "valid", scopes: { app: { include: [], exclude: ["secrets/**"] } } };
  const widened = { version: 2, status: "valid", scopes: { app: { include: [], exclude: [] } } };
  assert.equal(registryFingerprint(base), registryFingerprint(same));
  assert.notEqual(registryFingerprint(base), registryFingerprint(widened));
  assert.notEqual(registryFingerprint(base), registryFingerprint({ version: 2, status: "corrupt", scopes: {} }));
  assert.notEqual(registryFingerprint(base), registryFingerprint({ version: 2, status: "missing", scopes: {} }));
});

test("the retrieval policy blocks serving when the registry cannot be honored", () => {
  const policyRoot = mkdtempSync(join(tmpdir(), "compaction-fidelity-retrieval-policy-"));
  try {
    mkdirSync(join(policyRoot, indexDir), { recursive: true });
    const missing = retrievalPolicyFor(policyRoot, indexDir);
    assert.equal(missing.blocked, false);
    assert.equal(missing.filterFile("app/a.ts"), true);
    assert.equal(typeof missing.fingerprint, "string");

    const registryFile = join(policyRoot, indexDir, "architecture-scopes.json");
    writeFileSync(registryFile, "{ not json", "utf8");
    const corrupt = retrievalPolicyFor(policyRoot, indexDir);
    assert.equal(corrupt.blocked, true);
    assert.equal(corrupt.filterFile("app/a.ts"), false);
    assert.notEqual(corrupt.fingerprint, missing.fingerprint);

    rmSync(registryFile, { force: true });
    updateArchitectureScopeRules(policyRoot, indexDir, "app", { exclude: ["secrets/**"] });
    const managed = retrievalPolicyFor(policyRoot, indexDir);
    assert.equal(managed.blocked, false);
    assert.equal(managed.filterFile("app/a.ts"), true);
    assert.equal(managed.filterFile("app/secrets/token.ts"), false);
    assert.notEqual(managed.fingerprint, missing.fingerprint);
  } finally {
    rmSync(policyRoot, { recursive: true, force: true });
  }
});

test("a sub-scope exclusion also constrains the workspace index and its brief", () => {
  const filterRoot = mkdtempSync(join(tmpdir(), "compaction-fidelity-global-filter-"));
  try {
    mkdirSync(join(filterRoot, "app", "secrets"), { recursive: true });
    writeFileSync(join(filterRoot, "app", "index.ts"), "export const app = 1;\n", "utf8");
    writeFileSync(join(filterRoot, "app", "secrets", "token.ts"), "export const token = 'x';\n", "utf8");
    updateArchitectureScopeRules(filterRoot, indexDir, "app", { exclude: ["secrets/**"] });
    const registry = readArchitectureRegistry(filterRoot, indexDir);
    const filter = createGlobalWorkspaceFileFilter(registry);
    assert.equal(filter("app/index.ts"), true);
    assert.equal(filter("app/secrets/token.ts"), false);
    const index = buildIndex(filterRoot, { indexDir, write: false, filterFile: filter });
    assert.ok(index.files.some((file) => file.p === "app/index.ts"));
    assert.equal(index.files.some((file) => file.p === "app/secrets/token.ts"), false);
    assert.equal(index.brief.includes("token.ts"), false);
  } finally {
    rmSync(filterRoot, { recursive: true, force: true });
  }
});

test("managed document targets respect custom names and exclusion rules", () => {
  const registry = {
    version: 2,
    scopes: {
      excluded: { doc: "ARCHITECTURE.md", include: [], exclude: ["ARCHITECTURE.md"] },
      custom: { doc: "DESIGN.md", include: ["DESIGN.md"], exclude: [] },
    },
  };
  assert.equal(managedDocTarget(registry, "excluded"), null);
  assert.deepEqual(managedDocTarget(registry, "custom"), { scope: "custom", docName: "DESIGN.md", relative: "custom/DESIGN.md" });
  assert.deepEqual(managedDocTarget(registry, "."), { scope: ".", docName: "ARCHITECTURE.md", relative: "ARCHITECTURE.md" });
});


test("a root exclude also denies a document inside that folder", () => {
  const registry = { scopes: { ".": { include: [], exclude: ["private/**"] }, private: { include: [], exclude: [] } } };
  assert.equal(managedDocTarget(registry, "private"), null, "the root exclude must reach the nested document");
  const open = { scopes: { ".": { include: [], exclude: [] }, private: { include: [], exclude: [] } } };
  assert.equal(managedDocTarget(open, "private").relative, "private/ARCHITECTURE.md", "without the exclude the document is still managed");
});

test("a refused document keeps a reason, and only an unregistered scope may default", async () => {
  const { resolveManagedDocTarget } = await import("../src/architecture-registry.mjs");
  const ancestor = { scopes: { ".": { include: [], exclude: ["private/**"] }, private: { include: [], exclude: [] } } };
  const deniedAncestor = resolveManagedDocTarget(ancestor, "private");
  assert.equal(deniedAncestor.ok, false);
  assert.equal(deniedAncestor.reason, "denied-ancestor");
  const own = { scopes: { ".": { include: [], exclude: [] }, docs: { include: [], exclude: ["ARCHITECTURE.md"] } } };
  const deniedScope = resolveManagedDocTarget(own, "docs");
  assert.equal(deniedScope.reason, "denied-scope");
  const corrupt = { status: "corrupt", scopes: { private: { include: [], exclude: [] } } };
  assert.equal(resolveManagedDocTarget(corrupt, "private").reason, "corrupt-registry", "a corrupt registry must not fall back to the default document");
  const open = { scopes: { ".": { include: [], exclude: [] } } };
  const allowed = resolveManagedDocTarget(open, "unregistered");
  assert.equal(allowed.ok, true, "an unregistered scope with no rule against it keeps the default document");
  assert.equal(allowed.relative, "unregistered/ARCHITECTURE.md");
  assert.equal(resolveManagedDocTarget(open, "../escape").reason, "invalid-scope");
});
