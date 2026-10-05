// Deterministic pre/post-compaction fidelity fingerprint.
//
// This module is intentionally lexical and cheap: exact values from the
// existing Compaction-Fidelity ledger plus CJK character bigrams and structural markers.
// It is designed for the hot compaction path (offline, reproducible, no
// network/model dependency), so a slow neural embedding is not required to
// decide whether a summary has lost Chinese content or exact values.
import { extractLedger } from './summarizer.mjs';
import { uniqueBy } from './util.mjs';

const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{2,}/g;
const CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const HEADING_RE = /^#{1,6}\s+\S.*$/gm;
const CODE_FENCE_RE = /```([^\n`]*)\n([\s\S]*?)```/g;
const TOOL_TOKEN_RE = /\b(?:npm|pnpm|yarn|node|python|pip|git|docker|kubectl|curl|wget|grep|rg|sed|awk|powershell|pwsh|cmd|bash|zsh|make|cargo|go|dotnet|mvn|gradle)\b/gi;
const BARE_NUMBER_RE = /\b\d{2,}\b/g;

function messagesText(messages) {
  const out = [];
  for (const message of messages ?? []) {
    const content = message?.content;
    if (typeof content === 'string') {
      out.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') out.push(block.text);
    }
  }
  return out.join('\n');
}

function cjkBigrams(text) {
  const out = [];
  for (const match of text.matchAll(CJK_RUN_RE)) {
    const run = match[0];
    for (let index = 0; index + 2 <= run.length; index += 1) out.push(run.slice(index, index + 2));
  }
  return uniqueBy(out, (value) => value).slice(0, 400);
}

function headings(text) {
  return uniqueBy(text.match(HEADING_RE) ?? [], (value) => value.trim()).slice(0, 80);
}

function codeLanguages(text) {
  const out = [];
  for (const match of text.matchAll(CODE_FENCE_RE)) {
    const language = (match[1] ?? '').trim().split(/\s+/)[0];
    if (language.length > 0) out.push(language.toLowerCase());
  }
  return uniqueBy(out, (value) => value).slice(0, 40);
}

function exactCategories(ledger) {
  return {
    paths: ledger.paths ?? [],
    commands: ledger.commands ?? [],
    errors: ledger.errors ?? [],
    identifiers: ledger.identifiers ?? [],
    numbers: ledger.numbers ?? [],
  };
}

export function analyzeLanguageMix(text) {
  const value = typeof text === "string" ? text : "";
  const cjkChars = (value.match(CJK_CHAR_RE) ?? []).length;
  const latinChars = (value.match(/[A-Za-z]/g) ?? []).length;
  const total = cjkChars + latinChars;
  const cjkRatio = total === 0 ? 0 : Number((cjkChars / total).toFixed(4));
  const latinRatio = total === 0 ? 0 : Number((latinChars / total).toFixed(4));
  const mixedRatio = total === 0 ? 0 : Number(Math.min(cjkRatio, latinRatio).toFixed(4));
  const dominantLanguage = total === 0 ? "unknown" : cjkRatio >= 0.7 ? "zh" : latinRatio >= 0.7 ? "en" : "mixed";
  return { cjkChars, latinChars, cjkRatio, latinRatio, mixedRatio, dominantLanguage };
}
export function buildFingerprint(messages, options = {}) {
  const text = messagesText(messages);
  const ledger = options.ledger ?? extractLedger(messages);
  const exact = exactCategories(ledger);
  exact.numbers = uniqueBy([...(exact.numbers ?? []), ...(text.match(BARE_NUMBER_RE) ?? [])], (value) => value).slice(0, 80);
  const languageMix = analyzeLanguageMix(text);
  const cjkChars = (text.match(CJK_CHAR_RE) ?? []).length;
  const approxTokens = Math.ceil(cjkChars * 0.8 + Math.max(0, text.length - cjkChars) / 4);
  return {
    generatedAt: new Date().toISOString(),
    language: ledger.language,
    languageMix,
    exact,
    cjkBigrams: cjkBigrams(text),
    headings: headings(text),
    codeLanguages: codeLanguages(text),
    toolTokens: uniqueBy(text.match(TOOL_TOKEN_RE) ?? [], (value) => value.toLowerCase()).slice(0, 40),
    stats: {
      chars: text.length,
      cjkChars,
      approxTokens,
    },
  };
}

function recall(beforeValues, afterSet) {
  if (!Array.isArray(beforeValues) || beforeValues.length === 0) return 1;
  let hit = 0;
  for (const value of beforeValues) if (afterSet.has(value)) hit += 1;
  return hit / beforeValues.length;
}

function missing(beforeValues, afterSet, limit = 24) {
  const out = [];
  for (const value of beforeValues) if (!afterSet.has(value)) out.push(value);
  return out.slice(0, limit);
}

export function compareFingerprints(before, after) {
  const categories = ['paths', 'commands', 'errors', 'identifiers', 'numbers'];
  const exactRecall = {};
  const exactMissing = {};
  let total = 0;
  let hit = 0;
  for (const category of categories) {
    const beforeValues = before?.exact?.[category] ?? [];
    const afterValues = new Set(after?.exact?.[category] ?? []);
    exactRecall[category] = recall(beforeValues, afterValues);
    exactMissing[category] = missing(beforeValues, afterValues);
    total += beforeValues.length;
    hit += beforeValues.filter((value) => afterValues.has(value)).length;
  }
  const exactOverall = total === 0 ? 1 : hit / total;
  const cjkAfter = new Set(after?.cjkBigrams ?? []);
  const beforeCjk = before?.cjkBigrams ?? [];
  const cjkRecall = recall(beforeCjk, cjkAfter);
  const headingAfter = new Set(after?.headings ?? []);
  const headingRecall = recall(before?.headings ?? [], headingAfter);
  const codeAfter = new Set(after?.codeLanguages ?? []);
  const codeRecall = recall(before?.codeLanguages ?? [], codeAfter);

  let level = 'L3';
  if (exactOverall >= 0.98 && cjkRecall >= 0.95) level = 'L0';
  else if (exactOverall >= 0.9 && cjkRecall >= 0.8) level = 'L1';
  else if (exactOverall >= 0.75 && cjkRecall >= 0.6) level = 'L2';

  return {
    level,
    exactRecall,
    exactOverall: Number(exactOverall.toFixed(4)),
    cjkRecall: Number(cjkRecall.toFixed(4)),
    headingRecall: Number(headingRecall.toFixed(4)),
    codeRecall: Number(codeRecall.toFixed(4)),
    exactMissing,
    cjkMissingCount: beforeCjk.filter((value) => !cjkAfter.has(value)).length,
  };
}

export function buildCompensationText(comparison, maxTokens = 2048) {
  return buildCompensation(comparison, { maxTokens }).text;
}

const COMPENSATION_CATEGORIES = [
  { key: "paths", label: "paths", share: 0.4 },
  { key: "commands", label: "commands", share: 0.25 },
  { key: "errors", label: "errors", share: 0.2 },
  { key: "identifiers", label: "identifiers", share: 0.1 },
  { key: "numbers", label: "numbers", share: 0.05 },
];

function isCjkCodePoint(codePoint) {
  return (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff);
}

export function estimateCompensationTokens(text) {
  let cjk = 0;
  let ascii = 0;
  let other = 0;
  for (const ch of String(text ?? "")) {
    const cp = ch.codePointAt(0);
    if (isCjkCodePoint(cp)) cjk += 1;
    else if (cp <= 0x7f) ascii += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 0.8 + other * 0.5 + ascii / 4);
}

function compensationItem(value) {
  return "  - " + value;
}

export function buildCompensation(comparison, options = {}) {
  const maxTokens = Number.isInteger(options.maxTokens) && options.maxTokens >= 128 ? options.maxTokens : 2048;
  if (comparison === undefined || comparison.level === "L0") {
    return { text: "", tokens: 0, maxTokens, truncated: false, entriesByCategory: {}, omittedByCategory: {} };
  }
  const headerLines = [
    "<fidelity_compensation level=\"" + comparison.level + "\" exact_recall=\"" + comparison.exactOverall + "\" cjk_recall=\"" + comparison.cjkRecall + "\">",
    "The summary above may have dropped exact values from the pre-compaction context. Re-inject the following entries verbatim; do not translate or paraphrase them.",
  ];
  const footer = "</fidelity_compensation>";
  const overhead = estimateCompensationTokens(headerLines.join("\n") + "\n" + footer) + 8;
  const usable = Math.max(0, maxTokens - overhead);
  const accepted = new Map();
  const omittedByCategory = {};
  const pools = COMPENSATION_CATEGORIES.map((category) => ({
    category,
    values: [...(comparison.exactMissing?.[category.key] ?? [])],
  }));
  let used = 0;
  for (const pool of pools) {
    const cap = Math.floor(usable * pool.category.share);
    let categoryUsed = 0;
    while (pool.values.length > 0) {
      const item = compensationItem(pool.values[0]);
      const itemCost = estimateCompensationTokens(item + "\n") + 2;
      const list = accepted.get(pool.category.key) ?? [];
      const headerCost = list.length > 0 ? 0 : estimateCompensationTokens("- " + pool.category.label + ":\n") + 1;
      if (categoryUsed + headerCost + itemCost > cap || used + headerCost + itemCost > usable) break;
      pool.values.shift();
      categoryUsed += headerCost + itemCost;
      used += headerCost + itemCost;
      list.push(item);
      accepted.set(pool.category.key, list);
    }
  }

  for (const pool of pools) {
    while (pool.values.length > 0) {
      const item = compensationItem(pool.values[0]);
      const itemCost = estimateCompensationTokens(item + "\n") + 2;
      const list = accepted.get(pool.category.key) ?? [];
      const headerCost = list.length > 0 ? 0 : estimateCompensationTokens("- " + pool.category.label + ":\n") + 1;
      if (used + headerCost + itemCost > usable) break;
      pool.values.shift();
      used += headerCost + itemCost;
      list.push(item);
      accepted.set(pool.category.key, list);
    }
  }
  for (const category of COMPENSATION_CATEGORIES) {
    const original = comparison.exactMissing?.[category.key]?.length ?? 0;
    const acceptedCount = accepted.get(category.key)?.length ?? 0;
    omittedByCategory[category.key] = Math.max(0, original - acceptedCount);
  }
  const render = () => {
    const lines = [...headerLines];
    for (const category of COMPENSATION_CATEGORIES) {
      const list = accepted.get(category.key) ?? [];
      if (list.length === 0) continue;
      lines.push("- " + category.label + ":");
      for (const item of list) lines.push(item);
    }
    const omittedTotal = Object.values(omittedByCategory).reduce((sum, value) => sum + value, 0);
    if (omittedTotal > 0) lines.push("- [truncated: " + omittedTotal + " exact-value entries omitted due to " + maxTokens + " token budget]");
    lines.push(footer);
    return lines.join("\n");
  };
  let text = render();
  while (estimateCompensationTokens(text) > maxTokens) {
    let removed = false;
    for (let index = COMPENSATION_CATEGORIES.length - 1; index >= 0; index -= 1) {
      const key = COMPENSATION_CATEGORIES[index].key;
      const list = accepted.get(key);
      if (list && list.length > 0) {
        list.pop();
        omittedByCategory[key] += 1;
        removed = true;
        break;
      }
    }
    if (!removed) break;
    text = render();
  }
  const entriesByCategory = {};
  for (const category of COMPENSATION_CATEGORIES) entriesByCategory[category.key] = accepted.get(category.key)?.length ?? 0;
  const truncated = Object.values(omittedByCategory).some((value) => value > 0);
  return { text, tokens: estimateCompensationTokens(text), maxTokens, truncated, entriesByCategory, omittedByCategory };
}



