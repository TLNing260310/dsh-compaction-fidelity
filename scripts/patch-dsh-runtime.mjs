#!/usr/bin/env node
// DSH runtime fix for DSH Desktop 0.2.0-rc.2.
//
// 1. The `minimal` agent preset has no compaction backend, so long sessions
//    cannot compact and eventually fail with CONTEXT_WINDOW_EXCEEDED.
// 2. @deepseek-ai/dsh-token-meter prices every text at 4 chars/token, which
//    severely underestimates CJK text and delays compaction.
//
// Both fixes are idempotent and write timestamped backups under
// <DSH_HOME>/runtime-fixes/backups/. Re-run after every DSH Desktop update.
//
// Usage:
//   node patch-dsh-runtime.mjs                 # apply both patches
//   node patch-dsh-runtime.mjs --restore       # restore newest backup
//   node patch-dsh-runtime.mjs --restore <dir> # restore one backup dir
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const appNodeModules = resolve(valueOf("--app", process.env.DSH_APP_NODE_MODULES ?? "D:/DSH/DSH Desktop/resources/app/node_modules"));
const dshHome = resolve(process.env.DSH_HOME ?? join(homedir(), ".dsh"));
const backupRoot = join(dshHome, "runtime-fixes", "backups");

const targets = {
  minimalPreset: join(appNodeModules, "@deepseek-ai", "dsh-web-app", "presets", "minimal.patch.yml"),
  tokenMeter: join(appNodeModules, "@deepseek-ai", "dsh-token-meter", "lib", "index.js"),
};

const MINIMAL_MARKER = "# DSH runtime fix: minimal preset compaction group";
const TOKEN_MARKER = "DSH_RUNTIME_CJK_AWARE_ESTIMATOR";

function read(file) {
  if (!existsSync(file)) throw new Error(`missing target: ${file}`);
  return readFileSync(file, "utf8");
}

function backup(file, dir) {
  const relativePath = relative(appNodeModules, file).replace(/[\\/]/g, "__");
  copyFileSync(file, join(dir, relativePath));
  return join(dir, relativePath);
}

function checkJs(file) {
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}

function latestBackupDir() {
  if (!existsSync(backupRoot)) throw new Error(`no backup root at ${backupRoot}`);
  const dirs = readdirSync(backupRoot)
    .map((name) => join(backupRoot, name))
    .filter((path) => statSync(path).isDirectory())
    .sort();
  if (dirs.length === 0) throw new Error(`no backups under ${backupRoot}`);
  return dirs[dirs.length - 1];
}

function restore(dir) {
  const sourceDir = dir === undefined ? latestBackupDir() : resolve(dir);
  const restores = [
    [join(sourceDir, relative(appNodeModules, targets.minimalPreset).replace(/[\\/]/g, "__")), targets.minimalPreset],
    [join(sourceDir, relative(appNodeModules, targets.tokenMeter).replace(/[\\/]/g, "__")), targets.tokenMeter],
  ];
  for (const [from, to] of restores) {
    if (!existsSync(from)) {
      console.log(`skip (no backup): ${to}`);
      continue;
    }
    copyFileSync(from, to);
    console.log(`restored: ${to}`);
  }
}

function patchMinimalPreset() {
  const source = read(targets.minimalPreset);
  if (source.includes(MINIMAL_MARKER) || source.includes("@deepseek-ai/dsh-compaction-basic")) {
    console.log("minimal preset: already compaction-capable; skipping");
    return false;
  }
  const group = [
    "",
    "          # DSH runtime fix: minimal preset compaction group",
    "          # Keep this group aligned with the standard preset; it is the safety net",
    "          # that lets a minimal session compact before the window is exhausted.",
    "          - id: compaction",
    "            name: cordis:group",
    "            group: true",
    "            isolate:",
    "              compaction: true",
    "              toolResultPruner: true",
    "            config:",
    "              - id: compaction-basic",
    "                name: '@deepseek-ai/dsh-compaction-basic'",
    "                config:",
    "                  thresholdRatio: 0.8",
    "                  headroomTokens: 65536",
    "                  retainRatio: 0.16",
    "                  compactionRetries: 1",
    "                  maxOverflowRetries: 1",
    "              - id: command-compact",
    "                name: '@deepseek-ai/dsh-command-compact'",
    "              - id: tool-result-pruner",
    "                name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
    "                config:",
    "                  thresholdChars: 16384",
    "                  headChars: 12288",
    "                  tailChars: 2048",
    "",
  ].join("\n");
  const patched = `${source.replace(/\s*$/, "")}\n${group}`;
  backup(targets.minimalPreset, backupDir);
  writeFileSync(targets.minimalPreset, patched, "utf8");
  console.log("minimal preset: added compaction group");
  return true;
}

