---
schema: aoci-lite-architecture-retrieval
version: 1
scope: "."
generatedAt: "2026-10-07T02:51:17.495Z"
---

<architecture_attestation>
{
  "revision": 3,
  "structureHash": "158d2e3dc1aa97627434ab6dc1350d191c4831a8c3e05eee296e5e59e807cd9f",
  "updateLogHash": "1ceaf0e04ae2e8a50beb1526aa9b3e62fc02f53c76e65b4f91db92adf73d5a49",
  "entryCount": 2,
  "updatedAt": "2026-10-07T03:58:13.926Z"
}
</architecture_attestation>

# Architecture Retrieval Context

<architecture_retrieval scope="." version="1">

## 1. Scope and Purpose

```json
{
  "scope": ".",
  "docName": "ARCHITECTURE.md",
  "generatedAt": "2026-10-07T02:51:17.495Z",
  "purpose": "记录该目录的架构坐标、约束与压缩后回查线索",
  "entrypoints": [
    "src/architecture-io.mjs",
    "src/architecture-doc.mjs",
    "src/architecture-registry.mjs",
    "src/architecture-changes.mjs",
    "README.md",
    "README.zh.md",
    "test/architecture-changes.test.mjs",
    "test/architecture-doc.test.mjs"
  ]
}
```

## 2. Module Map

```json
{
  "modules": [
    {
      "path": "src/architecture-io.mjs",
      "kind": "arch-doc",
      "imports": []
    },
    {
      "path": "src/architecture-doc.mjs",
      "kind": "arch-doc",
      "imports": []
    },
    {
      "path": "src/architecture-registry.mjs",
      "kind": "arch-doc",
      "imports": []
    },
    {
      "path": "src/architecture-changes.mjs",
      "kind": "arch-doc",
      "imports": []
    },
    {
      "path": "README.md",
      "kind": "arch-doc",
      "imports": []
    },
    {
      "path": "README.zh.md",
      "kind": "arch-doc",
      "imports": []
    },
    {
      "path": "test/architecture-changes.test.mjs",
      "kind": "arch-doc",
      "imports": []
    },
    {
      "path": "test/architecture-doc.test.mjs",
      "kind": "arch-doc",
      "imports": []
    },
    {
      "path": "test/architecture-io.test.mjs",
      "kind": "arch-doc",
      "imports": []
    },
    {
      "path": "test/architecture-registry.test.mjs",
      "kind": "arch-doc",
      "imports": []
    },
    {
      "path": "preset/README.md",
      "kind": "arch-doc",
      "imports": []
    },
    {
      "path": "package.json",
      "kind": "manifest",
      "imports": []
    },
    {
      "path": "src/index.mjs",
      "kind": "entry",
      "imports": []
    },
    {
      "path": "src/util.mjs",
      "kind": "code",
      "imports": []
    },
    {
      "path": "src/project-index.mjs",
      "kind": "code",
      "imports": []
    },
    {
      "path": "src/constraint-ledger.mjs",
      "kind": "code",
      "imports": []
    },
    {
      "path": "src/fidelity-calibration.mjs",
      "kind": "code",
      "imports": []
    },
    {
      "path": "src/state.mjs",
      "kind": "code",
      "imports": []
    },
    {
      "path": "src/summarizer.mjs",
      "kind": "code",
      "imports": []
    },
    {
      "path": "src/engine.mjs",
      "kind": "code",
      "imports": []
    },
    {
      "path": "src/fidelity-gate.mjs",
      "kind": "code",
      "imports": []
    },
    {
      "path": "src/fingerprint-privacy.mjs",
      "kind": "code",
      "imports": []
    },
    {
      "path": "src/fingerprint.mjs",
      "kind": "code",
      "imports": []
    },
    {
      "path": "src/message-source.mjs",
      "kind": "code",
      "imports": []
    },
    {
      "path": "src/range.mjs",
      "kind": "code",
      "imports": []
    },
    {
      "path": "src/reminder-state.mjs",
      "kind": "code",
      "imports": []
    },
    {
      "path": "src/step-policy.mjs",
      "kind": "code",
      "imports": []
    },
    {
      "path": "scripts/migrate-fingerprint-sidecars.mjs",
      "kind": "code",
      "imports": []
    }
  ]
}
```

