// Managed scope registry with include/exclude rules for architecture retrieval.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertWorkspaceContained, atomicWriteArchitectureFile, mutateArchitectureDocument } from "./architecture-io.mjs";
import { isSafeRelativePath } from "./util.mjs";

export const REGISTRY_VERSION = 2;
export const REGISTRY_FILE = "architecture-scopes.json";
const MAX_PATTERN_LENGTH = 256;
const MAX_PATTERN_SEGMENTS = 32;
const MAX_RULES = 128;

function registryPath(cwd, indexDir) {
  return join(cwd, indexDir, REGISTRY_FILE);
}

function normalizeScope(scope) {
  const value = String(scope ?? ".").replace(/\\/g, "/").replace(/\/+$/, "");
  if (value.length === 0 || value === ".") return ".";
  if (!isSafeRelativePath(value)) return null;
  return value;
}

function normalizePattern(pattern) {
  const raw = String(pattern ?? "").trim().replace(/\\/g, "/");
  if (raw.length === 0 || raw.length > MAX_PATTERN_LENGTH) return null;
  if (/[\u0000-\u001f]/.test(raw)) return null;
  if (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) return null;
  const parts = raw.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0 || parts.length > MAX_PATTERN_SEGMENTS) return null;
  if (parts.some((part) => part === "..")) return null;
  return parts.join("/");
}

function toRuleList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const normalized = normalizePattern(item);
    if (normalized !== null && !out.includes(normalized)) out.push(normalized);
    if (out.length >= MAX_RULES) break;
  }
  return out.sort();
}

export function globToRegExp(pattern) {
  const normalized = normalizePattern(pattern);
  if (normalized === null) return null;
  let source = "";
  let index = 0;
  while (index < normalized.length) {
    const char = normalized[index];
    if (char === "*") {
      const isDouble = normalized[index + 1] === "*";
      if (isDouble) {
        const followedBySlash = normalized[index + 2] === "/";
        source += followedBySlash ? "(?:.*/)?" : ".*";
        index += followedBySlash ? 3 : 2;
        continue;
      }
      source += "[^/]*";
      index += 1;
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    source += /[|\\{}()[\]^$+?.]/.test(char) ? `\\${char}` : char;
    index += 1;
  }
  const needsAnyDepth = !normalized.includes("/");
  const prefix = needsAnyDepth ? "(?:.*/)?" : "";
  try {
    return new RegExp(`^${prefix}${source}$`);
  } catch {
    return null;
  }
}

export function isValidScopePattern(pattern) {
  return normalizePattern(pattern) !== null;
}

export function matchesScopeRules(relativeFile, rules) {
  const rel = String(relativeFile ?? "").replace(/\\/g, "/");
  const rawInclude = Array.isArray(rules?.include) ? rules.include : [];
  const include = toRuleList(rawInclude);
  const exclude = toRuleList(rules?.exclude);
  if (exclude.some((pattern) => globToRegExp(pattern)?.test(rel))) return false;
  if (rawInclude.length > 0 && include.length === 0) return false;
  if (include.length === 0) return true;
  return include.some((pattern) => globToRegExp(pattern)?.test(rel));
}

export function createWorkspaceFileFilter(registry, scope) {
  const normalizedScope = normalizeScope(scope);
  if (normalizedScope === null) return () => false;
  const rules = registry?.scopes?.[normalizedScope] ?? null;
  if (rules === null) return () => true;
  return (workspaceFile) => {
    let rel = String(workspaceFile ?? "").replace(/\\/g, "/");
    if (normalizedScope !== ".") {
      const prefix = `${normalizedScope}/`;
      if (!rel.startsWith(prefix)) return false;
      rel = rel.slice(prefix.length);
    }
    if (rel.length === 0 || rel.startsWith("../")) return false;
    return matchesScopeRules(rel, rules);
  };
}

/**
 * Resolve the managed architecture document for one scope. A registered
 * scope controls both the document name and whether that document may be
 * read or injected; excluded documents return null instead of falling back
 * to the default name. Unregistered scopes keep the previous default-document
 * behavior.
 */
export function managedDocTarget(registry, scope, fallbackDoc = "ARCHITECTURE.md") {
  const normalizedScope = normalizeScope(scope);
  if (normalizedScope === null) return null;
  const entry = registry?.scopes?.[normalizedScope];
  const docName = typeof entry?.doc === "string" && /^[\w.-]+\.md$/i.test(entry.doc) ? entry.doc : fallbackDoc;
  const workspacePath = normalizedScope === "." ? docName : `${normalizedScope}/${docName}`;
  if (!createWorkspaceFileFilter(registry, normalizedScope)(workspacePath)) return null;
  return { scope: normalizedScope, docName, relative: workspacePath };
}

function normalizeEntry(entry) {
  const rawInclude = Array.isArray(entry?.include) ? entry.include : [];
  const include = toRuleList(rawInclude);
  const exclude = toRuleList(entry?.exclude);
  if (include.length === 0 && rawInclude.length > 0) include.push("__invalid_rule__");
  const now = new Date().toISOString();
  const doc = typeof entry?.doc === "string" && /^[\w.-]+\.md$/i.test(entry.doc) ? entry.doc : "ARCHITECTURE.md";
  return {
    doc,
    include,
    exclude,
    createdAt: typeof entry?.createdAt === "string" ? entry.createdAt : now,
    updatedAt: typeof entry?.updatedAt === "string" ? entry.updatedAt : now,
  };
}

function parseRegistryText(text) {
  const scopes = {};
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      for (const scope of parsed) {
        const normalized = normalizeScope(scope);
        if (normalized !== null) scopes[normalized] = normalizeEntry({});
      }
    } else if (parsed !== null && typeof parsed === "object" && parsed.scopes !== null && typeof parsed.scopes === "object") {
      for (const [scope, entry] of Object.entries(parsed.scopes)) {
        const normalized = normalizeScope(scope);
        if (normalized !== null) scopes[normalized] = normalizeEntry(entry);
      }
    }
  } catch {
    // invalid registry falls back to empty
  }
  return { version: REGISTRY_VERSION, scopes };
}

