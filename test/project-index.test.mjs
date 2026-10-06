import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anchorsForFile, briefForRoot, buildIndex, computeAnchors, loadIndex, purgeIndex, searchIndex, updateAnchorsForFiles, verifyIndex } from '../src/project-index.mjs';
import { isSafeRelativePath } from '../src/util.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'compaction-fidelity-index-'));
  const write = (rel, content) => {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  };
  write('package.json', JSON.stringify({ name: 'fixture', scripts: { test: 'node --test', build: 'tsc' } }, null, 2));
  write('README.md', '# Fixture project\n\nA project used to test Compaction-Fidelity indexing.\n');
  write('docs/architecture.md', '# Architecture\n\nThe runtime core owns request dispatch.\n');
  write('src/index.ts', "import { Runtime } from './core/runtime';\nexport const app = new Runtime();\n");
  write('src/core/runtime.ts', 'export class Runtime { run() { return 1; } }\n');
  write('src/foo/bar.ts', "import { Runtime } from '../core/runtime';\nexport function makeBar(runtime: Runtime) { return runtime.run(); }\n");
  write('src/foo/bar.test.ts', "import { makeBar } from './bar';\nimport { Runtime } from '../core/runtime';\ntest('bar', () => makeBar(new Runtime()));\n");
  write('db/migrations/001_init.sql', 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);\n');
  write('data/table.csv', 'a,b\n1,2\n');
  write('data/model.parquet', 'not-really-parquet');
  write('assets/icon.png', 'png-bytes');
  write('.env', 'DSH_SECRET=should-not-be-hashed\n');
  write('id_rsa', 'private-key-material\n');
  return root;
}

