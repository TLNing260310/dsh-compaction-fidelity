import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { architectureActiveState, buildArchitectureView, clampArchitectureViewText, parseArchitectureDocument, DEFAULT_VIEW_CHARS, MIN_VIEW_CHARS } from "../src/architecture-view.mjs";
import { appendArchitectureUpdate, renderArchitectureDoc } from "../src/architecture-doc.mjs";

const openCount = (text) => (text.match(/<architecture_update\b/g) ?? []).length;
const closeCount = (text) => (text.match(/<\/architecture_update>/g) ?? []).length;
const fixture = (updates, summaryChars) => {
  let doc = renderArchitectureDoc({ scope: ".", title: "fixture" });
  for (let index = 0; index < updates; index += 1) {
    doc = appendArchitectureUpdate(doc, { scope: ".", summary: "decision-" + index + " " + "x".repeat(summaryChars) });
  }
  return doc;
};

test("the newest update coordinate survives a document longer than the view budget", () => {
  const doc = fixture(5, 1000);
  assert.ok(doc.length > DEFAULT_VIEW_CHARS, "fixture must exceed the view budget");
  const view = buildArchitectureView(doc, { maxChars: DEFAULT_VIEW_CHARS, relative: "ARCHITECTURE.md" });
  assert.equal(view.ok, true);
  assert.ok(view.text.includes("update#5"), "the newest update coordinate must reach the excerpt");
  assert.ok(view.chars <= DEFAULT_VIEW_CHARS);
});

test("this repository's own document keeps its coordinates", () => {
  const doc = readFileSync(fileURLToPath(new URL("../ARCHITECTURE.md", import.meta.url)), "utf8");
  const view = buildArchitectureView(doc, { maxChars: DEFAULT_VIEW_CHARS, relative: "ARCHITECTURE.md" });
  assert.equal(view.ok, true);
  assert.ok(view.text.includes("7. Update Log"), "section coordinates must survive even when bodies do not");
  assert.ok(view.text.includes("scope=."));
  assert.ok(view.text.includes("chars=" + doc.length));
  assert.ok(view.chars <= DEFAULT_VIEW_CHARS);
});

test("an update that does not fit is omitted whole, with a pointer", () => {
  let doc = renderArchitectureDoc({ scope: ".", title: "fixture" });
  doc = appendArchitectureUpdate(doc, { scope: ".", summary: "small-early " + "y".repeat(200) });
  doc = appendArchitectureUpdate(doc, { scope: ".", summary: "huge-late " + "z".repeat(3000) });
  const view = buildArchitectureView(doc, { maxChars: 1200, relative: "docs/ARCHITECTURE.md", includeHistory: true });
  assert.equal(view.ok, true);
  assert.equal(view.incomplete, true);
  assert.equal(openCount(view.text), closeCount(view.text), "no half block may be emitted");
  assert.ok(view.text.includes("Newest update omitted for budget"));
  assert.ok(view.text.includes("docs/ARCHITECTURE.md update#2"));
  assert.equal(view.text.includes("huge-late"), false, "omitted text must not leak partially");
});

test("a damaged update block is reported, not injected", () => {
  const doc = [
    '<architecture_retrieval scope="." version="1">',
    "## 1. Scope and Purpose",
    "## 7. Update Log",
    "<!-- architecture-update-log -->",
    '<architecture_update at="t1" scope=".">',
    "```json",
    "{ this is not json }",
    "```",
    "</architecture_update>",
    "</architecture_retrieval>",
  ].join("\n");
  const view = buildArchitectureView(doc, { maxChars: DEFAULT_VIEW_CHARS, includeHistory: true });
  assert.equal(view.ok, true);
  assert.equal(openCount(view.text), 0, "a damaged block must not be injected");
  assert.ok(view.omitted.some((item) => String(item.reason).startsWith("invalid")));
  assert.equal(view.incomplete, true);
});

test("an unterminated update block is reported, not injected", () => {
  const doc = [
    '<architecture_retrieval scope="." version="1">',
    "## 7. Update Log",
    '<architecture_update at="t1" scope=".">',
    "```json",
    '{ "summary": "x" }',
    "```",
    "</architecture_retrieval>",
  ].join("\n");
  const parsed = parseArchitectureDocument(doc);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.updateLog.unterminated, 1);
  assert.equal(parsed.updateLog.entries.length, 0);
  const view = buildArchitectureView(doc, { parsed, maxChars: DEFAULT_VIEW_CHARS, includeHistory: true });
  assert.equal(openCount(view.text), 0);
  assert.ok(view.omitted.some((item) => item.reason === "unterminated"));
});

