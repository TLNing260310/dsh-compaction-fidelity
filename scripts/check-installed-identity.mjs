#!/usr/bin/env node
// Identity check for an installed plugin payload.
//
// Three questions, answered separately because they fail differently:
//   1. Baseline - does the payload match the release artifact of the version it
//      claims to be? The artifact is the git tag for that version, restricted to
//      the package's own `files` manifest.
//   2. Payloads - do the plugin directory and the Desktop Profile copy agree?
//   3. Upgrade  - how far is the installed version behind HEAD? Reported as a gap,
//      never as damage: an older but intact install is not a broken one.
//
// Identity is the raw SHA-256 of the bytes. Line-ending normalization is only
// used to *explain* a difference, and a pair that matches only after
// normalization is reported as IDENTICAL_AFTER_NORMALIZATION, not as identical.
// What cannot be verified is reported as UNKNOWN instead of counted as a match.
//
// Exit codes: 0 verified (identical, or identical once line endings explain the
// byte difference), 1 drift, 2 UNKNOWN, 3 the check could not run.
//
// Nothing here writes to the payload, the working tree, or git.
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDshHome } from "../src/state.mjs";

export const DEFAULT_IGNORES = Object.freeze(["node_modules", ".git", ".dsh", ".tmp", "*.log", ".DS_Store", "Thumbs.db"]);
export const PLUGIN_DIR_NAME = "dsh-compaction-fidelity";
export const EXIT = Object.freeze({ VERIFIED: 0, DRIFT: 1, UNKNOWN: 2, CANNOT_RUN: 3 });
export const STATUS = Object.freeze({
  IDENTICAL: "identical",
  NORMALIZED: "identical-after-normalization",
  DIFFERS: "differs",
  UNKNOWN: "unknown",
  ONLY_REFERENCE: "only-in-reference",
  ONLY_PAYLOAD: "only-in-payload",
});

const TEXT_LIMIT_BYTES = 16 * 1024 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;
const STRICT_DECODER = new TextDecoder("utf-8", { fatal: true });

export function normalizeLineEndings(text) {
  return String(text ?? "").replace(/\r\n/g, "\n");
}

export function sha256Of(input) {
  return createHash("sha256").update(Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ""), "utf8")).digest("hex");
}

/** Stream a file so even an oversized payload file still has an identity. */
export function hashFileSync(path) {
  const hash = createHash("sha256");
  const handle = openSync(path, "r");
  try {
    const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let position = 0;
    let read = readSync(handle, chunk, 0, chunk.length, position);
    while (read > 0) {
      hash.update(chunk.subarray(0, read));
      position += read;
      read = readSync(handle, chunk, 0, chunk.length, position);
    }
  } finally {
    closeSync(handle);
  }
  return hash.digest("hex");
}

function wildcardToRegExp(pattern) {
  const escaped = String(pattern ?? "")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp("^" + escaped + "$");
}

/**
 * Ignore rules match either a whole relative path (when the pattern contains a
 * slash) or any single path segment, so "node_modules" prunes the tree and
 * "*.log" drops matching files. Used only when no install manifest is available.
 */
export function createIgnoreMatcher(patterns = DEFAULT_IGNORES) {
  const matchers = (patterns ?? []).map((pattern) => ({
    regex: wildcardToRegExp(pattern),
    hasSlash: String(pattern ?? "").includes("/"),
  }));
  return (relativePath) => {
    const posix = String(relativePath ?? "").replace(/\\/g, "/");
    const segments = posix.split("/");
    for (const matcher of matchers) {
      if (matcher.hasSlash) {
        if (matcher.regex.test(posix)) return true;
      } else if (segments.some((segment) => matcher.regex.test(segment))) {
        return true;
      }
    }
    return false;
  };
}

function manifestPatternToRegExp(pattern) {
  const escaped = String(pattern ?? "")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*");
  return new RegExp("^" + escaped + "$");
}

/**
 * Match a package `files` manifest. npm semantics are approximated: a trailing
 * double-star covers the whole subtree, a leading double-star matches at any
 * depth, and a bare name matches one exact path.
 */
export const MANIFEST_ALWAYS_INCLUDED = Object.freeze(["package.json"]);

export function createManifestMatcher(patterns) {
  const list = (patterns ?? []).filter((pattern) => String(pattern ?? "").trim().length > 0).map((pattern) => manifestPatternToRegExp(pattern));
  if (list.length === 0) return null;
  // npm ships package.json whatever `files` says, so a manifest-scoped comparison
  // that dropped it would leave the entry points, exports and peer ranges
  // unverified even though the payload matched the artifact.
  for (const always of MANIFEST_ALWAYS_INCLUDED) list.push(manifestPatternToRegExp(always));
  return (relativePath) => {
    const posix = String(relativePath ?? "").replace(/\\/g, "/");
    return list.some((regex) => regex.test(posix));
  };
}