function patchTokenMeter() {
  let source = read(targets.tokenMeter);
  if (source.includes(TOKEN_MARKER)) {
    console.log("token meter: already CJK-aware; skipping");
    return false;
  }
  const oldHeader = "/** Fixed text-density estimate used until exact tokenization is needed. */\nconst CHARS_PER_TOKEN = 4;\n";
  if (!source.includes(oldHeader)) throw new Error("token meter: unexpected estimator header");
  const newHeader = [
    "/** Fixed text-density estimate used until exact tokenization is needed. */",
    "const CHARS_PER_TOKEN = 4;",
    "/**",
    ` * ${TOKEN_MARKER}: keep the fixed ASCII density, but stop treating CJK and other`,
    " * non-ASCII text as 4 characters per token. Provider usage anchors still",
    " * override this estimate whenever an exact anchor exists.",
    " */",
    "const CJK_TOKENS_PER_CHAR = 0.8;",
    "const OTHER_TOKENS_PER_CHAR = 0.5;",
    "function estimateTextTokens(text) {",
    "\tif (typeof text !== \"string\" || text.length === 0) return 0;",
    "\tlet ascii = 0;",
    "\tlet cjk = 0;",
    "\tlet other = 0;",
    "\tfor (const ch of text) {",
    "\t\tconst cp = ch.codePointAt(0);",
    "\t\tif (cp >= 0x2e80 && cp <= 0x9fff || cp >= 0xf900 && cp <= 0xfaff || cp >= 0xff00 && cp <= 0xffef || cp >= 0x20000 && cp <= 0x2fa1f) cjk += 1;",
    "\t\telse if (cp < 0x80) ascii += 1;",
    "\t\telse other += 1;",
    "\t}",
    "\treturn Math.ceil(ascii / CHARS_PER_TOKEN + cjk * CJK_TOKENS_PER_CHAR + other * OTHER_TOKENS_PER_CHAR);",
    "}",
    "",
  ].join("\n");
  source = source.replace(oldHeader, newHeader);
  const expressionReplacements = [
    ["Math.ceil(JSON.stringify(reference).length / CHARS_PER_TOKEN)", "estimateTextTokens(JSON.stringify(reference))"],
    ["Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)", "estimateTextTokens(JSON.stringify(block))"],
    ["Math.ceil(block.text.length / CHARS_PER_TOKEN)", "estimateTextTokens(block.text)"],
    ["Math.ceil(block.name.length / CHARS_PER_TOKEN) + Math.ceil(block.arguments.length / CHARS_PER_TOKEN)", "estimateTextTokens(block.name) + estimateTextTokens(block.arguments)"],
    ["Math.ceil(JSON.stringify(header.tools).length / CHARS_PER_TOKEN)", "estimateTextTokens(JSON.stringify(header.tools))"],
  ];
  for (const [from, to] of expressionReplacements) {
    if (!source.includes(from)) throw new Error(`token meter: pattern not found: ${from}`);
    source = source.split(from).join(to);
  }
  const systemFunction = /function estimateSystemMessage\(message\) \{[\s\S]*?\n\}/;
  if (!systemFunction.test(source)) throw new Error("token meter: estimateSystemMessage not found");
  source = source.replace(systemFunction, [
    "function estimateSystemMessage(message) {",
    "\tif (message.content.length === 0) return 0;",
    "\tlet tokens = 0;",
    "\tfor (const block of message.content) tokens += estimateTextTokens(block.type === \"text\" ? block.text : JSON.stringify(block));",
    "\treturn tokens + 4;",
    "}",
  ].join("\n"));
  backup(targets.tokenMeter, backupDir);
  writeFileSync(targets.tokenMeter, source, "utf8");
  checkJs(targets.tokenMeter);
  console.log("token meter: enabled CJK-aware estimation");
  return true;
}

if (args.includes("--restore")) {
  restore(args[args.indexOf("--restore") + 1]);
  process.exit(0);
}

mkdirSync(backupRoot, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = join(backupRoot, stamp);
mkdirSync(backupDir, { recursive: true });

let changed = 0;
if (patchMinimalPreset()) changed += 1;
if (patchTokenMeter()) changed += 1;

if (changed === 0) {
  rmSync(backupDir, { recursive: true, force: true });
  console.log("nothing to do; both runtime fixes are already present");
} else {
  console.log(`backup: ${backupDir}`);
  console.log("restart DSH Desktop and create a new session for the fixes to load");
}
