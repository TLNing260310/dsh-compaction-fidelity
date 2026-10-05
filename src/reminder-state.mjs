// Persistent reminder backoff for architecture refresh notifications.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteArchitectureFile } from "./architecture-io.mjs";

export const REMINDER_FILE = "architecture-reminders.json";
const SECOND_DELAY_MS = 5 * 60 * 1000;
const THIRD_DELAY_MS = 30 * 60 * 1000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;

function filePath(cwd, indexDir) {
  return join(cwd, indexDir, REMINDER_FILE);
}

export function architectureReminderKey(cwd, scope, mtimeMs) {
  const workspace = String(cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedScope = String(scope ?? ".").replace(/\\/g, "/").replace(/^\.\//, "") || ".";
  const stamp = Number.isFinite(mtimeMs) ? Math.trunc(mtimeMs) : 0;
  return `${workspace}|${normalizedScope}|${stamp}`;
}

export function readReminderState(cwd, indexDir) {
  try {
    const parsed = JSON.parse(readFileSync(filePath(cwd, indexDir), "utf8"));
    if (parsed !== null && typeof parsed === "object" && parsed.entries !== null && typeof parsed.entries === "object") return parsed;
  } catch {
    // missing or invalid state falls back to empty
  }
  return { version: 1, entries: {} };
}

export function writeReminderState(cwd, indexDir, state) {
  atomicWriteArchitectureFile(filePath(cwd, indexDir), JSON.stringify(state, null, 2));
}

export function reminderDecision(entry, now = Date.now(), options = {}) {
  const secondDelay = Number.isFinite(options.secondDelayMs) ? options.secondDelayMs : SECOND_DELAY_MS;
  const thirdDelay = Number.isFinite(options.thirdDelayMs) ? options.thirdDelayMs : THIRD_DELAY_MS;
  const count = Number.isInteger(entry?.count) ? entry.count : 0;
  const lastAt = Number.isFinite(entry?.lastAt) ? entry.lastAt : 0;
  if (count === 0) return { action: "inject", stage: 1, delayMs: 0 };
  if (count === 1) return now - lastAt >= secondDelay ? { action: "inject", stage: 2, delayMs: now - lastAt } : { action: "wait", stage: 2, delayMs: secondDelay - (now - lastAt) };
  if (count === 2) return now - lastAt >= thirdDelay ? { action: "inject", stage: 3, delayMs: now - lastAt } : { action: "wait", stage: 3, delayMs: thirdDelay - (now - lastAt) };
  return { action: "status-only", stage: 4, delayMs: 0 };
}

export function recordReminder(entry, now = Date.now()) {
  return { count: (Number.isInteger(entry?.count) ? entry.count : 0) + 1, lastAt: now };
}

export function pruneReminderState(state, now = Date.now(), options = {}) {
  const maxAge = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : MAX_AGE_MS;
  const maxEntries = Number.isInteger(options.maxEntries) ? options.maxEntries : MAX_ENTRIES;
  const entries = state.entries ?? {};
  for (const [key, entry] of Object.entries(entries)) {
    if (!Number.isFinite(entry?.lastAt) || now - entry.lastAt > maxAge) delete entries[key];
  }
  const keys = Object.keys(entries);
  if (keys.length > maxEntries) {
    keys
      .sort((left, right) => (entries[left]?.lastAt ?? 0) - (entries[right]?.lastAt ?? 0))
      .slice(0, keys.length - maxEntries)
      .forEach((key) => delete entries[key]);
  }
  state.entries = entries;
  return state;
}