export function describeContent(input) {
  const raw = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ""), "utf8");
  const sha256 = sha256Of(raw);
  if (raw.includes(0)) return { kind: "binary", bytes: raw.length, sha256, crlf: false, text: null };
  let text;
  try {
    text = STRICT_DECODER.decode(raw);
  } catch {
    // Two different invalid byte sequences can decode to the same replacement
    // characters, so undecodable content has no text identity at all.
    return { kind: "undecodable", bytes: raw.length, sha256, crlf: false, text: null };
  }
  return { kind: "text", bytes: raw.length, sha256, crlf: text.includes("\r\n"), text };
}
function scopeLabel(options, manifest) {
  if (manifest !== null) return { kind: "manifest", patterns: options.manifestPatterns ?? [] };
  return { kind: "ignore", patterns: options.ignore ?? DEFAULT_IGNORES };
}

function describeFileSync(path, size) {
  if (size > TEXT_LIMIT_BYTES) return { kind: "large", bytes: size, sha256: hashFileSync(path), crlf: false, text: null };
  try {
    return describeContent(readFileSync(path));
  } catch {
    return { kind: "unreadable", bytes: size, sha256: null, crlf: false, text: null };
  }
}

/**
 * Collect a directory into a comparable map. Files outside the install manifest
 * are listed separately instead of counting as drift, so "the repo ships tests
 * that the install does not" never looks like damage. Symlinks are recorded by
 * target rather than followed.
 */
export function collectDirectory(root, options = {}) {
  const requested = resolve(root);
  const ignore = createIgnoreMatcher(options.ignore ?? DEFAULT_IGNORES);
  const manifest = typeof options.manifest === "function" ? options.manifest : null;
  const empty = { files: new Map(), notShipped: new Map(), scope: scopeLabel(options, manifest) };
  if (!existsSync(requested)) return { ok: false, reason: "missing", root: requested, realRoot: null, linked: false, ...empty };
  let linked = false;
  let absolute = requested;
  try {
    if (lstatSync(requested).isSymbolicLink()) {
      linked = true;
      absolute = realpathSync(requested);
    }
  } catch {
    return { ok: false, reason: "unreadable", root: requested, realRoot: null, linked: false, ...empty };
  }
  if (!statSync(absolute).isDirectory()) return { ok: false, reason: "not-a-directory", root: requested, realRoot: absolute, linked, ...empty };

  const files = new Map();
  const notShipped = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const target = join(dir, entry.name);
      const relativePath = relative(absolute, target).split(sep).join("/");
      if (ignore(relativePath)) continue;
      const inScope = manifest === null ? true : manifest(relativePath) === true;
      let stat;
      try {
        stat = lstatSync(target);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        let linkTarget = null;
        try {
          linkTarget = readlinkSync(target);
        } catch {
          linkTarget = null;
        }
        const described = { kind: "symlink", bytes: 0, sha256: null, crlf: false, text: null, target: linkTarget };
        if (inScope) files.set(relativePath, described);
        else notShipped.set(relativePath, { kind: described.kind, bytes: 0, sha256: null });
        continue;
      }
      if (stat.isDirectory()) {
        walk(target);
        continue;
      }
      if (!stat.isFile()) continue;
      if (inScope) files.set(relativePath, describeFileSync(target, stat.size));
      else {
        const described = describeFileSync(target, stat.size);
        notShipped.set(relativePath, { kind: described.kind, bytes: described.bytes, sha256: described.sha256 });
      }
    }
  };
  walk(absolute);
  return { ok: true, reason: null, root: requested, realRoot: absolute, linked, files, notShipped, scope: scopeLabel(options, manifest) };
}

export function firstDifferingLine(referenceText, payloadText) {
  const left = String(referenceText ?? "").split("\n");
  const right = String(payloadText ?? "").split("\n");
  const limit = Math.max(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    const a = index < left.length ? left[index] : null;
    const b = index < right.length ? right[index] : null;
    if (a !== b) return { line: index + 1, reference: a, payload: b };
  }
  return { line: null, reference: null, payload: null };
}

/**
 * Decide one file's status. Raw SHA-256 is the identity; newline normalization
 * only explains bytes that differ by nothing else.
 */
