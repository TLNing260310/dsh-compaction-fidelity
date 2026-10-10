---
schema: aoci-lite-architecture-retrieval
version: 1
scope: "."
generatedAt: "2026-10-10T04:07:42.122Z"
---

<architecture_attestation>
{
  "revision": 4,
  "structureHash": "fb71bfadebb96d446f86999eb3fa931d714294da3a3200616bca3fd30417a977",
  "updateLogHash": "931b12330b7cfc9b03b877fb89f801e0c35673278928295621dd37b56b94c382",
  "entryCount": 4,
  "updatedAt": "2026-10-10T04:07:55.394Z"
}
</architecture_attestation>

# Architecture Retrieval Context

<architecture_retrieval scope="." version="1">

## 1. Scope and Purpose

```json
{
  "scope": ".",
  "docName": "ARCHITECTURE.md",
  "candidateVersion": "0.4.0-rc.1",
  "purpose": "本文件既是插件回查用的架构坐标，也是本仓库的完整结构说明：逐文件职责、运行机制、失败关闭契约、设计取舍与发布身份。",
  "readingOrder": [
    "README.md",
    "ARCHITECTURE.md",
    "SECURITY.md",
    "CHANGELOG.md",
    "docs/architecture-registry.md",
    "docs/paired-evaluation-protocol.zh.md"
  ],
  "entrypoints": [
    "src/index.mjs",
    "src/engine.mjs",
    "src/summarizer.mjs",
    "src/project-index.mjs",
    "src/architecture-changes.mjs"
  ]
}
```

## 2. Repository File Map