test("a document without a retrieval block is refused rather than sliced", () => {
  const parsed = parseArchitectureDocument("# just a heading\n");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "no-retrieval-block");
  const view = buildArchitectureView("# just a heading\n", { maxChars: DEFAULT_VIEW_CHARS });
  assert.equal(view.ok, false);
  assert.equal(view.text, "");
  assert.equal(view.incomplete, true);
});

test("every emitted unit stays whole and within budget", () => {
  const doc = fixture(8, 900);
  for (const budget of [MIN_VIEW_CHARS, 1200, 2000, DEFAULT_VIEW_CHARS]) {
    const view = buildArchitectureView(doc, { maxChars: budget, relative: "ARCHITECTURE.md", includeHistory: true });
    assert.equal(view.ok, true, "fixture must parse at budget " + budget);
    assert.ok(view.chars <= budget, "budget " + budget + " exceeded with " + view.chars);
    assert.equal(openCount(view.text), closeCount(view.text), "unbalanced blocks at budget " + budget);
  }
});

test("the backstop clamp never cuts inside an update block", () => {
  const doc = fixture(3, 600);
  const view = buildArchitectureView(doc, { maxChars: DEFAULT_VIEW_CHARS, includeHistory: true });
  const clamped = clampArchitectureViewText(view.text, 900);
  assert.ok(clamped.length <= 900);
  assert.equal(openCount(clamped), closeCount(clamped));
});test("a later withdrawal retires an earlier requirement in the active view", () => {
  let doc = renderArchitectureDoc({ scope: ".", title: "fixture" });
  doc = appendArchitectureUpdate(doc, { scope: ".", summary: "必须使用 tabs 缩进" });
  doc = appendArchitectureUpdate(doc, { scope: ".", summary: "不再需要 tabs 缩进这条，其他保留" });
  const parsed = parseArchitectureDocument(doc);
  const state = architectureActiveState(parsed);
  assert.equal(state.constraints.some((item) => item.text.includes("tabs")), false, "the withdrawn requirement must leave the active view");
  assert.ok(state.retracted.length >= 1);
  const view = buildArchitectureView(doc, {
    parsed,
    maxChars: DEFAULT_VIEW_CHARS,
    activeConstraints: state.constraints,
    retiredCounts: { retracted: state.retracted.length, superseded: state.superseded.length },
  });
  assert.ok(view.text.includes("Retired by later entries"), "retirement must be visible without inlining stale text");
  assert.ok(view.text.includes("Full history"), "history must stay reachable");
  assert.equal(view.text.includes("必须使用 tabs 缩进"), false, "a retracted instruction must not be projected into the default view");
});


test("update bodies stay out of the default prompt projection", () => {
  const doc = fixture(2, 80);
  const view = buildArchitectureView(doc, { maxChars: DEFAULT_VIEW_CHARS });
  assert.equal(view.text.includes("decision-0"), false, "the default projection must not inline history bodies");
  assert.equal(view.text.includes("decision-1"), false);
  assert.ok(view.text.includes("update#1") && view.text.includes("update#2"), "history coordinates must stay visible");
  const explicit = buildArchitectureView(doc, { maxChars: DEFAULT_VIEW_CHARS, includeHistory: true });
  assert.ok(explicit.text.includes("decision-0"));
});

test("a retracted instruction never enters the default excerpt", () => {
  let doc = renderArchitectureDoc({ scope: ".", title: "fixture" });
  doc = appendArchitectureUpdate(doc, { scope: ".", summary: "必须使用 tabs 缩进" });
  doc = appendArchitectureUpdate(doc, { scope: ".", summary: "不再需要 tabs 缩进这条，其他保留" });
  const parsed = parseArchitectureDocument(doc);
  const state = architectureActiveState(parsed);
  const view = buildArchitectureView(doc, {
    parsed,
    maxChars: 12000,
    activeConstraints: state.constraints,
    retiredCounts: { retracted: state.retracted.length, superseded: state.superseded.length },
  });
  assert.equal(view.text.includes("必须使用 tabs 缩进"), false, "a retracted instruction must not be projected");
  assert.ok(view.text.includes("Retired by later entries"));
  assert.ok(view.text.includes("Full history"));
  const explicit = buildArchitectureView(doc, { parsed, maxChars: 12000, includeHistory: true });
  assert.ok(explicit.text.includes("必须使用 tabs 缩进"), "explicit history retrieval keeps the original text");
});
