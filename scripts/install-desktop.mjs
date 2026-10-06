#!/usr/bin/env node
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const source = option("--source", dirname(dirname(fileURLToPath(import.meta.url))));
const home = option("--home", process.env.DSH_HOME ?? join(homedir(), ".dsh"));
const useLink = args.includes("--link");
const profileDir = join(home, "profiles", "desktop");
const target = join(home, "plugins", "dsh-compaction-fidelity");
const packageName = "dsh-compaction-fidelity";

if (!existsSync(join(profileDir, "package.json"))) {
  console.error(`DSH Desktop profile not found: ${profileDir}`);
  process.exit(2);
}

const sourceManifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
if (sourceManifest.name !== packageName) {
  console.error(`unexpected source package: ${sourceManifest.name}`);
  process.exit(2);
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

mkdirSync(join(home, "plugins"), { recursive: true });
const sourceReal = realpathSync(source);
const targetReal = existsSync(target) ? realpathSync(target) : join(realpathSync(dirname(target)), basename(target));
if (sourceReal === targetReal || isInside(sourceReal, targetReal) || isInside(targetReal, sourceReal)) {
  console.error(`refusing overlapping source and target: source=${sourceReal} target=${targetReal}`);
  process.exit(2);
}

function patternToRegExp(pattern) {
  const normalized = String(pattern ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  let out = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        out += ".*";
        index += 1;
        if (normalized[index + 1] === "/") index += 1;
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += /[|\\{}()[\]^$+?.]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${out}$`);
}

const COPY_IGNORE_RE = /(^|[\\/])(node_modules|\.git|\.dsh|\.pnpm|\.tmp)([\\/]|$)/i;
const COPY_SECRET_RE = /(^|[\\/])(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|id_rsa(\.pub)?|id_ed25519(\.pub)?|credentials(\..*)?|secrets?(\..*)?)$/i;
const packagePatterns = Array.isArray(sourceManifest.files) ? sourceManifest.files : [];
function packageFileAllowed(rel) {
  if (rel === "package.json") return true;
  return packagePatterns.some((pattern) => patternToRegExp(pattern).test(rel));
}
function copyFilter(file) {
  if (file === source) return true;
  const rel = relative(source, file).replace(/\\/g, "/");
  if (rel.length === 0) return true;
  if (COPY_IGNORE_RE.test(rel) || COPY_SECRET_RE.test(rel)) return false;
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return false;
  }
  if (stat.isDirectory()) return true;
  return packageFileAllowed(rel);
}
function backupTarget(targetPath, backupPath) {
  const stat = lstatSync(targetPath);
  if (stat.isSymbolicLink()) return readlinkSync(targetPath);
  cpSync(targetPath, backupPath, {
    recursive: true,
    filter: (file) => !/(^|[\\/])(node_modules|\.git|\.pnpm|\.tmp)([\\/]|$)/.test(String(file)),
  });
  return null;
}
function restoreTarget(targetPath, backupPath, linkTarget) {
  if (existsSync(targetPath)) rmSync(targetPath, { recursive: true, force: true });
  if (linkTarget !== null) {
    symlinkSync(linkTarget, targetPath, process.platform === "win32" ? "junction" : "dir");
  } else if (existsSync(backupPath)) {
    renameSync(backupPath, targetPath);
  }
}

mkdirSync(join(home, "plugins"), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = join(home, "plugins", ".backups", stamp);
mkdirSync(backupDir, { recursive: true });
const packageBackup = join(backupDir, "package");
let targetLink = null;
if (existsSync(target)) {
  targetLink = backupTarget(target, packageBackup);
}

try {
  if (useLink) {
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
  } else {
    const staging = join(home, "plugins", `.dsh-compaction-fidelity.install-${stamp}`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    try {
      cpSync(source, staging, { recursive: true, filter: copyFilter });
      const stagedManifest = JSON.parse(readFileSync(join(staging, "package.json"), "utf8"));
      if (stagedManifest.name !== packageName || stagedManifest.version !== sourceManifest.version) {
        throw new Error(`staged package manifest mismatch: ${stagedManifest.name}@${stagedManifest.version}`);
      }
      if (!existsSync(join(staging, "lib", "client.js"))) throw new Error("staged package is missing lib/client.js");
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      renameSync(staging, target);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
} catch (error) {
  restoreTarget(target, packageBackup, targetLink);
  console.error(`install failed before profile update: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

for (const name of ["package.json", "cordis.patch.yml", "cordis.yml", "pnpm-workspace.yaml", "pnpm-lock.yaml"]) {
  const file = join(profileDir, name);
  if (existsSync(file)) cpSync(file, join(backupDir, name));
}

const manifestPath = join(profileDir, "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.dependencies ??= {};
const relativeTarget = relative(profileDir, target).replace(/\\/g, "/");
manifest.dependencies[packageName] = `file:${relativeTarget}`;
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
manifest.dsh.profile.bundles ??= [];
if (!manifest.dsh.profile.bundles.includes(packageName)) manifest.dsh.profile.bundles.push(packageName);
// A previous Desktop plugin-manager disable writes this advisory ledger and
// removes the bundle from `dsh.profile.bundles`. Installing again is the
// explicit enable signal, so clear both forms of the disabled state.
if (Array.isArray(manifest.dsh.desktopDeselectedBundles)) {
  manifest.dsh.desktopDeselectedBundles = manifest.dsh.desktopDeselectedBundles.filter((name) => name !== packageName);
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

// pnpm may keep a stale hardlink/copy for a `file:` dependency; remove the
// installed package first so a forced install always refreshes the client half.
const installedPath = join(profileDir, "node_modules", packageName);
rmSync(installedPath, { recursive: true, force: true });
let pnpmOk = false;
if (existsSync(join(profileDir, "pnpm-workspace.yaml"))) {
  const result = spawnSync("pnpm", ["install", "--force", "--ignore-scripts"], {
    cwd: profileDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  pnpmOk = result.status === 0;
  if (!pnpmOk) console.warn("pnpm install failed; falling back to a direct node_modules link.");
} else {
  console.warn("pnpm-workspace.yaml missing; falling back to a direct node_modules link.");
}
if (!pnpmOk) {
  const nodeModules = join(profileDir, "node_modules");
  mkdirSync(nodeModules, { recursive: true });
  const linkPath = join(nodeModules, packageName);
  if (existsSync(linkPath)) unlinkSync(linkPath);
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

try {
  const require = createRequire(join(profileDir, "package.json"));
  require.resolve(`${packageName}/package.json`);
  require.resolve(`${packageName}/client`);
  const installedManifestPath = join(profileDir, "node_modules", packageName, "package.json");
  const installedManifest = JSON.parse(readFileSync(installedManifestPath, "utf8"));
  const clientFile = join(profileDir, "node_modules", packageName, "lib", "client.js");
  const clientDeclared = installedManifest.dsh?.client?.platform === "web";
  const clientExported = installedManifest.exports?.["./client"] === "./lib/client.js";
  if (!clientDeclared || !clientExported || !existsSync(clientFile)) {
    throw new Error(`client half incomplete (dsh.client=${clientDeclared}, exports=${clientExported}, file=${existsSync(clientFile)})`);
  }
  console.log(`resolved ${packageName} and its client from the Desktop profile`);
} catch (error) {
  console.warn(`could not resolve ${packageName} or its client from the Desktop profile: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

const installed = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
console.log(`installed ${installed.name}@${installed.version}`);
console.log(`  package: ${target}`);
console.log(`  profile: ${profileDir}`);
console.log(`  backup:  ${backupDir}`);
const switchScript = join(target, "scripts", "master-switch.mjs");
if (existsSync(switchScript)) {
  const enabled = spawnSync(process.execPath, [switchScript, "enable", "--home", home], { stdio: "inherit" });
  if (enabled.status !== 0) console.warn("master switch enable failed; default state may need a manual enable.");
}
console.log("");
console.log("Restart DSH Desktop, then create a new session. Useful commands:");
console.log("  /compaction-fidelity status");
console.log("  /compaction-fidelity off      # runtime master switch off, immediate");
console.log("  /compaction-fidelity on");
console.log(`Hard load-time switch: node "${join(target, "scripts", "master-switch.mjs")}" disable`);
