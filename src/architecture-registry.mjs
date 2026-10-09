// Managed scope registry with include/exclude rules for architecture retrieval.
//
// A registry only ever *narrows* what may be read, indexed, cached, or injected.
// An absent registry file means "unmanaged workspace" and keeps default reads
// available, but a registry we cannot fully honor must fail closed instead of
// degrading to "no rules": an empty rule set grants the widest possible read,
// so treating a corrupt file as empty turns data corruption into a leak.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertWorkspaceContained, atomicWriteArchitectureFile, mutateArchitectureDocument } from "./architecture-io.mjs";
import { isSafeRelativePath, sha256 } from "./util.mjs";

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

function countNonEmptyRules(value) {
  if (!Array.isArray(value)) return 0;
  let count = 0;
  for (const item of value) {
    if (String(item ?? "").trim().length > 0) count += 1;
    if (count >= MAX_RULES) break;
  }
  return count;
}

/**
 * True when every rule in the entry can be honored exactly. toRuleList drops
 * patterns it cannot normalize; a dropped *exclude* would widen access, so an
 * entry we cannot fully honor makes the whole registry corrupt.
 */
function entryRulesAreHonorable(entry) {
  const rawInclude = Array.isArray(entry?.include) ? entry.include : [];
  const rawExclude = Array.isArray(entry?.exclude) ? entry.exclude : [];
  if (countNonEmptyRules(rawInclude) > 0 && toRuleList(rawInclude).length === 0) return false;
  return toRuleList(rawExclude).length === countNonEmptyRules(rawExclude);
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
  if (rules !== null && typeof rules === "object" && rules.denyAll === true) return false;
  const rel = String(relativeFile ?? "").replace(/\\/g, "/");
  const rawInclude = Array.isArray(rules?.include) ? rules.include : [];
  const include = toRuleList(rawInclude);
  const exclude = toRuleList(rules?.exclude);
  if (exclude.some((pattern) => globToRegExp(pattern)?.test(rel))) return false;
  if (rawInclude.length > 0 && include.length === 0) return false;
  if (include.length === 0) return true;
  return include.some((pattern) => globToRegExp(pattern)?.test(rel));
}

/**
 * Rules object returned for a registry that cannot be honored. It denies every
 * path so no caller can fall back to default-document behavior.
 */
export const DENY_ALL_RULES = Object.freeze({ denyAll: true, doc: "ARCHITECTURE.md", include: [], exclude: [] });

export function registryIsCorrupt(registry) {
  return registry?.status === "corrupt";
}

/**
 * Stable fingerprint of the effective read policy. Cached artifacts (index,
 * brief, anchor map) record the fingerprint they were built under, so a rule
 * change or a corrupt registry invalidates them instead of serving content the
 * current rules no longer allow.
 */
