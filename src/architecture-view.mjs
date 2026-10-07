// Bounded architecture injection views.
//
// The update log is append-only and grows at the end of the document, while a
// summary can only carry a small excerpt. Taking the head of the file therefore
// drops the newest decisions first. This module parses a document into its
// structure and update entries, computes which requirements are still active,
// and then assembles an excerpt that always keeps the architecture coordinates
// and spends the remaining budget on whole items, newest first. It never emits
// a partial JSON block, tag or constraint.
import { extractConstraintLedger } from './constraint-ledger.mjs';

export const DEFAULT_VIEW_CHARS = 4000;
export const MIN_VIEW_CHARS = 500;
export const MAX_DOCUMENT_CHARS = 512000;
export const FOOTER_RESERVE_CHARS = 320;
export const ARCHITECTURE_VIEW_TOTAL_CHARS = 8000;

const RETRIEVAL_OPEN_RE = /<architecture_retrieval\b([^>]*)>/;
const RETRIEVAL_CLOSE = '</architecture_retrieval>';
const SECTION_RE = /^##[ \t]+(.+?)[ \t]*$/gm;
const UPDATE_RE = /<architecture_update\b([^>]*)>([\s\S]*?)<\/architecture_update>/g;
const ATTESTATION_RE = /<architecture_attestation>([\s\S]*?)<\/architecture_attestation>/;
const ATTR_RE = /([A-Za-z_][-\w]*)[ \t]*=[ \t]*"([^"]*)"/g;

function attributes(text) {
  const out = {};
  ATTR_RE.lastIndex = 0;
  let match = ATTR_RE.exec(String(text ?? ''));
  while (match !== null) {
    out[match[1]] = match[2];
    match = ATTR_RE.exec(String(text ?? ''));
  }
  return out;
}