```json
{
  "files": [
    {
      "path": "src/index.mjs",
      "role": "插件入口与宿主集成",
      "detail": "导出 name/inject/apply；注册 compaction-fidelity-brief、compaction-fidelity-lookup、compaction-fidelity-architecture 工具与 /compaction-fidelity 命令；维护索引队列、pre-step 钩子、锚点注入、架构同意与刷新流程。宿主副作用集中在此文件。"
    },
    {
      "path": "src/engine.mjs",
      "role": "压缩引擎",
      "detail": "CompactionFidelityEngine 继承官方 Basic 压缩事务；实现绝对阈值压缩、summarizeFidelity 摘要改写与保真注入、pre-step 阈值钩子（批准后调度、取消直接终止、非取消错误才走官方兜底）以及架构文档的有界投影。"
    },
    {
      "path": "src/summarizer.mjs",
      "role": "摘要指令与精确值账本",
      "detail": "从会话消息提取用户原话、纠正、路径、命令、错误、标识符与数字；判定叙述语言（忽略 plugin:* 生产者消息）；组装带 token 预算的摘要指令；支持 CJK 路径与结构化 tool-call 参数。"
    },
    {
      "path": "src/constraint-ledger.mjs",
      "role": "约束账本",
      "detail": "按最新优先解析 active/retracted/superseded 约束并生成探针；确保用户已撤回的规则不会在压缩后重新变成不可协商约束。"
    },
    {
      "path": "src/fidelity-gate.mjs",
      "role": "保真闸门",
      "detail": "生成精确值探针，评估探针召回与 exact ledger；gate 失败时给出可诊断原因，而不是只报总分。"
    },
    {
      "path": "src/fingerprint.mjs",
      "role": "指纹与补偿",
      "detail": "语言混合分析、结构/精确值指纹构建与压缩前后比较、补偿文本生成与 token 估算。"
    },
    {
      "path": "src/fidelity-calibration.mjs",
      "role": "校准样本",
      "detail": "记录与汇总保真样本、分组计算保真等级、导入导出校准 JSON；字段白名单仍是已知缺口。"
    },
    {
      "path": "src/fingerprint-privacy.mjs",
      "role": "指纹隐私聚合",
      "detail": "对外只输出类别计数与聚合结果，避免把原始敏感值写入诊断/校准产物。"
    },
    {
      "path": "src/project-index.mjs",
      "role": "项目索引",
      "detail": "遍历工作区（忽略构建目录、隐藏目录与敏感文件）生成 index.json、project.*.txt、PROJECT.md、anchors.json/anchors.md；提供 brief/lookup/verify 与策略指纹；支持取消检查与注入式读取计数。"
    },
    {
      "path": "src/architecture-registry.mjs",
      "role": "scope 规则注册表",
      "detail": "维护 architecture-scopes.json v2（include/exclude/denyAll/doc）；createGlobalWorkspaceFileFilter 是全局读取策略；resolveManagedDocTarget 的拒绝 outcome 一律 target=null；registry 损坏时 fail-closed。"
    },
    {
      "path": "src/architecture-doc.mjs",
      "role": "托管文档生命周期",
      "detail": "托管文档路径解析、读取、渲染、追加更新、attestation 与更新日志；人工维护区标记与合并，冲突拒绝刷新；结构哈希排除人工区。"
    },
    {
      "path": "src/architecture-changes.mjs",
      "role": "变化检测与基线",
      "detail": "Git 候选（--untracked-files=all、rename）加速 + 基线内容哈希对照；缺失/损坏 baseline、Git 失败/不可用、扫描不完整、预算耗尽都返回显式 unknown；classifyAlignment 输出 aligned/stale/unknown。"
    },
    {
      "path": "src/architecture-view.mjs",
      "role": "有效投影视图",
      "detail": "解析 retrieval 文档与 update 日志，计算 active/retracted/superseded；默认只输出结构坐标、有效约束与历史坐标，更新正文仅在 includeHistory 时输出。"
    },
    {
      "path": "src/architecture-io.mjs",
      "role": "底层文档 IO",
      "detail": "sha256、原子写、容器校验与单文件锁 + CAS 的 mutateArchitectureDocument，供文档与基线共用。"
    },
    {
      "path": "src/reminder-state.mjs",
      "role": "提醒退避状态",
      "detail": "architecture-reminders.json 的去重、阶段升级、退避与上限裁剪。"
    },
    {
      "path": "src/step-policy.mjs",
      "role": "pre-step 决策策略",
      "detail": "preStepStopped 判定取消/reject、架构创建同意解析、候选 scope 提及检测。"
    },
    {
      "path": "src/range.mjs",
      "role": "近期上下文保留窗口",
      "detail": "按 token 预算选择近期消息并保持工具调用配对，避免截断在工具调用中间。"
    },
    {
      "path": "src/state.mjs",
      "role": "运行时状态与阈值",
      "detail": "总开关标记、home/workspace 持久化、阈值解析（默认 350k）与绝对阈值/保留 token 计划。"
    },
    {
      "path": "src/message-source.mjs",
      "role": "消息生产者归属",
      "detail": "PRODUCER_SOURCE 与 isProducerOwnedSource 的单一来源，避免把插件注入误当人类输入或写回退役 source 语法。"
    },
    {
      "path": "src/util.mjs",
      "role": "共享工具",
      "detail": "文本/哈希/原子 JSON/截断、Unicode 安全路径与工作区包含校验、AbortController helpers（createAbortError、throwIfAborted）。"
    }
  ],
  "tests": [
    {
      "path": "test/architecture-changes.test.mjs",
      "detail": "变化检测、基线读写、三态分类、Git 恢复 HEAD/未跟踪目录、maxFiles 边界、坏 schema 与取消。"
    },
    {
      "path": "test/architecture-doc.test.mjs",
      "detail": "渲染、追加更新、attestation、人工约束/决策/笔记保留、人工区、冲突拒绝。"
    },
    {
      "path": "test/architecture-entry-refusal.test.mjs",
      "detail": "工具与命令入口的拒绝、授权、全局策略与 refresh 人工区保留（需要真实 DSH peers）。"
    },
    {
      "path": "test/architecture-io.test.mjs",
      "detail": "原子写、锁/CAS、链接与逃逸防护。"
    },
    {
      "path": "test/architecture-registry.test.mjs",
      "detail": "scope 规则、全局策略、指纹、并发与重新纳入基线。"
    },
    {
      "path": "test/architecture-view.test.mjs",
      "detail": "解析、active state、预算内整条输出、有效投影与 includeHistory。"
    },
    {
      "path": "test/constraint-ledger.test.mjs",
      "detail": "约束账本提取、撤回/替代与比较。"
    },
    {
      "path": "test/constraint-ledger-heuristics.test.mjs",
      "detail": "约束启发式的中英文边界样例。"
    },
    {
      "path": "test/engine-architecture-refusal.test.mjs",
      "detail": "引擎在有/无 peers 下的拒绝、跳过、有效投影、取消传播（真实 peers 时含 prompt 级断言）。"
    },
    {
      "path": "test/fidelity-calibration.test.mjs",
      "detail": "校准评分、分组、导入导出与指纹。"
    },
    {
      "path": "test/fidelity-gate.test.mjs",
      "detail": "探针 gate 的通过/失败条件。"
    },
    {
      "path": "test/fingerprint.test.mjs",
      "detail": "语言混合、指纹比较、补偿与隐私迁移边界。"
    },
    {
      "path": "test/install-desktop.test.mjs",
      "detail": "Desktop 安装脚本的 staging/替换/恢复分支（不触碰真实 Profile）。"
    },
    {
      "path": "test/installed-identity.test.mjs",
      "detail": "安装副本与 tag/HEAD 的身份核对逻辑。"
    },
    {
      "path": "test/language-following.test.mjs",
      "detail": "语言判定与显式语言优先级。"
    },
    {
      "path": "test/message-source.test.mjs",
      "detail": "producer-owned source 契约。"
    },
    {
      "path": "test/migrate-fingerprint-sidecars.test.mjs",
      "detail": "历史 fingerprint 隐私迁移。"
    },
    {
      "path": "test/pre-step-hook.test.mjs",
      "detail": "pre-step 取消/拒绝/慢拒绝零副作用、队列策略重读、刷新快照与完整引擎钩子。"
    },
    {
      "path": "test/project-index.test.mjs",
      "detail": "索引、锚点、verify、取消与缺失/损坏 baseline。"
    },
    {
      "path": "test/range.test.mjs",
      "detail": "近期窗口与工具配对。"
    },
    {
      "path": "test/reminder-state.test.mjs",
      "detail": "提醒退避、去重与上限。"
    },
    {
      "path": "test/state.test.mjs",
      "detail": "阈值解析、持久化与总开关。"
    },
    {
      "path": "test/step-policy.test.mjs",
      "detail": "取消/reject 判定与同意解析。"
    },
    {
      "path": "test/summarizer.test.mjs",
      "detail": "账本提取、指令预算、生产者过滤、CJK 与工具参数路径。"
    }
  ],
  "tooling": [
    {
      "path": "scripts/verify-local.mjs",
      "detail": "真实 Harness 依赖 + mock LLM 的本地集成检查（不代表真实模型效果）。"
    },
    {
      "path": "scripts/check-installed-identity.mjs",
      "detail": "逐文件核对已安装副本与 tag/HEAD，先行尾归一化再比哈希。"
    },
    {
      "path": "scripts/install-desktop.mjs",
      "detail": "Desktop Profile 的 staging/替换/恢复路径；当前事务边界仍不覆盖 Profile 重写、依赖链接、验证与 enable 的完整回滚。"
    },
    {
      "path": "scripts/patch-dsh-runtime.mjs",
      "detail": "把 cordis patch 应用到目标运行时并保留恢复信息。"
    },
    {
      "path": "scripts/generate-preset-patch.mjs",
      "detail": "从 preset 生成 cordis.patch.yml。"
    },
    {
      "path": "scripts/migrate-fingerprint-sidecars.mjs",
      "detail": "历史 fingerprint sidecar 的隐私迁移（--apply 需显式授权）。"
    },
    {
      "path": "scripts/master-switch.mjs",
      "detail": "写入/移除总开关标记。"
    },
    {
      "path": "lib/client.js",
      "detail": "Desktop UI 注入客户端：压缩线控件、语言与状态操作。"
    },
    {
      "path": "locale/en.json",
      "detail": "UI 英文文案。"
    },
    {
      "path": "locale/zh.json",
      "detail": "UI 中文文案。"
    },
    {
      "path": "locale/engine/en.json",
      "detail": "引擎侧英文文案。"
    },
    {
      "path": "locale/engine/zh.json",
      "detail": "引擎侧中文文案。"
    },
    {
      "path": "preset/README.md",
      "detail": "preset 与 patch 的生成/安装说明。"
    }
  ],
  "projectDocs": [
    {
      "path": "README.md",
      "detail": "英文总览、安装与状态入口。"
    },
    {
      "path": "README.zh.md",
      "detail": "中文总览、安装与状态入口。"
    },
    {
      "path": "CHANGELOG.md",
      "detail": "版本与候选变更记录；0.4.0-rc.1 为测试候选段。"
    },
    {
      "path": "SECURITY.md",
      "detail": "威胁模型、读取策略、已知缺口与隐私说明。"
    },
    {
      "path": "REFERENCES.md",
      "detail": "参考资料与来源。"
    },
    {
      "path": "THIRD-PARTY-NOTICES.md",
      "detail": "第三方组件声明。"
    },
    {
      "path": "LICENSE",
      "detail": "项目许可证。"
    },
    {
      "path": "licenses/AOCI-FSL-1.1-MIT.txt",
      "detail": "AOCI 相关许可证文本。"
    },
    {
      "path": "docs/architecture-registry.md",
      "detail": "scope registry 与读取策略语义。"
    },
    {
      "path": "docs/paired-evaluation-protocol.zh.md",
      "detail": "三后端配对评测协议（尚未执行，不据此声明优效）。"
    },
    {
      "path": "docs/release-status-0.3.0.md",
      "detail": "0.3.0 历史发布状态。"
    },
    {
      "path": "docs/release-status-0.3.1.md",
      "detail": "0.3.1 稳定发布状态（身份保持不动）。"
    },
    {
      "path": "package.json",
      "detail": "包清单、版本、入口、脚本与发布 include 列表。"
    },
    {
      "path": "cordis.patch.yml",
      "detail": "Cordis 运行时 patch 模板。"
    },
    {
      "path": "icon.svg",
      "detail": "插件图标。"
    },
    {
      "path": ".gitignore",
      "detail": "忽略本地证据、临时产物与审计文件。"
    }
  ]
}
```

