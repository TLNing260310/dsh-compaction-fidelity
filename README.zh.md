# dsh-compaction-fidelity

> 项目名与包名：`dsh-compaction-fidelity`；定位：DSH 上下文压缩保真层。

面向社区版 **DSH Desktop 2.0.17** 所内嵌 **DeepSeek Harness 0.2.0-rc.2** 运行时的 Profile Bundle：双语压缩引擎 + 跨语言保真指纹与补偿 + 项目架构回查锚点 + 动态压缩线。版本、迁移、预算、验证与分发状态见 [0.3.0 发布状态](docs/release-status-0.3.0.md)，真实三后端评测设计见 [配对评测协议](docs/paired-evaluation-protocol.zh.md)。

## 项目目的

让 DSH 在长时间、大仓库、中英混合和工具调用密集的会话中，把压缩摘要当作有损索引而不是完整 transcript。

## 核心理念

官方 compaction 提供会话继续与溢出恢复机制；本插件量化并补偿关键事实和约束的损失，提供项目架构回查，但不保证压缩后任务必然正确。

## 适宜人群

DSH Desktop 长会话用户、大仓库或多模块项目、中文或中英混合工作流、工具调用密集且上下文增长快的会话。

## 学习参考与协议

学习参考与选择性集成说明见 REFERENCES.md；安全模型见 SECURITY.md；发布记录见 CHANGELOG.md。本项目代码采用 MIT 协议。


- **动态压缩线**：输入区可选 `256K / 350K / 512K / 800K（官方默认）` 预设；插件默认 350K；自定义范围 `256 < 值 < 800（K）`；`800K` 在 1M 窗口会按官方 80% 线（含输出预留）自动封顶。350K 是开发者实际个人体验后体感舒适、并观察 DeepSeek V4.1 Flash 上下文自动压缩线相关项目后认为合理的设置；如有不认同，可在本项目内自行修改自定义有效值。K 表示 1000 tokens，与 DSH ContextMeter 显示一致。
- **Compaction-Fidelity 项目认知**：确定性扫描工作区，生成随 Git 版本化的 `.dsh/compaction-fidelity/` 索引（模块图、架构文件、命令、数据库结构锚点）。
- **架构级回查锚点**：修改文件后把该文件的架构级依赖/文档/测试/迁移写入 `.dsh/compaction-fidelity/anchors.md`，并在下一步注入上下文；压缩摘要中也带锚点。
- **原文不丢失**：锚点只是指针；原始文件与 session log 仍在。`compaction-fidelity-lookup`、`compaction-fidelity-brief` 可在压缩后精确回查。
- **总开关/总闸**：安装 bundle 即整体启用；卸载即恢复内置 preset；运行时 `/compaction-fidelity on|off` 在插件压缩与官方压缩之间整体切换。
- **Managed Scope 规则**：include/exclude 过滤器写入 architecture-scopes.json，并作用于生成文档、baseline、变更检测与锚点注入。
- **架构文档 Attestation**：每份 ARCHITECTURE.md 带 revision、structureHash、updateLogHash、entryCount；status 与 verify 会报告不一致。
- **哈希归一化**：structureHash / updateLogHash 在 CRLF、行尾空白、连续空行归一化后计算，纯格式刷新不会误报不一致。
- **排除/恢复语义**：文件被 exclude 期间发生的变化不追踪；re-include 会以当前状态重建 baseline，不会立即误报。
- **显式对齐检查**：architecture check 直接报告 aligned/stale、语义变化分、检测方式、attestation revision 与一致性。
- **跨语言保真指纹**：压缩前冻结精确值、CJK 字符二元组（词法指标）与结构指纹；压缩后比对并输出 L0–L3 分级，缺失精确值会自动追加 `fidelity_compensation` 补偿块，并写入 `.dsh/compaction-fidelity/fingerprints/`。
- **安全加固**：scope / glob 校验、symlink 逃逸拒绝；registry、reminder、calibration 统一使用带锁 CAS 写入。
- **调度加固**：pre-step 语义检查按 workspace/scope 节流；会话缓存有上限；fingerprint 文件只保留最新 500 份。
- **语言策略**：默认 `auto` 跟随会话语言，避免翻译两次；`en` 模式英文写摘要，但用户原话与精确值原样保留、不翻译。
- **全局注入预算**：摘要指令、补偿块与 pinned constraints 共享一个 CJK 估算 token 预算（`injectionMaxTokens`，默认 16000）。预算不足时先丢弃或截断低优先的 project brief、锚点、架构文档与刷新提示，精确值账本与 pinned constraints 最后才处理；发生截断时提示中留下 `<compaction_fidelity_injection_budget>` 标记，引擎日志记录被影响的块。
- **补偿前后指纹校准**：压缩摘要的原始指纹与追加补偿块后的最终指纹按语言组分别记录到 `.dsh/compaction-fidelity/fidelity-calibration.json`；每条样本包含 `dominantLanguage`、`mixedRatio`、`cjkRatio`、`latinRatio`。中英混合会话进入 `mixed:<主语言>` 组。每个语言组累计 8 个样本后给出校准分级，诊断 gate 使用原始召回指标及最终探针/约束检查，不采用历史分位数。
- **锚点质量**：锚点按 canonical identity 去重，按关系强度评分，并按类别限流（测试 2、文档 1、数据库 2）。

