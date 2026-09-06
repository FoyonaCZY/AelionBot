# Hermes 风格的精简 Harness

设计版本：0.4 · 基准日：2026-09-05 · 适用产品：OpenGrokBot / AelionBot 本地版

当前落地机制和多项目源码对照见 [Harness 0.4 实现说明](Harness-Implementation-v04.md)。本文中的较大目标不能直接当作已实现功能清单。

这是本项目拟实施的 Harness，暂称 Hermes Lite；不是 Hermes 官方分支，也不是已经完成的运行时。它替换此前“通用 Native Harness + 首版 Codex 适配器”的优先级：首版围绕 Hermes 的长期记忆、技能复用、上下文压缩与历史回查建立一个统一内核，Codex 不作为首版必需依赖。

产品约束不变：Windows 优先；应用维护唯一固定 Linux 工作电脑；用户本机为另一个可授权执行位置；Bot/Computer 多对多；Bot 可以直接交流、在协作房间交接工作。任务、记忆、技能和压缩记录保存在本机 agentd 的持久存储中，不随 VM 关闭或重建丢失。

## 1. 参考依据与取舍

本次用官方仓库 HEAD 固定到 `b0ab2e163a50d4e6c36507eba955a6067fde6abc`，阅读了 ContextEngine、压缩器、微压缩、历史检索、技能读取/管理和技能 lint 的部分关键实现。记忆快照与后台学习的行为同时参照官方文档。没有运行 Hermes 基准，也没有完成全仓库审计；不据此宣称压缩质量在所有任务上优于其他 Harness。

已取得源码的文件大小与 SHA-256 记录在 [参考文件清单](hermes-reference-manifest.json)。上游代码只在临时目录阅读，没有并入应用或执行。