## 3. Contracts and Constraints

```json
{
  "constraints": [
    {
      "id": "k1",
      "kind": "hard",
      "text": "保持官方 Basic 压缩事务、工具配对边界、稳定性检查与溢出恢复；不为保真注入复制、绕过或改写整个官方事务。"
    },
    {
      "id": "k2",
      "kind": "hard",
      "text": "不修改日常 Desktop Profile、已安装 DSH payload、用户原始会话日志与既有工作区证据。"
    },
    {
      "id": "k3",
      "kind": "hard",
      "text": "真实模型调用、隐私迁移 --apply、日常 Profile 升级与外部发布均需显式授权；发布只走约定渠道并逐渠道验收。"
    },
    {
      "id": "k4",
      "kind": "hard",
      "text": "确定性账本只保证选中字符串逐字保真，不保证事实仍然有效，也不保证全部必要事实被召回。"
    },
    {
      "id": "k5",
      "kind": "hard",
      "text": "不引入通用长期记忆、embedding 数据库、无限上下文或额外后台服务。"
    },
    {
      "id": "k6",
      "kind": "hard",
      "text": "所有结论必须标注证据来源：源码、纯内存复现、隔离集成、mock LLM、真实模型或用户记录。"
    },
    {
      "id": "k7",
      "kind": "hard",
      "text": "拒绝优先于缺失：outcome 层拒绝必须 target=null；文件系统异常只在包装层映射为明确原因，不得当作 missing。"
    },
    {
      "id": "k8",
      "kind": "hard",
      "text": "所有读取入口共享同一全局策略并在读取前判定；缓存与索引携带策略指纹，策略变化即失效。"
    },
    {
      "id": "k9",
      "kind": "hard",
      "text": "宿主批准且信号有效后才调度扫描；拒绝、取消或抛错的步骤不得产生读取、索引或文档写入副作用。"
    },
    {
      "id": "k10",
      "kind": "hard",
      "text": "基线内容是变化判断依据，Git 只做候选加速；缺失/损坏基线、Git 失败、扫描不完整、预算耗尽一律 unknown，不得冒充 aligned。"
    },
    {
      "id": "k11",
      "kind": "hard",
      "text": "人工维护区只增不覆盖；同键冲突必须拒绝刷新并保留旧内容；结构哈希排除人工区。"
    },
    {
      "id": "k12",
      "kind": "hard",
      "text": "默认提示只含当前有效约束投影与来源坐标；历史正文仅在显式 includeHistory 或回查时输出，已撤回指令不得重新成为要求。"
    },
    {
      "id": "k13",
      "kind": "hard",
      "text": "plugin:* 生产者消息不参与语言判定、纠正与用户原话；仅人类输入决定叙述语言。"
    },
    {
      "id": "k14",
      "kind": "hard",
      "text": "aligned 只表示语义变化分低于刷新阈值，不表示源文件与快照逐字相同。"
    }
  ]
}
```