export function registryFingerprint(registry) {
  const status = registry?.status === "corrupt" ? "corrupt" : registry?.status === "valid" ? "valid" : "missing";
  const scopes = {};
  for (const [scope, entry] of Object.entries(registry?.scopes ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    const normalized = normalizeScope(scope);
    if (normalized === null) continue;
    scopes[normalized] = {
      doc: typeof entry?.doc === "string" ? entry.doc : "ARCHITECTURE.md",
      include: toRuleList(entry?.include),
      exclude: toRuleList(entry?.exclude),
    };
  }
  return sha256(JSON.stringify({ version: REGISTRY_VERSION, status, scopes }));
}

/**
 * Read policy shared by every retrieval entry point. `blocked` means the
 * registry cannot be honored and nothing may be served; otherwise `fingerprint`
 * identifies the policy cached artifacts must have been built under, and
 * `filterFile` is the workspace-wide filter used when building them.
 */
export function retrievalPolicyFor(cwd, indexDir = ".dsh/compaction-fidelity") {
  const registry = readArchitectureRegistry(cwd, indexDir);
  return {
    blocked: registryIsCorrupt(registry),
    fingerprint: registryFingerprint(registry),
    filterFile: createGlobalWorkspaceFileFilter(registry),
  };
}

export function createWorkspaceFileFilter(registry, scope) {
  const normalizedScope = normalizeScope(scope);
  if (normalizedScope === null) return () => false;
  if (registryIsCorrupt(registry)) return () => false;
  const rules = registry?.scopes?.[normalizedScope] ?? null;
  if (rules === null) return () => true;
  if (rules.denyAll === true) return () => false;
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
 * Workspace-wide filter that applies *every* registered scope's rules to a
 * workspace-relative path. The root index spans all subfolders, so a rule
 * registered for one sub-scope must still constrain root-level reads.
 */
export function createGlobalWorkspaceFileFilter(registry) {
  if (registryIsCorrupt(registry)) return () => false;
  const entries = Object.entries(registry?.scopes ?? {});
  if (entries.length === 0) return () => true;
  return (workspaceFile) => {
    const rel = String(workspaceFile ?? "").replace(/\\/g, "/");
    if (!isSafeRelativePath(rel)) return false;
    for (const [scope, rules] of entries) {
      const normalized = normalizeScope(scope);
      if (normalized === null) continue;
      let scopedRel = rel;
      if (normalized !== ".") {
        const prefix = `${normalized}/`;
        if (!rel.startsWith(prefix)) continue;
        scopedRel = rel.slice(prefix.length);
      }
      if (scopedRel.length === 0 || scopedRel.startsWith("../")) return false;
      if (!matchesScopeRules(scopedRel, rules)) return false;
    }
    return true;
  };
}

/**
 * Resolve the managed architecture document for one scope. A registered
 * scope controls both the document name and whether that document may be
 * read or injected; excluded documents return null instead of falling back
 * to the default name. Unregistered scopes keep the previous default-document
 * behavior.
 */
export function resolveManagedDocTarget(registry, scope, fallbackDoc = "ARCHITECTURE.md") {
  const normalizedScope = normalizeScope(scope);
  if (normalizedScope === null) return { ok: false, reason: "invalid-scope", scope: null, registered: false };
  if (registryIsCorrupt(registry)) return { ok: false, reason: "corrupt-registry", scope: normalizedScope, registered: false };
  const entry = registry?.scopes?.[normalizedScope];
  const registered = entry !== undefined && entry !== null;
  const docName = registered && typeof entry?.doc === "string" && /^[\w.-]+\.md$/i.test(entry.doc) ? entry.doc : fallbackDoc;
  const workspacePath = normalizedScope === "." ? docName : normalizedScope + "/" + docName;
  // The workspace-wide filter applies every registered scope's rules, so a root
  // exclude also constrains a document inside that folder, and a scope that
  // excludes its own document denies it for every reader.
  if (!createGlobalWorkspaceFileFilter(registry)(workspacePath)) {
    // Denial is not absence: the reason is kept so a caller never reports the
    // document as missing and then offers to create or rescan it.
    // Keep the reason specific: a rule of this scope is a different finding
    // from a rule registered above it.
    const ownRulesDeny = !createWorkspaceFileFilter(registry, normalizedScope)(workspacePath);
    return { ok: false, reason: ownRulesDeny ? "denied-scope" : "denied-ancestor", scope: normalizedScope, docName, relative: workspacePath, registered };
  }
  return { ok: true, reason: null, scope: normalizedScope, docName, relative: workspacePath, registered };
}

/** The resolved target, or null when the policy refuses the document. */
export function managedDocTarget(registry, scope, fallbackDoc = "ARCHITECTURE.md") {
  const resolved = resolveManagedDocTarget(registry, scope, fallbackDoc);
  return resolved.ok === true ? { scope: resolved.scope, docName: resolved.docName, relative: resolved.relative } : null;
}

function refusalOutcome(reason) {
  return { ok: false, reason, target: null };
}

/**
 * Structured, fail-closed outcome for one managed architecture document.
 *
 * This is the single policy gate every reader and writer must pass before it
 * resolves a path, reads a file, or mutates anything. Outcome-layer refusals
 * (denied-scope, denied-ancestor, corrupt-registry, invalid-scope) always
 * return target: null: a refused outcome is not a pointer, and no caller may
 * build a default-document target from it.
 *
 * Filesystem failures (missing, unsafe-path, symlink, too-large, unreadable)
 * are deliberately not produced here; they belong to the reader
 * (readManagedArchitectureDoc) and are only meaningful once policy has allowed
 * the document.
 */
export function managedDocOutcomeFor(scope, deps = {}) {
  if (typeof scope !== "string") return refusalOutcome("invalid-scope");
  const trimmed = scope.trim();
  if (trimmed.length === 0 || trimmed.includes("\0")) return refusalOutcome("invalid-scope");
  const normalizedScope = normalizeScope(trimmed);
  if (normalizedScope === null) return refusalOutcome("invalid-scope");
  const fallbackDoc = typeof deps.fallbackDoc === "string" && /^[\w.-]+\.md$/i.test(deps.fallbackDoc)
    ? deps.fallbackDoc
    : "ARCHITECTURE.md";
  let registry;
  try {
    registry = typeof deps.loadRegistry === "function" ? deps.loadRegistry() : deps.registry;
  } catch {
    // The low-level reader already folds IO failures into corrupt; an injected
    // reader that throws must fail closed for the same reason.
    registry = { version: REGISTRY_VERSION, status: "corrupt", scopes: {} };
  }
  if (registry === null || registry === undefined) registry = { version: REGISTRY_VERSION, status: "missing", scopes: {} };
  const resolved = resolveManagedDocTarget(registry, normalizedScope, fallbackDoc);
  if (resolved.ok !== true) {
    // Keep the specific refusal found below (denied-scope vs denied-ancestor).
    // This project does not promise a separate registry-unreadable reason
    // because the reader already reports IO failures as corrupt.
    return refusalOutcome(resolved.reason === "registry-unreadable" ? "corrupt-registry" : resolved.reason);
  }
  return {
    ok: true,
    reason: null,
    target: { scope: resolved.scope, docName: resolved.docName, relative: resolved.relative },
  };
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

/**
 * Parse registry text with an explicit validity verdict. Only a genuinely
 * absent file may be treated as "no rules"; anything we cannot honor is
 * reported as corrupt so callers can fail closed.
 */
function parseRegistryText(text) {
  const scopes = {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, scopes: {} };
  }
  if (Array.isArray(parsed)) {
    // Legacy v1 shape: a bare list of registered scopes without rules.
    for (const scope of parsed) {
      const normalized = normalizeScope(scope);
      if (normalized === null) return { ok: false, scopes: {} };
      scopes[normalized] = normalizeEntry({});
    }
    return { ok: true, scopes };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, scopes: {} };
  if (parsed.scopes === null || typeof parsed.scopes !== "object" || Array.isArray(parsed.scopes)) return { ok: false, scopes: {} };
  for (const [scope, entry] of Object.entries(parsed.scopes)) {
    const normalized = normalizeScope(scope);
    if (normalized === null) return { ok: false, scopes: {} };
    if (!entryRulesAreHonorable(entry)) return { ok: false, scopes: {} };
    scopes[normalized] = normalizeEntry(entry);
  }
  return { ok: true, scopes };
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
  const file = registryPath(cwd, indexDir);
  let text;
  try {
    if (!existsSync(file)) return { version: REGISTRY_VERSION, status: "missing", scopes: {} };
    text = readFileSync(file, "utf8");
  } catch {
    // An unreadable registry is not an absent one; fail closed.
    return { version: REGISTRY_VERSION, status: "corrupt", scopes: {} };
  }
  // A file that exists but holds nothing is not an absent registry: only a
  // genuinely missing file may fall back to default behavior, so a blank one is
  // reported as corrupt and must be repaired by hand.
  if (text.trim().length === 0) return { version: REGISTRY_VERSION, status: "corrupt", scopes: {} };
  const parsed = parseRegistryText(text);
  if (!parsed.ok) return { version: REGISTRY_VERSION, status: "corrupt", scopes: {} };
  return { version: REGISTRY_VERSION, status: "valid", scopes: parsed.scopes };
}

export function writeArchitectureRegistry(cwd, indexDir, registry) {
  assertWorkspaceContained(cwd, registryPath(cwd, indexDir));
  const payload = serializeRegistry(registry);
  atomicWriteArchitectureFile(registryPath(cwd, indexDir), JSON.stringify(payload, null, 2));
  return payload;
}

/**
 * Map a registry mutation failure onto its public refusal reason. The lock and
 * CAS helpers report failures by message, so this stays deliberately small and
 * prefers failing closed (write-failed) over guessing.
 */
export function classifyRegistryWriteError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/CAS conflict/i.test(message)) return "registry-cas-conflict";
  if (/lock timeout/i.test(message)) return "registry-locked";
  if (/corrupt|blank/i.test(message)) return "corrupt-registry";
  return "registry-write-failed";
}

