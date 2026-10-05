// Atomic, locked, compare-and-swap writes for folder-scoped architecture documents.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_LOCK_STALE_MS = 30000;

export function architectureHash(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}
export function assertWorkspaceContained(root, target) {
  const rootReal = realpathSync(resolve(root));
  let current = dirname(resolve(target));
  for (;;) {
    if (existsSync(current)) {
      const real = realpathSync(current);
      const rel = relative(rootReal, real);
      if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("architecture target escapes workspace: " + target);
      return;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function sleepMs(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function acquireLock(lockFile, options = {}) {
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = Number.isInteger(options.staleMs) ? options.staleMs : DEFAULT_LOCK_STALE_MS;
  const started = Date.now();
  for (;;) {
    try {
      const token = `${process.pid}-${Date.now()}-${randomUUID()}`;
      const fd = openSync(lockFile, "wx");
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }));
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          const parsed = JSON.parse(readFileSync(lockFile, "utf8"));
          if (parsed?.token !== token) return;
        } catch {
          return;
        }
        try {
          unlinkSync(lockFile);
        } catch {
          // another process may already have cleaned it
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const stat = statSync(lockFile);
        if (Date.now() - stat.mtimeMs > staleMs) {
          unlinkSync(lockFile);
          continue;
        }
      } catch {
        // lock disappeared between stat and retry
      }
      if (Date.now() - started > timeoutMs) throw new Error("architecture document lock timeout: " + lockFile);
      sleepMs(25);
    }
  }
}

export function atomicWriteArchitectureFile(file, text) {
  const tmp = join(dirname(file), "." + basename(file) + ".tmp-" + process.pid + "-" + Date.now());
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(tmp, text, "utf8");
    try {
      const fd = openSync(tmp, "r+");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      // fsync is best effort; rename still protects partial content.
    }
    renameSync(tmp, file);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }
}

export function mutateArchitectureDocument(file, mutate, options = {}) {
  const maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : 3;
  mkdirSync(dirname(file), { recursive: true });
  const lockFile = file + ".lock";
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const before = existsSync(file) ? readFileSync(file, "utf8") : null;
    const after = mutate(before);
    if (after === null || after === undefined) return { changed: false, content: before, attempts: attempt };
    if (after === before) return { changed: false, content: before, attempts: attempt };
    const release = acquireLock(lockFile, options);
    try {
      const current = existsSync(file) ? readFileSync(file, "utf8") : null;
      if (current !== before) continue;
      atomicWriteArchitectureFile(file, after);
      return { changed: true, content: after, attempts: attempt };
    } finally {
      release();
    }
  }
  throw new Error("architecture document CAS conflict after " + (maxRetries + 1) + " attempts: " + file);
}