## 4. Key Decisions

```json
{
  "decisions": [
    {
      "id": "d1",
      "decision": "托管 scope 读策略失败关闭：registry 损坏时拒绝一切读取，而不是退化为无规则。",
      "reason": "损坏时宽松读取会把已被排除的内容重新送入远端摘要。",
      "status": "active"
    },
    {
      "id": "d2",
      "decision": "检索产物记录读取策略指纹 retrieval-scope.json，策略变化即令缓存失效。",
      "reason": "旧缓存可能包含当前规则已排除的内容。",
      "status": "active"
    },
    {
      "id": "d3",
      "decision": "约束账本按最新优先，并区分 active、retracted、superseded。",
      "reason": "用户已撤回的规则不得在压缩后重新成为不可协商约束。",
      "status": "active"
    },
    {
      "id": "d4",
      "decision": "架构基线写入走容器校验加锁与 CAS。",
      "reason": "避免链接逃逸，以及并发刷新互相覆盖条目。",
      "status": "active"
    },
    {
      "id": "d5",
      "decision": "pre-step 在宿主 decision 之后立即判断取消与 reject，写入前复查，分支整体隔离异常。",
      "reason": "取消后不得产生文件或状态副作用。",
      "status": "active"
    },
    {
      "id": "d6",
      "decision": "fidelity gate 的探针召回参与 ok，raw 与 final 分开评估。",
      "reason": "高召回指纹不应掩盖精确值全部丢失。",
      "status": "active"
    },
    {
      "id": "d7",
      "decision": "架构注入采用有界有效投影：结构坐标 + active 约束 + 历史坐标；更新正文只在 includeHistory 时输出。",
      "reason": "历史追加在文末，取文件头会先丢最新决策，全量正文又会把已撤指令带回提示。",
      "status": "active"
    },
    {
      "id": "d8",
      "decision": "叙述语言跟随人类用户最近发言，plugin:* 生产者消息不计票；mixed 只在双方都成规模时成立。",
      "reason": "减少不必要的转译损耗，也避免插件注入改变会话语言。",
      "status": "active"
    },
    {
      "id": "d9",
      "decision": "必须保存的精确值由代码组合并逐字核验，LLM 只负责语义归纳。",
      "reason": "字符串保真不应依赖模型抄写。",
      "status": "active"
    },
    {
      "id": "d10",
      "decision": "root 与子 scope 共用同一 workspace 级读取策略，root status/update/refresh 不能读取子 scope 排除的文件。",
      "reason": "局部 filter 会扩大读取范围并把被排除内容登记进基线。",
      "status": "active"
    },
    {
      "id": "d11",
      "decision": "索引与后台扫描在宿主允许继续之后才排队，执行时重新读取当前策略。",
      "reason": "慢速拒绝、抛错或取消都可能晚于排队，提前扫描已在拒绝前产生副作用。",
      "status": "active"
    },
    {
      "id": "d12",
      "decision": "Git 模式以基线快照为真值：枚举未跟踪文件与 rename 对，并重新核对记录文件集合，恢复 HEAD 也算变化。",
      "reason": "只比较 HEAD 会漏掉 dirty-at-refresh 之后被还原的内容。",
      "status": "active"
    },
    {
      "id": "d13",
      "decision": "变化检测对坏 schema、坏基线、扫描边界与预算耗尽返回显式 unknown，并用 completeness 标记。",
      "reason": "部分扫描或结构损坏不能伪装成 aligned。",
      "status": "active"
    },
    {
      "id": "d14",
      "decision": "文档区分自动生成区与人工维护区：刷新只替换自动区，人工条目合并保留，同键冲突拒绝刷新。",
      "reason": "refresh 不能清除人工约束、决策、笔记与未知人工段落。",
      "status": "active"
    },
    {
      "id": "d15",
      "decision": "用户意图与精确值只从人类输入与结构化工具参数提取，语言与路径支持 CJK。",
      "reason": "插件注入不是人工指令，CJK 路径也是必须逐字保留的精确值。",
      "status": "active"
    },
    {
      "id": "d16",
      "decision": "0.3.1 稳定 tag 身份保持不动；0.4.0-rc.1 仅作为 GitHub prerelease 测试候选发布。",
      "reason": "候选版本可以诚实标注测试状态，但不能改写既有稳定身份或提前声明 npm latest/市场可用。",
      "status": "active"
    },
    {
      "id": "d17",
      "decision": "索引、哈希、Git 子进程与文件锁目前仍同步执行。",
      "reason": "这是已知性能限制：大仓库会延迟宿主事件循环；取消检查与预算只能缓解，异步队列/worker 留待后续。",
      "status": "known-gap"
    },
    {
      "id": "d18",
      "decision": "安装事务目前只覆盖包替换与 staging 恢复，Profile 重写、依赖链接、验证与 enable 的完整回滚尚未闭合。",
      "reason": "安装生命周期需要故障注入验证，不能用源码字符串测试代替。",
      "status": "known-gap"
    },
    {
      "id": "d19",
      "decision": "三后端配对面板评测与真实模型冒烟尚未执行。",
      "reason": "机制正确性可以有隔离证据，但优效/成本结论必须等配对实验。",
      "status": "pending"
    }
  ]
}
```

