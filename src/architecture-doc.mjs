// Folder-scoped AOCI-style architecture retrieval document.
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isSafeRelativePath, sha256, toPosix } from "./util.mjs";

export const DEFAULT_ARCHITECTURE_DOC = "ARCHITECTURE.md";
export const MAX_ARCHITECTURE_DOC_BYTES = 1048576;


function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

export function lastUserText(messages) {
  for (const message of [...(messages ?? [])].reverse()) {
    if (message?.role !== "user") continue;
    const text = messageText(message).trim();
    if (text.length > 0) return text;
  }
  return "";
}

function existingDir(root, candidate) {
  try {
    const absolute = resolve(root, candidate);
    const rel = toPosix(relative(resolve(root), absolute));
    if (rel.length === 0 || rel.startsWith("..")) return null;
    if (!existsSync(absolute)) return null;
    const entryStat = lstatSync(absolute);
    if (entryStat.isSymbolicLink()) return null;
    if (!entryStat.isDirectory()) return existingDir(root, dirname(absolute));
    if (!isSafeRelativePath(rel === "." ? "." : rel)) return null;
    return { relativeDir: rel === "" ? "." : rel, absolute };
  } catch {
    return null;
  }
}


const PATH_RE = /[A-Za-z]:[\\/][^\s"'`]+|(?:\.{0,2}[\\/])?[\w.@-]+(?:[\\/][\w.@-]+)+/g;
const FOLDER_PHRASE_RE = /在\s*([^，。；\n]{1,120}?)(?:文件夹|目录)/g;
const ENGLISH_FOLDER_RE = /(?:folder|directory)\s*[:：]?\s*([A-Za-z0-9_.\/\\-]+)/gi;
const IN_FOLDER_RE = /(?:in|under)\s+([A-Za-z0-9_.\/\\-]+)/gi;

export function detectTaskFolders(messages, root, options = {}) {
  const scores = new Map();
  const add = (candidate, weight, reason) => {
    if (typeof candidate !== "string" || candidate.trim().length === 0) return;
    const dir = existingDir(root, candidate.trim());
    if (dir === null) return;
    const entry = scores.get(dir.relativeDir) ?? { ...dir, score: 0, reasons: [] };
    entry.score += weight;
    if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
    scores.set(dir.relativeDir, entry);
  };
  const text = (messages ?? []).map(messageText).join("\n");
  for (const match of text.matchAll(PATH_RE)) add(match[0].replace(/[.,;:]+$/, ""), 20, "path");
  for (const match of text.matchAll(FOLDER_PHRASE_RE)) add(match[1], 40, "explicit-folder");
  for (const match of text.matchAll(ENGLISH_FOLDER_RE)) add(match[1], 40, "explicit-folder");
  for (const match of text.matchAll(IN_FOLDER_RE)) add(match[1], 30, "in-folder");
  const candidates = [...scores.values()].sort((left, right) => right.score - left.score || right.relativeDir.length - left.relativeDir.length);
  const primary = candidates[0] ?? null;
  const ambiguous = candidates.length > 1 && candidates[1].score >= Math.max(1, primary.score * 0.8);
  return { docName: options.docName ?? DEFAULT_ARCHITECTURE_DOC, candidates, primary: ambiguous ? null : primary, ambiguous };
}

export function resolveArchitectureDoc(root, relativeDir = ".", docName = DEFAULT_ARCHITECTURE_DOC) {
  const scope = typeof relativeDir === "string" && relativeDir.trim().length > 0 ? relativeDir.trim() : ".";
  if (scope !== "." && !isSafeRelativePath(scope)) throw new Error(`architecture doc scope is not a safe workspace-relative path: ${scope}`);
  if (!/^[\w.-]+\.md$/i.test(String(docName ?? ""))) throw new Error(`architecture doc name is not safe: ${String(docName)}`);
  const rootResolved = resolve(root);
  const absolute = join(rootResolved, scope === "." ? "" : scope, docName);
  let current = rootResolved;
  for (const part of relative(rootResolved, dirname(absolute)).split(/[\\/]+/)) {
    if (part.length === 0 || part === ".") continue;
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("architecture doc path traverses a symlink: " + current);
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
  try {
    if (lstatSync(absolute).isSymbolicLink()) throw new Error("architecture doc target is a symlink: " + absolute);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { absolute, relative: toPosix(relative(rootResolved, absolute)), scope, docName };
}

export function architectureDocExists(root, relativeDir = ".", docName = DEFAULT_ARCHITECTURE_DOC) {
  const target = resolveArchitectureDoc(root, relativeDir, docName);
  return existsSync(target.absolute) ? target : null;
}

export function readArchitectureDoc(root, relativeDir = ".", docName = DEFAULT_ARCHITECTURE_DOC) {
  const target = architectureDocExists(root, relativeDir, docName);
  if (target === null) return null;
  let bytes = 0;
  try {
    bytes = statSync(target.absolute).size;
  } catch {
    return { ...target, text: "", bytes: 0, truncated: true };
  }
  // Size is checked before reading so an oversized document cannot be pulled into
  // memory only to be rejected afterwards; callers must treat truncated as
  // unreadable instead of falling back to raw bytes.
  if (bytes > MAX_ARCHITECTURE_DOC_BYTES) return { ...target, text: "", bytes, truncated: true };
  return { ...target, text: readFileSync(target.absolute, "utf8"), bytes, truncated: false };
}

function attr(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function jsonBlock(value) {
  return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
}

export function renderArchitectureDoc(options = {}) {
  const scope = typeof options.scope === "string" && options.scope.trim().length > 0 ? options.scope.trim() : ".";
  const docName = options.docName ?? DEFAULT_ARCHITECTURE_DOC;
  const now = new Date().toISOString();
  const archFiles = options.index?.archFiles ?? options.index?.files ?? [];
  const modules = archFiles.slice(0, 40).map((file) => ({ path: file.p, kind: file.kind ?? "module", imports: (file.imports ?? []).slice(0, 8) }));
  const commands = (options.index?.commands ?? []).slice(0, 24);
  const dbFiles = (options.index?.dbFiles ?? []).slice(0, 24);
  const constraints = (options.constraints ?? []).map((item, index) => ({ id: item.id ?? "c" + (index + 1), kind: item.kind ?? "hard", text: item.text ?? String(item) }));
  const decisions = (options.decisions ?? []).map((item, index) => ({ id: item.id ?? "d" + (index + 1), decision: item.decision ?? String(item), reason: item.reason ?? "", status: item.status ?? "active" }));
  const notes = (options.notes ?? []).map((text) => String(text));
  const rendered = [
    "---",
    "schema: aoci-lite-architecture-retrieval",
    "version: 1",
    "scope: \"" + scope + "\"",
    "generatedAt: \"" + now + "\"",
    "---",
    "",
    "# Architecture Retrieval Context",
    "",
    "<architecture_retrieval scope=\"" + attr(scope) + "\" version=\"1\">",
    "",
    "## 1. Scope and Purpose",
    "",
    jsonBlock({ scope, docName, generatedAt: now, purpose: "记录该目录的架构坐标、约束与压缩后回查线索", entrypoints: modules.slice(0, 8).map((module) => module.path) }),
    "",
    "## 2. Module Map",
    "",
    jsonBlock({ modules }),
    "",
    "## 3. Contracts and Constraints",
    "",
    jsonBlock({ constraints }),
    "",
    "## 4. Key Decisions",
    "",
    jsonBlock({ decisions }),
    "",
    "## 5. Commands and Data",
    "",
    jsonBlock({ commands, dbFiles }),
    "",
    "## 6. Compression Retrieval Notes",
    "",
    jsonBlock({ notes, exactValues: options.exactValues ?? [], retrievalAnchors: options.retrievalAnchors ?? [] }),
    "",
    "## 7. Update Log",
    "",
    "<!-- architecture-update-log -->",
    "",
    "</architecture_retrieval>",
    "",
  ].join("\n");
  return finalizeArchitectureDoc(rendered);
}

function appendArchitectureUpdateRaw(text, update = {}) {
  const marker = "<!-- architecture-update-log -->";
  const at = update.at ?? new Date().toISOString();
  const scope = update.scope ?? ".";
  const summary = String(update.summary ?? "").trim().slice(0, 4000);
  const changedFiles = (Array.isArray(update.changedFiles) ? update.changedFiles : []).map((item) => String(item)).slice(0, 200);
  const payload = { at, scope, summary, changedFiles, decisions: Array.isArray(update.decisions) ? update.decisions.slice(0, 50) : [], constraints: Array.isArray(update.constraints) ? update.constraints.slice(0, 50) : [] };
  const block = ["<architecture_update at=\"" + attr(at) + "\" scope=\"" + attr(scope) + "\">", "```json", JSON.stringify(payload, null, 2), "```", "</architecture_update>", ""].join("\n");
  const markerIndex = text.indexOf(marker);
  const closingTag = "</architecture_retrieval>";
  const closingIndex = text.indexOf(closingTag, markerIndex >= 0 ? markerIndex : 0);
  const searchEnd = closingIndex >= 0 ? closingIndex : text.length;
  if (markerIndex >= 0) {
    const lastUpdateEnd = text.lastIndexOf("</architecture_update>", searchEnd - 1);
    if (lastUpdateEnd >= markerIndex) {
      const insertAt = lastUpdateEnd + "</architecture_update>".length;
      return text.slice(0, insertAt) + "\n\n" + block + text.slice(insertAt);
    }
    const insertAt = markerIndex + marker.length;
    return text.slice(0, insertAt) + "\n\n" + block + text.slice(insertAt);
  }
  if (closingIndex >= 0) {
    return text.slice(0, closingIndex) + marker + "\n\n" + block + "\n" + text.slice(closingIndex);
  }
  return text.trimEnd() + "\n\n## Update Log\n\n" + marker + "\n\n" + block;
}

function preserveArchitectureUpdateLogRaw(oldText, newText) {
  const marker = "<!-- architecture-update-log -->";
  const closingTag = "</architecture_retrieval>";
  const oldStart = oldText.indexOf(marker);
  const newStart = newText.indexOf(marker);
  if (oldStart < 0 || newStart < 0) return newText;
  const oldEnd = oldText.lastIndexOf(closingTag);
  const newEnd = newText.lastIndexOf(closingTag);
  if (oldEnd < 0 || newEnd < 0) return newText;
  const oldLog = oldText.slice(oldStart, oldEnd);
  return newText.slice(0, newStart) + oldLog + newText.slice(newEnd);
}

export function appendArchitectureUpdate(text, update = {}) {
  return finalizeArchitectureDoc(appendArchitectureUpdateRaw(text, update));
}

export function preserveArchitectureUpdateLog(oldText, newText) {
  const merged = preserveArchitectureUpdateLogRaw(oldText, newText);
  const previousRevision = Math.max(readArchitectureAttestation(oldText)?.revision ?? 0, readArchitectureAttestation(merged)?.revision ?? 0);
  const attestation = buildArchitectureAttestation(merged);
  return upsertArchitectureAttestation(merged, { ...attestation, revision: previousRevision + 1 });
}

const ATTESTATION_RE = /<architecture_attestation>([\s\S]*?)<\/architecture_attestation>\s*/g;

function stripAttestation(text) {
  return String(text ?? "").replace(ATTESTATION_RE, "");
}

function normalizeHashSection(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function structureSection(text) {
  const value = String(text ?? "");
  const markerIndex = value.indexOf("<!-- architecture-update-log -->");
  const closingIndex = value.indexOf("</architecture_retrieval>");
  const end = markerIndex >= 0 ? markerIndex : closingIndex >= 0 ? closingIndex : value.length;
  return normalizeHashSection(stripAttestation(value.slice(0, end)));
}

function updateLogSection(text) {
  const value = String(text ?? "");
  const markerIndex = value.indexOf("<!-- architecture-update-log -->");
  const closingIndex = value.indexOf("</architecture_retrieval>");
  if (markerIndex < 0 || closingIndex < 0) return "";
  return normalizeHashSection(stripAttestation(value.slice(markerIndex, closingIndex)));
}

export function readArchitectureAttestation(text) {
  const match = /<architecture_attestation>([\s\S]*?)<\/architecture_attestation>/.exec(String(text ?? ""));
  if (match === null) return null;
  try {
    const parsed = JSON.parse(match[1].trim());
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function buildArchitectureAttestation(text) {
  const value = String(text ?? "");
  const previous = readArchitectureAttestation(value);
  const entryCount = (value.match(/<architecture_update\b/g) ?? []).length;
  return {
    revision: Number.isInteger(previous?.revision) ? previous.revision + 1 : 1,
    structureHash: sha256(structureSection(value)),
    updateLogHash: sha256(updateLogSection(value)),
    entryCount,
    updatedAt: new Date().toISOString(),
  };
}

function renderAttestationBlock(attestation) {
  return "<architecture_attestation>\n" + JSON.stringify(attestation, null, 2) + "\n</architecture_attestation>";
}

export function upsertArchitectureAttestation(text, attestation = undefined) {
  const source = String(text ?? "");
  const resolved = attestation ?? buildArchitectureAttestation(source);
  const value = source.replace(ATTESTATION_RE, "").replace(/\n{3,}/g, "\n\n");
  const block = renderAttestationBlock(resolved);
  const frontmatter = value.match(/^---\n[\s\S]*?\n---\n/);
  if (frontmatter !== null) return value.slice(0, frontmatter[0].length) + "\n" + block + "\n" + value.slice(frontmatter[0].length);
  return block + "\n\n" + value;
}


export function finalizeArchitectureDoc(text) {
  return upsertArchitectureAttestation(text);
}

export function verifyArchitectureDoc(text) {
  const value = String(text ?? "");
  const validation = validateArchitectureDoc(value);
  const errors = [...validation.errors];
  const attestation = readArchitectureAttestation(value);
  const expected = buildArchitectureAttestation(value);
  if (attestation === null) {
    errors.push("missing architecture_attestation");
  } else {
    for (const key of ["structureHash", "updateLogHash", "entryCount"]) {
      if (attestation[key] !== expected[key]) errors.push("attestation " + key + " mismatch");
    }
  }
  const markerIndex = value.indexOf("<!-- architecture-update-log -->");
  const updateCount = (value.match(/<architecture_update\b/g) ?? []).length;
  const closeCount = (value.match(/<\/architecture_update>/g) ?? []).length;
  if (markerIndex < 0 && updateCount > 0) errors.push("updates exist without update-log marker");
  if (markerIndex >= 0) {
    const firstUpdate = value.indexOf("<architecture_update");
    if (firstUpdate >= 0 && firstUpdate < markerIndex) errors.push("update appears before update-log marker");
  }
  if (updateCount !== closeCount) errors.push("unbalanced architecture_update tags");
  return {
    ok: errors.length === 0,
    errors,
    attestation,
    expected,
    entryCount: updateCount,
    structureHash: expected.structureHash,
    updateLogHash: expected.updateLogHash,
  };
}
export function countChangedFilesSince(root, scope, sinceMs, options = {}) {
  const base = resolve(root, scope === "." || scope === undefined ? "" : String(scope));
  const maxFiles = Number.isInteger(options.maxFiles) && options.maxFiles > 0 ? options.maxFiles : 20000;
  const exclude = new Set((options.exclude ?? []).map((item) => String(item).toLowerCase()));
  const filter = typeof options.filterFile === "function" ? options.filterFile : null;
  const ignoreDirs = new Set(["node_modules", ".git", ".dsh", "dist", "build", "target", "coverage", ".next", ".cache"]);
  const semanticExtensions = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte", ".py", ".go", ".rs", ".java", ".kt", ".kts", ".cs", ".php", ".rb", ".swift", ".c", ".cc", ".cpp", ".h", ".hpp", ".sql", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".md", ".mdx", ".sh", ".ps1", ".bat", ".cmd"]);
  const stack = [base];
  let changed = 0;
  while (stack.length > 0 && changed < maxFiles) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (changed >= maxFiles) break;
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name)) continue;
        stack.push(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (exclude.has(entry.name.toLowerCase())) continue;
      const lowerName = entry.name.toLowerCase();
      const dot = lowerName.lastIndexOf(".");
      const extension = dot >= 0 ? lowerName.slice(dot) : "";
      if (!semanticExtensions.has(extension) && lowerName !== "dockerfile" && lowerName !== "makefile") continue;
      if (filter !== null) {
        const relativeFile = toPosix(relative(resolve(root), join(dir, entry.name)));
        if (!filter(relativeFile)) continue;
      }
      try {
        if (statSync(join(dir, entry.name)).mtimeMs > sinceMs) changed += 1;
      } catch {
        // ignore unreadable files
      }
    }
  }
  return changed;
}
export function validateArchitectureDoc(text) {
  const value = String(text ?? "").replace(/\r\n?/g, "\n");
  const errors = [];
  if (!/^---\n[\s\S]*?\n---/m.test(value)) errors.push("missing frontmatter");
  if (!value.includes("<architecture_retrieval")) errors.push("missing <architecture_retrieval>");
  if (!value.includes("</architecture_retrieval>")) errors.push("missing </architecture_retrieval>");
  const jsonBlocks = [];
  for (const match of value.matchAll(/```json\n([\s\S]*?)\n```/g)) {
    try { jsonBlocks.push(JSON.parse(match[1])); } catch (error) { errors.push("invalid json block: " + (error instanceof Error ? error.message : String(error))); }
  }
  return { ok: errors.length === 0, errors, jsonBlocks };
}









