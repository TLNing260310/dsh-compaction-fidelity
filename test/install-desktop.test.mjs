import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const script = fileURLToPath(new URL("../scripts/install-desktop.mjs", import.meta.url));
const homes = [];

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "compaction-fidelity-install-"));
  homes.push(home);
  mkdirSync(join(home, "profiles", "desktop"), { recursive: true });
  writeFileSync(join(home, "profiles", "desktop", "package.json"), JSON.stringify({
    name: "dsh-profile-desktop",
    private: true,
    dsh: { profile: { bundles: [] } },
  }), "utf8");
  return home;
}

function makePackage(dir, overrides = {}) {
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "dsh-compaction-fidelity",
    version: "0.3.0",
    files: ["lib/**", "scripts/**"],
    exports: { ".": "./src/index.mjs", "./client": "./lib/client.js", "./package.json": "./package.json" },
    dsh: { client: { platform: "web" }, bundle: { patch: "cordis.patch.yml" } },
  }), "utf8");
  writeFileSync(join(dir, "lib", "client.js"), "export const client = true;\n", "utf8");
  if (overrides.missingClient) rmSync(join(dir, "lib", "client.js"), { force: true });
  if (overrides.manifest) writeFileSync(join(dir, "package.json"), JSON.stringify(overrides.manifest), "utf8");
}

function runInstall(home, source, extraArgs = []) {
  return spawnSync(process.execPath, [script, "--source", source, "--home", home, ...extraArgs], {
    encoding: "utf8",
    timeout: 30000,
  });
}

after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

test("installer refuses a source that is the target directory", () => {
  const home = makeHome();
  const source = join(home, "plugins", "dsh-compaction-fidelity");
  makePackage(source);
  writeFileSync(join(source, "keep.txt"), "keep", "utf8");
  const result = runInstall(home, source);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /refusing overlapping source and target/);
  assert.equal(existsSync(join(source, "keep.txt")), true);
});

test("installer copies only packaged files and leaves secrets behind", () => {
  const home = makeHome();
  const source = join(home, "source");
  makePackage(source);
  writeFileSync(join(source, ".env"), "TOKEN=do-not-copy\n", "utf8");
  writeFileSync(join(source, "notes.private.md"), "do not copy\n", "utf8");
  const result = runInstall(home, source);
  assert.equal(result.status, 0, result.stderr);
  const target = join(home, "plugins", "dsh-compaction-fidelity");
  assert.equal(existsSync(join(target, "lib", "client.js")), true);
  assert.equal(existsSync(join(target, ".env")), false);
  assert.equal(existsSync(join(target, "notes.private.md")), false);
  assert.equal(existsSync(join(source, ".env")), true);
});

test("installer restores the previous package when staging validation fails", () => {
  const home = makeHome();
  const source = join(home, "source");
  makePackage(source, { manifest: { name: "dsh-compaction-fidelity", version: "0.3.0", files: ["lib/**"] } });
  rmSync(join(source, "lib", "client.js"), { force: true });
  const target = join(home, "plugins", "dsh-compaction-fidelity");
  makePackage(target);
  writeFileSync(join(target, "old-marker.txt"), "old", "utf8");
  const result = runInstall(home, source);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /install failed before profile update/);
  assert.equal(existsSync(join(target, "old-marker.txt")), true);
  assert.equal(existsSync(join(target, "lib", "client.js")), true);
});