## 5. Commands and Data

```json
{
  "commands": [
    "npm test — node --test test/*.test.mjs（宿主 peers 缺失时相关用例自动跳过）",
    "npm run check — 对所有源码、客户端与脚本做语法检查",
    "npm run verify:local — 真实 Harness 依赖 + mock LLM 集成检查",
    "npm run verify:installed — 安装副本与 tag/HEAD 身份核对",
    "npm run generate-patch — 从 preset 生成 cordis.patch.yml",
    "npm run patch:dsh — 应用运行时 patch",
    "npm run migrate:fingerprint-privacy — 历史 fingerprint 隐私迁移（--apply 需授权）",
    "npm pack --ignore-scripts — 生成候选 tarball 与 sha256"
  ],
  "dataLayout": [
    {
      "path": ".dsh/compaction-fidelity/index.json",
      "detail": "项目索引：文件、导入、命令、db 线索与生成时间。"
    },
    {
      "path": ".dsh/compaction-fidelity/project.txt / project.*.txt",
      "detail": "根清单与 meta/code/arch/database 分区卷。"
    },
    {
      "path": ".dsh/compaction-fidelity/PROJECT.md",
      "detail": "面向模型的 brief 文本。"
    },
    {
      "path": ".dsh/compaction-fidelity/anchors.json / anchors.md",
      "detail": "按文件维护的回查锚点与可读锚点图。"
    },
    {
      "path": ".dsh/compaction-fidelity/retrieval-scope.json",
      "detail": "索引对应的读取策略指纹。"
    },
    {
      "path": ".dsh/compaction-fidelity/architecture-scopes.json",
      "detail": "scope 规则注册表（v2，include/exclude/denyAll/doc）。"
    },
    {
      "path": ".dsh/compaction-fidelity/architecture-baseline.json",
      "detail": "按 scope 的刷新快照：hash/size/mtime 与 Git 元数据。"
    },
    {
      "path": ".dsh/compaction-fidelity/architecture-reminders.json",
      "detail": "架构提醒退避与去重状态。"
    },
    {
      "path": ".dsh/compaction-fidelity/state.json",
      "detail": "工作区级运行时状态。"
    },
    {
      "path": ".dsh/compaction-fidelity/fidelity-calibration.json",
      "detail": "本地校准样本与分组统计。"
    },
    {
      "path": "DSH_HOME 下的 home 状态与总开关标记",
      "detail": "跨工作区默认阈值、语言与禁用标记。"
    }
  ],
  "dbFiles": []
}
```