export function compareFile(left, right) {
  if (left === undefined) return { status: STATUS.ONLY_PAYLOAD, reason: "absent from the reference", payloadSha256: right.sha256 ?? null };
  if (right === undefined) return { status: STATUS.ONLY_REFERENCE, reason: "absent from the payload", referenceSha256: left.sha256 ?? null };
  const hashes = { referenceSha256: left.sha256 ?? null, payloadSha256: right.sha256 ?? null };
  if (left.kind === "unreadable" || right.kind === "unreadable") return { ...hashes, status: STATUS.UNKNOWN, reason: "unreadable on disk" };
  if (left.kind === "undecodable" || right.kind === "undecodable") return { ...hashes, status: STATUS.UNKNOWN, reason: "bytes are not valid UTF-8 (no text identity)" };
  if (left.kind === "symlink" || right.kind === "symlink") {
    if (left.kind === "symlink" && right.kind === "symlink") {
      return left.target === right.target
        ? { ...hashes, status: STATUS.IDENTICAL, reason: "symlink target matches" }
        : { ...hashes, status: STATUS.DIFFERS, reason: "symlink target differs", referenceLine: String(left.target), payloadLine: String(right.target) };
    }
    return { ...hashes, status: STATUS.DIFFERS, reason: "one side is a symlink" };
  }
  if (left.sha256 !== null && left.sha256 === right.sha256) return { ...hashes, status: STATUS.IDENTICAL };
  if (left.kind === "text" && right.kind === "text") {
    if (normalizeLineEndings(left.text) === normalizeLineEndings(right.text)) {
      return { ...hashes, status: STATUS.NORMALIZED, reason: "bytes differ only by CRLF" };
    }
    // Line numbers are reported after CRLF normalization, otherwise a checkout
    // difference makes every line the "first" difference on a LF baseline.
    const referenceText = normalizeLineEndings(left.text);
    const payloadText = normalizeLineEndings(right.text);
    const at = firstDifferingLine(referenceText, payloadText);
    return {
      ...hashes,
      status: STATUS.DIFFERS,
      reason: "content",
      line: at.line,
      referenceLine: at.reference,
      payloadLine: at.payload,
      referenceLines: referenceText.split("\n").length,
      payloadLines: payloadText.split("\n").length,
    };
  }
  if (left.sha256 === null || right.sha256 === null) return { ...hashes, status: STATUS.UNKNOWN, reason: "no digest for one side" };
  return { ...hashes, status: STATUS.DIFFERS, reason: left.kind === right.kind ? "binary content" : "file kind differs" };
}

export function compareCollections(reference, payload) {
  const paths = [...new Set([...reference.files.keys(), ...payload.files.keys()])].sort();
  const rows = paths.map((path) => ({ path, bytes: payload.files.get(path)?.bytes ?? reference.files.get(path)?.bytes ?? null, ...compareFile(reference.files.get(path), payload.files.get(path)) }));
  const counts = { compared: rows.length, identical: 0, normalized: 0, differs: 0, unknown: 0, onlyReference: 0, onlyPayload: 0 };
  for (const row of rows) {
    if (row.status === STATUS.IDENTICAL) counts.identical += 1;
    else if (row.status === STATUS.NORMALIZED) counts.normalized += 1;
    else if (row.status === STATUS.DIFFERS) counts.differs += 1;
    else if (row.status === STATUS.UNKNOWN) counts.unknown += 1;
    else if (row.status === STATUS.ONLY_REFERENCE) counts.onlyReference += 1;
    else if (row.status === STATUS.ONLY_PAYLOAD) counts.onlyPayload += 1;
  }
  const verdict = counts.differs + counts.onlyReference + counts.onlyPayload > 0
    ? "DRIFT"
    : counts.unknown > 0
      ? "UNKNOWN"
      : counts.normalized > 0
        ? "IDENTICAL_AFTER_NORMALIZATION"
        : "IDENTICAL";
  return { verdict, counts, rows, differences: rows.filter((row) => row.status !== STATUS.IDENTICAL && row.status !== STATUS.NORMALIZED) };
}
function readBatchContents(buffer, into) {
  if (!Buffer.isBuffer(buffer)) return;
  let offset = 0;
  while (offset < buffer.length) {
    const headerEnd = buffer.indexOf(0x0a, offset);
    if (headerEnd === -1) return;
    const parts = buffer.toString("utf8", offset, headerEnd).split(" ");
    if (parts.length < 3) return;
    const size = Number(parts[2]);
    const start = headerEnd + 1;
    const end = start + size;
    if (!Number.isFinite(size) || end > buffer.length) return;
    into.set(parts[0], buffer.subarray(start, end));
    offset = end + 1;
  }
}

/**
 * Read a git ref into the same comparable shape as collectDirectory, without
 * touching the working tree. One ls-tree plus one cat-file --batch means a
 * payload of a few hundred files costs two processes rather than one per file.
 */
