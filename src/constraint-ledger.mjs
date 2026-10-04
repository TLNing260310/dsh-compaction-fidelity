// Deterministic constraint ledger: hard/soft constraints, verdicts, probes.

const HARD_RE = /(?:must not|must|never|do not|don't|only|always|avoid|require|ensure|禁止|不要|必须|一定要|务必|只能|仅在|只在|不允许|避免|记住)/i;
const SOFT_RE = /(?:prefer|should|keep|maintain|preserve|保持|优先|尽量|建议|注意)/i;
const FIXED_DISTRACTORS = ["No additional constraint applies.", "Use default behavior when uncertain."];

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

function clampText(text, maxChars) {
  const value = String(text ?? "").trim();
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function splitSegments(text) {
  return String(text ?? "").split(/[\n。；;！？!?]+/).map((part) => part.trim()).filter((part) => part.length > 0);
}

export function extractConstraintLedger(messages, options = {}) {
  const maxConstraints = Number.isInteger(options.maxConstraints) && options.maxConstraints > 0 ? options.maxConstraints : 32;
  const seen = new Set();
  const constraints = [];
  for (const message of messages ?? []) {
    if (message?.role !== "user" && message?.role !== "system") continue;
    const text = messageText(message);
    for (const segment of splitSegments(text)) {
      const hard = HARD_RE.test(segment);
      const soft = SOFT_RE.test(segment);
      if (!hard && !soft) continue;
      const value = clampText(segment, 500);
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      constraints.push({ id: "c" + (constraints.length + 1), text: value, kind: hard ? "hard" : "soft" });
      if (constraints.length >= maxConstraints) break;
    }
    if (constraints.length >= maxConstraints) break;
  }
  return { generatedAt: new Date().toISOString(), constraints };
}

function normalizeText(text) {
  return String(text ?? "").toLowerCase().replace(/[\s\p{P}]+/gu, "");
}

function tokenize(text) {
  const value = String(text ?? "").toLowerCase();
  const tokens = value.match(/[a-z0-9_]+/g) ?? [];
  const cjk = value.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? [];
  const bigrams = [];
  for (let index = 0; index + 2 <= cjk.length; index += 1) bigrams.push(cjk[index] + cjk[index + 1]);
  return [...tokens, ...bigrams];
}


export function compareConstraintLedger(ledger, summaryText) {
  const afterNorm = normalizeText(summaryText);
  const afterTokens = new Set(tokenize(summaryText));
  const verdicts = (ledger?.constraints ?? []).map((constraint) => {
    const normalized = normalizeText(constraint.text);
    if (normalized.length > 0 && afterNorm.includes(normalized)) return { ...constraint, verdict: "preserved" };
    const tokens = tokenize(constraint.text);
    let hit = 0;
    for (const token of tokens) if (afterTokens.has(token)) hit += 1;
    const overlap = tokens.length === 0 ? 0 : hit / tokens.length;
    return { ...constraint, verdict: overlap >= 0.5 ? "rewritten" : "dropped", overlap: Number(overlap.toFixed(3)) };
  });
  const counts = { preserved: 0, rewritten: 0, dropped: 0 };
  for (const verdict of verdicts) counts[verdict.verdict] += 1;
  const total = verdicts.length;
  return { verdicts, ...counts, total, preservedRatio: total === 0 ? 1 : counts.preserved / total };
}

export function buildConstraintProbes(ledger, options = {}) {
  const max = Number.isInteger(options.max) && options.max > 0 ? options.max : 8;
  const constraints = (ledger?.constraints ?? []).slice(0, max);
  return constraints.map((constraint, index) => {
    const choices = [constraint.text];
    for (let offset = 1; choices.length < 3 && offset <= constraints.length; offset += 1) {
      const candidate = constraints[(index + offset) % constraints.length]?.text;
      if (candidate && !choices.includes(candidate)) choices.push(candidate);
    }
    for (const distractor of FIXED_DISTRACTORS) {
      if (choices.length >= 3) break;
      if (!choices.includes(distractor)) choices.push(distractor);
    }
    return {
      id: constraint.id,
      kind: constraint.kind,
      question: "Which constraint must remain in force?",
      options: choices,
      answerIndex: choices.indexOf(constraint.text),
      expected: constraint.text,
    };
  });
}

