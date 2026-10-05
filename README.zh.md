# dsh-compaction-fidelity

> 项目名与包名：`dsh-compaction-fidelity`；定位：DSH 上下文压缩保真层。

面向 **DeepSeek Harness 0.2.0-rc.2** 的 Profile Bundle：跨语言压缩保真（fingerprint）+ Compaction-Fidelity 项目认知/架构级回查锚点 + 动态压缩线。

## 项目目的

让 DSH 在长时间、大仓库、中英混合和工具调用密集的会话中，把压缩摘要当作有损索引而不是完整 transcript。

## 核心理念

官方 compaction 保证会话还能继续；本插件保证关键事实、行为约束和项目架构能跨过压缩边界继续存活。

## 适宜人群

DSH Desktop 长会话用户、大仓库或多模块项目、中文或中英混合工作流、工具调用密集且上下文增长快的会话。

## 学习参考与协议

学习参考与选择性集成说明见 REFERENCES.md；安全模型见 SECURITY.md；发布记录见 CHANGELOG.md。本项目代码采用 MIT 协议。


- **动态压缩线**：输入区可选 `256K / 350K / 512K / 800K（官方默认）` 预设；插件默认 350K；自定义范围 `256 < 值 < 800（K）`；`800K` 在 1M 窗口会按官方 80% 线（含输出预留）自动封顶。350K 是开发者实际个人体验后体感舒适、并观察 DeepSeek V4.1 Flash 上下文自动压缩线相关项目后认为合理的设置；如有不认同，可在本项目内自行修改自定义有效值。K 表示 1000 tokens，与 DSH ContextMeter 显示一致。
- **Compaction-Fidelity 项目认知**：确定性扫描工作区，生成随 Git 版本化的 `.dsh/compaction-fidelity/` 索引（模块图、架构文件、命令、数据库结构锚点）。
- **架构级回查锚点**：修改文件后把该文件的架构级依赖/文档/测试/迁移写入 `.dsh/compaction-fidelity/anchors.md`，并在下一步注入上下文；压缩摘要中也带锚点。
- **原文不丢失**：锚点只是指针；原始文件与 session log 仍在。`compaction-fidelity-lookup`、`compaction-fidelity-brief` 可在压缩后精确回查。
- **总开关/总闸**：安装 bundle 即整体启用；卸载即恢复内置 preset；运行时 `/compaction-fidelity on|off` 在插件压缩与官方压缩之间整体切换。
- **跨语言保真指纹**：压缩前冻结精确值、CJK 二元语义单元与结构指纹；压缩后比对并输出 L0–L3 分级，缺失精确值会自动追加 `fidelity_compensation` 补偿块，并写入 `.dsh/compaction-fidelity/fingerprints/`。
- **语言策略**：默认 `auto` 跟随会话语言，避免翻译两次；`en` 模式英文写摘要，但用户原话与精确值原样保留、不翻译。

> 本插件按 DSH Desktop 0.2.0-rc.2 生成并锁定 peer 版本。0.1.5-rc.3 的 preset / 压缩 API 不同，不能混用。
>
> **DSH runtime 修复**：DSH Desktop 0.2.0-rc.2 的 `minimal` preset 默认没有任何压缩后端；`@deepseek-ai/dsh-token-meter` 固定按 4 字符/token 估算，中文会被严重低估。安装本插件后请执行一次（DSH 升级后需重新执行）：
>
> ```powershell
> node scripts/patch-dsh-runtime.mjs
> node scripts/patch-dsh-runtime.mjs --restore   # 可选回滚
> ```
>
> 脚本会给 `minimal` preset 挂上官方 `compaction-basic` 安全网（`/compact`、工具结果修剪、溢出恢复均可用），并把 token-meter 改为 CJK 感知估算（ASCII 仍 4 字符/token；provider usage 锚点仍优先）。Compaction-Fidelity bundle patch 现在覆盖 `standard` / `cordis` / `ptc` / `minimal` 四个 preset。安装脚本会强制刷新 profile 里的 `file:` 依赖并校验 `dsh.client` + `lib/client.js`，避免客户端 UI 旧副本不生效。


## 为什么值得用（简明版）

- CJK 计量：4 字符/token 严重低估中文，本插件用 0.8 token/char 保守估计。
- 有效预算：显式先算 `W - O - H`，再比较压缩线；与官方 min(W×ratio, W−O−H) 语义对齐，并便于诊断估算误差。
- 保真量化：精确值 ledger + CJK bigram + L0–L3 + 自动补偿。
- 压缩后回查：项目认知索引 + brief/lookup + 架构锚点注入。
- 官方安全网：minimal 也注入官方压缩；插件异常自动回退。
- 本地可审计：文本索引与指纹可随 Git 版本化，热路径无神经嵌入。
- 差异化：生态已有阈值/checkpoint 插件；本项目聚焦中英混合压缩损失量化与补偿。

## 设计理念展开

- 摘要是有损索引，不是完整 transcript。
- 精确事实逐字保留，不翻译。
- 确定性抽取优先于概率猜测。
- 结构/锚点比全文复制便宜。
- 官方安全网永远保留；关闭时值保留但不生效。
- 每次压缩都有信息损失；早压缩是安全与近期上下文的权衡。

