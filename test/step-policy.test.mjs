import test from "node:test";
import assert from "node:assert/strict";
import { mentionsCandidate, preStepStopped, readArchitectureConsent } from "../src/step-policy.mjs";

const choosePending = { kind: "choose", candidates: [{ relativeDir: "src" }, { relativeDir: "packages/app" }], key: "choose-key" };
const createPending = { kind: "create", scope: "app", key: "create-key" };

test("only an aborted signal or a rejected decision stops the step", () => {
  assert.equal(preStepStopped({ aborted: true }, { messages: [] }), true);
  assert.equal(preStepStopped({ aborted: false }, { kind: "reject" }), true);
  assert.equal(preStepStopped({ aborted: false }, { messages: [] }), false);
  assert.equal(preStepStopped(undefined, undefined), false);
});

test("a plain acknowledgement creates only once a scope is already known", () => {
  assert.deepEqual(readArchitectureConsent(createPending, "创建"), { action: "create", scope: "app" });
  assert.deepEqual(readArchitectureConsent(createPending, "好的，创建 app 文档"), { action: "create", scope: "app" });
  assert.deepEqual(readArchitectureConsent(createPending, "我们继续讨论别的"), { action: "none", scope: null });
});

test("naming a folder selects it but never authorises the write", () => {
  assert.deepEqual(readArchitectureConsent(choosePending, "请先处理 src 里的问题"), { action: "select", scope: "src" });
  assert.deepEqual(readArchitectureConsent(choosePending, "使用 packages/app"), { action: "select", scope: "packages/app" });
});

test("a refusal that names a folder must not create it", () => {
  assert.deepEqual(readArchitectureConsent(choosePending, "不要创建 src，先检查它"), { action: "decline", scope: null });
  assert.deepEqual(readArchitectureConsent(choosePending, "先不创建 packages/app"), { action: "decline", scope: null });
  assert.deepEqual(readArchitectureConsent(createPending, "do not create it yet"), { action: "decline", scope: null });
  assert.deepEqual(readArchitectureConsent(createPending, "不用"), { action: "decline", scope: null });
  assert.deepEqual(readArchitectureConsent(createPending, "不需要"), { action: "decline", scope: null });
});

test("selection plus explicit consent in one message creates the chosen folder", () => {
  assert.deepEqual(readArchitectureConsent(choosePending, "确认创建 packages/app"), { action: "create", scope: "packages/app" });
  assert.deepEqual(readArchitectureConsent(choosePending, "创建 src"), { action: "create", scope: "src" });
});

test("no outstanding question means no action", () => {
  assert.deepEqual(readArchitectureConsent(null, "创建 src"), { action: "none", scope: null });
  assert.deepEqual(readArchitectureConsent(createPending, "   "), { action: "none", scope: null });
});

test("a folder is matched by relative path or by its last segment", () => {
  assert.equal(mentionsCandidate({ relativeDir: "packages/app" }, "work in packages/app"), true);
  assert.equal(mentionsCandidate({ relativeDir: "packages/app" }, "work in app"), true);
  assert.equal(mentionsCandidate({ relativeDir: "src" }, "work in lib"), false);
  assert.equal(mentionsCandidate({ relativeDir: "" }, "work in src"), false);
  assert.equal(mentionsCandidate(null, "work in src"), false);
});