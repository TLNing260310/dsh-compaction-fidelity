import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendArchitectureUpdate, detectTaskFolders, renderArchitectureDoc, validateArchitectureDoc } from "../src/architecture-doc.mjs";

const root = mkdtempSync(join(tmpdir(), "compaction-fidelity-architecture-"));
mkdirSync(join(root, "src", "feature"), { recursive: true });
writeFileSync(join(root, "src", "feature", "index.ts"), "export {};", "utf8");
after(() => rmSync(root, { recursive: true, force: true }));

test("detects an existing task folder from the user message", () => {
  const messages = [{ role: "user", content: [{ type: "text", text: "请在 src/feature 目录下修改 index.ts，并保持 API 不变。" }] }];
  const detection = detectTaskFolders(messages, root);
  assert.ok(detection.candidates.some((candidate) => candidate.relativeDir === "src/feature"));
});

test("renders and validates Markdown + DSML + JSON blocks", () => {
  const text = renderArchitectureDoc({
    scope: "src/feature",
    index: { archFiles: [{ p: "src/feature/index.ts", kind: "module", imports: [] }], files: [], commands: [], dbFiles: [] },
    constraints: [{ id: "c1", kind: "hard", text: "不要删除 index.ts" }],
  });
  assert.ok(text.startsWith("---"));
  assert.ok(text.includes("<architecture_retrieval"));
  const validation = validateArchitectureDoc(text);
  assert.equal(validation.ok, true);
  assert.ok(validation.jsonBlocks.length >= 4);
});

test("append-only update preserves the original and appends a structured update", () => {
  const original = renderArchitectureDoc({ scope: "src/feature", index: { archFiles: [], files: [], commands: [], dbFiles: [] } });
  const updated = appendArchitectureUpdate(original, { scope: "src/feature", summary: "新增缓存层，保留原 API", changedFiles: ["src/feature/cache.ts"] });
  assert.ok(updated.includes(original.slice(0, original.indexOf("<!-- architecture-update-log -->")).trim()));
  assert.ok(updated.includes("<architecture_update"));
  assert.ok(updated.includes("新增缓存层"));
  const validation = validateArchitectureDoc(updated);
  assert.equal(validation.ok, true);
});