## 3. Contracts and Constraints

```json
{
  "constraints": [
    {
      "id": "c1",
      "kind": "hard",
      "text": "保持官方 Basic 压缩事务、工具配对边界、稳定性检查与溢出恢复；不得为加入 trace 或附录复制、绕过或改写整个官方事务。"
    },
    {
      "id": "c2",
      "kind": "hard",
      "text": "不修改日常 Desktop Profile、已安装 DSH payload、用户原始会话日志与既有工作区证据。"
    },
    {
      "id": "c3",
      "kind": "hard",
      "text": "真实模型调用、隐私迁移 --apply、日常 Profile 升级与外部发布均需单独授权。"
    },
    {
      "id": "c4",
      "kind": "hard",
      "text": "确定性附录只保证选中字符串逐字保真，不等于事实仍然有效，也不等于全部必要事实召回。"
    },
    {
      "id": "c5",
      "kind": "hard",
      "text": "不新增通用长期记忆、embedding 数据库、无限上下文或额外后台服务。"
    },
    {
      "id": "c6",
      "kind": "hard",
      "text": "所有结论必须标注证据来源：源码、纯内存复现、隔离集成、真实模型或用户提供记录。"
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
      "decision": "架构注入优先当前有效视图与最新更新，而非文件头截断。",
      "reason": "历史追加在文末，取文件头会先丢掉最新决策。实施阶段 S1。",
      "status": "pending"
    },
    {
      "id": "d8",
      "decision": "语义叙述跟随用户主要交流语言，混合会话不再自动要求英文主摘要。",
      "reason": "减少不必要的转译损耗。实施阶段 S2。",
      "status": "pending"
    },
    {
      "id": "d9",
      "decision": "必须保存的精确值由代码组合并逐字核验，LLM 只负责语义归纳。",
      "reason": "出现过的值不等于仍然有效，但字符串保真不应依赖模型抄写。实施阶段 S3。",
      "status": "pending"
    }
  ]
}
```

## 5. Commands and Data

```json
{
  "commands": [
    "npm run test — node --test test/*.test.mjs",
    "npm run check — node --check src/index.mjs && node --check src/engine.mjs && node --check src/fingerprint.mjs && node --check src/fingerprint-privacy.mjs && node --check src/summarizer.mjs && node --check src/project-index.mjs && node --check src/range.mjs && node --check src/state.mjs && node --check src/util.mjs && node --check lib/client.js && node --check src/constraint-ledger.mjs && node --check src/fidelity-gate.mjs && node --check src/architecture-doc.mjs && node --check src/architecture-io.mjs && node --check src/architecture-changes.mjs && node --check src/reminder-state.mjs && node --check src/fidelity-calibration.mjs && node --check src/architecture-registry.mjs && node --check src/step-policy.mjs && node --check scripts/migrate-fingerprint-sidecars.mjs",
    "npm run generate-patch — node scripts/generate-preset-patch.mjs",
    "npm run verify:local — node scripts/verify-local.mjs",
    "npm run patch:dsh — node scripts/patch-dsh-runtime.mjs",
    "npm run migrate:fingerprint-privacy — node scripts/migrate-fingerprint-sidecars.mjs"
  ],
  "dbFiles": []
}
```

## 6. Compression Retrieval Notes

```json
{
  "notes": [
    "回查入口：compaction-fidelity-brief、compaction-fidelity-lookup、compaction-fidelity-architecture 工具，以及 /compaction-fidelity 命令。",
    "索引与锚点位于 .dsh/compaction-fidelity/：project.txt、PROJECT.md、anchors.md、anchors.json、index.json。",
    "身份核对：git rev-parse HEAD；已安装载荷需与 tag 逐文件比对，先归一化行尾再比哈希。",
    "已知缺口见 SECURITY.md 的 Known gaps 与 CHANGELOG 的 Unreleased 段。",
    "本文件 attestation 只证明内容一致性，不证明文档权威或事实正确。"
  ],
  "exactValues": [],
  "retrievalAnchors": []
}
```

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

</architecture_retrieval>
