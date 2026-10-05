// Managed scope registry with include/exclude rules for architecture retrieval.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteArchitectureFile } from "./architecture-io.mjs";

export const REGISTRY_VERSION = 2;
export const REGISTRY_FILE = "architecture-scopes.json";

function registryPath(cwd, indexDir) {
  return join(cwd, indexDir, REGISTRY_FILE);
}

function normalizeScope(scope) {
  const value = String(scope ?? ".").replace(/\\/g, "/").replace(/\/+$/, "");
  return value.length === 0 ? "." : value;
}

function normalizePattern(pattern) {
  const value = String(pattern ?? "").trim().replace(/\\/g, "/");
  if (value.length === 0) return null;
  if (value.startsWith("/") || /^[A-Za-z]:\//.test(value)) return null;
  const parts = value.split("/");
  if (parts.some((part) => part === "..")) return null;
  return parts.filter((part) => part.length > 0).join("/");
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

export function matchesScopeRules(relativeFile, rules) {
  const rel = String(relativeFile ?? "").replace(/\\/g, "/");
  const include = Array.isArray(rules?.include) ? rules.include.filter(Boolean) : [];
  const exclude = Array.isArray(rules?.exclude) ? rules.exclude.filter(Boolean) : [];
  if (exclude.some((pattern) => globToRegExp(pattern)?.test(rel))) return false;
  if (include.length === 0) return true;
  return include.some((pattern) => globToRegExp(pattern)?.test(rel));
}

export function createWorkspaceFileFilter(registry, scope) {
  const normalizedScope = normalizeScope(scope);
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

function normalizeEntry(entry) {
  const include = Array.isArray(entry?.include) ? entry.include.map(normalizePattern).filter(Boolean) : [];
  const exclude = Array.isArray(entry?.exclude) ? entry.exclude.map(normalizePattern).filter(Boolean) : [];
  const now = new Date().toISOString();
  return {
    doc: typeof entry?.doc === "string" && entry.doc.length > 0 ? entry.doc : "ARCHITECTURE.md",
    include: [...new Set(include)].sort(),
    exclude: [...new Set(exclude)].sort(),
    createdAt: typeof entry?.createdAt === "string" ? entry.createdAt : now,
    updatedAt: typeof entry?.updatedAt === "string" ? entry.updatedAt : now,
  };
}

export function readArchitectureRegistry(cwd, indexDir = ".dsh/compaction-fidelity") {
  try {
    const file = registryPath(cwd, indexDir);
    if (!existsSync(file)) return { version: REGISTRY_VERSION, scopes: {} };
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const scopes = {};
    if (Array.isArray(parsed)) {
      for (const scope of parsed) scopes[normalizeScope(scope)] = normalizeEntry({});
    } else if (parsed !== null && typeof parsed === "object" && parsed.scopes !== null && typeof parsed.scopes === "object") {
      for (const [scope, entry] of Object.entries(parsed.scopes)) scopes[normalizeScope(scope)] = normalizeEntry(entry);
    }
    return { version: REGISTRY_VERSION, scopes };
  } catch {
    return { version: REGISTRY_VERSION, scopes: {} };
  }
}

export function writeArchitectureRegistry(cwd, indexDir, registry) {
  const scopes = {};
  for (const [scope, entry] of Object.entries(registry?.scopes ?? {})) scopes[normalizeScope(scope)] = normalizeEntry(entry);
  const sorted = Object.fromEntries(Object.entries(scopes).sort(([left], [right]) => left.localeCompare(right)));
  atomicWriteArchitectureFile(registryPath(cwd, indexDir), JSON.stringify({ version: REGISTRY_VERSION, scopes: sorted }, null, 2));
  return { version: REGISTRY_VERSION, scopes: sorted };
}

export function rememberArchitectureScope(cwd, indexDir, scope, options = {}) {
  const registry = readArchitectureRegistry(cwd, indexDir);
  const normalized = normalizeScope(scope);
  const now = new Date().toISOString();
  const existing = registry.scopes[normalized];
  registry.scopes[normalized] = normalizeEntry({
    ...(existing ?? {}),
    doc: options.docName ?? existing?.doc ?? "ARCHITECTURE.md",
    updatedAt: now,
    createdAt: existing?.createdAt ?? now,
  });
  return writeArchitectureRegistry(cwd, indexDir, registry);
}

export function updateArchitectureScopeRules(cwd, indexDir, scope, change = {}) {
  const registry = readArchitectureRegistry(cwd, indexDir);
  const normalized = normalizeScope(scope);
  const now = new Date().toISOString();
  const existing = registry.scopes[normalized] ?? normalizeEntry({});
  const include = new Set(existing.include ?? []);
  const exclude = new Set(existing.exclude ?? []);
  const addInclude = Array.isArray(change.include) ? change.include : [];
  const removeInclude = Array.isArray(change.removeInclude) ? change.removeInclude : [];
  const addExclude = Array.isArray(change.exclude) ? change.exclude : [];
  const removeExclude = Array.isArray(change.removeExclude) ? change.removeExclude : [];
  for (const pattern of addInclude) { const value = normalizePattern(pattern); if (value !== null) include.add(value); }
  for (const pattern of removeInclude) { const value = normalizePattern(pattern); if (value !== null) include.delete(value); }
  for (const pattern of addExclude) { const value = normalizePattern(pattern); if (value !== null) exclude.add(value); }
  for (const pattern of removeExclude) { const value = normalizePattern(pattern); if (value !== null) exclude.delete(value); }
  registry.scopes[normalized] = normalizeEntry({
    ...existing,
    include: [...include].sort(),
    exclude: [...exclude].sort(),
    createdAt: existing.createdAt ?? now,
    updatedAt: now,
  });
  return writeArchitectureRegistry(cwd, indexDir, registry);
}

export function removeArchitectureScope(cwd, indexDir, scope) {
  const registry = readArchitectureRegistry(cwd, indexDir);
  const normalized = normalizeScope(scope);
  const existed = Object.prototype.hasOwnProperty.call(registry.scopes, normalized);
  delete registry.scopes[normalized];
  return { existed, registry: writeArchitectureRegistry(cwd, indexDir, registry) };
}

export function managedScopeRules(registry, scope) {
  return registry?.scopes?.[normalizeScope(scope)] ?? null;
}