export function readGitRef(ref, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const ignore = createIgnoreMatcher(options.ignore ?? DEFAULT_IGNORES);
  const manifest = typeof options.manifest === "function" ? options.manifest : null;
  const files = new Map();
  const notShipped = new Map();
  const empty = { files, notShipped, realRoot: null, linked: false, scope: scopeLabel(options, manifest) };
  const listed = spawnSync("git", ["ls-tree", "-r", "-z", ref], { cwd, maxBuffer: 64 * 1024 * 1024 });
  if (listed.error !== undefined && listed.error !== null) {
    return { ok: false, reason: "git-unavailable", detail: String(listed.error.message ?? listed.error), ref, commit: null, ...empty };
  }
  if (listed.status !== 0) {
    return { ok: false, reason: "unknown-ref", detail: String(listed.stderr ?? "").trim(), ref, commit: null, ...empty };
  }
  const resolved = spawnSync("git", ["rev-parse", ref], { cwd, encoding: "utf8" });
  const commit = resolved.status === 0 ? String(resolved.stdout).trim() : null;

  const entries = [];
  for (const record of String(listed.stdout ?? "").split("\0")) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const meta = record.slice(0, tab).split(" ");
    if (meta[1] !== "blob") continue;
    const path = record.slice(tab + 1);
    if (ignore(path)) continue;
    entries.push({ sha: meta[2], path, inScope: manifest === null ? true : manifest(path) === true });
  }

  const contents = new Map();
  if (entries.length > 0) {
    const batched = spawnSync("git", ["cat-file", "--batch"], {
      cwd,
      input: entries.map((entry) => entry.sha).join("\n") + "\n",
      maxBuffer: 256 * 1024 * 1024,
    });
    if (batched.error === undefined || batched.error === null) readBatchContents(batched.stdout, contents);
  }

  for (const entry of entries) {
    const raw = contents.get(entry.sha);
    const described = raw === undefined
      ? { kind: "unreadable", bytes: 0, sha256: null, crlf: false, text: null }
      : describeContent(raw);
    if (entry.inScope) files.set(entry.path, described);
    else notShipped.set(entry.path, { kind: described.kind, bytes: described.bytes, sha256: described.sha256 });
  }
  return { ok: true, reason: null, ref, commit, files, notShipped, realRoot: null, linked: false, scope: scopeLabel(options, manifest) };
}

export function readManifestPatternsFromText(text) {
  try {
    const parsed = JSON.parse(String(text ?? ""));
    const patterns = Array.isArray(parsed?.files) ? parsed.files.filter((item) => typeof item === "string" && item.trim().length > 0) : [];
    const version = typeof parsed?.version === "string" ? parsed.version : null;
    if (patterns.length === 0) return { ok: false, reason: "empty-manifest", patterns: [], version };
    return { ok: true, reason: null, patterns, version };
  } catch {
    return { ok: false, reason: "unreadable-manifest", patterns: [], version: null };
  }
}

export function readManifestFromRef(ref, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const shown = spawnSync("git", ["cat-file", "blob", ref + ":package.json"], { cwd, maxBuffer: 8 * 1024 * 1024 });
  if (shown.status !== 0 || !Buffer.isBuffer(shown.stdout)) return { ok: false, reason: "no-manifest-at-ref", patterns: [], version: null };
  return readManifestPatternsFromText(shown.stdout.toString("utf8"));
}

export function readManifestFromDirectory(root) {
  const path = join(resolve(root), "package.json");
  if (!existsSync(path)) return { ok: false, reason: "no-manifest", patterns: [], version: null };
  try {
    return readManifestPatternsFromText(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, reason: "unreadable-manifest", patterns: [], version: null };
  }
}

/** The release artifact of the installed version is the tag named for it. */
export function resolveBaselineRef(version, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  if (typeof version !== "string" || version.length === 0) return { ok: false, reason: "no-version", detail: "the payload declares no version" };
  for (const candidate of ["v" + version, version]) {
    const resolved = spawnSync("git", ["rev-parse", "--verify", "--quiet", candidate + "^{commit}"], { cwd, encoding: "utf8" });
    if (resolved.status === 0) return { ok: true, reason: null, ref: candidate, commit: String(resolved.stdout).trim() };
  }
  return { ok: false, reason: "no-tag-for-version", detail: "no git tag matches the installed version " + version };
}

/** Where the Desktop Profile expects the payload, from its declared dependency. */
export function resolveProfilePayload(options = {}) {
  const home = options.home ?? resolveDshHome();
  const profileDir = join(home, "profiles", "desktop");
  const manifestPath = join(profileDir, "package.json");
  if (!existsSync(manifestPath)) return { ok: false, reason: "no-profile", detail: "no Desktop profile at " + profileDir };
  let declared = null;
  try {
    declared = JSON.parse(readFileSync(manifestPath, "utf8"))?.dependencies?.[PLUGIN_DIR_NAME] ?? null;
  } catch {
    return { ok: false, reason: "unreadable-profile", detail: "cannot read " + manifestPath };
  }
  const candidates = [join(profileDir, "node_modules", PLUGIN_DIR_NAME), join(home, "plugins", PLUGIN_DIR_NAME)];
  const found = candidates.filter((candidate) => existsSync(candidate));
  if (found.length === 0) {
    return { ok: false, reason: "no-profile-payload", detail: "the profile declares " + String(declared) + " but no payload directory exists", declared, profileDir };
  }
  return { ok: true, reason: null, path: found[0], declared, profileDir, candidates: found };
}

