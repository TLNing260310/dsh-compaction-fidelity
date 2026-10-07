#!/usr/bin/env node
// Read-only drift check between an installed plugin payload and a git ref or the
// working tree.
//
// Why this exists: a hotfix applied directly to ~/.dsh/plugins leaves the running
// environment and the repository disagreeing about what the code is. That is
// invisible until something breaks, and the fix that keeps an environment alive
// can silently become the only copy of a change. This script makes the
// disagreement explicit and reviewable instead of relying on memory.
//
// Line endings: the repository stores LF while a checkout under
// core.autocrlf=true is CRLF, so content is compared after \r\n is normalized to
// \n. The report still counts how many payload files arrived with CRLF.
//
// Exit codes: 0 identical, 1 drift, 2 the check could not run (missing payload,
// unknown ref, not a git repository).
//
// Nothing here writes to the payload, the working tree, or git.
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDshHome } from "../src/state.mjs";

export const DEFAULT_IGNORES = Object.freeze(["node_modules", ".git", ".dsh", ".tmp", "*.log", ".DS_Store", "Thumbs.db"]);
const PLUGIN_DIR_NAME = "dsh-compaction-fidelity";
const MAX_FILE_BYTES = 16 * 1024 * 1024;

export function normalizeLineEndings(text) {
  return String(text ?? "").replace(/\r\n/g, "\n");
}

function wildcardToRegExp(pattern) {
  const escaped = String(pattern ?? "")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp("^" + escaped + "$");
}

/**
 * Ignore rules match either a whole workspace-relative path (when the pattern
 * contains a slash) or any single path segment (otherwise), so "node_modules"
 * prunes the tree and "*.log" drops matching files.
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

export function describeContent(input) {
  const raw = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ""), "utf8");
  if (raw.includes(0)) {
    return { kind: "binary", bytes: raw.length, digest: createHash("sha256").update(raw).digest("hex") };
  }
  const text = raw.toString("utf8");
  return { kind: "text", bytes: raw.length, crlf: text.includes("\r\n"), text: normalizeLineEndings(text) };
}

/**
 * Collect a directory into a comparable map. Symlinks are recorded by target
 * rather than followed, so a linked file that points somewhere new is drift and
 * a link cycle cannot hang the walk.
 */
export function collectDirectory(root, options = {}) {
  const requested = resolve(root);
  const ignore = createIgnoreMatcher(options.ignore ?? DEFAULT_IGNORES);
  if (!existsSync(requested)) return { ok: false, reason: "missing", root: requested, realRoot: null, linked: false, files: new Map() };
  let linked = false;
  let absolute = requested;
  try {
    if (lstatSync(requested).isSymbolicLink()) {
      linked = true;
      absolute = realpathSync(requested);
    }
  } catch {
    return { ok: false, reason: "unreadable", root: requested, realRoot: null, linked: false, files: new Map() };
  }
  if (!statSync(absolute).isDirectory()) return { ok: false, reason: "not-a-directory", root: requested, realRoot: absolute, linked, files: new Map() };

  const files = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const target = join(dir, entry.name);
      const relativePath = relative(absolute, target).split(sep).join("/");
      if (ignore(relativePath)) continue;
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
        files.set(relativePath, { kind: "symlink", bytes: 0, target: linkTarget });
        continue;
      }
      if (stat.isDirectory()) {
        walk(target);
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_BYTES) {
        files.set(relativePath, { kind: "oversized", bytes: stat.size, digest: null });
        continue;
      }
      try {
        files.set(relativePath, describeContent(readFileSync(target)));
      } catch {
        files.set(relativePath, { kind: "unreadable", bytes: stat.size, digest: null });
      }
    }
  };
  walk(absolute);
  return { ok: true, reason: null, root: requested, realRoot: absolute, linked, files };
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
 * Read a git ref into the same comparable shape as collectDirectory, without
 * touching the working tree. Blobs are read one at a time so submodule entries
 * and other non-blob tree items are skipped instead of failing the whole run.
 */
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
  const files = new Map();
  const listed = spawnSync("git", ["ls-tree", "-r", "-z", ref], { cwd, maxBuffer: 64 * 1024 * 1024 });
  if (listed.error !== undefined && listed.error !== null) {
    return { ok: false, reason: "git-unavailable", detail: String(listed.error.message ?? listed.error), ref, commit: null, files };
  }
  if (listed.status !== 0) {
    return { ok: false, reason: "unknown-ref", detail: String(listed.stderr ?? "").trim(), ref, commit: null, files };
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
    entries.push({ sha: meta[2], path });
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
    if (raw === undefined) {
      files.set(entry.path, { kind: "unreadable", bytes: 0, digest: null });
      continue;
    }
    files.set(entry.path, describeContent(raw));
  }
  return { ok: true, reason: null, ref, commit, files };
}