### 校准数据看板与冷启动导入

`fidelity-calibration.json` 是核心证据资产。现可查看实时统计，并从工作区内的 JSON 文件导入可信样本：

```text
/compaction-fidelity calibration summary
/compaction-fidelity calibration import trusted-samples.json
```

导入校验时间、语言组及 `[0,1]` 内的原始/最终分数；拒绝无效或过大的文件，去重并记录相对来源，只保留最近 500 条。损坏的既有账本不会被静默清空。最小合法样本：

```json
{
  "samples": [
    { "at": "2026-10-06T00:00:00.000Z", "language": "zh", "calibrationKey": "zh", "rawScore": 0.68, "finalScore": 0.84 },
    { "at": "2026-10-06T00:01:00.000Z", "language": "en", "calibrationKey": "mixed:en", "mixedRatio": 0.42, "rawScore": 0.61, "finalScore": 0.71 }
  ]
}
```

每组累计 8 个样本后才显示校准分级；诊断 gate 使用固定召回阈值及探针/约束检查，不采用历史分位数。混合语言样本不会进入纯语言分位数。

### 与压缩后端的关系

本插件的引擎子类**确实覆盖了 `summarize()`**：它生成双语摘要、对比原始与补偿后指纹、记录保真度。因此准确定位是“带观测能力的压缩后端”，不是纯旁路观测层。`dsh-compaction-pro` 等后端也占用压缩服务/预设行；同一预设中并用尚未验证，不能宣称兼容。
- **提醒退避持久化**：架构刷新提醒按 0 -> 5 分钟 -> 30 分钟退避，之后只保留 status 可见；状态存于 `.dsh/compaction-fidelity/architecture-reminders.json`。

> 本插件按 DSH Desktop 2.0.17 内嵌的 Harness 0.2.0-rc.2 生成并锁定 peer 版本。独立安装的旧 CLI 0.1.5-rc.3 的 preset / 压缩 API 不同，不能混用。
>
> **可选的本机 DSH runtime 修改**：本 bundle patch 已给 `minimal` preset 加入压缩组，不需要修改宿主文件才能安装。下列脚本另行修改安装目录内的 `minimal` preset 与 token-meter，用于实验性 CJK 估算；不会在安装时自动运行，也不属于市场 bundle 契约。只在核对过 `0.2.0-rc.2` 的本机安装后手动执行；DSH 升级后先重新核对兼容性：
>
> ```powershell
> node scripts/patch-dsh-runtime.mjs
> node scripts/patch-dsh-runtime.mjs --restore   # 可选回滚
> ```
>
> 脚本带备份与 `--restore` 回滚；宿主修改不随 bundle 卸载而自动恢复。长期应通过 DSH 官方扩展点或上游修复替代。Compaction-Fidelity bundle patch 覆盖 `standard` / `cordis` / `ptc` / `minimal` 四个 preset。


## 为什么值得用（简明版）

- CJK 计量：可选的本机 runtime 修改采用 0.8 token/中文字符；bundle 安装本身不改 DSH token-meter。
- 有效预算：显式先算 `W - O - H`，再比较压缩线；与官方 min(W×ratio, W−O−H) 语义对齐，并便于诊断估算误差。
- 保真量化：精确值 ledger + CJK bigram + L0–L3 + 自动补偿。
- 压缩后回查：项目认知索引 + brief/lookup + 架构锚点注入。
- 官方安全网：minimal 也注入官方压缩；插件异常自动回退。
- 本地可审计：文本索引与指纹可随 Git 版本化，热路径无神经嵌入。
- 差异化：生态已有阈值/checkpoint 插件；本项目聚焦中英混合压缩损失量化与补偿。

## 为什么需要量化校准

逐字保留或选择性压缩只决定留下了什么，却不会告诉你生成摘要丢了多少精确值或 CJK 二元组。本插件在每次压缩后记录原始摘要与最终摘要（含补偿块）的分语言保留指标，写入 .dsh/compaction-fidelity/ ；经审查和脱敏后可选择随 Git 版本化；每个语言组累计 8 个样本后，才用这些历史给出一份校准分级作为证据。诊断 gate 使用固定召回阈值及探针/约束检查，独立于历史分位数。

## 设计理念展开

- 摘要是有损索引，不是完整 transcript。
- 精确事实逐字保留，不翻译。
- 确定性抽取优先于概率猜测。
- 结构/锚点比全文复制便宜。
- 官方安全网永远保留；关闭时值保留但不生效。
- 每次压缩都有信息损失；早压缩是安全与近期上下文的权衡。

## 已知边界与验证方向