## 6. Compression Retrieval Notes

```json
{
  "notes": [
    "理念：把压缩摘要视为有损索引而不是事实副本。代码负责精确值、有效约束、来源坐标与确定性补偿，模型只负责语义归纳；缺失细节通过原始文件、索引与架构文档回查恢复。",
    "压缩流程：阈值计划 → 保留窗口与工具配对 → engine.summarizeFidelity → 约束账本/指纹/gate/补偿 → 注入预算 → 宿主 LLM；插件异常回退官方压缩，官方安全网始终保留。",
    "回查流程：project-index 生成 index.json、project.*.txt、PROJECT.md、anchors.json/anchors.md；brief/lookup/architecture 工具与 /compaction-fidelity 命令消费这些产物；所有缓存带策略指纹，策略变化即失效。",
    "架构流程：registry 解析 → 全局读取策略 → 托管文档读写/刷新/更新 → 更新日志与 attestation → Git/哈希三态变化检测 → 提醒退避。attestation 只证明内容一致性，不证明文档权威。",
    "失败关闭：拒绝优先于 missing；outcome 层拒绝 target=null；文件系统异常不映射为 missing；取消直接终止不进入兜底；不完整或预算耗尽的扫描返回 unknown 而不是 aligned。",
    "人工所有权取舍：自动区可重生成，人工区只增不覆盖，冲突拒绝刷新并保留旧内容；结构哈希排除人工区，使人工编辑不被误报为篡改，同时自动内容仍受 attestation 覆盖。",
    "有效投影取舍：默认提示只含当前有效约束投影与历史坐标，历史正文留在文件并可用 includeHistory/回查工具显式取出；这牺牲了部分历史细节的即时可见性，换取已撤回指令不复活。",
    "性能取舍：索引、哈希、Git 子进程与等锁目前同步执行，大仓库会阻塞宿主事件循环；现有缓解是取消检查、预算与稳定的记录顺序，异步 I/O/worker 与完整预算指标仍待完成。",
    "隐私取舍：索引跳过常见敏感文件，fingerprint 诊断只保留聚合与类别计数，隐私迁移需显式 --apply；校准 JSON 的任意字段白名单仍未实现，按未脱敏数据管理。",
    "证据边界：词法召回、校准分数与 attestation 不等于事实正确、任务成功率或成本收益；配对评测协议尚未执行，当前测试是隔离集成与 mock LLM 证据。",
    "分发身份：v0.3.1 是既有稳定 Release，身份与 tag 保持不动；0.4.0-rc.1 是 GitHub prerelease 测试候选，未发布 npm、未合并插件目录、未验收 Desktop 进程加载。"
  ],
  "exactValues": [],
  "retrievalAnchors": []
}
```