export function compareCollections(reference, payload) {
  const paths = [...new Set([...reference.files.keys(), ...payload.files.keys()])].sort();
  const differences = [];
  let identical = 0;
  let normalized = 0;
  for (const path of paths) {
    const left = reference.files.get(path);
    const right = payload.files.get(path);
    if (left === undefined) {
      differences.push({ path, kind: "only-in-payload", payloadBytes: right.bytes });
      continue;
    }
    if (right === undefined) {
      differences.push({ path, kind: "only-in-reference", referenceBytes: left.bytes });
      continue;
    }
    if (left.kind !== right.kind) {
      differences.push({ path, kind: "type", referenceKind: left.kind, payloadKind: right.kind });
      continue;
    }
    if (left.kind === "symlink") {
      if (left.target === right.target) identical += 1;
      else differences.push({ path, kind: "symlink-target", referenceTarget: left.target, payloadTarget: right.target });
      continue;
    }
    if (left.kind === "binary") {
      if (left.digest === right.digest) identical += 1;
      else differences.push({ path, kind: "binary-content", referenceBytes: left.bytes, payloadBytes: right.bytes });
      continue;
    }
    if (left.kind !== "text") {
      if (left.bytes === right.bytes) identical += 1;
      else differences.push({ path, kind: left.kind, referenceBytes: left.bytes, payloadBytes: right.bytes });
      continue;
    }
    if (left.text === right.text) {
      identical += 1;
      if (right.crlf) normalized += 1;
      continue;
    }
    const at = firstDifferingLine(left.text, right.text);
    differences.push({
      path,
      kind: "content",
      line: at.line,
      referenceLine: at.reference,
      payloadLine: at.payload,
      referenceLines: left.text.split("\n").length,
      payloadLines: right.text.split("\n").length,
    });
  }
  return {
    status: differences.length === 0 ? "identical" : "drift",
    paths,
    compared: paths.length,
    identical,
    normalized,
    differences,
  };
}

function clipLine(value, limit = 160) {
  const text = value === null || value === undefined ? "(absent)" : String(value).trim();
  return text.length <= limit ? text : text.slice(0, limit - 3) + "...";
}

export function formatReport(label, result, options = {}) {
  const lines = [];
  lines.push("payload:   " + (label.payload ?? "(unknown)"));
  lines.push("reference: " + (label.reference ?? "(unknown)"));
  lines.push("compared:  " + result.compared + " file(s)");
  lines.push("ignored:   " + (label.ignored ?? DEFAULT_IGNORES).join(", "));
  lines.push("identical: " + result.identical + (result.normalized > 0 ? " (" + result.normalized + " matched only after newline normalization)" : ""));
  lines.push("differ:    " + result.differences.length);
  for (const item of result.differences) {
    lines.push("  " + item.kind + ": " + item.path);
    if (item.kind === "content") {
      lines.push("    reference L" + item.line + ": " + clipLine(item.referenceLine));
      lines.push("    payload   L" + item.line + ": " + clipLine(item.payloadLine));
      if (item.referenceLines !== item.payloadLines) {
        lines.push("    line counts differ: reference " + item.referenceLines + ", payload " + item.payloadLines);
      }
    } else if (item.kind === "only-in-payload") {
      lines.push("    present only in the payload (" + item.payloadBytes + " bytes)");
    } else if (item.kind === "only-in-reference") {
      lines.push("    present only in the reference (" + item.referenceBytes + " bytes)");
    } else if (item.kind === "symlink-target") {
      lines.push("    reference -> " + item.referenceTarget + ", payload -> " + item.payloadTarget);
    } else if (item.kind === "type") {
      lines.push("    reference kind " + item.referenceKind + ", payload kind " + item.payloadKind);
    }
  }
  if (options.list === true) {
    const changed = new Set(result.differences.map((item) => item.path));
    lines.push("identical files:");
    for (const path of result.paths) {
      if (!changed.has(path)) lines.push("  " + path);
    }
  }
  lines.push("verdict:   " + (result.status === "identical" ? "IDENTICAL" : "DRIFT"));
  return lines.join("\n");
}
export const USAGE = [
  "Usage: node scripts/check-installed-identity.mjs [options]",
  "",
  "  --payload <dir>   installed payload (default: $DSH_HOME/plugins/dsh-compaction-fidelity)",
  "  --ref <ref>       git ref to compare against (default: HEAD)",
  "  --against <what>  git (default) or worktree",
  "  --source <dir>    repository root (default: the repository holding this script)",
  "  --ignore <a,b>    replace the default ignore patterns",
  "  --json            machine-readable output",
  "  --list            also list identical files",
  "",
  "Exit codes: 0 identical, 1 drift, 2 the check could not run.",
].join("\n");

