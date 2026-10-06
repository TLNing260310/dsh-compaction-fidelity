// Pre-step policy decisions that must be verifiable without the host runtime.
//
// Two questions are deliberately kept apart: *which* folder a user meant, and
// *whether* they authorised a write. Naming a folder answers only the first, so
// a phrase such as "不要创建 src，先检查它" names src and authorises nothing.

/** Whole-sentence acknowledgements of a specific pending question. */
const CONSENT_SENTENCE_RE = /^(?:创建|创建吧|可以|可以创建|好的|好|同意|确认|是|是的|yes|y|ok|okay|create|do it|go ahead)[。.!！?？\s]*$/i;

/**
 * A creation verb is only consent when it stands as its own token. Requiring a
 * delimiter on both sides keeps "不要创建 src" from reading as an approval
 * while still accepting "好的，创建 app 文档".
 */
const CONSENT_TOKEN_RE = /(?:^|[\s，,。.!！?？、;；])(?:创建|新建|建立|create|do it|go ahead|确认创建|同意创建)(?:$|[\s，,。.!！?？、;；])/i;

/** Whole-sentence refusals. */
const DECLINE_SENTENCE_RE = /^(?:不|不用|不了|不需要|先不|暂时不|跳过|取消|算了|no|skip|cancel|not now)[。.!！?？\s]*$/i;

/** A refusal may also name the thing it refuses, e.g. "不要创建 src". */
const DECLINE_WITH_TARGET_RE = /(?:不要|不用|不需要|先不|暂时不|别|请勿)\s*(?:创建|新建|建立|生成|写入|添加)|(?:do not|don't|no need to|avoid)\s+(?:create|creating|write|writing|add)/i;

/**
 * True when the step has been cancelled or rejected. A stopped step must not
 * produce side effects: the architecture helpers can create documents, register
 * scopes, and record reminder state.
 */
export function preStepStopped(signal, decision) {
  return signal?.aborted === true || decision?.kind === "reject";
}

/** A folder is mentioned when its relative path or its last segment appears. */
export function mentionsCandidate(candidate, normalizedText) {
  const rel = String(candidate?.relativeDir ?? "").toLowerCase();
  if (rel.length === 0) return false;
  if (normalizedText.includes(rel)) return true;
  const base = rel.split("/").pop();
  return base !== undefined && base.length > 0 && normalizedText.includes(base);
}

/**
 * Interpret one user reply against an outstanding architecture question.
 * Returns `{ action: "decline" | "select" | "create" | "none", scope }`.
 * `select` means "the user chose this folder, but has not authorised a write".
 */
export function readArchitectureConsent(pending, text) {
  const raw = String(text ?? "");
  const normalized = raw.trim().toLowerCase();
  if (pending === null || pending === undefined || normalized.length === 0) return { action: "none", scope: null };
  if (DECLINE_SENTENCE_RE.test(normalized) || DECLINE_WITH_TARGET_RE.test(raw)) return { action: "decline", scope: null };
  const consented = CONSENT_SENTENCE_RE.test(normalized) || CONSENT_TOKEN_RE.test(raw);
  if (pending.kind === "create") {
    const scope = typeof pending.scope === "string" ? pending.scope : null;
    return consented && scope !== null ? { action: "create", scope } : { action: "none", scope: null };
  }
  if (pending.kind === "choose") {
    const chosen = (Array.isArray(pending.candidates) ? pending.candidates : []).find((item) => mentionsCandidate(item, normalized)) ?? null;
    if (chosen === null) return { action: "none", scope: null };
    const scope = String(chosen.relativeDir ?? "");
    if (scope.length === 0) return { action: "none", scope: null };
    return consented ? { action: "create", scope } : { action: "select", scope };
  }
  return { action: "none", scope: null };
}