export function loadHotfixes(path) {
  if (typeof path !== "string" || path.length === 0) return { ok: false, reason: "no-registry", entries: [] };
  if (!existsSync(path)) return { ok: false, reason: "missing-registry", entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.hotfixes) ? parsed.hotfixes : [];
    return { ok: true, reason: null, entries: list.filter((entry) => entry !== null && typeof entry === "object") };
  } catch {
    return { ok: false, reason: "unreadable-registry", entries: [] };
  }
}

/**
 * A registered hotfix is an intentional divergence, so it is reported on its own
 * line with its source and both hashes instead of being counted as drift. It has
 * to match the exact before/after hashes, otherwise it explains nothing.
 */
export function applyHotfixes(result, entries) {
  const list = Array.isArray(entries) ? entries : [];
  const known = [];
  const unexplained = [];
  for (const row of result.differences) {
    // A registration explains a difference only when it carries both hashes and
    // they match the row. An UNKNOWN row has no identity to match against, so a
    // registration without hashes can never turn it into a pass.
    const match = row.status === STATUS.UNKNOWN
      ? undefined
      : list.find((entry) => typeof entry.originalHash === "string" && entry.originalHash.length > 0
        && typeof entry.patchedHash === "string" && entry.patchedHash.length > 0
        && entry.file === row.path
        && entry.originalHash === row.referenceSha256
        && entry.patchedHash === row.payloadSha256);
    if (match === undefined) unexplained.push(row);
    else known.push({ row, hotfix: { reason: match.reason ?? null, source: match.source ?? null, registeredAt: match.registeredAt ?? null } });
  }
  // A difference that is fully explained by a registered hotfix is neither drift
  // nor identity: it gets its own verdict, and only the unexplained rest decides
  // between DRIFT and UNKNOWN.
  const verdict = unexplained.length === 0
    ? (known.length > 0 ? "KNOWN_HOTFIX_ONLY" : result.verdict)
    : unexplained.some((row) => row.status === STATUS.UNKNOWN)
      ? "UNKNOWN"
      : "DRIFT";
  return { ...result, verdict, known, unexplained };
}

export function hotfixRecordFor(row, options = {}) {
  return {
    file: row.path,
    originalHash: row.referenceSha256 ?? null,
    patchedHash: row.payloadSha256 ?? null,
    line: row.line ?? null,
    reason: options.reason ?? null,
    source: options.source ?? null,
  };
}

function clipLine(value, limit = 200) {
  const text = value === null || value === undefined ? "(absent)" : String(value);
  return text.length <= limit ? text : text.slice(0, limit - 3) + "...";
}

function shortHash(hash, full) {
  if (hash === null || hash === undefined) return "(no digest - UNKNOWN)";
  return full === true ? hash : hash.slice(0, 16) + "...";
}

