import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutateArchitectureDocument } from "../src/architecture-io.mjs";

const root = mkdtempSync(join(tmpdir(), "compaction-fidelity-architecture-io-"));
const file = join(root, "ARCHITECTURE.md");
after(() => rmSync(root, { recursive: true, force: true }));

test("mutateArchitectureDocument creates and updates a file without leaving lock or temp files", () => {
  const created = mutateArchitectureDocument(file, () => "first");
  assert.equal(created.changed, true);
  assert.equal(readFileSync(file, "utf8"), "first");
  const updated = mutateArchitectureDocument(file, (current) => current + "\nsecond");
  assert.equal(updated.changed, true);
  assert.equal(readFileSync(file, "utf8"), "first\nsecond");
  assert.equal(existsSync(file + ".lock"), false);
  assert.equal(existsSync(join(root, "." + "ARCHITECTURE.md.tmp")), false);
});

test("a stale lock is removed and does not block the next writer", () => {
  const lock = file + ".lock";
  writeFileSync(lock, "stale", "utf8");
  const past = new Date(Date.now() - 60000);
  utimesSync(lock, past, past);
  const result = mutateArchitectureDocument(file, (current) => current + "\nthird", { staleMs: 1000, timeoutMs: 1000 });
  assert.equal(result.changed, true);
  assert.equal(readFileSync(file, "utf8"), "first\nsecond\nthird");
  assert.equal(existsSync(lock), false);
});

test("a no-op mutation reports changed=false and leaves the file intact", () => {
  const snapshot = readFileSync(file, "utf8");
  const result = mutateArchitectureDocument(file, () => snapshot);
  assert.equal(result.changed, false);
  assert.equal(readFileSync(file, "utf8"), snapshot);
  assert.equal(statSync(file).size, Buffer.byteLength(snapshot));
});
