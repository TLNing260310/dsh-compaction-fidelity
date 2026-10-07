import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  collectDirectory,
  compareCollections,
  compareFile,
  createIgnoreMatcher,
  createManifestMatcher,
  describeContent,
  EXIT,
  firstDifferingLine,
  formatReport,
  applyHotfixes,
  hotfixRecordFor,
  main,
  normalizeLineEndings,
  readGitRef,
  STATUS,
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
  assert.equal(result.verdict, "IDENTICAL_AFTER_NORMALIZATION", "matching only after normalization is not byte identity");
  assert.equal(result.counts.compared, 2);
  assert.equal(result.counts.normalized, 2, "both payload files arrived with CRLF");
  assert.notEqual(result.rows[0].referenceSha256, result.rows[0].payloadSha256, "the raw bytes do differ");
  assert.equal(normalizeLineEndings("a\r\nb"), "a\nb");
});

test("a single changed line is reported with both sides and the line number", () => {
  const referenceRoot = makeTree({ "src/index.mjs": "line one\nline two\nline three\n" });
  const payloadRoot = makeTree({ "src/index.mjs": "line one\npatched two\nline three\n" });
  const result = compareCollections(collectDirectory(referenceRoot), collectDirectory(payloadRoot));
  assert.equal(result.verdict, "DRIFT");
  const [difference] = result.differences;
  assert.equal(difference.status, "differs");
  assert.equal(difference.reason, "content");
  assert.equal(difference.line, 2);
  assert.equal(difference.referenceLine, "line two");
  assert.equal(difference.payloadLine, "patched two");
  assert.equal(firstDifferingLine("a\nb", "a\nc").line, 2);
  const report = formatReport({ payload: payloadRoot, reference: referenceRoot }, result);
  assert.ok(report.includes("verdict:   DRIFT"));
  assert.ok(!report.includes("patched two"), "source lines are printed only on request");
  const verbose = formatReport({ payload: payloadRoot }, result, { showSource: true });
  assert.ok(verbose.includes("line two"));
  assert.ok(verbose.includes("patched two"));
});

test("files present on only one side are named", () => {
  const referenceRoot = makeTree({ "keep.mjs": "a\n", "removed.mjs": "b\n" });
  const payloadRoot = makeTree({ "keep.mjs": "a\n", "added.mjs": "c\n" });
  const result = compareCollections(collectDirectory(referenceRoot), collectDirectory(payloadRoot));
  assert.equal(result.verdict, "DRIFT");
  assert.deepEqual(result.differences.map((item) => item.status + ":" + item.path).sort(), ["only-in-payload:added.mjs", "only-in-reference:removed.mjs"]);
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
  assert.equal(describeContent(first).sha256.length, 64);
  const same = compareCollections({ files: new Map([["a.bin", describeContent(first)]]) }, { files: new Map([["a.bin", describeContent(first)]]) });
  assert.equal(same.verdict, "IDENTICAL");
  const other = compareCollections({ files: new Map([["a.bin", describeContent(first)]]) }, { files: new Map([["a.bin", describeContent(Buffer.from([0x00, 0x01, 0x03]))]]) });
  assert.equal(other.verdict, "DRIFT");
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
  assert.equal(main(["--payload", absent, "--against", "worktree", "--source", referenceRoot], { log: quiet, error: quiet }), EXIT.CANNOT_RUN);
  const complaints = [];
  assert.equal(main(["not-an-option"], { log: quiet, error: (line) => complaints.push(String(line)) }), EXIT.CANNOT_RUN);
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
  assert.equal(compareCollections(reference, collected).verdict, "IDENTICAL");
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
});test("content without a text identity is decided by hash, never by size", () => {
  const left = { kind: "large", bytes: 4096, sha256: "a".repeat(64), crlf: false, text: null };
  const right = { kind: "large", bytes: 4096, sha256: "b".repeat(64), crlf: false, text: null };
  assert.equal(compareFile(left, right).status, STATUS.DIFFERS, "equal size must not mean equal content");
  assert.equal(compareFile(left, { ...right, sha256: left.sha256 }).status, STATUS.IDENTICAL);
});

test("different invalid UTF-8 bytes are UNKNOWN, not identical", () => {
  const left = describeContent(Buffer.from([0xff]));
  const right = describeContent(Buffer.from([0xfe]));
  assert.equal(left.kind, "undecodable");
  assert.equal(left.text, null, "undecodable bytes have no text identity to compare");
  assert.notEqual(left.sha256, right.sha256);
  const result = compareCollections({ files: new Map([["x.txt", left]]) }, { files: new Map([["x.txt", right]]) });
  assert.equal(result.verdict, "UNKNOWN");
  assert.equal(result.rows[0].status, STATUS.UNKNOWN);
});

test("the install manifest decides the scope and out-of-scope files are listed", () => {
  const root = makeTree({ "src/a.mjs": "a\n", "README.md": "r\n", "test/a.test.mjs": "t\n" });
  const patterns = ["src/**", "README.md"];
  const collected = collectDirectory(root, { manifest: createManifestMatcher(patterns), manifestPatterns: patterns });
  assert.deepEqual([...collected.files.keys()].sort(), ["README.md", "src/a.mjs"]);
  assert.deepEqual([...collected.notShipped.keys()], ["test/a.test.mjs"], "a repo-only file is listed, not counted as drift");
  assert.equal(collected.scope.kind, "manifest");
});

test("a registered hotfix is reported on its own and is not drift", () => {
  const row = { path: "src/index.mjs", status: STATUS.DIFFERS, referenceSha256: "1".repeat(64), payloadSha256: "2".repeat(64), line: 792 };
  const result = { verdict: "DRIFT", counts: { compared: 1 }, rows: [row], differences: [row] };
  assert.equal(applyHotfixes(result, []).verdict, "DRIFT");
  const registered = applyHotfixes(result, [hotfixRecordFor(row, { reason: "target is not defined", source: "audit_outputs/dsh-target-hotfix-nmUNL7" })]);
  assert.equal(registered.verdict, "KNOWN_HOTFIX_ONLY");
  assert.equal(registered.known.length, 1);
  assert.equal(registered.unexplained.length, 0);
  assert.equal(registered.known[0].hotfix.source, "audit_outputs/dsh-target-hotfix-nmUNL7");
  const wrongHashes = applyHotfixes(result, [{ file: "src/index.mjs", originalHash: "9".repeat(64), patchedHash: "8".repeat(64) }]);
  assert.equal(wrongHashes.verdict, "DRIFT", "a registration with different hashes explains nothing");
});