- 补偿前后指纹校准现已记录原始摘要与最终摘要的分语言指标，但下游 QA 相关性仍未测量。
- 校准按语言组各需 8 个样本；中英混合会话进入 `mixed:<主语言>` 组，避免污染纯 zh/en 统计。
- 锚点 quality 权重仍为固定值；项目级权重覆盖列为 P1 候选。
- 补偿块/锚点可能稀释注意力；已实现 2048 token 软上限、类别优先级、锚点质量限流，以及 CJK 估算的 16000 token 全局注入预算；最优阈值仍需更多校准样本。
- zh/en/bilingual 摘要策略缺对照；约束 ledger 尚未覆盖。
- 16000 token 全局注入预算是保守工程上限，不是经实验证明的最优值。触发截断时，提示中会出现 `<compaction_fidelity_injection_budget>` 标记，引擎日志会记录被丢弃或缩短的块。
- 输出预留取当前路由请求/模型配置；summaryMaxTokens 与 headroom 默认各为 65536，应按实际模型预算调整。
- 256K/350K/512K 自定义线需验证安全收益与信息损失的权衡。

## 1. 安装、卸载与总开关

### DSH Desktop 2.0.17（内嵌 Harness 0.2.0-rc.2）

1. 通过 Desktop 终端/插件管理器安装 [v0.3.0 GitHub tag](https://github.com/TLNing260310/dsh-compaction-fidelity/releases/tag/v0.3.0) 或本地检出。`0.3.0` 是首个独立插件 SemVer 版本；npm 发布目标是 `dsh-compaction-fidelity@0.3.0`，Desktop 内置社区市场一键安装要求 npm `latest` 解析到该稳定版本。使用市场路径前先执行 `npm view dsh-compaction-fidelity version` 检查。仓库尚未被 `awesome-dsh-plugin` 收录。
2. bundle 加入 `dsh.profile.bundles` 并应用 `cordis.patch.yml`：
   - 插入宿主插件行 `compaction-fidelity`（工具、命令、索引、锚点注入）；
   - 按 id 覆盖内置 `preset-standard` 与 `preset-cordis`，把 `compaction-basic` 行替换为 `dsh-compaction-fidelity/engine`。
3. 新建会话使用覆盖后的 preset；已存在会话保持启动时组合，不会中途换引擎。

### Desktop CLI profile

```powershell
dsh plugin --profile desktop add 'github:TLNing260310/dsh-compaction-fidelity#v0.3.0'
dsh plugin --profile desktop remove dsh-compaction-fidelity
```

独立 CLI Web profile 可将 `desktop` 改为 `web`。卸载后覆盖层消失，内置 `standard`/`cordis` 自动恢复官方压缩；重启后新会话恢复官方行为。

### 关闭语义

| 方式 | 效果 |
|---|---|
| 停用 bundle 或 dsh plugin remove | 完整卸载：preset 覆盖、Compaction-Fidelity 工具、命令、监听器全部消失 |
| 宿主行 config.enabled = false | 不注册工具/命令/监听器；engine 若仍被 preset 引用则回退官方摘要，绝对阈值不生效 |
| 运行时 /compaction-fidelity off | 当前进程关闭 Compaction-Fidelity 能力，压缩回退官方 0.2.0 行为；文件与索引保留 |
| 运行时 /compaction-fidelity on | 恢复绝对阈值压缩、Compaction-Fidelity 摘要、锚点注入与回查工具 |

/compaction-fidelity off 不是没有压缩，而是保留官方安全网，避免长会话直接溢出。

## 2. 绝对阈值压缩

官方 0.2.0 的阈值是 min(窗口 × thresholdRatio, 窗口 − 预留输出 − headroom)，默认 80% 窗口 + 64Ki headroom。对 1M 窗口的 DeepSeek-V41-Flash，通常接近 70 万 token 才触发；本机测试会话最大约 44.8 万 token，从未触发。

本插件用官方 summarize() 子类钩子 + 自己的 agent/pre-step 监听器实现绝对阈值：

- 达到 threshold 后先让官方 toolResultPruner 修剪超大工具结果，再测量；
- 仍超阈值时按 retainTokens 保留最近原文，压缩最旧的 tool-pair 平衡区间；
- 通过官方 compactRegion() 完成落盘、替换与完整性检查；
- 压缩失败只记录警告并继续当前轮次，不阻塞对话；
- `350k` 是绝对阈值模式；`800k` 会受模型有效预算封顶；`80%` / `full` / `1m` 才走官方动态压力线。

### 配置字段

| 字段（engine 行） | 默认 | 说明 |
|---|---|---|
| enabled | true | engine 级开关；运行时状态优先级更高 |
| threshold | 350k | 256k / 350k / 512k / 800k / full / 自定义 256<值<800（K） |
| retainTokens | 阈值的 10%，上限 65536 | 压缩时逐字保留的最近原文预算 |
| headroomTokens | 65536 | 自定义阈值的最低安全余量 |
| summaryLanguage | auto | auto / zh / en / bilingual |
| summaryMaxTokens | 65536 | 摘要输出上限；与官方 0.2.0 默认对齐 |
| compensationMaxTokens | 2048 | 补偿块 token 预算；按 paths > commands > errors > identifiers > numbers 整条截断 |
| summaryProvider / summaryModel | 继承会话路由 | 成对设置，可路由到更便宜或更强的模型 |
| injectionMaxTokens | 16000 | 汇总提示、补偿块与 pinned constraints 共享的 CJK 估算 token 预算；低优先内容先截断，精确值账本与约束最后处理 |
| compactionRetries | 1 | 阈值仍高时的额外压缩次数 |
| ledger | true | 确定性精确值账本 |
| anchors | true | 摘要中注入 Compaction-Fidelity 简览与锚点 |
| anchorsPerFile | 8 | 每文件最多锚点数 |
| indexDir | .dsh/compaction-fidelity | 索引目录（工作区相对路径） |
| architectureRefreshThreshold | 30 | scope 内语义变化分达到该值时，pre-step 注入 ARCHITECTURE.md 刷新提示 |
| architectureSingleFileChangeThreshold | 300 | 单个核心文件变更行数达到该值时强制触发刷新 |

### 运行时命令

```text
/compaction-fidelity threshold 256k
/compaction-fidelity threshold 512k
/compaction-fidelity threshold 800k
/compaction-fidelity threshold 300000   # 300K 等价
/compaction-fidelity retain 65536
/compaction-fidelity language auto | zh | en | bilingual
/compaction-fidelity calibration summary
/compaction-fidelity calibration import trusted-samples.json
```

阈值、保留量、语言会即时写入进程内全局状态，并持久化到 DSH home 的 .dsh-compaction-fidelity/state.json 与工作区 .dsh/compaction-fidelity/state.json。当前进程立即生效，重启后继续生效。

### 摘要语言：关于只记英文、不翻译两次

- auto（默认）：检测会话 CJK 比例，中文会话用中文写 checkpoint。中文到中文，不存在翻译，也就不存在翻译两次。
- en：模型自述部分使用英文，但 verbatim_user_input 与 exact_value_ledger 中的用户原话、路径、命令、错误串、标识符、数值保持原语言、禁止翻译。适合跨 Agent 统一英文日志的场景；精确值不会经历第二次翻译。
- bilingual：英文结构 + 中文关键约束补充。
- 无论哪种模式，原始消息仍在 session log 中，可用 compaction-fidelity-lookup、compaction-fidelity-brief 与 session 日志回查。

结论：用户原话是中文时，纯英文且零翻译在逻辑上不可能：要么翻译用户原话（有损），要么原样引用（不是纯英文）。本插件默认零翻译；需要英文 canonical log 时，英文只用于模型自述，精确值原样保留。

## 3. Compaction-Fidelity 二改

### 保留的优点

| Compaction-Fidelity 优点 | 本插件实现 |
|---|---|
| 持久化、随 Git 版本化、跨会话复用 | .dsh/compaction-fidelity 文本索引与 JSON 基线随仓库提交 |
| 本地优先、不联网、不用数据库凭据 | 纯本地确定性扫描 |
| 整体代码认知而非简单 RAG | project.code.txt 模块图 + project.arch.txt 架构级文件 + PROJECT.md 简览 |
| 数据库 Schema 认知 | project.database.txt 记录 schema/migration 文件作为锚点 |
| 治理与新鲜度 | baseline.json + /compaction-fidelity verify 比对哈希 |
| 稳定格式 | 保留 Compaction-Fidelity 式 project.meta/code/arch/database.txt；另给 index.json、anchors.json |
| 架构级文件重要 | README、架构文档、ADR、清单、入口、高 fan-in 文件识别为锚点 |

### 舍弃或降级

| Compaction-Fidelity 原能力 | 处理 | 原因 |
|---|---|---|
| 188K 行 Go 治理内核 | 不移植，改 Node 薄层 | 体量与依赖不匹配 |
| stdio MCP Server / 9 个 MCP 工具 | 改 DSH 原生工具与命令 | 不需要额外进程 |
| FRAS/Attestation/Ledger/Recovery 全套治理状态机 | 只保留 index + baseline + verify | 依赖组织治理约定 |
| Agent 逐批撰写、300K token Whole-Index | 确定性规则索引 + 按需回查 | 防止索引本身挤占上下文 |
| Managed Scope 三角色 index/observe/exclude | include/exclude 已实现 | observe 仍不纳入 |
| phase_transition 阶段推断 | 不采用自动推断 | 仅保留显式命令、语义分与压缩触发 |
| Token 级 Whole-Index 预算 120K/180K/240K | 保留单文档 4000 字符 + 总量 8000 字符检索预算 | 避免从压缩保真层滑向索引治理 |
| 完整 tree-sitter 调用图 | JS/TS/Python/Go/Rust 启发式 import 图 | 第一版不引入语言服务器 |
| 实时数据库系统目录与 DSN | 只识别 schema/migration 文件 | 本地优先、零凭据、零网络 |
| Compaction-Fidelity CLI、跨仓库全局索引 | 每工作区一套 .dsh/compaction-fidelity | 与 DSH workspace 隔离一致 |

### 架构锚点如何进入上下文

1. 模型通过 write、edit、str_replace_editor（非 view）修改文件；
2. tools/result 监听器记录会话改了哪些文件；
3. 下一步 agent/pre-step 把架构级锚点作为一条 user 消息追加到上下文；
4. 同一批修改写入 .dsh/compaction-fidelity/anchors.md，并在下一次压缩摘要中以 compaction_fidelity_anchors 出现；
5. 模型可随时调用 compaction-fidelity-lookup、compaction-fidelity-brief 精确回查。

## 4. 命令与工具

### 命令

```text
/compaction-fidelity status                    查看总开关、阈值、保留量、语言、索引状态
/compaction-fidelity on | off                  运行时总开关（off 回退官方压缩）
/compaction-fidelity threshold 256k|350k|512k|800k|N  设置绝对阈值（输入区自定义按 K 解析）
/compaction-fidelity retain N                  设置最近原文保留预算
/compaction-fidelity language auto|zh|en|bilingual
/compaction-fidelity init | reindex            重建 Compaction-Fidelity 索引
/compaction-fidelity verify                    对照 baseline 检查索引新鲜度
/compaction-fidelity brief                     输出项目简览
/compaction-fidelity anchors <file>            输出某文件的架构级锚点
/compaction-fidelity lookup <query>            按路径/模块/命令关键词搜索索引
/compaction-fidelity purge --yes               删除当前工作区 .dsh/compaction-fidelity
/compaction-fidelity architecture check | read | create | refresh | status | verify | update | include | exclude | manage | unmanage [scope] [summary|pattern]
```

### 模型工具

- compaction-fidelity-brief：返回项目简览（模块、架构文件、命令、数据库结构）。
- compaction-fidelity-lookup(file 或 query, limit)：返回锚点或搜索结果；适合编辑陌生文件前、压缩后使用。
- compaction-fidelity-architecture(action, scope, summary, changedFiles)：检查、读取、创建或追加更新任务文件夹内的 ARCHITECTURE.md；创建前必须先询问用户。

## 5. 安装后的目录

```text
<workspace>/.dsh/compaction-fidelity/
  project.meta.txt       项目元信息/语言统计
  project.code.txt       模块图
  project.arch.txt       架构级文件
  project.database.txt   schema/migration 锚点
  PROJECT.md          项目简览
  anchors.md          文件到架构锚点的映射
  index.json          机器索引
  anchors.json        机器锚点表
  baseline.json       文件哈希基线
  state.json          当前工作区的运行时开关
```
  fidelity-calibration.json  补偿前后指纹校准样本
  architecture-reminders.json 架构刷新提醒退避状态

只把经过审查和脱敏的证据文件提交到 Git。旧版本（至 1.25）的 `fingerprints/*.json` 可能含有缺失的精确值与约束原文；新版本只写聚合指标，但导入的校准样本仍可能带额外字段。公开仓库不要无审查地放行整个 `.dsh/compaction-fidelity/`。

## 6. 安全与边界

- 索引与指纹计算在本地进行，不读数据库凭据、不执行仓库代码；摘要生成通过 DSH 配置的 LLM 服务，可能调用远程模型。
- 索引是启发式结果：入口、架构文档、高 fan-in 是检索锚点，不保证 100% 语义正确；可用 /compaction-fidelity reindex 重建。
- 插件工具与命令在 DSH Host 进程运行，不构成独立沙箱；插件自身负责路径校验和文件操作边界。
- 覆盖内置 preset 是按 id 的整段 config 覆盖；DSH 升级后内置 preset 结构变化时需要重新生成 patch。
- `350k` 等固定档在达到有效绝对阈值时触发；`800k` 会受窗口及输出预留封顶。`80%` / `full` / `1m` 采用官方动态压力线。

## 7. 开发

```powershell
node --test test/*.test.mjs
npm run check
# 针对另一份 DSH 安装重新生成 patch：
node scripts/generate-preset-patch.mjs
```

| 文件 | 职责 |
|---|---|
| src/index.mjs | 宿主插件：命令、工具、索引调度、锚点记录与注入 |
| src/engine.mjs | Preset 内压缩引擎：继承 BasicCompactionEngine，绝对阈值 + 自定义 summarize |
| src/state.mjs | 阈值解析、运行时状态、持久化 |
| src/range.mjs | 保留尾部 + tool-pair 平衡的压缩区间选择 |
| src/summarizer.mjs | 语言检测、精确值账本、摘要指令 |
| src/project-index.mjs | Compaction-Fidelity 扫描、索引、锚点、简览、搜索、verify |
| scripts/generate-preset-patch.mjs | 从 DSH 内置 preset 生成覆盖 patch |
| src/fidelity-calibration.mjs | 补偿前后指纹度量、分语言校准与样本持久化 |
| src/reminder-state.mjs | 架构刷新提醒退避与持久化状态 |
| src/architecture-io.mjs | 锁 + CAS + AtomicWrite 事务原语 |
| src/architecture-changes.mjs | Git/hash/mtime 变更检测与语义变化分 |

MIT License；上游 AOCI-CODE 的相关版权与许可见 THIRD-PARTY-NOTICES.md 与 licenses/AOCI-FSL-1.1-MIT.txt。


### 配置优先级

生成的 bundle patch 中，宿主行只放功能开关与索引参数；压缩阈值、保留量、摘要语言、摘要上限等默认值在 preset 的 engine 行。运行时 /compaction-fidelity threshold、/compaction-fidelity language 等命令设置的是进程级覆盖，会持久化并优先于 engine 行；这样直接修改 preset 里的 engine 配置不会被宿主默认值覆盖。


如果本机安装了 DSH Desktop，可运行 `npm run verify:local`：脚本会临时链接 DSH 的 node_modules，验证 engine 构造、宿主插件注册、摘要指令与绝对阈值区间选择，然后清理链接。


TESTBOX
└────DSH 前缀────┘ └插件本体┘


## 8. 版本命名规范

插件版本与适配的 Harness 版本解耦。Harness 兼容性由精确的 `@deepseek-ai/dsh` peer 声明。

- 当前版本：`0.3.0`
- 适配 Harness：`@deepseek-ai/dsh@0.2.0-rc.2`（社区 DSH Desktop 2.0.17）
- 历史预发布版本使用 `<harness-version>.plugin.<n>`，例如 `0.2.0-rc.2.plugin.1.25`
- Harness 兼容范围变化时，插件 SemVer 继续单调递增，更新 peer 并在 CHANGELOG.md 记录映射；不再把 Harness 版本写进插件版本号

## 9. 语言机制：官方为什么是英文，本插件为什么改

官方 0.2.0 的压缩指令要求使用英文工程 prose，通常有四个原因：

- 跨模型与跨 Agent 一致性：英文摘要结构是事实上的 canonical form。
- 技术文本 token 特性：路径、命令、代码、错误串多为英文，英文叙述与精确值混排更稳定。
- 提示词与工具目录以英文为主：系统提示、工具描述、checkpoint preamble 都是英文。
- 历史与生态原因：DSH 面向全球模型路由，先固定英文模板是较小实现成本。

但对中文会话，官方形式有两个真实问题：

1. 用户约束与纠正先被翻译成英文，模型再从英文理解，存在双重翻译损耗。
2. 摘要模型可以重述用户原话，精确措辞、语气强度、否定范围容易丢失。

本插件默认保留官方事实标准，只增加会话语言跟随与精确值保真：

- auto：中文会话中文 checkpoint，零翻译。
- en：英文 canonical 叙述，但用户原话、路径、命令、错误串、标识符、数值原样保留。
- bilingual：英文结构加中文关键约束。

Compaction-Fidelity 的 Localization contract 也支持这一判断：en-US 与 zh-CN 是两种完整官方 locale；切换 locale 时路径、标识符、API、代码事实不翻译，只重新生成自然语言字段。

## 10. Compaction-Fidelity 再次审计：新增、保留与不采用

再次审计 Compaction-Fidelity-CODE 后，有价值并已并入的内容：

| Compaction-Fidelity 机制 | 本插件的实现 |
|---|---|
| project.txt Root Manifest，用 #Volume: 声明认知集合 | 新增 .dsh/compaction-fidelity/compaction-fidelity.txt，声明 meta/arch/code/database 四个 Volume |
| Meta 约定：Locale、ID、配额、创作合同 | 在 project.meta.txt 写入 locale、ID scheme、配额、admission 说明 |
| 稳定对象身份 code:path | 锚点、brief、索引统一使用 code:path canonical identity |
| FRAS 的 F/R/A/S 语义结构 | 本版借用 ID、Relations、Quota 思想；F/R/A/S 语义条目暂不机器代写，避免低质量伪语义 |
| Database Cognition 的表级认知 | 确定性提取 CREATE TABLE、Prisma model 等表名，写入 project.database.txt，标记为 file-level evidence |
| Baseline/Verify/Drift | 保留 baseline.json 与 /compaction-fidelity verify |
| Locale 对等与标识符不翻译 | 实现 auto/en/zh/bilingual 与 verbatim ledger |
| 压缩后重新读取认知，不信任摘要 | 摘要规则明确：架构事实只是 locator，恢复后应重读 project.txt / PROJECT.md |
| Overview 分块交付 | 保留 compaction-fidelity-brief 6000 字符上限；后续可加 cursor 分块 |

明确不采用：Agent 逐条写 FRAS Whole-Index、Go 治理状态机、Attestation/Recovery/Ledger、MCP Server、实时数据库连接。Managed Scope observe、phase_transition 自动推断、token 级 Whole-Index 预算也不纳入路线图。它们成本高，并会让索引本身变成新的上下文负担。

## 11. 阈值有效范围

当前已落盘硬校验：

- 阈值必须是 (0, 1M] 范围内的正整数；0 非法，超过 1,048,576 非法。
- 256k、350k、512k、800k、1m、full、auto 均合法；600k 仍作为 CLI 兼容值保留。
- 80%/1m/full/auto 表示走官方窗口线，实际触发点为 min(0.8×窗口, 窗口减预留输出再减 headroom)。
- retainTokens 必须小于阈值；engine 载入时校验，非法配置会 fail loud。
- 运行时 /compaction-fidelity threshold 300000、/compaction-fidelity threshold 80% 合法；阈值 0 与 2m 返回错误。输入区自定义按 K 解析，仅接受 256<值<800（K，即 257–799）。

## 12. 压力/调度与安全加固（已落盘）

调度：

- 宿主插件已启动时，engine 运行时策略走进程内 global state 快路径，不再每步同步读 state.json。
- compactIfNeeded 在 Compaction-Fidelity 启用时直接返回 null，官方 listener 不再重复测量与解析模型。
- 绝对阈值 listener 先 measure，低于配置阈值就不 resolveModelInfo。
- 模型信息增加 60 秒 TTL 缓存。
- queueIndex 只在索引缺失时自动构建；文件修改只更新 anchors，/compaction-fidelity reindex 才强制全量。
- tools/result 不再触发全量索引重建。

安全：

- indexDir 必须是安全工作区相对路径；拒绝 ..、盘符与 symlink/junction。
- baseline.json 路径在 verify 时走 isSafeRelativePath 与 joinWorkspace 守卫，拒绝路径穿越。
- .env、*.key、*.pem、id_rsa、credentials/secrets 等敏感文件不进入索引与 baseline 哈希。
- /compaction-fidelity purge --yes 校验目标在工作区内且不是符号链接。
- 索引以路径、类型、导入关系、哈希和表名为主；本地扫描不联网、不读数据库凭据。摘要仍通过 DSH 的 LLM 服务生成。

如果本机安装了 DSH Desktop，可运行 npm run verify:local：脚本会临时链接 DSH 的 node_modules，验证 engine 构造、宿主插件注册、摘要指令与绝对阈值区间选择，然后清理链接。


## 13. 默认启用与临时关闭语义

本插件设计为安装即全局默认启用：宿主行 enabled=true、engine 行 enabled=true、bundle patch 覆盖内置 standard/cordis，新会话默认使用 Compaction-Fidelity engine。

手动关闭分三档：

- /compaction-fidelity off：临时关闭，当前进程/会话立即生效，不写入持久状态；重启 DSH 或执行 /compaction-fidelity on 即恢复全局默认启用。
- /compaction-fidelity off --persist：持久关闭，重启后仍保持关闭，直到 /compaction-fidelity on。
- scripts/master-switch.mjs disable：加载期硬关闭，创建 .dsh-compaction-fidelity/disabled；重启后宿主插件不注册、engine 回退官方；enable 恢复默认启用。

/compaction-fidelity on 总会把状态写回 enabled=true，因此插件启用时保持全局默认启用。


## 14. 输入区压缩线控件

控件通过 DSH 官方 `conversation.input.right` 槽位注册，位于模型/推理强度选择器左侧（不再注入 ContextMeter DOM）：

- `256K` / `350K（插件默认）` / `512K` / `800K（官方默认）` 四个预设；`350K` 为插件默认，`800K` 为官方默认；
- 自定义输入框，单位 K，合法值 `256 < 值 < 800（K，即 257–799）`；
- 当前实际设置显示在触发按钮上；点击展开不调用工具，只有更改选项时调用一次 `/compaction-fidelity threshold`；只有最后一次成功设置的选项保持高亮；
- 临时关闭/启用不在该控件内，统一使用 DSH 插件管理器或 `/compaction-fidelity off` / `/compaction-fidelity on`。

实现说明：客户端调用 remote `/compaction-fidelity threshold`；插件管理器禁用 bundle 时该槽位贡献与宿主命令一并卸载，满足即插即用、即关即停。

安装或更新后需要重启 DSH Desktop，客户端模块才会加载。








---

## 15. 结构化架构级回查文档（ARCHITECTURE.md）

- 文件位置：任务相关文件夹内，默认文件名 `ARCHITECTURE.md`；
- 文档格式：Markdown + DSML 标签 + 内嵌 JSON 代码块；
- 用途：记录架构坐标、行为约束、关键决策、压缩后回查线索；
- 生成方式：
  - 插件检测用户任务中的候选文件夹；
  - 如已有多个候选，按任务语义选择主项目文件夹；有歧义时询问用户；
  - 如果 `ARCHITECTURE.md` 不存在，插件会主动询问用户是否创建；
- 更新方式：
  - 默认只追加，不覆写原介绍；
  - 每段更新以 `<architecture_update>` + JSON 块追加到文件末尾；
  - 最近一次更新位于最末尾，以最新内容为准；
  - 可写入 AOCI 风格缩写/模块约定，便于用少量字母定位模块；
- AOCI 风格认知刷新门控：
  - 对齐状态：`/compaction-fidelity architecture status <scope>`；
- **Managed Scope 规则**：`architecture include <scope> <glob>` 与 `architecture exclude <scope> <glob>` 把 include/exclude 过滤器写入 `.dsh/compaction-fidelity/architecture-scopes.json`；规则同时作用于生成文档、baseline、变更检测与锚点注入。
- **架构文档 Attestation**：每份 ARCHITECTURE.md 带 revision、structureHash、updateLogHash、entryCount；`architecture status` 与 `architecture verify` 会报告不一致。
  - 语义阈值：scope 内自上次文档更新后的语义变化分达到 `architectureRefreshThreshold`（默认 30）时，插件会在 pre-step 注入刷新提示；单文件变更达到 `architectureSingleFileChangeThreshold`（默认 300）时强制触发；
  - 上下文压缩：压缩输入引用到 ARCHITECTURE.md 时，摘要指令会带 `<cognition_refresh trigger="context_compaction">`，并按引用文档、已登记 scope、根文档的优先级收集；
  - 结构刷新：`/compaction-fidelity architecture refresh <scope>` 重建模块图、入口点与命令锚点，同时保留原有 Update Log；
  - 已登记 scope 记录于 `.dsh/compaction-fidelity/architecture-scopes.json`，可跨会话复用；
  - 写入安全：跨进程锁 + CAS + 同目录 AtomicWrite，冲突明确报错；
  - 变更检测：Git status/diff 优先，内容 hash 其次，mtime 仅作降级；
  - 语义变化分：文件权重 + 单文件大变更强制触发；
- 工具：`compaction-fidelity-architecture`，动作为 `check | read | create | refresh | status | update`；
- 总开关关闭时不检测、不询问、不创建。

## 参考项目与文章思路

> 原报告未附完整 URL/DOI；正式引用请以对应论文或项目最新版本为准。

### Tokenizer 与 CJK

- openclaw：chars/4 低估 CJK 约 2–4 倍，建议约 1 token/char。
- Qwen Code：CJK 密集内容 token 被低估 39–54%。
- 社区实测：cl100k_base CJK 约 1.0–1.7 token/char；DeepSeek/Qwen 原生约 0.6–0.8；英文约 0.25。
- 本插件取 0.8 token/char（保守偏高），provider usage 锚点优先。

### 压缩损失、注意力与治理

- Lost in Compaction：5% 压缩损失约 7pp 召回；50% 压缩区域召回降至 0–7%。
- 关键词通过 grep 可找到 82–93%，但模型未必使用；未触碰区域召回 68%→39%。
- 温度 0 时同一对话召回率测量跨度可达 14 倍；瓶颈在注意力容量。
- Lost in Compression：0.33 keep-rate 下英文保留 57–62%，立陶宛语 10–24%，中文接近无。
- token premium 与压缩惩罚解耦；学习型压缩器存在英文监督偏差。
- LLMLingua-2 / XLM-R / mBERT 讨论：英文监督不能充分利用多语言骨干。
- Governance Decay：压缩静默丢弃 runtime policies / standing instructions。
- 1,323 episodes 中违规率 0%→30%（最高 59%）；软策略衰减约为硬规则 8.3 倍。

### DSH 与生态插件

- DSH Discussion #5123：外部报告称官方阈值按完整窗口缩放；需对照当前源码验证（当前源码已含 min(W×ratio, W−O−H)）。
- DSH minimal preset：默认无压缩后端，长任务会直接撞上限。
- dsh-infinite-context：动态阈值 + 多层记忆，按真实 CTX 推导。
- dsh-compaction-threshold：per-session 压缩阈值，Web composer 可调。
- dsh-context-checkpoint：达限→总结落盘→压缩→注入上下文开头。
- dsh-asc：模型自主决定压缩时机/对象，带可逆 tool-result 投影。
- dsh-compaction-policy：capped output reservation + no-progress retry guards。

### 上游项目与许可

- AOCI-CODE：项目认知、架构索引、baseline/verify 与文本索引格式的上游概念参考。
- 归属与许可见 THIRD-PARTY-NOTICES.md 与 licenses/AOCI-FSL-1.1-MIT.txt。
- 本插件为独立 Node 实现，未复制 Go 源码；本项目代码采用 MIT 许可。










### 交互成本与注入位置

- What Does Context Compression Cost an Agent?：压缩可能显著增加 reacquisition cost；检索工具调用增加，完成率未必下降。回归门禁应纳入检索调用次数。
- dsh-context-truth：压缩指令应禁止记录模型自身对上下文压力的猜测，避免错误信念跨压缩存活。
- dsh-context-checkpoint：把总结注入为静态上下文（prompt 前部）而非动态补偿块，可能更有效，需本地 A/B。








## 15.1 ARCHITECTURE.md 的可靠创建方式

- 回复 创建 可以 好 后，插件会在下一次 pre-step 直接创建对应文件夹的 ARCHITECTURE.md；
- 也可执行 /compaction-fidelity architecture create 命令直接创建；
- 生成内容按目标文件夹过滤模块、文件与数据库锚点；
- update 动作仍然只追加，不覆写原介绍。

旧指纹迁移默认只读。apply 会在工作区内创建独占备份；备份仍含原文，不能直接公开。工具检测嵌套 final-fidelity 精确值，拒绝链接、硬链接及复用备份目录，不修改校准账本。真正的 basic/pro/fidelity 对照见[配对评测协议](docs/paired-evaluation-protocol.zh.md)，目前尚未执行；保真 gate 只报告诊断，不阻止压缩。