## 已知边界与验证方向

- 指纹召回与下游 QA 相关性未 A/B；L0–L3 阈值需校准。
- 补偿块/锚点可能稀释注意力；已实现 2048 token 软上限与类别优先级，仍需 A/B 校准最优值。
- zh/en/bilingual 摘要策略缺对照；约束 ledger 尚未覆盖。
- 不建议默认降低 256K 输出预留；provider 约束仍成立。
- 256K/350K/512K 自定义线需验证安全收益与信息损失的权衡。

## 1. 安装、卸载与总开关

### DSH Desktop 0.2.0-rc.2

1. 在 Desktop 插件管理页安装本 bundle（本地路径，或发布后的 npm 包 `dsh-compaction-fidelity`）。
2. bundle 加入 `dsh.profile.bundles` 并应用 `cordis.patch.yml`：
   - 插入宿主插件行 `compaction-fidelity`（工具、命令、索引、锚点注入）；
   - 按 id 覆盖内置 `preset-standard` 与 `preset-cordis`，把 `compaction-basic` 行替换为 `dsh-compaction-fidelity/engine`。
3. 新建会话使用覆盖后的 preset；已存在会话保持启动时组合，不会中途换引擎。

### CLI profile

```powershell
dsh plugin --profile web add <path-to-dsh-compaction-fidelity>
dsh plugin --profile web remove dsh-compaction-fidelity
```

卸载后覆盖层消失，内置 `standard`/`cordis` 自动恢复官方压缩；重启后新会话恢复官方行为。

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
- 350k/800k/80%/full/1m 模式不自己做前缀压缩，交给官方按 80% 窗口线与输出预留计算触发点。

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
| compactionRetries | 1 | 阈值仍高时的额外压缩次数 |
| ledger | true | 确定性精确值账本 |
| anchors | true | 摘要中注入 Compaction-Fidelity 简览与锚点 |
| anchorsPerFile | 8 | 每文件最多锚点数 |
| indexDir | .dsh/compaction-fidelity | 索引目录（工作区相对路径） |

### 运行时命令

```text
/compaction-fidelity threshold 256k
/compaction-fidelity threshold 512k
/compaction-fidelity threshold 800k
/compaction-fidelity threshold 300000   # 300K 等价
/compaction-fidelity retain 65536
/compaction-fidelity language auto | zh | en | bilingual
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
/compaction-fidelity architecture check | read | create | update [scope] [summary]
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

建议把这些文件提交到 Git。若项目 .gitignore 忽略了 .dsh，需要显式放行 .dsh/compaction-fidelity。

## 6. 安全与边界

- 本地优先：不联网，不读数据库凭据，不执行仓库代码。
- 索引是启发式结果：入口、架构文档、高 fan-in 是检索锚点，不保证 100% 语义正确；可用 /compaction-fidelity reindex 重建。
- 工具与命令只在 DSH 进程内运行，受 DSH 权限与审批体系约束。
- 覆盖内置 preset 是按 id 的整段 config 覆盖；DSH 升级后内置 preset 结构变化时需要重新生成 patch。
- 350k/800k/80%/full/1m 不会在固定 token 处压缩；触发点由官方 80% 窗口线与输出预留、headroom 共同决定。

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

MIT License；上游 AOCI-CODE 的相关版权与许可见 THIRD-PARTY-NOTICES.md 与 licenses/AOCI-FSL-1.1-MIT.txt。


### 配置优先级

生成的 bundle patch 中，宿主行只放功能开关与索引参数；压缩阈值、保留量、摘要语言、摘要上限等默认值在 preset 的 engine 行。运行时 /compaction-fidelity threshold、/compaction-fidelity language 等命令设置的是进程级覆盖，会持久化并优先于 engine 行；这样直接修改 preset 里的 engine 配置不会被宿主默认值覆盖。


如果本机安装了 DSH Desktop，可运行 `npm run verify:local`：脚本会临时链接 DSH 的 node_modules，验证 engine 构造、宿主插件注册、摘要指令与绝对阈值区间选择，然后清理链接。


TESTBOX
└────DSH 前缀────┘ └插件本体┘


## 8. 版本命名规范

采用最新适配的 DSH 版本号作为前缀，用 .plugin.x.y 标识插件本体迭代。

```text
0.2.0-rc.2.plugin.1.0
```

- DSH 前缀当前为 0.2.0-rc.2，表示只适配该 DSH 版本区间。
- 插件本体为 1.0；功能迭代递增为 1.1、2.0。

- DSH 前缀变化时，例如升级到 0.2.0-rc.3，插件本体从 1.0 重新开始：0.2.0-rc.3.plugin.1.0。
- 这是合法 semver prerelease 版本，GitHub tag 可用同名字符串。

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

明确不采用：Agent 逐条写 FRAS Whole-Index、Go 治理状态机、Attestation/Recovery/Ledger、MCP Server、实时数据库连接。它们成本高，并会让索引本身变成新的上下文负担。

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
- 索引只保存路径、类型、导入关系、哈希与表名，不保存文件内容；插件不联网、不读数据库凭据。

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
- 工具：`compaction-fidelity-architecture`，动作为 `check | read | create | update`；
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