test('builds a persistent Compaction-Fidelity index, anchors, brief, search, and verify', () => {
  const root = fixture();
  try {
    const index = buildIndex(root, { indexDir: '.dsh/compaction-fidelity' });
    assert.ok(index.stats.files >= 8, `files=${index.stats.files}`);
    assert.ok(index.archFiles.some((file) => file.p === 'docs/architecture.md'));
    assert.ok(index.archFiles.some((file) => file.p === 'README.md'));
    assert.ok(index.archFiles.some((file) => file.p === 'package.json'));
    assert.ok(index.archFiles.some((file) => file.p === 'src/index.ts'));
    assert.ok(index.dbFiles.some((file) => file.p === 'db/migrations/001_init.sql'));
    assert.ok(index.dbFiles.some((file) => (file.tables ?? []).includes('users')));
    assert.ok(!index.files.some((file) => file.p === '.env'));
    assert.ok(!index.files.some((file) => file.p === 'id_rsa'));
    assert.ok(!index.files.some((file) => file.p === 'data/table.csv'));
    assert.ok(!index.files.some((file) => file.p === 'data/model.parquet'));
    assert.ok(!index.files.some((file) => file.p === 'assets/icon.png'));
    assert.equal(isSafeRelativePath('../escape'), false);
    assert.equal(isSafeRelativePath('src/ok.ts'), true);
    assert.match(readFileSync(join(root, '.dsh/compaction-fidelity/project.txt'), 'utf8'), /#COMPACTION-FIDELITY-ROOT-MANIFEST/);
    assert.match(readFileSync(join(root, '.dsh/compaction-fidelity/project.database.txt'), 'utf8'), /tables=users/);

    const anchors = computeAnchors(index, 'src/foo/bar.ts', 8);
    assert.ok(anchors.some((anchor) => anchor.path === 'src/core/runtime.ts'), JSON.stringify(anchors));
    assert.ok(anchors.some((anchor) => anchor.path === 'src/foo/bar.test.ts'), JSON.stringify(anchors));
    assert.ok(anchors.every((anchor) => Number.isFinite(anchor.quality)), JSON.stringify(anchors));
    assert.equal(new Set(anchors.map((anchor) => anchor.canonical)).size, anchors.length, JSON.stringify(anchors));

    const state = updateAnchorsForFiles(root, '.dsh/compaction-fidelity', ['src/foo/bar.ts']);
    assert.ok(state.byFile['src/foo/bar.ts'].length > 0);
    const map = readFileSync(join(root, '.dsh/compaction-fidelity', 'anchors.md'), 'utf8');
    assert.match(map, /src\/foo\/bar\.ts/);
    assert.ok(existsSync(join(root, '.dsh/compaction-fidelity', 'PROJECT.md')));
    assert.match(briefForRoot(root, '.dsh/compaction-fidelity'), /# Compaction-Fidelity Project Brief/);

    const found = searchIndex(loadIndex(root, '.dsh/compaction-fidelity'), 'runtime', 8);
    assert.ok(found.some((entry) => entry.path.includes('runtime')));

    const before = verifyIndex(root, '.dsh/compaction-fidelity');
    assert.equal(before.ok, true, JSON.stringify(before));
    writeFileSync(join(root, 'src/foo/bar.ts'), 'export const changed = true;\n', 'utf8');
    const after = verifyIndex(root, '.dsh/compaction-fidelity');
    assert.equal(after.ok, false);
    assert.ok(after.changed.includes('src/foo/bar.ts'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("cached retrieval artifacts are invalidated when the read policy changes", () => {
  const policyRoot = mkdtempSync(join(tmpdir(), "compaction-fidelity-cache-policy-"));
  try {
    writeFileSync(join(policyRoot, "app.ts"), "export const app = 1;\n", "utf8");
    const localIndexDir = ".dsh/compaction-fidelity";
    const options = { indexDir: localIndexDir, scopeFingerprint: "policy-a", expectedFingerprint: "policy-a" };
    buildIndex(policyRoot, options);
    assert.match(readFileSync(join(policyRoot, localIndexDir, "retrieval-scope.json"), "utf8"), /policy-a/);
    assert.notEqual(loadIndex(policyRoot, options), null);
    assert.match(briefForRoot(policyRoot, options) ?? "", /Compaction-Fidelity Project Brief/);

    // A tightened policy must never be served the artifact built under the old one.
    const tightened = { indexDir: localIndexDir, expectedFingerprint: "policy-b" };
    assert.equal(loadIndex(policyRoot, tightened), null);
    assert.equal(briefForRoot(policyRoot, tightened), null);
    assert.equal(anchorsForFile(policyRoot, localIndexDir, "app.ts", 8, { expectedFingerprint: "policy-b" }), null);
    assert.equal(verifyIndex(policyRoot, tightened).ok, false);
    assert.equal(updateAnchorsForFiles(policyRoot, localIndexDir, ["app.ts"], { anchorsPerFile: 8, expectedFingerprint: "policy-b" }), null);

    // Rebuilding under the new policy makes the artifacts servable again.
    buildIndex(policyRoot, { ...tightened, scopeFingerprint: "policy-b" });
    assert.notEqual(loadIndex(policyRoot, tightened), null);
  } finally {
    rmSync(policyRoot, { recursive: true, force: true });
  }
});

test("purge refuses a directory the plugin does not manage", () => {
  const purgeRoot = mkdtempSync(join(tmpdir(), "compaction-fidelity-purge-"));
  try {
    mkdirSync(join(purgeRoot, "notes"), { recursive: true });
    writeFileSync(join(purgeRoot, "notes", "keep.txt"), "keep", "utf8");
    assert.throws(() => purgeIndex(purgeRoot, "notes"), /does not look like/);
    assert.equal(readFileSync(join(purgeRoot, "notes", "keep.txt"), "utf8"), "keep");

    mkdirSync(join(purgeRoot, ".dsh", "compaction-fidelity"), { recursive: true });
    writeFileSync(join(purgeRoot, ".dsh", "compaction-fidelity", "index.json"), "{}", "utf8");
    assert.ok(purgeIndex(purgeRoot, ".dsh/compaction-fidelity").includes("compaction-fidelity"));
  } finally {
    rmSync(purgeRoot, { recursive: true, force: true });
  }
});

test('rejects a linked parent for index writes and purge', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'compaction-fidelity-index-link-'));
  const outside = mkdtempSync(join(tmpdir(), 'compaction-fidelity-index-outside-'));
  try {
    writeFileSync(join(root, 'package.json'), '{}', 'utf8');
    const externalDir = join(outside, 'compaction-fidelity');
    mkdirSync(externalDir, { recursive: true });
    const sentinel = join(externalDir, 'sentinel.txt');
    writeFileSync(sentinel, 'keep', 'utf8');
    try {
      symlinkSync(outside, join(root, '.dsh'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        t.skip('symlink creation is not permitted on this platform');
        return;
      }
      throw error;
    }
    assert.throws(() => buildIndex(root, { indexDir: '.dsh/compaction-fidelity' }), /symbolic link|junction|escapes workspace/);
    assert.throws(() => purgeIndex(root, '.dsh/compaction-fidelity'), /symbolic link|junction|escapes workspace/);
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep');
  } finally {
    rmSync(join(root, '.dsh'), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