export function parseArguments(argv) {
  const options = { payload: null, ref: "HEAD", against: "git", source: null, ignore: null, json: false, list: false, help: false, unknown: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--payload" || argument === "--ref" || argument === "--source") {
      const value = argv[index + 1];
      if (value === undefined) {
        options.unknown = argument;
        return options;
      }
      options[argument === "--payload" ? "payload" : argument === "--ref" ? "ref" : "source"] = value;
      index += 1;
    } else if (argument === "--against") {
      const value = argv[index + 1];
      options.against = value === "worktree" ? "worktree" : "git";
      index += 1;
    } else if (argument === "--ignore") {
      const value = argv[index + 1];
      options.ignore = String(value ?? "").split(",").map((item) => item.trim()).filter((item) => item.length > 0);
      index += 1;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--list") {
      options.list = true;
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

export function main(argv = process.argv.slice(2), io = {}) {
  const log = typeof io.log === "function" ? io.log : console.log;
  const fail = typeof io.error === "function" ? io.error : console.error;
  const options = parseArguments(argv);
  if (options.help === true) {
    log(USAGE);
    return 0;
  }
  if (typeof options.unknown === "string") {
    fail("unknown or incomplete argument: " + options.unknown);
    log(USAGE);
    return 2;
  }

  const repoRoot = options.source !== null ? resolve(options.source) : defaultRepoRoot();
  const payloadRoot = options.payload !== null ? resolve(options.payload) : join(resolveDshHome(), "plugins", PLUGIN_DIR_NAME);
  const ignores = options.ignore ?? DEFAULT_IGNORES;

  const payload = collectDirectory(payloadRoot, { ignore: ignores });
  if (payload.ok !== true) {
    fail("cannot read the installed payload (" + payload.reason + "): " + payloadRoot);
    return 2;
  }

  let reference;
  if (options.against === "worktree") {
    reference = collectDirectory(repoRoot, { ignore: ignores });
    if (reference.ok !== true) {
      fail("cannot read the working tree (" + reference.reason + "): " + repoRoot);
      return 2;
    }
  } else {
    reference = readGitRef(options.ref, { cwd: repoRoot, ignore: ignores });
    if (reference.ok !== true) {
      fail("cannot read " + options.ref + " from git (" + reference.reason + (reference.detail ? ": " + reference.detail : "") + ")");
      return 2;
    }
  }

  const result = compareCollections(reference, payload);
  const sameTree = typeof payload.realRoot === "string" && typeof reference.realRoot === "string" && payload.realRoot === reference.realRoot;
  const referenceLabel = options.against === "worktree" ? "worktree " + repoRoot : options.ref + " (" + (reference.commit ?? "unresolved") + ")";

  if (options.json === true) {
    log(JSON.stringify({
      status: sameTree ? "linked" : result.status,
      compared: result.compared,
      identical: result.identical,
      normalized: result.normalized,
      differences: result.differences,
      payload: { root: payloadRoot, realRoot: payload.realRoot, linked: payload.linked },
      reference: { kind: options.against, ref: reference.ref ?? null, commit: reference.commit ?? null, root: reference.realRoot ?? repoRoot },
      sameTree,
    }, null, 2));
  } else if (sameTree) {
    log("payload and reference are the same directory: " + payload.realRoot);
    log("verdict:   LINKED (a linked install tracks the repository by construction)");
  } else {
    log(formatReport({
      payload: payloadRoot + (payload.linked ? " -> " + payload.realRoot : ""),
      reference: referenceLabel,
      ignored: ignores,
    }, result, { list: options.list === true }));
  }
  return result.differences.length === 0 ? 0 : 1;
}

const entry = resolve(process.argv[1] ?? "");
const self = resolve(fileURLToPath(import.meta.url));
const invokedDirectly = process.platform === "win32" ? entry.toLowerCase() === self.toLowerCase() : entry === self;
if (invokedDirectly) process.exitCode = main();