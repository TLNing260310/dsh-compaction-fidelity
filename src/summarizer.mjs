import { clampText, uniqueBy } from './util.mjs';



const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/g;

const PATH_RE = /(?:[A-Za-z]:[\\/])?(?:[\w.@()-]+[\\/])*[\w.@()-]+\.(?:ts|tsx|js|jsx|mjs|cjs|go|py|rs|java|kt|kts|cs|rb|php|swift|c|h|cc|cpp|hpp|json|jsonc|ya?ml|toml|ini|md|mdx|sql|graphql|prisma|xml|gradle|properties|sh|ps1|bat|cmd|env)\b/g;

const COMMAND_RE = /(?:^|[\s。；;，,、])((?:[$>]\s*)?(?:npm|pnpm|yarn|npx|bun|node|deno|go|cargo|rustc|python|python3|pip|pip3|pytest|uv|poetry|dotnet|mvn|gradle|make|cmake|git|docker|docker-compose|kubectl|helm|terraform|pwsh|powershell|bash|sh|zsh|cmd|dsh)\b[^\n]*)/gim;

const ERROR_RE = /^.*(?:error|exception|failed|failure|fatal|panic|traceback|报错|错误|失败|异常|崩溃).*$/gim;

const IDENT_RE = /\b(?:[A-Z][A-Z0-9_]{2,}|[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*|[a-f0-9]{7,40}|#\d+)\b/g;

const NUMBER_RE = /\b(?:v?\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?|\d+(?:\.\d+)?\s?(?:ms|s|kb|mb|gb|k|m|%|tokens?))\b/gi;

const CORRECTION_RE = /(?:不对|不是|不要|别再|改成|改为|纠正|修正|注意|记住|必须|禁止|避免|应该说|我是说|我的意思|更正|wrong|incorrect|don['’]?t|instead|actually|rather|correction|remember|never|must not)/i;



export function messageText(message) {

  if (message === null || message === undefined) return '';

  const content = message.content;

  if (typeof content === 'string') return content;

  if (!Array.isArray(content)) return '';

  const parts = [];

  for (const block of content) {

    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);

  }

  return parts.join('\n');

}



export function describeMessages(messages) {

  const described = [];

  for (const message of messages ?? []) {

    const text = messageText(message);

    if (text.length === 0) continue;

    described.push({ role: message?.role ?? 'unknown', text, message });

  }

  return described;

}



export function detectLanguage(texts) {

  let cjk = 0;

  let latin = 0;

  for (const text of texts ?? []) {

    const value = String(text ?? '');

    cjk += (value.match(CJK_RE) ?? []).length;

    latin += (value.match(/[A-Za-z]/g) ?? []).length;

  }

  if (cjk === 0 && latin === 0) return 'en';

  if (cjk >= 12 && cjk * 4 >= latin) return 'zh';

  if (cjk > 0 && latin > 0) return 'mixed';

  return 'en';

}



function uniqueStrings(values, limit) {

  return uniqueBy(values.filter((value) => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim()), (value) => value).slice(0, limit);

}



export function extractLedger(messages, options = {}) {

  const described = describeMessages(messages);

  const userMessages = described.filter((entry) => entry.role === 'user');

  const allText = described.map((entry) => entry.text).join('\n');

  const corrections = userMessages.filter((entry) => CORRECTION_RE.test(entry.text));

  const prioritizedUsers = uniqueBy([...userMessages.slice(-12), ...corrections], (entry) => `${entry.role}:${entry.text.slice(0, 80)}`).slice(-16);

  return {

    generatedAt: new Date().toISOString(),

    language: detectLanguage(described.map((entry) => entry.text)),

    userQuotes: prioritizedUsers.map((entry) => clampText(entry.text, 2400)),

    corrections: corrections.slice(-12).map((entry) => clampText(entry.text, 1200)),

    paths: uniqueStrings(allText.match(PATH_RE) ?? [], options.maxPaths ?? 80),

    commands: uniqueStrings([...allText.matchAll(COMMAND_RE)].map((match) => (match[1] ?? match[0]).trim()), options.maxCommands ?? 50),

    errors: uniqueStrings((allText.match(ERROR_RE) ?? []).map((line) => line.trim()), options.maxErrors ?? 40),

    identifiers: uniqueStrings(allText.match(IDENT_RE) ?? [], options.maxIdentifiers ?? 120),

    numbers: uniqueStrings(allText.match(NUMBER_RE) ?? [], options.maxNumbers ?? 60),

  };

}



export function extractFilePathsFromMessages(messages, root = process.cwd()) {

  const text = (messages ?? []).map(messageText).join('\n');

  const matches = text.match(PATH_RE) ?? [];

  const relRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');

  const out = [];

  for (const raw of matches) {

    let value = raw.replace(/\\/g, '/');

    if (relRoot.length > 0 && value.startsWith(`${relRoot}/`)) value = value.slice(relRoot.length + 1);

    if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) continue;

    if (value.includes('..')) continue;

    out.push(value);

  }

  return uniqueStrings(out, 120);

}



function languageHeadings(language) {

  if (language === 'zh') return {

    title: '结构化上下文检查点（中文）',

    sections: [

      ['首要请求与意图', '用户最初与当前的目标；对精确措辞重要的原话直接引用'],

      ['关键技术概念', '技术栈、框架、模式与约定'],

      ['文件与代码', '精确路径：作用、关键改动或代码片段'],

      ['错误与修复', '错误：如何解决，以及相关用户反馈'],

      ['待办任务', '已明确要求但尚未完成的工作'],

      ['当前工作', '压缩发生时正在进行的精确工作'],

      ['下一步', '与最近请求一致的下一个动作'],

      ['关键上下文', '决策及理由、约束、用户偏好、开放问题、继续所需数据'],

      ['Compaction-Fidelity 锚点', '最近修改文件对应的架构级文件；缺失细节时用 compaction-fidelity-lookup 精确回查'],

    ],

  };

  if (language === 'bilingual') return {

    title: 'Structured Checkpoint (English) / 结构化检查点（中文补充）',

    sections: [

      ['Primary Request and Intent / 首要请求与意图', 'goals; quote verbatim where wording matters / 对精确措辞重要的原话直接引用'],

      ['Key Technical Concepts / 关键技术概念', 'stack, frameworks, patterns, conventions'],

      ['Files and Code / 文件与代码', 'exact path: why it matters, key changes or snippets'],

      ['Errors and Fixes / 错误与修复', 'error: resolution, plus related user feedback'],

      ['Pending Jobs / 待办任务', 'explicitly requested work not yet completed'],

      ['Current Work / 当前工作', 'precisely what was in progress'],

      ['Next Step / 下一步', 'single next action in line with the most recent request'],

      ['Critical Context / 关键上下文', 'decisions and rationale, constraints, preferences, open questions'],

      ['Compaction-Fidelity Anchors / Compaction-Fidelity 锚点', 'architecture-level files for recently modified files; use compaction-fidelity-lookup to retrieve exact content'],

    ],

  };

  return {

    title: 'Structured Context Checkpoint',

    sections: [

      ['Primary Request and Intent', 'the user’s original and evolving goals; quote verbatim where the exact wording matters'],

      ['Key Technical Concepts', 'technologies, frameworks, patterns, and conventions in play'],

      ['Files and Code', 'exact path: why it matters, key changes or snippets'],

      ['Errors and Fixes', 'error: how it was resolved, plus any related user feedback'],

      ['Pending Jobs', 'explicitly requested work not yet completed'],

      ['Current Work', 'precisely what was in progress at this checkpoint'],

      ['Next Step', 'the single next action, directly in line with the most recent request'],

      ['Critical Context', 'decisions and their rationale, constraints, user preferences, open questions, data needed to continue'],

      ['Compaction-Fidelity Anchors', 'architecture-level files for recently modified files; use compaction-fidelity-lookup to retrieve exact content'],

    ],

  };

}



export function buildSummaryInstruction({ language = 'auto', ledger, brief = '', anchors = '', constraints = [], architectureDocs = '', maxChars = 24000 } = {}) {

  const resolvedLanguage = language === 'auto' ? (ledger?.language === 'zh' ? 'zh' : ledger?.language === 'mixed' ? 'bilingual' : 'en') : language;

  const headings = languageHeadings(resolvedLanguage === 'mixed' ? 'bilingual' : resolvedLanguage);

  const structure = headings.sections.map(([heading, hint]) => `## ${heading}\n- [${hint}]`).join('\n\n');

  const ledgerText = clampText(JSON.stringify({

    language: ledger?.language ?? 'unknown',

    user_quotes: ledger?.userQuotes ?? [],

    user_corrections: ledger?.corrections ?? [],

    exact_paths: ledger?.paths ?? [],

    exact_commands: ledger?.commands ?? [],

    errors: ledger?.errors ?? [],

    identifiers: ledger?.identifiers ?? [],

    numbers: ledger?.numbers ?? [],

  }, null, 2), 9000);

  const constraintsText = (constraints ?? []).map((item, index) => "- [" + index + "] " + (item.text ?? item)).join("\n");

  const languageRule = resolvedLanguage === 'zh'

    ? '使用中文撰写检查点；所有路径、命令、错误串、标识符、数值必须原样保留，禁止翻译。'

    : resolvedLanguage === 'bilingual'

      ? 'Write the main prose in English; add concise Chinese notes for user-facing constraints. Preserve exact values verbatim.'

      : 'Write concise English engineering prose. The `verbatim_user_input` and `exact_value_ledger` entries MUST stay in their original language and MUST NOT be translated.';

  const acknowledgmentRule = 'This checkpoint is a lossy index, not a complete transcript. If a required fact is missing or uncertain, say so in "Critical Context"/"Compaction-Fidelity Anchors" and retrieve it with the available retrieval tools instead of guessing. Architecture facts are only locators here: after resuming, re-read `.dsh/compaction-fidelity/project.txt` and `.dsh/compaction-fidelity/PROJECT.md` before relying on them as ground truth.';

  return [

    'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',

    '',

    `Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.`,

    '',

    structure,

    '',

    'Rules:',

    `- ${languageRule}`,

    '- The `exact_value_ledger` block below is generated deterministically from the original messages. Treat every entry as ground truth and copy it into the relevant section verbatim; never paraphrase or translate an exact value.',

    '- `verbatim_user_input` contains the user’s own wording. Quote it verbatim where the exact wording matters; do not translate it.',

    '- Capture user feedback and explicit instructions faithfully, especially corrections.',
    '- Treat pinned_constraints as non-negotiable: copy them verbatim into "Critical Context"; never rewrite, translate, or drop them.',

    '- If the conversation is long, prefer preserving decisions, constraints, unresolved questions, exact identifiers, and user corrections over narrative detail.',

    '- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts and exact-value ledger entries, drop stale ones, and merge newer information into one consolidated summary.',

    '- Never record statements from the assistant about its remaining context, token pressure, compaction need, or the belief that context is almost full; those are not facts and must not survive into future checkpoints.',

    '- This applies to every role: user, operator, or assistant; only host/provider usage measurements are authoritative.',

    '- If the user explicitly asks to stop or compact, record that instruction verbatim, but never record the asserted context usage as fact.',

    `- ${acknowledgmentRule}`,

    '- Output only the checkpoint text: do not call any tool or take any other action.',

    '',

    brief ? `<compaction_fidelity_project_brief>\n${clampText(brief, 3000)}\n</compaction_fidelity_project_brief>` : '',

    anchors ? `<compaction_fidelity_anchors>\n${clampText(anchors, 3000)}\n</compaction_fidelity_anchors>` : '',

    ledgerText ? `<exact_value_ledger>\n${ledgerText}\n</exact_value_ledger>` : '',

    (ledger?.userQuotes?.length ?? 0) > 0 ? `<verbatim_user_input>\n${clampText((ledger.userQuotes ?? []).map((quote, index) => `[${index + 1}] ${quote}`).join('\n\n'), 7000)}\n</verbatim_user_input>` : '',

    constraintsText ? `<pinned_constraints>\n${clampText(constraintsText, 2000)}\n</pinned_constraints>` : '',
    architectureDocs ? `<architecture_retrieval_docs>\n${clampText(architectureDocs, 8000)}\n</architecture_retrieval_docs>` : '',
  ].filter((part) => part.length > 0).join('\n');

}