<!-- architecture-manual:start -->

<!-- architecture-manual:end -->

## 7. Update Log

<!-- architecture-update-log -->

<architecture_update at="2026-10-07T03:00:50.521Z" scope=".">
```json
{
  "at": "2026-10-07T03:00:50.521Z",
  "scope": ".",
  "summary": "S1：架构注入改为有界当前视图，不再取文件头",
  "changedFiles": [
    "src/architecture-view.mjs",
    "src/engine.mjs",
    "src/summarizer.mjs",
    "src/architecture-doc.mjs"
  ],
  "decisions": [
    "结构坐标与最新有效更新优先；单条不完整时只给来源指针和 omission"
  ],
  "constraints": [
    "不得注入半截更新块、JSON 或约束；只允许整条或指针"
  ]
}
```
</architecture_update>

<architecture_update at="2026-10-07T03:58:13.925Z" scope=".">
```json
{
  "at": "2026-10-07T03:58:13.925Z",
  "scope": ".",
  "summary": "S2：叙述语言跟随用户本人最近的发言，mixed 不再强制英文",
  "changedFiles": [
    "src/summarizer.mjs",
    "test/language-following.test.mjs"
  ],
  "decisions": [
    "标识符与散文词分开计数，代码块先剔除；混合只在双方都成规模时成立"
  ],
  "constraints": [
    "显式语言设置优先于自动判定；精确值仍须逐字保留"
  ]
}
```
</architecture_update>