export function mutateArchitectureRegistry(cwd, indexDir, mutator, options = {}) {
  const file = registryPath(cwd, indexDir);
  assertWorkspaceContained(cwd, file);
  let payload = null;
  const result = mutateArchitectureDocument(file, (text) => {
    let registry;
    if (typeof text === "string" && text.trim().length === 0) {
      throw new Error("architecture registry is blank and must be repaired before it can be updated: " + file);
    }
    if (text === null) {
      registry = { version: REGISTRY_VERSION, status: "missing", scopes: {} };
    } else {
      const parsed = parseRegistryText(text);
      // Rewriting a corrupt registry would drop the user's rules and widen
      // access; require an explicit repair instead.
      if (!parsed.ok) throw new Error("architecture registry is corrupt and must be repaired before it can be updated: " + file);
      registry = { version: REGISTRY_VERSION, status: "valid", scopes: parsed.scopes };
    }
    const next = mutator(registry);
    if (next === null || next === undefined) return null;
    payload = serializeRegistry(next);
    return JSON.stringify(payload, null, 2);
  }, options);
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

export function updateArchitectureScopeRules(cwd, indexDir, scope, change = {}, mutationOptions = {}) {
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
  }, mutationOptions);
  return mutation.registry;
}

export function removeArchitectureScope(cwd, indexDir, scope, mutationOptions = {}) {
  const normalized = normalizeScope(scope);
  if (normalized === null) throw new Error(`unsafe architecture scope: ${String(scope)}`);
  let existed = false;
  const mutation = mutateArchitectureRegistry(cwd, indexDir, (registry) => {
    existed = Object.prototype.hasOwnProperty.call(registry.scopes, normalized);
    delete registry.scopes[normalized];
    return registry;
  }, mutationOptions);
  return { existed, registry: mutation.registry };
}

export function managedScopeRules(registry, scope) {
  if (registryIsCorrupt(registry)) return DENY_ALL_RULES;
  const normalized = normalizeScope(scope);
  if (normalized === null) return DENY_ALL_RULES;
  return registry?.scopes?.[normalized] ?? null;
}


