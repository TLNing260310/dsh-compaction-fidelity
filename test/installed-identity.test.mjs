import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  collectDirectory,
  compareCollections,
  createIgnoreMatcher,
  describeContent,
  firstDifferingLine,
  formatReport,
  main,
  normalizeLineEndings,
  readGitRef,
} from "../scripts/check-installed-identity.mjs";

const createdRoots = [];
after(() => {
  for (const root of createdRoots) rmSync(root, { recursive: true, force: true });
});

function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), "cf-identity-"));
  createdRoots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
  return root;
}

const quiet = () => {};

test("a payload that differs only in line endings is identical", () => {
  const referenceRoot = makeTree({ "package.json": '{\n  "name": "x"\n}\n', "src/a.mjs": "export const a = 1;\n" });
  const payloadRoot = makeTree({ "package.json": '{\r\n  "name": "x"\r\n}\r\n', "src/a.mjs": "export const a = 1;\r\n" });
  const result = compareCollections(collectDirectory(referenceRoot), collectDirectory(payloadRoot));
  assert.equal(result.status, "identical");
  assert.equal(result.compared, 2);
  assert.equal(result.normalized, 2, "both payload files arrived with CRLF");
  assert.equal(normalizeLineEndings("a\r\nb"), "a\nb");
});

test("a single changed line is reported with both sides and the line number", () => {
  const referenceRoot = makeTree({ "src/index.mjs": "line one\nline two\nline three\n" });
  const payloadRoot = makeTree({ "src/index.mjs": "line one\npatched two\nline three\n" });
  const result = compareCollections(collectDirectory(referenceRoot), collectDirectory(payloadRoot));
  assert.equal(result.status, "drift");
  const [difference] = result.differences;
  assert.equal(difference.kind, "content");
  assert.equal(difference.line, 2);
  assert.equal(difference.referenceLine, "line two");
  assert.equal(difference.payloadLine, "patched two");
  assert.equal(firstDifferingLine("a\nb", "a\nc").line, 2);
  const report = formatReport({ payload: payloadRoot, reference: referenceRoot }, result);
  assert.ok(report.includes("verdict:   DRIFT"));
  assert.ok(report.includes("reference L2: line two"));
  assert.ok(report.includes("payload   L2: patched two"));
});

test("files present on only one side are named", () => {
  const referenceRoot = makeTree({ "keep.mjs": "a\n", "removed.mjs": "b\n" });
  const payloadRoot = makeTree({ "keep.mjs": "a\n", "added.mjs": "c\n" });
  const result = compareCollections(collectDirectory(referenceRoot), collectDirectory(payloadRoot));
  assert.equal(result.status, "drift");
  assert.deepEqual(result.differences.map((item) => item.kind + ":" + item.path).sort(), ["only-in-payload:added.mjs", "only-in-reference:removed.mjs"]);
});

test("default ignore rules prune dependency and state directories", () => {
  const root = makeTree({
    "src/a.mjs": "a\n",
    "node_modules/x/index.js": "x\n",
    ".dsh/state.json": "{}\n",
    "debug.log": "l\n",
    ".tmp/scratch.txt": "s\n",
  });
  assert.deepEqual([...collectDirectory(root).files.keys()], ["src/a.mjs"]);
  const matcher = createIgnoreMatcher();
  assert.equal(matcher("node_modules"), true);
  assert.equal(matcher("nested/.dsh"), true);
  assert.equal(matcher("run.log"), true);
  assert.equal(matcher("src/keep.mjs"), false);
});

test("binary content is compared by digest rather than as text", () => {
  const first = Buffer.from([0x00, 0x01, 0x02]);
  assert.equal(describeContent(first).kind, "binary");
  assert.equal(describeContent(first).digest.length, 64);
  const same = compareCollections({ files: new Map([["a.bin", describeContent(first)]]) }, { files: new Map([["a.bin", describeContent(first)]]) });
  assert.equal(same.status, "identical");
  const other = compareCollections({ files: new Map([["a.bin", describeContent(first)]]) }, { files: new Map([["a.bin", describeContent(Buffer.from([0x00, 0x01, 0x03]))]]) });
  assert.equal(other.status, "drift");
});

test("a missing payload reports a reason instead of throwing", () => {
  const collected = collectDirectory(join(tmpdir(), "cf-identity-absent-" + Date.now()));
  assert.equal(collected.ok, false);
  assert.equal(collected.reason, "missing");
});

test("the command reports identical, drift, and unreadable payloads by exit code", () => {
  const referenceRoot = makeTree({ "src/a.mjs": "a\n" });
  const payloadRoot = makeTree({ "src/a.mjs": "a\n" });
  const args = ["--payload", payloadRoot, "--against", "worktree", "--source", referenceRoot];
  assert.equal(main(args, { log: quiet, error: quiet }), 0);

  writeFileSync(join(payloadRoot, "src", "a.mjs"), "changed\n", "utf8");
  const lines = [];
  assert.equal(main(args, { log: (line) => lines.push(String(line)), error: quiet }), 1);
  assert.ok(lines.some((line) => line.includes("verdict:   DRIFT")));
  assert.ok(lines.some((line) => line.includes("src/a.mjs")));

  const absent = join(tmpdir(), "cf-identity-absent-payload-" + Date.now());
  assert.equal(main(["--payload", absent, "--against", "worktree", "--source", referenceRoot], { log: quiet, error: quiet }), 2);
  const complaints = [];
  assert.equal(main(["not-an-option"], { log: quiet, error: (line) => complaints.push(String(line)) }), 2);
  assert.equal(complaints.length, 1);
});

test("a linked payload is compared through its target", (t) => {
  const payloadTarget = makeTree({ "src/a.mjs": "a\n" });
  const parent = mkdtempSync(join(tmpdir(), "cf-identity-link-"));
  createdRoots.push(parent);
  const linkPath = join(parent, "payload");
  try {
    symlinkSync(payloadTarget, linkPath, "junction");
  } catch {
    t.skip("symlinks are not permitted on this platform");
    return;
  }
  const collected = collectDirectory(linkPath);
  assert.equal(collected.ok, true);
  assert.equal(collected.linked, true);
  const reference = collectDirectory(payloadTarget);
  assert.equal(compareCollections(reference, collected).status, "identical");
});

test("a git ref can be read without touching the working tree", (t) => {
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  const fromGit = readGitRef("HEAD", { cwd: repoRoot });
  if (fromGit.ok !== true) {
    t.skip("this copy is not a git repository: " + repoRoot);
    return;
  }
  // The committed content is asserted on its own terms: a dirty working tree must
  // not change the answer, which is the point of reading the ref through git.
  assert.match(fromGit.commit, /^[0-9a-f]{40}$/);
  assert.ok(fromGit.files.has("src/engine.mjs"));
  const manifest = fromGit.files.get("package.json");
  assert.ok(manifest !== undefined && manifest.kind === "text");
  assert.equal(JSON.parse(manifest.text).name, "dsh-compaction-fidelity");
  assert.equal(collectDirectory(repoRoot).ok, true);
});