export function formatReport(label, result, options = {}) {
  const lines = [];
  const count = result.counts;
  lines.push("baseline:  " + (label.reference ?? "(unknown)"));
  lines.push("payload:   " + (label.payload ?? "(unknown)"));
  lines.push("scope:     " + (label.scope?.kind === "manifest"
    ? "package files manifest (" + (label.scope.patterns?.length ?? 0) + " patterns)"
    : "ignore list (" + (label.scope?.patterns ?? []).join(", ") + ")"));
  lines.push("compared:  " + count.compared + " file(s)" + (label.notShippedCount > 0 ? ", " + label.notShippedCount + " outside the manifest (listed only)" : ""));
  lines.push("identical: " + count.identical + " (raw SHA-256 equal)");
  lines.push("explained: " + count.normalized + (count.normalized > 0 ? " identical only after CRLF normalization" : ""));
  lines.push("differs:   " + (count.differs + count.onlyReference + count.onlyPayload));
  for (const row of result.unexplained ?? result.differences) {
    lines.push("  " + row.path + "  [" + row.status + "]");
    if (row.reason !== undefined && row.reason !== null) lines.push("    reason: " + row.reason);
    if (row.line !== undefined && row.line !== null) lines.push("    first differing line: " + row.line);
    lines.push("    baseline sha256: " + shortHash(row.referenceSha256, options.fullHash));
    lines.push("    payload  sha256: " + shortHash(row.payloadSha256, options.fullHash));
    if (options.showSource === true && (row.referenceLine !== undefined || row.payloadLine !== undefined)) {
      lines.push("    baseline: " + clipLine(row.referenceLine));
      lines.push("    payload:  " + clipLine(row.payloadLine));
    }
  }
  for (const item of result.known ?? []) {
    lines.push("  " + item.row.path + "  [known-hotfix]");
    lines.push("    baseline sha256: " + item.row.referenceSha256);
    lines.push("    payload  sha256: " + item.row.payloadSha256);
    if (item.row.line !== undefined && item.row.line !== null) lines.push("    first differing line: " + item.row.line);
    if (item.hotfix.reason !== null) lines.push("    reason: " + item.hotfix.reason);
    if (item.hotfix.source !== null) lines.push("    source: " + item.hotfix.source);
  }
  lines.push("unknown:   " + count.unknown);
  lines.push("verdict:   " + result.verdict + (result.verdict === "IDENTICAL_AFTER_NORMALIZATION" ? " (bytes differ only by line endings; not byte-identical)" : ""));
  return lines.join("\n");
}
export const USAGE = [
  "Usage: node scripts/check-installed-identity.mjs [options]",
  "",
  "Three separate questions: does the payload match the release artifact of the",
  "version it claims to be; do the plugin directory and the Desktop Profile copy",
  "agree; and how far is the install behind HEAD (reported as a gap, never damage).",
  "",
  "  --payload <dir>    plugin directory (default: $DSH_HOME/plugins/dsh-compaction-fidelity)",
  "  --profile <dir>    Desktop Profile payload (default: resolved from the profile)",
  "  --baseline <ref>   release baseline (default: the tag named for the payload version)",
  "  --against <what>   baseline (default) or worktree",
  "  --head <ref>       ref for the upgrade gap (default: HEAD, --no-head to skip)",
  "  --hotfix <file>    registry of intentional divergences (file/originalHash/patchedHash)",
  "  --emit-hotfix <f>  write the unexplained differences as a registry draft",
  "  --source <dir>     repository root (default: the repository holding this script)",
  "  --ignore <a,b>     replace the default ignore patterns",
  "  --show-source      print the differing lines themselves",
  "  --full-hash        print full 64-character hashes",
  "  --json             machine-readable output",
  "  --list             list every compared file",
  "",
  "Exit codes: 0 verified, 1 drift, 2 UNKNOWN, 3 the check could not run.",
].join("\n");

export function parseArguments(argv) {
  const options = {
    payload: null, profile: null, baseline: null, against: "baseline", head: "HEAD",
    source: null, ignore: null, hotfix: null, emit: null, reason: null, sourceNote: null,
    json: false, list: false, showSource: false, fullHash: false, help: false, unknown: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if ([ "--payload", "--profile", "--baseline", "--head", "--source", "--hotfix", "--emit-hotfix", "--reason", "--source-note" ].includes(argument)) {
      const value = argv[index + 1];
      if (value === undefined) {
        options.unknown = argument;
        return options;
      }
      const key = { "--payload": "payload", "--profile": "profile", "--baseline": "baseline", "--head": "head", "--source": "source", "--hotfix": "hotfix", "--emit-hotfix": "emit", "--reason": "reason", "--source-note": "sourceNote" }[argument];
      options[key] = value;
      index += 1;
    } else if (argument === "--against") {
      options.against = argv[index + 1] === "worktree" ? "worktree" : "baseline";
      index += 1;
    } else if (argument === "--ignore") {
      options.ignore = String(argv[index + 1] ?? "").split(",").map((item) => item.trim()).filter((item) => item.length > 0);
      index += 1;
    } else if (argument === "--no-head") {
      options.head = null;
    } else if (argument === "--no-profile") {
      options.profile = false;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--list") {
      options.list = true;
    } else if (argument === "--show-source") {
      options.showSource = true;
    } else if (argument === "--full-hash") {
      options.fullHash = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      options.unknown = argument;
      return options;
    }
  }
  return options;
}

function defaultRepoRoot() {
  return resolve(fileURLToPath(new URL("../", import.meta.url)));
}

function severityOf(verdict) {
  // Rank, not numeric value: a verified difference outranks an unverifiable one,
  // so a real drift is never hidden behind an UNKNOWN elsewhere.
  if (verdict === "DRIFT") return 2;
  if (verdict === "UNKNOWN") return 1;
  return 0;
}