function fencedJson(body) {
  const match = /```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/.exec(String(body ?? ''));
  return match === null ? null : match[1];
}

function failed(reason, value) {
  return {
    ok: false,
    reason,
    scope: null,
    version: null,
    attestation: null,
    attestationOk: null,
    sections: [],
    updateLog: { present: false, markerOffset: null, entries: [], unterminated: 0, malformed: 0 },
    bodyStart: 0,
    bodyEnd: 0,
    totalChars: String(value ?? '').length,
  };
}

/**
 * Read a managed architecture document into structure plus update entries.
 * Returns ok:false instead of guessing when the document cannot be parsed, so a
 * caller never falls back to slicing raw bytes.
 */
export function parseArchitectureDocument(text, options = {}) {
  const value = String(text ?? '');
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0 ? options.maxChars : MAX_DOCUMENT_CHARS;
  if (value.trim().length === 0) return failed('empty', value);
  if (value.length > maxChars) return failed('too-large', value);
  const open = RETRIEVAL_OPEN_RE.exec(value);
  const closeAt = value.lastIndexOf(RETRIEVAL_CLOSE);
  if (open === null || closeAt === -1 || closeAt < open.index) return failed('no-retrieval-block', value);

  const bodyStart = open.index + open[0].length;
  const body = value.slice(bodyStart, closeAt);
  const attrs = attributes(open[1]);
  const version = attrs.version === undefined ? null : Number(attrs.version);

  let attestation = null;
  let attestationOk = null;
  const attestationMatch = ATTESTATION_RE.exec(value);
  if (attestationMatch !== null) {
    try {
      attestation = JSON.parse(attestationMatch[1].trim());
      attestationOk = true;
    } catch {
      attestationOk = false;
    }
  }

  const sections = [];
  const sectionRe = new RegExp(SECTION_RE.source, 'gm');
  let match = sectionRe.exec(body);
  while (match !== null) {
    sections.push({ title: match[1].trim(), start: bodyStart + match.index, end: bodyStart + body.length });
    match = sectionRe.exec(body);
  }
  for (let index = 0; index + 1 < sections.length; index += 1) sections[index].end = sections[index + 1].start;

  const entries = [];
  const updateRe = new RegExp(UPDATE_RE.source, 'g');
  let found = updateRe.exec(body);
  while (found !== null) {
    const raw = found[0];
    const boundary = attributes(found[1]);
    const start = bodyStart + found.index;
    const entry = {
      index: entries.length + 1,
      start,
      end: start + raw.length,
      chars: raw.length,
      raw,
      at: boundary.at ?? null,
      scope: boundary.scope ?? null,
      parseOk: true,
      reason: null,
      summary: '',
      changedFiles: [],
      decisions: [],
      constraints: [],
    };
    const json = fencedJson(found[2]);
    if (json === null) {
      entry.parseOk = false;
      entry.reason = 'no-json-fence';
    } else {
      try {
        const payload = JSON.parse(json);
        if (typeof payload?.summary === 'string') entry.summary = payload.summary;
        if (Array.isArray(payload?.changedFiles)) entry.changedFiles = payload.changedFiles;
        if (Array.isArray(payload?.decisions)) entry.decisions = payload.decisions;
        if (Array.isArray(payload?.constraints)) entry.constraints = payload.constraints;
      } catch {
        entry.parseOk = false;
        entry.reason = 'invalid-json';
      }
    }
    entries.push(entry);
    found = updateRe.exec(body);
  }

  const markerText = '<!-- architecture-update-log -->';
  const markerAt = body.indexOf(markerText);
  const opened = (body.match(/<architecture_update\b/g) ?? []).length;
  return {
    ok: true,
    reason: null,
    scope: typeof attrs.scope === 'string' ? attrs.scope : null,
    version: Number.isFinite(version) ? version : null,
    attestation,
    attestationOk,
    sections,
    updateLog: {
      present: entries.length > 0 || markerAt !== -1,
      markerOffset: markerAt === -1 ? null : bodyStart + markerAt,
      entries,
      unterminated: Math.max(0, opened - entries.length),
      malformed: entries.filter((entry) => !entry.parseOk).length,
    },
    bodyStart,
    bodyEnd: closeAt,
    totalChars: value.length,
  };
}
/**
 * Which requirements from the update log are still in force. The newest-first
 * retraction and supersession rules used for conversation constraints are
 * applied to log entries as well, so withdrawing a requirement in a later entry
 * retires the earlier one instead of leaving both active.
 */
export function architectureActiveState(parsed) {
  const source = (parsed?.updateLog?.entries ?? []).filter((entry) => entry.parseOk === true);
  if (source.length === 0) return { constraints: [], retracted: [], superseded: [], considered: 0 };
  const messages = source.map((entry) => ({
    role: 'user',
    content: [{ type: 'text', text: [entry.summary, ...(entry.decisions ?? []), ...(entry.constraints ?? [])].filter((item) => String(item ?? '').trim().length > 0).join('\n') }],
  }));
  const ledger = extractConstraintLedger(messages);
  const withEntry = (item) => {
    const origin = Number.isInteger(item?.source?.messageIndex) ? source[item.source.messageIndex] : undefined;
    return { ...item, entryIndex: origin?.index ?? null, entryAt: origin?.at ?? null };
  };
  return {
    constraints: ledger.constraints.map(withEntry),
    retracted: ledger.retracted.map(withEntry),
    superseded: (ledger.superseded ?? []).map(withEntry),
    considered: ledger.considered,
  };
}

function summariseOmitted(omitted) {
  const counts = new Map();
  for (const item of omitted) {
    const reason = String(item.reason ?? 'unknown').split(':')[0];
    const key = item.kind + '/' + reason;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0) return '';
  return ' [' + [...counts.entries()].map(([key, value]) => key + '=' + value).join(', ') + ']';
}

/**
 * Assemble a bounded excerpt of one managed document. Structure coordinates are
 * emitted first, then active requirements, then update blocks from newest to
 * oldest. Every emitted unit is whole: an item that does not fit is omitted with
 * a readable pointer rather than cut in half.
 */
export function buildArchitectureView(text, options = {}) {
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0 ? options.maxChars : DEFAULT_VIEW_CHARS;
  const relative = typeof options.relative === 'string' && options.relative.length > 0 ? options.relative : 'ARCHITECTURE.md';
  const parsed = options.parsed ?? parseArchitectureDocument(text, Number.isInteger(options.maxDocumentChars) ? { maxChars: options.maxDocumentChars } : {});
  const included = [];
  const omitted = [];
  if (parsed.ok !== true) {
    return { ok: false, reason: parsed.reason, excerpt: true, relative, scope: null, text: '', included, omitted, incomplete: true, chars: 0, entries: 0, activeCount: 0 };
  }
  const entries = parsed.updateLog.entries;
  const active = Array.isArray(options.activeConstraints) ? options.activeConstraints : [];
  const retired = options.retiredCounts ?? null;
  const budget = Math.max(0, maxChars - FOOTER_RESERVE_CHARS);
  const lines = [];
  let used = 0;
  const push = (line, kind, id) => {
    const cost = line.length + 1;
    if (used + cost > budget) return false;
    lines.push(line);
    used += cost;
    included.push({ kind, id: id ?? null, chars: line.length });
    return true;
  };

  push('### ' + relative + ' [excerpt] scope=' + (parsed.scope ?? '.') + ' chars=' + parsed.totalChars + ' sections=' + parsed.sections.length + ' updates=' + entries.length, 'header', relative);
  for (const section of parsed.sections) push('- ' + section.title + ' @' + section.start + ' +' + (section.end - section.start), 'structure', section.title);
  if (active.length > 0) {
    push('Active requirements (newest first):', 'active-header', 'active');
    for (const item of active) {
      const line = '- [' + (item.id ?? 'c') + '] ' + String(item.text ?? '');
      if (!push(line, 'constraint', item.id)) omitted.push({ kind: 'constraint', id: item.id ?? null, reason: 'budget', chars: line.length });
    }
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const pointer = relative + ' update#' + entry.index + ' (offset ' + entry.start + ', ' + entry.chars + ' chars)';
    if (entry.parseOk !== true) {
      omitted.push({ kind: 'update', id: entry.index, at: entry.at, reason: 'invalid:' + entry.reason, chars: entry.chars, pointer });
      continue;
    }
    if (!push(entry.raw, 'update', entry.index)) {
      omitted.push({ kind: 'update', id: entry.index, at: entry.at, reason: 'budget', chars: entry.chars, pointer });
    }
  }
  if (parsed.updateLog.unterminated > 0) omitted.push({ kind: 'update', id: null, reason: 'unterminated', count: parsed.updateLog.unterminated });

  const markerOffset = parsed.updateLog.markerOffset ?? (entries[0]?.start ?? null);
  const footer = ['Omitted: ' + omitted.length + ' item(s)' + summariseOmitted(omitted) + '.'];
  footer.push('Full history: ' + relative + ' update log' + (markerOffset === null ? '' : ' at offset ' + markerOffset) + ' (' + entries.length + ' update entries).');
  const newestOmitted = omitted.find((item) => item.kind === 'update' && item.reason === 'budget');
  if (newestOmitted !== undefined) footer.push('Newest update omitted for budget: ' + newestOmitted.pointer + '.');
  if (retired !== null && (retired.retracted > 0 || retired.superseded > 0)) {
    footer.push('Retired by later entries: retracted=' + retired.retracted + ', superseded=' + retired.superseded + ' (text stays in the file).');
  }
  if (parsed.attestationOk === false) footer.push('Attestation block is unreadable; re-verify with the architecture tool.');

  const body = lines.join('\n');
  const boundary = '[architecture view boundary: full document in ' + relative + ']';
  let view = body + '\n\n' + boundary + '\n' + footer.join('\n');
  let droppedFooter = 0;
  while (footer.length > 0 && view.length > maxChars) {
    footer.pop();
    droppedFooter += 1;
    view = body + '\n\n' + boundary + '\n' + footer.join('\n');
  }
  return {
    ok: true,
    excerpt: true,
    relative,
    scope: parsed.scope,
    version: parsed.version,
    text: view,
    included,
    omitted,
    incomplete: omitted.length > 0 || droppedFooter > 0,
    chars: view.length,
    entries: entries.length,
    activeCount: active.length,
  };
}

/**
 * Boundary-aware backstop for callers that still hold a hard character limit.
 * It cuts after the last complete update block, or at a line end, so it cannot
 * leave half a JSON block or half a constraint behind.
 */
export function clampArchitectureViewText(text, maxChars) {
  const value = String(text ?? '');
  if (!Number.isInteger(maxChars) || maxChars <= 0 || value.length <= maxChars) return value;
  let head = value.slice(0, maxChars);
  // A cut inside an update block would leave an unbalanced tag behind, and a cut
  // inside a fenced JSON block would leave half a payload. Both are dropped back
  // to the last safe boundary before the character limit is applied.
  const openAt = head.lastIndexOf('<architecture_update');
  const closedAt = head.lastIndexOf('</architecture_update>');
  if (openAt !== -1 && openAt > closedAt) head = head.slice(0, openAt);
  if (((head.match(/```/g) ?? []).length) % 2 === 1) {
    const lastFence = head.lastIndexOf('```');
    const before = head.lastIndexOf('\n', lastFence);
    if (before > 0) head = head.slice(0, before);
  }
  const lineAt = head.lastIndexOf('\n');
  return lineAt > 0 ? head.slice(0, lineAt) : head;
}