<architecture_update at="2026-10-10T04:07:42.123Z" scope=".">
```json
{
  "at": "2026-10-10T04:07:42.123Z",
  "scope": ".",
  "summary": "0.4.0-rc.1 测试候选：闭合审计 P1（全局读取策略、批准后调度、Git 基线真值、完整性与 schema unknown、人工区保留、有效投影、生产者/CJK/工具参数）",
  "changedFiles": [
    "src/index.mjs",
    "src/architecture-changes.mjs",
    "src/architecture-doc.mjs",
    "src/architecture-view.mjs",
    "src/project-index.mjs",
    "src/summarizer.mjs",
    "src/engine.mjs",
    "test/pre-step-hook.test.mjs",
    "test/architecture-changes.test.mjs",
    "test/architecture-doc.test.mjs",
    "test/architecture-view.test.mjs"
  ],
  "decisions": [
    "root 与子 scope 共用全局读取策略，扫描前判定",
    "宿主批准后才调度索引，拒绝/取消/抛错零副作用",
    "Git 只做候选加速，基线内容与完整性是判断依据",
    "人工维护区只增不覆盖，冲突拒绝刷新",
    "默认提示只含有效约束投影与来源坐标"
  ],
  "constraints": [
    "不完整、损坏或预算耗尽的扫描一律 unknown，不得冒充 aligned",
    "已撤回指令不得通过历史正文重新进入提示",
    "plugin:* 消息不参与语言与用户意图判定"
  ]
}
```
</architecture_update>

<architecture_update at="2026-10-10T04:07:42.124Z" scope=".">
```json
{
  "at": "2026-10-10T04:07:42.124Z",
  "scope": ".",
  "summary": "重写仓库结构文档：新增逐文件地图、运行机制、失败关闭契约、设计取舍与发布身份说明",
  "changedFiles": [
    "ARCHITECTURE.md"
  ],
  "decisions": [
    "结构文档同时承担插件回查坐标与仓库说明书职责",
    "0.4.0-rc.1 只作为 GitHub prerelease 测试候选，稳定版身份保持不动"
  ],
  "constraints": [
    "文档只描述真实实现与已知缺口，不把未执行评测写成结论"
  ]
}
```
</architecture_update>

</architecture_retrieval>