function describeComparison(name, label, result, options, log) {
  log("=== " + name + " ===");
  log(formatReport(label, result, { showSource: options.showSource === true, fullHash: options.fullHash === true }));
  if (options.list === true) {
    const interesting = new Set(result.rows.filter((row) => row.status !== STATUS.IDENTICAL && row.status !== STATUS.NORMALIZED).map((row) => row.path));
    log("files:");
    for (const row of result.rows) {
      if (interesting.has(row.path)) continue;
      log("  " + row.status + "  " + row.path);
    }
  }
}

export function main(argv = process.argv.slice(2), io = {}) {
  const log = typeof io.log === "function" ? io.log : console.log;
  const fail = typeof io.error === "function" ? io.error : console.error;
  const options = parseArguments(argv);
  if (options.help === true) {
    log(USAGE);
    return EXIT.VERIFIED;
  }
  if (typeof options.unknown === "string") {
    fail("unknown or incomplete argument: " + options.unknown);
    log(USAGE);
    return EXIT.CANNOT_RUN;
  }

  const repoRoot = options.source !== null ? resolve(options.source) : defaultRepoRoot();
  const ignores = options.ignore ?? DEFAULT_IGNORES;
  const payloadRoot = options.payload !== null ? resolve(options.payload) : join(resolveDshHome(), "plugins", PLUGIN_DIR_NAME);

  const payloadManifest = readManifestFromDirectory(payloadRoot);
  const version = payloadManifest.version ?? null;

  let baselineRef = options.baseline;
  if (baselineRef === null && options.against === "baseline") {
    const resolved = resolveBaselineRef(version, { cwd: repoRoot });
    if (resolved.ok !== true) {
      fail("cannot determine the release baseline (" + resolved.reason + (resolved.detail ? ": " + resolved.detail : "") + ")");
      return EXIT.CANNOT_RUN;
    }
    baselineRef = resolved.ref;
  }
  const baselineManifest = baselineRef === null ? { ok: false, patterns: [] } : readManifestFromRef(baselineRef, { cwd: repoRoot });
  const manifestPatterns = baselineManifest.ok === true ? baselineManifest.patterns : (payloadManifest.ok === true ? payloadManifest.patterns : []);
  const manifest = createManifestMatcher(manifestPatterns);
  const scopeOptions = { ignore: ignores, manifest, manifestPatterns };

  const payload = collectDirectory(payloadRoot, scopeOptions);
  if (payload.ok !== true) {
    fail("cannot read the installed payload (" + payload.reason + "): " + payloadRoot);
    return EXIT.CANNOT_RUN;
  }

  let reference;
  if (options.against === "worktree") {
    reference = collectDirectory(repoRoot, scopeOptions);
  } else {
    reference = readGitRef(baselineRef, { ...scopeOptions, cwd: repoRoot });
  }
  if (reference.ok !== true) {
    fail("cannot read the reference (" + reference.reason + (reference.detail ? ": " + reference.detail : "") + ")");
    return EXIT.CANNOT_RUN;
  }

  const hotfixes = loadHotfixes(options.hotfix);
  if (options.hotfix !== null && hotfixes.ok !== true) fail("hotfix registry not usable (" + hotfixes.reason + "): " + options.hotfix);
  const primary = applyHotfixes(compareCollections(reference, payload), hotfixes.entries);

  const profileInfo = options.profile === false
    ? { ok: false, reason: "skipped", detail: "the profile leg was not requested" }
    : options.profile !== null
      ? { ok: true, path: resolve(options.profile), declared: null }
      : resolveProfilePayload({});
  // A profile that cannot be read is UNKNOWN, not "not applicable": the second
  // payload simply was not verified.
  let profileResult = profileInfo.ok === true
    ? null
    : { path: profileInfo.profileDir ?? null, declared: profileInfo.declared ?? null, unavailable: profileInfo.reason, detail: profileInfo.detail ?? null };
  if (profileInfo.ok === true) {
    const profilePayload = collectDirectory(profileInfo.path, scopeOptions);
    if (profilePayload.ok === true) {
      profileResult = { path: profileInfo.path, declared: profileInfo.declared ?? null, sameTree: profilePayload.realRoot === payload.realRoot, result: applyHotfixes(compareCollections(payload, profilePayload), hotfixes.entries) };
    } else {
      profileResult = { path: profileInfo.path, declared: profileInfo.declared ?? null, unavailable: profilePayload.reason };
    }
  }

  let gap = null;
  if (options.head !== null) {
    const headTree = readGitRef(options.head, { ...scopeOptions, cwd: repoRoot });
    if (headTree.ok === true) {
      const gapManifest = readManifestFromRef(options.head, { cwd: repoRoot });
      const gapResult = compareCollections(headTree, payload, gapManifest.ok === true ? {} : {});
      gap = {
        ref: options.head,
        commit: headTree.commit,
        counts: gapResult.counts,
        missing: gapResult.rows.filter((row) => row.status === STATUS.ONLY_REFERENCE).map((row) => row.path),
        extra: gapResult.rows.filter((row) => row.status === STATUS.ONLY_PAYLOAD).map((row) => row.path),
        changed: gapResult.rows.filter((row) => row.status === STATUS.DIFFERS).map((row) => row.path),
      };
    }
  }

  const primaryLabel = {
    payload: payloadRoot + (payload.linked ? " -> " + payload.realRoot : "") + (version === null ? "" : "  (declares " + version + ")"),
    reference: options.against === "worktree" ? "worktree " + repoRoot : baselineRef + " (" + (reference.commit ?? "unresolved") + ")",
    scope: payload.scope,
    notShippedCount: reference.notShipped.size,
  };

  if (options.json === true) {
    log(JSON.stringify({
      verdict: primary.verdict,
      baseline: { ref: baselineRef, commit: reference.commit ?? null, scope: payload.scope },
      payload: { root: payloadRoot, realRoot: payload.realRoot, linked: payload.linked, version, scopeKind: payloadManifest.ok === true ? "manifest" : "ignore" },
      counts: primary.counts,
      rows: primary.rows,
      knownHotfixes: primary.known.map((item) => ({ path: item.row.path, ...item.hotfix, line: item.row.line ?? null, originalHash: item.row.referenceSha256 ?? null, patchedHash: item.row.payloadSha256 ?? null })),
      unexplained: primary.unexplained,
      notShipped: [...reference.notShipped.keys()].sort(),
      profile: profileResult === null ? null : { path: profileResult.path, declared: profileResult.declared, unavailable: profileResult.unavailable ?? null, sameTree: profileResult.sameTree ?? null, verdict: profileResult.result?.verdict ?? null, counts: profileResult.result?.counts ?? null, differences: profileResult.result?.unexplained ?? null },
      upgradeGap: gap,
    }, null, 2));
  } else {
    describeComparison(options.against === "worktree" ? "payload vs worktree" : "payload vs release baseline", primaryLabel, primary, options, log);
    if (profileResult !== null) {
      log("");
      if (profileResult.unavailable !== undefined) {
        log("=== payload vs Desktop Profile ===");
        log("profile:   " + profileResult.path);
        log("verdict:   UNKNOWN (cannot read the profile payload: " + profileResult.unavailable + ")");
      } else {
        describeComparison("payload vs Desktop Profile", {
          payload: profileResult.path + (profileResult.declared === null ? "" : "  (profile declares " + profileResult.declared + ")"),
          reference: payloadRoot,
          scope: payload.scope,
          notShippedCount: 0,
        }, profileResult.result, options, log);
      }
    }
    log("");
    log("=== upgrade gap (informational, not damage) ===");
    if (gap === null) log("head:      UNKNOWN (no readable " + String(options.head) + " in " + repoRoot + ")");
    else {
      log("head:      " + gap.ref + " (" + gap.commit + ")");
      log("gap:       " + gap.missing.length + " file(s) present in HEAD only, " + gap.changed.length + " changed, " + gap.extra.length + " present in the payload only");
      for (const path of gap.missing.slice(0, 12)) log("  head-only: " + path);
      if (gap.missing.length > 12) log("  ... and " + (gap.missing.length - 12) + " more");
    }
    log("");
    log("summary:   baseline=" + primary.verdict + " profile=" + (profileResult === null ? "n/a" : profileResult.unavailable !== undefined ? "UNKNOWN" : profileResult.result.verdict) + " loaded=UNKNOWN (no host-reported version source is read)");
  }

  if (options.emit !== null) {
    const records = primary.unexplained.map((row) => hotfixRecordFor(row, { reason: options.reason, source: options.sourceNote }));
    try {
      writeFileSync(resolve(options.emit), JSON.stringify({ generatedAt: new Date().toISOString(), baseline: baselineRef, payload: payloadRoot, hotfixes: records }, null, 2) + "\n", "utf8");
      log("wrote " + records.length + " hotfix record(s) to " + resolve(options.emit));
    } catch (error) {
      fail("cannot write the hotfix draft: " + (error instanceof Error ? error.message : String(error)));
      return EXIT.CANNOT_RUN;
    }
  }

  const worst = Math.max(severityOf(primary.verdict), profileResult?.result?.verdict === undefined ? 0 : severityOf(profileResult.result.verdict));
  if (worst === 2) return EXIT.DRIFT;
  if (worst === 1) return EXIT.UNKNOWN;
  return EXIT.VERIFIED;
}

const entry = resolve(process.argv[1] ?? "");
const self = resolve(fileURLToPath(import.meta.url));
const invokedDirectly = process.platform === "win32" ? entry.toLowerCase() === self.toLowerCase() : entry === self;
if (invokedDirectly) process.exitCode = main();