function serializeRegistry(registry) {
  const scopes = {};
  for (const [scope, entry] of Object.entries(registry?.scopes ?? {})) {
    const normalized = normalizeScope(scope);
    if (normalized !== null) scopes[normalized] = normalizeEntry(entry);
  }
  const sorted = Object.fromEntries(Object.entries(scopes).sort(([left], [right]) => left.localeCompare(right)));
  return { version: REGISTRY_VERSION, scopes: sorted };
}

export function readArchitectureRegistry(cwd, indexDir = ".dsh/compaction-fidelity") {
  try {
    const file = registryPath(cwd, indexDir);
    if (!existsSync(file)) return { version: REGISTRY_VERSION, scopes: {} };
    return parseRegistryText(readFileSync(file, "utf8"));
  } catch {
    return { version: REGISTRY_VERSION, scopes: {} };
  }
}

export function writeArchitectureRegistry(cwd, indexDir, registry) {
  assertWorkspaceContained(cwd, registryPath(cwd, indexDir));
  const payload = serializeRegistry(registry);
  atomicWriteArchitectureFile(registryPath(cwd, indexDir), JSON.stringify(payload, null, 2));
  return payload;
}

export function mutateArchitectureRegistry(cwd, indexDir, mutator) {
  const file = registryPath(cwd, indexDir);
  assertWorkspaceContained(cwd, file);
  let payload = null;
  const result = mutateArchitectureDocument(file, (text) => {
    const registry = text === null || text.trim().length === 0
      ? { version: REGISTRY_VERSION, scopes: {} }
      : parseRegistryText(text);
    const next = mutator(registry);
    if (next === null || next === undefined) return null;
    payload = serializeRegistry(next);
    return JSON.stringify(payload, null, 2);
  });
  return {
    changed: result.changed,
    registry: payload ?? readArchitectureRegistry(cwd, indexDir),
  };
}

export function rememberArchitectureScope(cwd, indexDir, scope, options = {}) {
  const normalized = normalizeScope(scope);
  if (normalized === null) throw new Error(`unsafe architecture scope: ${String(scope)}`);
  const now = new Date().toISOString();
  const mutation = mutateArchitectureRegistry(cwd, indexDir, (registry) => {
    const existing = registry.scopes[normalized];
    registry.scopes[normalized] = normalizeEntry({
      ...(existing ?? {}),
      doc: options.docName ?? existing?.doc ?? "ARCHITECTURE.md",
      updatedAt: now,
      createdAt: existing?.createdAt ?? now,
    });
    return registry;
  });
  return mutation.registry;
}

export function updateArchitectureScopeRules(cwd, indexDir, scope, change = {}) {
  const normalized = normalizeScope(scope);
  if (normalized === null) throw new Error(`unsafe architecture scope: ${String(scope)}`);
  const now = new Date().toISOString();
  const mutation = mutateArchitectureRegistry(cwd, indexDir, (registry) => {
    const existing = registry.scopes[normalized] ?? normalizeEntry({});
    const include = new Set(existing.include ?? []);
    const exclude = new Set(existing.exclude ?? []);
    for (const pattern of Array.isArray(change.include) ? change.include : []) {
      const value = normalizePattern(pattern);
      if (value !== null) include.add(value);
    }
    for (const pattern of Array.isArray(change.removeInclude) ? change.removeInclude : []) {
      const value = normalizePattern(pattern);
      if (value !== null) include.delete(value);
    }
    for (const pattern of Array.isArray(change.exclude) ? change.exclude : []) {
      const value = normalizePattern(pattern);
      if (value !== null) exclude.add(value);
    }
    for (const pattern of Array.isArray(change.removeExclude) ? change.removeExclude : []) {
      const value = normalizePattern(pattern);
      if (value !== null) exclude.delete(value);
    }
    registry.scopes[normalized] = normalizeEntry({
      ...existing,
      include: [...include],
      exclude: [...exclude],
      createdAt: existing.createdAt ?? now,
      updatedAt: now,
    });
    return registry;
  });
  return mutation.registry;
}

export function removeArchitectureScope(cwd, indexDir, scope) {
  const normalized = normalizeScope(scope);
  if (normalized === null) throw new Error(`unsafe architecture scope: ${String(scope)}`);
  let existed = false;
  const mutation = mutateArchitectureRegistry(cwd, indexDir, (registry) => {
    existed = Object.prototype.hasOwnProperty.call(registry.scopes, normalized);
    delete registry.scopes[normalized];
    return registry;
  });
  return { existed, registry: mutation.registry };
}

export function managedScopeRules(registry, scope) {
  const normalized = normalizeScope(scope);
  if (normalized === null) return null;
  return registry?.scopes?.[normalized] ?? null;
}


