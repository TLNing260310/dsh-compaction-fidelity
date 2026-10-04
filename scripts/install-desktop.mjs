#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
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

mkdirSync(join(home, "plugins"), { recursive: true });
if (existsSync(target)) {
  const targetManifestPath = join(target, "package.json");
  const samePackage = existsSync(targetManifestPath) && JSON.parse(readFileSync(targetManifestPath, "utf8")).name === packageName;
  if (!samePackage && !args.includes("--force")) {
    console.error(`refusing to replace ${target}: it is not ${packageName}; pass --force to override`);
    process.exit(2);
  }
  rmSync(target, { recursive: true, force: true });
}
if (useLink) {
  symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
} else {
  cpSync(source, target, {
    recursive: true,
    filter: (file) => !/[\\/](node_modules|\.git|\.dsh)([\\/]|$)/.test(file) && !/[\\/]\.tmp/.test(file),
  });
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = join(home, "plugins", ".backups", stamp);
mkdirSync(backupDir, { recursive: true });
for (const name of ["package.json", "cordis.patch.yml", "cordis.yml", "pnpm-workspace.yaml"]) {
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
