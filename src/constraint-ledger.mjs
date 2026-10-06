// Deterministic constraint ledger: which rules are still in force, verdicts,
// and probes.
//
// The ledger is the single place that decides which user rules still apply.
// Constraints are collected with provenance, explicit withdrawals and later
// restatements are resolved newest-first, and only surviving rules may be
// pinned as non-negotiable. A rule the user has already withdrawn must never be
// re-strengthened by re-injecting it after a compaction, and two conflicting
// rules must never both be presented as "non-negotiable".

const HARD_RE = /(?:must not|must|never|do not|don't|only|always|avoid|require|ensure|禁止|不要|必须|一定要|务必|只能|仅在|只在|不允许|避免|记住)/i;
const SOFT_RE = /(?:prefer|should|keep|maintain|preserve|保持|优先|尽量|建议|注意)/i;
const FIXED_DISTRACTORS = ["No additional constraint applies.", "Use default behavior when uncertain."];

// --- withdrawal -------------------------------------------------------------

/**
 * Explicit withdrawal cues. A cue only retracts rules whose content it names,
 * so a plain prohibition such as "不要使用 npm" stays a constraint while
 * "不再需要 npm 了" retracts an earlier one.
 */
const RETRACT_RE = /(?:不再需要|不再要求|不再|不用再|不需要|无需|无须|取消|撤销|撤回|作废|失效|忽略|忘掉|忘记|别管|作罢|算了|改为|改成|换成|现在可以|允许|no longer|not needed anymore|never mind|forget about|forget|disregard|ignore|scratch that|instead|switch to|change to|now allowed|revoke|repeal)/gi;

/** Generic words removed from a withdrawal so its named target can be matched. */
const RETRACT_NOISE_CJK_RE = /(?:所有|全部|一切|以上|上面|前面|之前|此前|刚才|刚刚|的|约束|要求|限制|规则|指令|条件|条款)/g;
const RETRACT_NOISE_ASCII_RE = /\b(?:all|every|any|previous|prior|earlier|above|other|the|constraints?|requirements?|restrictions?|rules?|instructions?)\b/gi;

/** A withdrawal that names no specific rule applies to every earlier rule. */
const BLANKET_RETRACT_RE = /(?:(?:所有|全部|以上|上面|前面|之前|此前)[^。；;！？!?]{0,10}(?:约束|要求|限制|规则|指令|条件)|(?:约束|要求|限制|规则|指令)[^。；;！？!?]{0,6}(?:全部|都|一律)(?:作废|取消|撤销|失效)|(?:all|every|any)\s+(?:previous|prior|earlier|above|other)\s+(?:constraints?|requirements?|restrictions?|rules?|instructions?)|(?:forget|ignore|disregard)\s+(?:all|everything|the\s+rest))/i;

/** Prohibition markers: they tell a rule apart from its reversal. */
const NEGATIVE_RE = /(?:不要|不能|不可|不许|不允许|禁止|严禁|避免|切勿|无需|不用|别|never|must not|do not|don't|avoid|forbidden|prohibited|not allowed)/i;

// Modality words are removed before comparing two rules by *object*, so that
// "必须使用 tabs" and "不要使用 tabs" are recognised as the same object with
// opposite polarity, while "marker-1" and "marker-2" stay unrelated rules.
const MODAL_CJK_RE = /(?:不要|不能|不可|不许|不允许|禁止|严禁|避免|切勿|无需|不用|必须|一定要|务必|只能|仅在|只在|要求|确保|记住|始终|总是|优先|尽量|建议|注意|保持|维持|需要|应该|别)/g;
const MODAL_ASCII_RE = /\b(?:must|should|never|always|only|require|requires|ensure|remember|prefer|keep|maintain|preserve|avoid|do|does|not|no|the|a|an|to|it|and|or)\b/gi;

const MAX_CONSTRAINT_CHARS = 500;
// Bounds the newest-first resolution cost on very long conversations. Only the
// newest candidates matter, because the ledger is capped the same way.
const MAX_CANDIDATES_SCANNED = 400;
const REVOKE_TARGET_COVERAGE = 0.6;
const CONFLICT_OBJECT_OVERLAP = 0.75;
const CONFLICT_MIN_SHARED_TOKENS = 2;

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

/** Best-effort provenance for a message, when the host provides a timestamp. */
function messageTimestamp(message) {
  for (const key of ["at", "timestamp", "createdAt", "time", "sentAt"]) {
    const value = message?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
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

function stripModals(text) {
  return String(text ?? "").replace(MODAL_CJK_RE, " ").replace(MODAL_ASCII_RE, " ");
}

/** Content tokens of a rule, with modality and polarity words removed. */
function objectTokens(text) {
  return new Set(tokenize(stripModals(text)));
}

function sharedTokenCount(left, right) {
  let hits = 0;
  for (const token of left) if (right.has(token)) hits += 1;
  return hits;
}

function isNegative(text) {
  return NEGATIVE_RE.test(String(text ?? ""));
}

/**
 * True when `newer` names the same object as `older` but disagrees about
 * polarity, e.g. "必须使用 tabs" against "不要使用 tabs". Same-polarity rules
 * with high overlap (a list of sibling constraints) are deliberately kept.
 */
function conflictsWith(newer, older) {
  if (newer.negative === older.negative) return false;
  if (newer.object.size === 0 || older.object.size === 0) return false;
  const shared = sharedTokenCount(older.object, newer.object);
  if (shared < CONFLICT_MIN_SHARED_TOKENS) return false;
  return shared / Math.min(older.object.size, newer.object.size) >= CONFLICT_OBJECT_OVERLAP;
}

/** True when a withdrawal names this rule, or withdraws every earlier rule. */
function retractionCovers(retraction, candidate) {
  if (retraction.ordinal <= candidate.ordinal) return false;
  if (retraction.blanket) return true;
  if (retraction.object.size === 0) return false;
  const shared = sharedTokenCount(retraction.object, candidate.object);
  if (shared === 0) return false;
  return shared / retraction.object.size >= REVOKE_TARGET_COVERAGE;
}

function withdrawalTarget(text) {
  return String(text ?? "")
    .replace(RETRACT_RE, " ")
    .replace(RETRACT_NOISE_CJK_RE, " ")
    .replace(RETRACT_NOISE_ASCII_RE, " ");
}

function describeRetired(candidate, extra) {
  return {
    text: candidate.text,
    kind: candidate.kind,
    ordinal: candidate.ordinal,
    messageIndex: candidate.messageIndex,
    at: candidate.at,
    ...extra,
  };
}

/**
 * Collect the constraints that are still in force, newest first, together with
 * the provenance of each rule and a diagnostic list of rules that were dropped
 * because the user withdrew or replaced them.
 */
export function extractConstraintLedger(messages, options = {}) {
  const maxConstraints = Number.isInteger(options.maxConstraints) && options.maxConstraints > 0 ? options.maxConstraints : 32;
  const list = Array.isArray(messages) ? messages : [];

  const candidates = [];
  const retractions = [];
  let ordinal = 0;
  for (let messageIndex = 0; messageIndex < list.length; messageIndex += 1) {
    const message = list[messageIndex];
    if (message?.role !== "user" && message?.role !== "system") continue;
    const at = messageTimestamp(message);
    for (const segment of splitSegments(messageText(message))) {
      ordinal += 1;
      // A withdrawal is recorded even when it is not itself phrased as a
      // constraint, e.g. "不再需要 npm 的限制了" carries no rule of its own.
      const target = withdrawalTarget(segment);
      if (target !== segment) {
        retractions.push({
          ordinal,
          blanket: BLANKET_RETRACT_RE.test(segment),
          object: objectTokens(target),
        });
      }
      const hard = HARD_RE.test(segment);
      const soft = SOFT_RE.test(segment);
      if (!hard && !soft) continue;
      candidates.push({
        ordinal,
        messageIndex,
        at,
        text: clampText(segment, MAX_CONSTRAINT_CHARS),
        kind: hard ? "hard" : "soft",
        object: objectTokens(segment),
        negative: isNegative(segment),
      });
    }
  }

  // Only the newest rules can survive the cap, so the expensive pairwise
  // resolution is bounded to the newest candidates.
  const scanned = candidates.length > MAX_CANDIDATES_SCANNED
    ? candidates.slice(candidates.length - MAX_CANDIDATES_SCANNED)
    : candidates;

  const revoked = [];
  const superseded = [];
  const alive = [];
  const seen = new Set();
  for (let index = scanned.length - 1; index >= 0; index -= 1) {
    const candidate = scanned[index];
    const retraction = retractions.find((entry) => retractionCovers(entry, candidate));
    if (retraction !== undefined) {
      revoked.push(describeRetired(candidate, { revokedByOrdinal: retraction.ordinal }));
      continue;
    }
    const replacement = alive.find((other) => conflictsWith(other, candidate));
    if (replacement !== undefined) {
      superseded.push(describeRetired(candidate, { supersededByOrdinal: replacement.ordinal }));
      continue;
    }
    const key = candidate.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    alive.push(candidate);
  }

  const constraints = alive.slice(0, maxConstraints).map((candidate, index) => ({
    id: "c" + (index + 1),
    kind: candidate.kind,
    text: candidate.text,
    status: "active",
    source: {
      messageIndex: candidate.messageIndex,
      ordinal: candidate.ordinal,
      at: candidate.at,
    },
  }));

  return {
    generatedAt: new Date().toISOString(),
    constraints,
    retracted: revoked,
    superseded,
    considered: candidates.length,
  };
}

function isActive(constraint) {
  return constraint?.status === undefined || constraint.status === "active";
}

export function compareConstraintLedger(ledger, summaryText) {
  const afterNorm = normalizeText(summaryText);
  const afterTokens = new Set(tokenize(summaryText));
  const verdicts = (ledger?.constraints ?? []).filter(isActive).map((constraint) => {
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
  const constraints = (ledger?.constraints ?? []).filter(isActive).slice(0, max);
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