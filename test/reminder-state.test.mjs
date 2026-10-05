import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneReminderState, readReminderState, recordReminder, reminderDecision, writeReminderState } from "../src/reminder-state.mjs";

const root = mkdtempSync(join(tmpdir(), "compaction-fidelity-reminder-"));
after(() => rmSync(root, { recursive: true, force: true }));
const MINUTE = 60 * 1000;

test("reminder decisions back off from immediate to five and thirty minutes", () => {
  const now = 1_000_000_000;
  assert.equal(reminderDecision(undefined, now).action, "inject");
  assert.equal(reminderDecision({ count: 1, lastAt: now }, now).action, "wait");
  assert.equal(reminderDecision({ count: 1, lastAt: now }, now + 5 * MINUTE).action, "inject");
  assert.equal(reminderDecision({ count: 2, lastAt: now }, now + 10 * MINUTE).action, "wait");
  assert.equal(reminderDecision({ count: 2, lastAt: now }, now + 30 * MINUTE).action, "inject");
  assert.equal(reminderDecision({ count: 3, lastAt: now }, now + 24 * 60 * MINUTE).action, "status-only");
});

test("recordReminder increments the counter and updates the timestamp", () => {
  const first = recordReminder(undefined, 100);
  assert.deepEqual(first, { count: 1, lastAt: 100 });
  const second = recordReminder(first, 200);
  assert.deepEqual(second, { count: 2, lastAt: 200 });
});

test("pruneReminderState removes stale entries and caps the store", () => {
  const now = 10_000_000_000;
  const state = { version: 1, entries: { old: { count: 1, lastAt: 0 }, keep: { count: 1, lastAt: now } } };
  pruneReminderState(state, now, { maxAgeMs: 1000, maxEntries: 1 });
  assert.deepEqual(Object.keys(state.entries), ["keep"]);
});

test("reminder state persists under the workspace index", () => {
  const state = { version: 1, entries: { "session|scope|1": { count: 1, lastAt: 123 } } };
  writeReminderState(root, ".dsh/compaction-fidelity", state);
  assert.ok(existsSync(join(root, ".dsh", "compaction-fidelity", "architecture-reminders.json")));
  const loaded = readReminderState(root, ".dsh/compaction-fidelity");
  assert.equal(loaded.entries["session|scope|1"].count, 1);
});