| 已核对的 Hermes 机制 | 精简版的处理 |
|---|---|
| [有界持久记忆与会话起始快照](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) | 保留短记忆、稳定前缀和按需事实查询；用户纠正、撤销和隐私删除立即生效 |
| [技能按目录、正文、支持文件逐层加载](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/) | 保留渐进加载、版本固定和 skill_manage；增加 Bot/项目权限范围 |
| [可替换 ContextEngine](https://github.com/NousResearch/hermes-agent/blob/b0ab2e163a50d4e6c36507eba955a6067fde6abc/agent/context_engine.py) | 保留 assemble/estimate/prune/compact/restore 边界，首版只有一个实现 |
| [工具输出裁剪、保留首尾、结构化摘要、精确锚点与历史恢复提示](https://github.com/NousResearch/hermes-agent/blob/b0ab2e163a50d4e6c36507eba955a6067fde6abc/agent/context_compressor.py) | 保留分层处理；压缩对象是上下文视图，原始记录不被覆盖 |
| [按 exchange 更新滚动摘要的微压缩，默认关闭](https://github.com/NousResearch/hermes-agent/blob/b0ab2e163a50d4e6c36507eba955a6067fde6abc/agent/micro_compaction.py) | 首版不做逐轮 LLM 微压缩，先控制缓存破坏、额外延迟和摘要漂移 |
| [会话搜索、定位原消息、读取邻近记录](https://github.com/NousResearch/hermes-agent/blob/b0ab2e163a50d4e6c36507eba955a6067fde6abc/tools/session_search_tool.py) | 保留带来源的搜索和展开；限制到 Bot 有权读取的历史 |
| [技能修改入口](https://github.com/NousResearch/hermes-agent/blob/b0ab2e163a50d4e6c36507eba955a6067fde6abc/tools/skill_manager_tool.py)与[结构检查](https://github.com/NousResearch/hermes-agent/blob/b0ab2e163a50d4e6c36507eba955a6067fde6abc/tools/skill_linter.py) | 保留统一写入服务、校验和可选审阅；不把 lint 通过当作任务验证通过 |
| [后台自我改进与写入策略](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/#background-review-notifications-displaymemory_notifications) | 做成有预算的异步 Learning Job；默认私有沉淀，共享单独管理 |

不引入首版：多消息渠道 Gateway、远程沙箱适配、技能市场同步、外部记忆供应商、复杂知识图谱、自动技能集群整理、RL 训练、无限递归子 Agent。若复用 Hermes 源码，保留其 [MIT 许可证与版权声明](https://github.com/NousResearch/hermes-agent/blob/b0ab2e163a50d4e6c36507eba955a6067fde6abc/LICENSE)，不直接拷贝全部提示词及历史兼容分支。

## 2. 六个核心模块

```text
用户输入 / Routine / Bot 邮箱
             ↓
       RunController
             ↓
       ContextManager ←→ HistoryStore
         ↑       ↑
   MemoryService  SkillService
             ↓
         AgentLoop ←→ ModelAdapter
             ↓
         ToolGateway → 工作电脑 / 我的电脑 / 连接器
             ↓
      结果、产物、验证事件
             ↓
        LearningWorker → 记忆变更 / 技能新版本
```

六个模块是 AgentLoop、ContextManager、MemoryService、HistoryStore、SkillService、LearningWorker。已有的 RunController、ToolGateway、Computer Router、资源租约、产物服务和预算账本继续复用，不在 Harness 内再做一套。

| 模块 | 责任 | 首版边界 |
|---|---|---|
| AgentLoop | 模型交互、工具决定、进度、停止/等待/验证 | 一个 Bot 默认一个活跃修改型 Run；不要求所有任务先展开大计划 |
| ContextManager | 上下文组装、预算、裁剪、压缩与恢复 | 一个可替换实现，普通任务使用同一条路径 |
| MemoryService | 有界事实、用户偏好、作用域、修订和删除 | SQLite 主记录，Markdown 是可读投影/导出 |
| HistoryStore | 原始事件、消息、工具记录、阶段摘要和搜索 | 本地存储与文本索引；大内容放 Blob Store |
| SkillService | 技能发现、加载、版本、来源及写入 | 小目录起步，按需加载，不把所有技能正文注入前缀 |
| LearningWorker | 从已完成或关键阶段的工作提取可复用知识 | 有限上下文与工具，无桌面/任意 shell/连接器写入能力 |

AgentLoop 中不应混入 UI、Windows API、VM 生命周期和文档渲染实现。学习任务可以提出技能脚本，但执行验证必须由现有 ToolGateway 在有授权的 Workspace 完成。

## 3. 五种状态各自保存

| 状态 | 例子 | 存放与读取 |
|---|---|---|
| 活跃任务事实 | 目标、当前约束、待验证项、已发生的外部动作 | TaskState，始终以当前版本读取，不靠摘要恢复 |
| 短期上下文 | 最近对话、最新工具结果、当前桌面观测 | ContextView，受 token 预算管理，可重建 |
| 持久记忆 | 用户格式偏好、项目约定、已核实的环境事实 | MemoryFact，按用户/Bot/项目作用域取小快照 |
| 程序性技能 | 制作月报、验证工作簿、处理某类构建错误的流程 | 版本化 SKILL.md + references/templates/scripts，按需加载 |
| 历史经验 | 某次任务发生了什么、为什么失败、最终用了哪个版本 | 原始事件 + 不可变 EpisodeSummary，可检索与展开 |

持久记忆不等于全部历史摘要，技能也不应变成一份越来越长的事故记录。用户的权限 Grant 单独保存，不能从“记住这条规则”或某份技能正文中生成。

本次讨论就是一个测试样例：最初设计两种部署，随后改为仅本地，再改成固定一台 VM。TaskState 保存当前决定；旧建议留在历史里。压缩和学习都不能把旧服务器方案重新变成活跃要求。

## 4. 一次任务的完整生命周期

1. RunController 接受用户任务、Routine 或有权委派的 Bot 请求，记录来源、Task 版本、预算和 Computer 允许范围。
2. 固定本次运行的 Bot 角色、技能版本和记忆快照，读取尚未处理的邮箱事件。
3. ContextManager 编译上下文：系统与工具契约、当前任务事实、短记忆、技能目录、历史摘要和最近完整对话。
4. 模型决定执行、等待、求助或候选完成。每个工具意图先进入持久日志，再由网关授权和执行。
5. 工具结果先完整保存，再返回受控大小的观测；对文件、日志和截图返回可重新读取的引用。
6. 完成里程碑时提交产物与检查记录。用户纠正、问题解决和技能失败产生轻量 LessonCandidate 事件。
7. 需要压缩时由 ContextManager 处理；任务不能因压缩被当作已完成或重新从头开始。
8. 候选完成进入既有验证流程，达到验收条件后交付。
9. 有学习价值时排入一个可去重的 Learning Job，异步更新记忆/技能；前台结果无需等待学习结束。

压缩前的 flush 是把已发生事件和已确认知识写入持久层，不要求临时再启动一个可能很慢的学习 Agent。即使压缩或学习失败，已保存的任务和原始证据仍可恢复。

## 5. 上下文组装与缓存

ContextView 按稳定性分层：

```text
稳定前缀
  系统规则、工具契约、Bot 角色
  本次 epoch 的短记忆与技能目录快照

当前执行状态
  当前 TaskState、用户最新约束、授权状态摘要
  已加载且本阶段仍需要的技能

可替换历史视图
  阶段摘要、精确锚点与可回查范围
  最近完整 exchanges、最新输入与工具结果
```

语义上的优先级由消息角色和来源定义，不由上面的排列位置推断。网页和其他 Bot 消息仍是带来源的数据，不能升级为用户指令。

每个 ContextEpoch 固定 memory revision、skill catalog revision 和载入版本。普通后台学习在下一 epoch 生效，减少前缀改动。用户明确纠正当前事实时追加带来源的更新，必要时重建快照；权限撤销、敏感信息删除和关键矛盾不能等到下一会话。缓存命中率服从正确性。

同一 Run 中重新取得浏览器/桌面租约后，必须刷新 observation。历史截图只可作为证据，不能作为继续点击的有效画面。

模型适配保留原生消息和 reasoning/compaction continuation；不尝试解码供应商不透明状态。首版的普通文本摘要是可移植层，换模型时用 TaskState、记忆、技能、原始可见证据重新编译上下文。

## 6. 压缩分三层

### 第一层：在工具出口控制体积

大日志、网页、表格、图片和文件正文先落盘。模型得到来源、大小、范围、摘要、错误和引用，后续可按行、页、范围或查询继续读取。摘要不能凭空声称未读取的部分已验证。

对电脑操作保留当前可用的观测；旧帧转成带时间和窗口身份的引用。对代码操作保留真实 exit code、修改版本和错误摘要；任务是否成功不能从被裁掉的文本猜测。

### 第二层：确定性裁剪，不调用模型

按资源 ID、版本和内容 hash 去除重复读取；替换过时的大工具正文；把已经不在当前阶段使用的技能正文变回版本引用。保留工具调用与结果的合法协议关系。原始工具参数、结果与签名不在存储中被改写。

一个 exchange 是模型调用与关联工具结果组成的原子组。压缩边界不能切在尚未返回的工具调用中间。供应商要求保留的原生 continuation 由 adapter 检查，不能由通用字符串裁剪破坏。

### 第三层：阶段压缩

处理流程为：

```text
确认原始范围已持久化
→ 选取最早一段完整 exchanges
→ 提取确定性锚点及当前任务事实引用
→ 辅助模型生成结构化历史摘要
→ 检查完整性、来源与实际 token 大小
→ CAS 提交新的 ContextEpoch
→ 从保留尾部继续运行
```

摘要包含已完成内容、关键决策、有效证据、失败路径、未解决事项和检索指针。当前目标、权限、文件版本、已提交操作 ID 等关键事实由程序从 TaskState/ActionJournal 绑定，不交给模型自由改写。

精确锚点优先来自结构化工具返回，如文件 hash、commit、对象 ID、工作簿及单元格范围；从文本抽取的锚点仍须过滤秘密并保留来源。锚点只是检索索引，不等于已验证事实。

正常压缩一段只调用一次辅助模型。摘要输入超出辅助模型容量时，缩小到它能完整读取的连续范围；不把抽样阅读伪装成完整覆盖。原始范围保持可回查，未覆盖部分仍留在上下文或下一轮待压缩范围中。首版不实现复杂摘要 DAG。

### 预算与初始配置

令 `C` 为模型实际上下文上限，`R` 为输出预留，`S` 为控制与下一次工具结果的余量，`B = C - R - S` 为本轮输入安全预算。估计值要包含工具 schema、图像和缓存命中 token；缓存便宜不代表不占窗口。

初始建议在约 `0.5B` 时检查裁剪，约 `0.6B` 时考虑阶段压缩，达到 `0.85B` 时强制在继续推理前释放空间。尾部以 token 预算保留完整 exchanges，初始上限可取 `min(12K, 0.2B)`；摘要目标可取 `min(6K, 0.1B)`。这些是本项目待测参数，不是照搬的 Hermes 默认值。

始终优先保留当前任务、最新用户约束、活跃技能、未完成工具关系和必要观测。若这些受保护内容本身超过 B，应该缩小本轮输入/任务范围或选择更大窗口，不能通过删权限规则挤进去。

### 提交和失败保护

- 压缩只创建新的上下文视图，历史事件不删除。
- 新视图携带 `through_seq`、覆盖范围、输入 hash、Task 版本和预期 epoch；并发新消息保留为尾部，用户取消/改目标会使旧候选重新校验或失效。
- 摘要为空、输出被截断、schema 不合法、引用不存在或压缩后更大时，拒绝提交；确定性裁剪可以保留，但不假造摘要成功。
- 连续无效压缩进入冷却，不每轮重复花钱；用户可显式要求再次整理。
- 压缩模型、延迟、token 成本、回查成功率和关键约束保留率都有指标。
- 不依赖滚动摘要无限传递事实；重要里程碑保留不可变 EpisodeSummary 和原始证据链接，必要时重建。

在同模型、同输入、同预算条件下评估压缩前后任务正确率，不能仅凭 token 变少判断压缩更优秀。

## 7. 持久记忆：短、可核实、可修订

Hermes 的有界记忆与冻结快照值得保留，但不能让本产品的多个 Bot 直接共写一份 MEMORY.md。这里使用 MemoryService 作为唯一写入入口，SQLite 保存事实记录和修订，按作用域生成可阅读的 Markdown 投影。

三个首版作用域：用户偏好、Bot 私有记忆、项目共享记忆。房间可以引用其项目事实和房间决策，但不自动得到成员的全部私有记忆。检索先检查权限，再选择内容；不把其他 Bot 的记忆先交给模型再要求它不要使用。

每条 MemoryFact 保存：稳定 ID、内容、作用域、事实类别、来源事件、证据等级、修订、适用条件、可选到期时间及 supersedes 关系。用户明确表达和工具核实的事实，与模型推断分开标记。来自另一个 Bot 的结论必须保留原始来源，不能反复转述后升级成用户偏好。

给模型的写入操作是 `memory.add/replace/remove`，带 expected revision 和 source refs。容量超出返回明确结果，让模型合并或移出不常用事实，不能静默丢弃旧条目。被移出提示词的事实仍可通过 MemoryService 查询，除非用户要求删除。

首轮可把总注入预算设为约 2K tokens，再按项目实测调整，不按所有语言同样的字符数估算。用户和项目事实不需要全部常驻；角色私有细节按相关性检索。

重要区别：记忆内容不是权限授予。记住“这个项目使用某个邮箱”不代表允许发送邮件。Computer ID、文件根和凭据绑定可作为受控资源引用，但可执行权限必须实时从授权服务读取。

用户纠正时更新或取代已有事实，保留必要审计来源，当前任务立即采用新版本。用户要求忘记时，停用相应事实、索引和依赖摘要/快照，阻止旧学习任务重新写回；物理历史和备份清理按明确保留策略处理，不能只删除一份 Markdown 就声称全部遗忘。

这里的撤销和删除约束后续检索、构建上下文及执行，无法追回已经发送到模型服务的请求；产品需要区分本地知识删除和外部服务的数据保留。

## 8. 技能沉淀与复用

技能目录先支持四个工作方向：资料研究、文档与表格、代码与测试、浏览器与本机应用。系统提示只给短目录或分组索引，`skills.search/list` 定位技能，`skill.view` 读取指定版本正文，再按需读取支持文件。

一个技能包包含：

```text
monthly-report/
  SKILL.md
  references/column-conventions.md
  templates/report-template.*
  scripts/transform-data.*        # 可选；有明确平台和执行能力要求
```

技能应写清适用场景、输入、前置条件、操作步骤、验证方式、已知失败与恢复。与本产品相关的元数据还包括支持的 Computer 类型、平台、工具能力、数据可见范围及验证等级。文件路径和账号不硬编码进通用技能，用项目资源映射或受控 binding 引用。

系统记录 `SkillVersion`，包括内容 hash、来源 Task、变更摘要、验证记录、可见范围和状态。运行时固定版本；后台产生新版本不替换正在执行的正文。用户显式撤回某技能或能力时停止新的调用，不能以版本固定为理由忽略撤销。

建议生命周期：`draft → active → deprecated`。自动沉淀先生成 draft；结构检查、来源核对和适用任务验证通过后，按用户已设置的学习策略启用。验证记录区别“仅源任务成功”“在独立输入复演成功”“只通过静态检查”，避免把不同强度都标成验证通过。

默认策略可以是：私有、无新增权限的技能自动保存和验证；符合规则后自动启用，并显示可撤销的变更摘要。跨 Bot/项目共享、新执行权限及高影响操作的变化需要单独匹配授权。用户不必每一条普通记忆都点确认，也不能让自动学习扩展原有权限。

不新增相似技能之前先检索已有技能；有价值的改进优先 patch 新版本。失败不会立即删除技能：先记录失败任务、环境和版本，确认是技能问题后修订。低使用率、反复失败和同类重复项先进入维护列表，不做首版复杂自动分类树。

## 9. LearningWorker：让学习形成闭环

触发条件使用有意义的事件，而非对每条消息启动一个完整 Agent：用户纠正已被解决、复杂流程首次成功、错误绕过得到验证、重复任务有稳定模式、用户明确要求记住或保存技能。

建议流程：

```text
Task / 阶段完成
→ 生成 LessonCandidate（指向原始事件和产物）
→ 空闲时合并同一任务的候选
→ 有预算的 Learning Job
→ 区分用户事实、项目事实、可复用流程、无学习价值
→ 更新已有知识或生成私有草案
→ 校验 / 必要的受控复演
→ 按学习策略启用
→ 记录下次任务是否实际复用并产生收益
```

学习 Agent 只看到固定证据快照，允许读取已获授权的记录和提出知识变更；它没有完整桌面控制、任意 shell、向外发送或递归委派能力。需要脚本测试时，提交一个显式验证子任务给既有执行系统，遵守同一 VM 的资源锁和授权。

首版每个 Bot 同时最多一个 Learning Job，按 episode ID、证据 hash 和学习策略版本去重；建议最多两次模型调用，学习总预算使用根任务预算预留的一小部分。具体 token 和费用上限在产品配置里固定，不靠提示词提醒。

在前台任务完成前预留学习子预算，或使用用户已启用的独立学习额度；任务结束后不能自行重开已经耗尽或撤销的预算。学习任务保存模型成本，用户可单独暂停自动学习。

新增用户任务优先于学习；学习可中断和重试，不影响前台已交付结果。学习任务不能以自身日志再次触发同类学习，避免无穷自我整理。它的知识写入使用 expected revision；共享事实冲突时进入显式候选，不能后写覆盖先写。

学习完成通知例如：“已记住：本项目月报使用自然月”“已更新技能：月报生成，增加空值检查”。用户可查看来源、差异、作用范围和撤销；未验证草案显示“待验证”，不算作已掌握技能。

## 10. 历史回查：让压缩可恢复

HistoryStore 保留来源事件及其稳定标识，压缩视图记录 lineage 和覆盖范围。首版提供：

- `history.search(query, scope)`：返回受权范围内的命中、事件 ID、时间和简短上下文。
- `history.read(episode_id, around_event_id, limit)`：围绕命中读取原始片段。
- `artifact.read(ref, range)`：读取相应版本的文件、日志或页图。

搜索先使用 SQLite FTS5 和元数据过滤；中文必须使用经过样例测试的分词或 n-gram 方案，不能只验证英文关键词。首版不依赖外部向量库；只有在真实跨语言/语义召回存在缺口时再增加可选向量检索。

返回结果区分原始用户消息、工具回执、模型输出和摘要。摘要是检索导航，不能冒充原始事实。已经压缩但属于当前 Run 的旧事件仍应可被找回；按 Run ID 简单排除“当前会话全部内容”会让回查失效。

默认不向学习/检索结果重复携带秘密和大附件。引用的源被撤销或删除时，依赖摘要及缓存也失效；有遗漏时返回“来源不可用”，不继续引用旧文字作为当前证据。

## 11. 多 Bot、协作房间与固定电脑

每个 Bot 有自己的 ContextManager 实例、记忆视图和技能 pin；它们可以共用底层数据库服务和唯一工作 VM。记忆的所有者是 Bot/用户/项目，不是 Computer。

房间维护共同目标、成员任务和项目知识引用。发送方交接的是产物、关键事实、来源和下一步；接收方重新编译自身上下文。发送方的系统提示、完整私有记忆、临时授权和有效桌面坐标不会随消息自动继承。

共享技能由发布操作进入项目目录，带源 Bot、来源 Task、版本和适用范围。接收方只在有权访问来源数据和相关工具时加载/使用。跨 Bot 共享流程不等于共享所有私有样例和账号资料。

同一个 Bot 在工作电脑执行脚本、再切到本机 Excel 检查时，TaskState 和记忆保持连续；计算机切换由工具调用的明确 target 和 Binding 控制。新 Computer 的 OS、会话、文件映射和工具能力需要重新读取，不能从旧记忆推断。

重要不变量：

1. 其他 Bot 的消息不能覆盖用户目标或授权。
2. 一个 Bot 的后台学习不能修改另一个 Bot 的私有知识。
3. Memory/Skill 更新与 VM 修复独立；重建唯一工作 VM 不清空已沉淀知识。
4. 压缩不会释放/授予电脑控制权，也不能恢复过期的 observation 或 lease。
5. 用户询问状态或补充细节时，保留当前 Task；只有明确取消或不兼容的新目标才改变任务生命周期。

## 12. 工程落地方式

继续采用 TypeScript 实现本地核心，Electron 提供 UI，Windows helper 和 guest 工具按既定方案实现。参考 Hermes 的边界、算法和测试场景，而不是把整个 Python Agent 包装成一个黑箱子进程后再叠一层主循环。

这个选择保留单一事务、预算、消息和授权路径，代价是需要移植相关机制并建立对照测试。若后续决定大量直接复用 Hermes Python 代码，再评估独立 Python worker；首版不同时维护两套持久会话和两套默认 Harness。

```text
packages/harness/
  agent-loop.ts
  context/
    context-manager.ts
    budget.ts
    exchange-groups.ts
    deterministic-pruner.ts
    summarizer.ts
    anchor-index.ts
    context-checkpoints.ts
  memory/
    memory-service.ts
    snapshot.ts
    mutations.ts
  history/
    history-store.ts
    search.ts
  skills/
    skill-service.ts
    loader.ts
    versions.ts
    validation.ts
  learning/
    lesson-candidates.ts
    learning-worker.ts
    activation-policy.ts
```

主要契约见 [harness-contracts.ts](harness-contracts.ts)。HistoryStore 复用原 events/blobs；MemoryService 复用 knowledge revisions；SkillService 使用不可变文件版本及数据库指针。不要给每个模块再建独立数据库。

需要新增/细化的数据包括 `context_epochs`、`context_blocks`、`episode_summaries`、`knowledge_sources`、`memory_revisions`、`skill_versions`、`skill_usage`、`lesson_candidates`、`learning_jobs` 和 `knowledge_mutations`。写入 blob 与切换 active pointer 使用原有可恢复产物提交模式。

## 13. 精简版实现顺序和验收

| 顺序 | 实现内容 | 可测验收 |
|---|---|---|
| H1 | AgentLoop、原始记录、TaskState、Memory 快照 | 同一 Bot 跨重启和跨两个 Computer 继续任务，用户当前约束保留 |
| H2 | 技能目录/加载、确定性裁剪、历史搜索 | 大日志可展开，技能正文按需载入，中文查询能找回关键来源 |
| H3 | 阶段压缩、锚点、epoch CAS、失败退避 | 多次压缩后任务不断链、工具协议合法、未知外部操作不重复提交 |
| H4 | LessonCandidate、LearningWorker、技能版本与启用 | 成功流程形成可追溯技能，下一次同类任务实际复用 |
| H5 | 项目共享知识、房间交接、撤销传播 | Bot 私有事实不串扰，共享技能有范围，撤销后旧上下文不再使用 |

重点评测用例：

- 连续修改需求后压缩，仍执行最后确认的设计，旧方案不复活。
- 保留文件 hash、commit、表格单元格等精确标识，能从摘要回查原记录。
- 压缩模型超时、截断或返回更大摘要，不覆盖可用上下文。
- 接收到新的用户纠正/取消时，正在生成的旧摘要不会覆盖它。
- 修改一条用户偏好后当前任务立即生效，下次会话不再加载旧值。
- 私有记忆与技能在多个 Bot 共享工作 VM 时不被自动合并。
- 一次报告任务学到的方法在另一份合法样例上复用，数值与版式仍通过检查。
- 学习生成的脚本无法获得源任务未授予的本机或连接器权限。
- 用户删除某项事实后，旧 Learning Job 和摘要不会把它写回来。
- 对比同模型、同任务的无学习基线，报告成功率、人工纠正次数、重复工具调用、上下文成本、学习成本和总完成时间。

H1–H3 是首个可用 Harness；H4 是长期助手形成差异的核心，应进入首版；H5 与既有多 Bot 协作一起验收。首版不以“永不遗忘”作目标，而以能持续工作、可回查、可纠正、可衡量地复用经验作为标准。
