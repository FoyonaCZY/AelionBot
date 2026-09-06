# OpenGrokBot 本地版详细设计

版本：0.4 · 设计基准日：2026-09-05 · 工作区暂名：AelionBot

本文是拟实施的产品与技术方案，不代表已有实现或已测性能。已确认：个人及小团队、本地运行、Windows 优先，之后扩展 macOS/Linux；办公与代码工作同等重要；Bot 与 Computer 为多对多关系；Bot 可以直接交流、委派和协作，也可以选择操作用户本机。最新首版范围为应用统一维护一台固定 Linux VM，不允许用户或 Bot 自行创建、克隆或导入 VM。用户看到两个执行位置：“工作电脑”和“我的电脑”。VM 内支持共享或分开的工作区/会话，独立 VM 之间的强隔离推迟到后续版本。本版不做服务器、远程控制面、多设备同步或云端常驻执行。下文数量、资源及验收阈值都是首轮工程目标，须以原型实测校准。

[交互架构图](architecture.html) · [Hermes 风格 Harness 专项设计](Harness-Hermes-Lite.md) · [领域契约草案](contracts.ts) · [GrokBot 实机观察与交互方案](GrokBot-UX-Review.md)

## 1. 推荐决策

产品定位：能持续接手工作、交付可检查成果的个人及小团队工作台。用户围绕项目、任务和产物工作，Bot 是可配置的长期角色。

1. 自建可恢复的任务控制内核，以 Hermes 的记忆、技能、历史回查和压缩机制为主要参考，实现一个精简的多模型 Harness。办公、代码和浏览器能力走同一套工具执行协议，具体见 Harness 专项设计。
2. 桌面 UI 与本地 `agentd` 后台分离。Bot、Computer、Workspace 独立建模，多对多绑定决定可使用的资源，临时租约决定谁此刻可以操作。
3. Windows 首版只验证和交付一种受管 VM Provider，当前候选为 QEMU + WHPX + Linux guest。镜像、设备、网络和资源策略由应用固定，其他 Provider 只保留未来扩展接口。
4. 模型 API、会话存储、授权网关、凭据保管与不可信工具执行环境分离。虚拟机提供运行边界，业务授权由工具网关执行。
5. 首版围绕 Hermes 风格内核完成长期学习闭环；Codex App Server 等外部引擎放到后续可选适配和对照评测，不作为首版依赖。
6. 首版采用模块化单体、SQLite 和磁盘文件。Bot 间消息、任务队列和定时任务共用本地事务日志；不引入服务器部署依赖。
7. Bot 有独立邮箱和协作房间，可以直接交流、请求帮助和交接。具体工作落为可追踪的子任务；消息触发模型运行受预算、去重与循环限制约束。
8. 首版固定两个 Computer 入口：应用维护的“工作电脑”和用户本机“我的电脑”。任务可以跨两者执行，Bot 仍然通过多对多授权关系绑定。
9. 完成状态依赖产物和检查证据；恢复依赖日志和操作回执；权限依赖显式能力和用户授权，不能只靠提示词。
10. 第一条贯穿全系统的演示：研究、文档、开发 Bot 在固定工作电脑的不同 Workspace 中交接成果，审核 Bot 从干净工作目录验证，文档 Bot 最后获准在本机 Excel 检查结果；中途强制重启后继续工作。同 VM 验证不宣称具有独立内核的防篡改隔离。

## 2. 如何对齐当前先进 Harness

“先进”不是拥有最多角色或最长 system prompt。这里采用可公开验证的能力基线，再用自己的办公与代码评测证明改进；不声称存在适用于所有模型和任务的唯一最强架构。

| 公开实现或资料 | 已核对的特征 | 本项目采用的设计 |
|---|---|---|
| [Hermes 记忆](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)、[技能](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/)与[压缩源码](https://github.com/NousResearch/hermes-agent/blob/b0ab2e163a50d4e6c36507eba955a6067fde6abc/agent/context_compressor.py) | 有界记忆快照、渐进技能加载、历史检索、分层压缩与后台经验沉淀 | 首版 Harness 的主要参考，精简渠道/部署适配，增加多 Bot 作用域和统一事务 |
| [Codex 开放 Harness 与产品集成](https://learn.chatgpt.com/blog/codex-as-a-platform) | 产品可以复用 Agent loop，同时掌握自己的界面、工具和业务规则 | 把产品模型与模型执行引擎分离，保留替换引擎的能力 |
| [Codex App Server](https://learn.chatgpt.com/docs/app-server) | 线程、turn、流式事件、审批、steering 等公开协议；部分接口和传输仍标为实验性 | 借鉴任务交互语义；通过版本固定的适配器使用，协议兼容测试先行 |
| [Anthropic Managed Agents 架构](https://www.anthropic.com/engineering/managed-agents) | 持久会话、Harness、Sandbox 分离；凭据位于执行沙箱外 | 原始事件独立保存，沙箱可重建，连接器由授权代理访问 |
| [长期任务 Harness](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | 跨会话工作需要明确进度和可接续的成果 | 阶段检查点、任务清单、下一步及未解决事项成为结构化数据 |
| [应用开发 Harness 设计](https://www.anthropic.com/engineering/harness-design-long-running-apps) | 使用明确验收标准和相对独立的评价过程改善结果 | 代码验证、文档视觉检查和事实核对独立记录，避免只让生成者自评 |
| [OpenHands SDK 架构](https://docs.openhands.dev/sdk/arch/overview) | Agent、工具和 workspace 的边界清晰 | 借鉴运行环境抽象，本版只实现本地 ComputerProvider |
| [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence)、[interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) | 持久状态与可恢复的人类介入；重入代码要考虑副作用 | 审批后可重启继续；外部操作独立记账和去重 |
| [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction)、[tool search](https://developers.openai.com/api/docs/guides/tools-tool-search) | 长上下文状态压缩和工具按需加载；原生压缩对象可能是不透明状态 | 同时维护可移植任务状态和供应商原生 continuation，避免把全部工具塞进每轮上下文 |
| [MCP code execution](https://www.anthropic.com/engineering/code-execution-with-mcp)、[Agent Skills](https://agentskills.io/specification) | 用代码组合工具并在近数据端筛选结果；技能逐层加载 | 小而稳定的工具集、受限代码执行、版本化技能与输出预算 |

这些是设计依据，不是对目标系统实现程度的证明。多 Agent、上下文压缩和复杂计划都应通过消融实验决定是否默认启用。

## 3. 产品对象和用户工作方式

| 对象 | 含义及约束 |
|---|---|
| Space | 本地资料和授权的逻辑集合。个人版自动创建，不需要注册云账号；同一 Windows 用户下不能把它当作防恶意用户的强安全隔离 |
| Project | 文档、仓库、规则、工作环境和项目记忆的集合 |
| BotProfile | 长期角色：职责、风格、默认技能、模型策略、权限上限；不等于一个进程或一台 VM |
| Conversation | 用户与一个或多个角色交流的历史；不直接承载调度状态 |
| Task | 持久工作目标，含输入、预期产物、验收标准、截止时间、预算和授权范围 |
| Run | Task 的一次执行或继续执行，具有唯一 owner、引擎和状态；可调用多个已绑定 Computer |
| Turn / Step | 一次模型交互及其决定；用于追踪、检查点和审计 |
| ToolInvocation | 一个确定的工具意图、参数摘要、执行状态和回执 |
| Computer | 可选择的执行机器；首版固定为用户本机和一台受管 Linux VM，一台机器有多个会话和工作区 |
| BotComputerBinding | Bot 与 Computer 的多对多授权边，包含能力、文件范围、可用账号和策略版本 |
| Workspace | Computer 上的项目工作目录、工具环境和可访问数据；一个 Computer 可容纳多个 Workspace |
| ResourceLease | 对具体桌面、浏览器页、仓库写入或 Office 文档的临时使用权；不等同于持久授权 |
| Channel / Message | Bot 私聊、用户参与的协作房间和持久消息；消息本身不自动授予能力 |
| ArtifactVersion | 不可变产物版本：文件、报告、补丁、预览、检查结果；带来源与哈希 |
| Grant / Approval | 持续授权与针对具体操作的确认；与聊天文本和模型记忆分开存储 |
| Routine | 由时间或事件触发的任务模板；运行时生成新的 Task/Run |

关键关系：一个 Bot 可同时绑定多台 Computer；一台 Computer 可被多个 Bot 使用；一个 Run 也可在多个 Computer 上分阶段操作。每次工具调用必须声明具体 Computer、Workspace 和需要的租约，不能靠含糊的“当前电脑”推断。增加一个 Bot 不自动增加账号权限，也不自动分配一整台虚拟机。

任务创建时默认提取：`objective`、`inputs`、`deliverables`、`acceptance_criteria`、`constraints`。模型可以补全建议，但重要约束必须保留来源；用户修改会产生新的 `spec_revision`。轻任务不需要强迫用户先填写表单。

## 4. 整体结构和职责

逻辑调用链：

```text
Desktop / Local CLI
  → Local Product API
  → Run Coordinator + Collaboration Bus
  → EngineAdapter
  → Tool & Authorization Gateway
  → Computer Router → Host Agent / VM Guest Agent
                     → Connector Service

Run Coordinator ↔ Event Store + Checkpoints + Scheduler
EngineAdapter   ↔ Context Builder + Model Provider
Tool Gateway    ↔ Grants + Action Journal + Credential Vault
Computer Router ↔ BotComputerBindings + ResourceLeases
Collaboration   ↔ Bot Mailboxes + Channels + Delegation Grants
Workspace       ↔ Immutable Artifact Store
```

图中的箭头表达逻辑调用，结果与事件沿协议返回。存储不是只能由某一个节点访问的物理拓扑；事务写入必须由协调器的受控接口完成。

| 模块 | 负责什么 | 不应拥有的能力 |
|---|---|---|
| Desktop renderer | 对话、项目、diff、文档预览、电脑接管 | Node 权限、API key、任意宿主命令执行 |
| Desktop main | IPC、文件选择、系统托盘、进程监督、连接配置 | 自行判断模型请求是否获授权 |
| agentd | 本地 API、任务、消息、调度、引擎生命周期 | 绕过 Host Agent 直接在自身进程内执行模型脚本 |
| VM broker | 固定 VM 的初始化、启停、健康检查、镜像更新与受控修复 | 向用户/Bot 暴露任意建机、镜像导入、设备配置或 shell 透传 |
| Hermes 风格 Harness | 上下文、推理、记忆、技能、压缩、历史回查及学习 | 直接获取长期凭据、跳过工具网关 |
| Tool Gateway | 验证参数、授权、审批、配额、回执、路由 | 相信模型声称“用户已批准” |
| VM Guest Agent | 虚拟机文件与终端、浏览器、桌面、长命令管理 | 访问未授权宿主目录、控制数据库或 vault |
| Host Agent | 经用户允许的本机文件、应用和桌面控制 | 自动提升为管理员、越过明确能力范围 |
| Computer Router | 根据绑定和任务约束选择机器，申请资源租约 | 把同一个 Bot 的多台电脑视作可无条件互传资料 |
| Connector Service | 绑定具体账号和 scope 后访问外部 API | 代用户自动扩展 OAuth 权限 |
| Artifact Service | 版本、预览、引用、受控发布到用户目录 | 将生成的 HTML 当作可信应用代码执行 |

## 5. 本地部署和 Computer 多对多关系

### 5.1 所有控制与状态驻留本机

```text
Windows 用户会话
  Desktop UI
     ↕ 受限 IPC
  Desktop main
     ↕ 本地命名管道
  agentd + SQLite + Artifact Store + Credential Vault
     ├─ Collaboration Bus：Bot 邮箱 / 协作房间
     ├─ Computer Router：多对多绑定 / 资源租约
     │    ├─ Host Agent → 本机文件、Word/Excel、浏览器、桌面
     │    └─ VM Guest Agent → 固定工作电脑：研究 / 文档 / 代码 Workspace
     └─ VM broker / QEMU（WHPX 加速）→ VM 生命周期
```

产品没有自建远程后台依赖。模型可以调用用户配置的 API，也可以使用本地推理端点；前者仍会把选择进入上下文的数据发送给模型服务，所以“纯客户端”不等于“完全离线”。本地模型模式必须显式关闭外部搜索、远程连接器、遥测和联网依赖下载，才能称为完整离线流程。

`agentd` 是独立后台进程，关闭 UI 可继续运行。开机或登录自启动由用户设置；Windows 休眠、关机、资源不足或系统策略暂停时，任务进入可恢复等待。醒来后处理错过的 Routine。Windows 锁屏时暂停本机前台桌面控制；宿主仍清醒且资源可用时，VM 内的独立桌面和计算可以继续。

宿主长期凭据通过 Windows 用户级保护存储，Linux guest 只得到短期、限定任务的访问能力。初始化镜像可以访问签名镜像源；任务期间的网络访问使用独立规则。

文件默认采用显式导入和版本化导出。用户选择文件夹时生成访问 Grant，输入复制到 VM workspace；输出先进入 Artifact Store，再以文件版本或 Git patch 发布。本机工作可以选择直接编辑原文件，但必须记录原始版本、检查用户并发修改并保留可恢复副本；不能强迫所有本机任务都先复制到 VM。

### 5.2 绑定矩阵示例

| Bot | 我的电脑 | 固定工作电脑 |
|---|---|---|
| 研究 Bot | 默认不绑定 | 研究 Workspace、浏览器、生成笔记 |
| 文档 Bot | 限定 Word/Excel 及指定文件 | 文档 Workspace、报告和图表 |
| 开发 Bot | 默认不绑定，可由用户追加 | 代码 Workspace、shell、仓库和测试 |
| 审核 Bot | 可选只读文件能力 | 检查 Workspace、产物快照与验证 |

表格只是初始授权模板，用户可调整 Bot 能使用的范围，但不能新增 Computer。绑定定义 `allow/deny`、文件根、账号身份、工具集合、是否允许后台运行、有效期和每类动作的审批规则。它不是 VM 所有权：多个绑定可以指向同一个 Computer。

Bot 的 `preferred_computer_id` 只是路由偏好，不能代替授权。任务明确指定本机时，遵循用户选择；未指定时按能力、数据位置、可用账号、隔离需求、当前负载和切换成本选机器。运行中更换 Computer 时，应显示明确的切换事件。

一次 Run 可以在固定工作电脑处理数据，再到用户本机验证 Excel。上下文和任务状态留在 agentd；每条工具调用携带 Computer ID。跨电脑交接只复制被批准的 ArtifactVersion，不复制整个用户目录或浏览器身份。

### 5.3 三种共享强度

| 方式 | 适合场景 | 实际边界 |
|---|---|---|
| 同电脑、同 Workspace | 两个 Bot 合写同一份报告、接续操作同一账号 | 信任共享；有资源锁，没有对恶意代码的独立隔离 |
| 同电脑、不同 Workspace/会话 | 并行研究、不同代码 worktree、不同浏览器 profile | 工作和状态隔离；同 OS 身份仍可能互相访问，不等同独立 VM |
| 不同 VM Computer（后续版本） | 不互信仓库、敏感项目、独立验证 | 独立内核/磁盘边界；首版不提供 |

“独占电脑”还需区分调度独占与安全隔离：首版临时整机独占租约防止别的 Bot 同时使用，却不会抹掉历史文件和登录状态。任务需要干净工具状态时创建新 Workspace/临时运行层；不能宣称它等价于另一台 VM。整机修复会影响全部 Bot，必须等待活跃任务完成或经用户暂停后进行；要求独立内核的任务在首版不支持。

### 5.4 资源租约和多人争用

持久授权解决“能不能用”，短期租约解决“现在谁在用”。建议资源键包括：

```text
computer/{id}/desktop/{session_id}/input
computer/{id}/browser/{session_id}/tab/{tab_id}
computer/{id}/workspace/{workspace_id}/write
computer/{id}/repo/{repo_id}/integration
computer/{id}/office/{document_id}/write
computer/{id}/lifecycle
```

同一桌面的鼠标键盘动作排他；生命周期锁与该 Computer 所有活跃操作冲突。不同 tab 仅在使用不争用桌面焦点的受控浏览器 API 时允许并发。点击打开文件选择框、使用系统剪贴板、切换窗口等动作必须升级为桌面输入租约。

不同 worktree 可并行运行 shell，最终整合代码时持有 integration 锁。Host 上的文件读写还需检测外部用户修改，产品内部租约无法阻止用户或第三方应用直接编辑。

申请多把锁时由调度器按统一顺序原子获取，或失败后释放并排队，避免两个 Bot 互相等待。使用短租约、心跳、fencing token、公平队列和最大持有时长。执行端在真正提交动作前验证租约，不能只在排队时检查。

用户接管时递增桌面控制 epoch、取消待执行输入、阻止后续注入并刷新 observation。已发出的单次输入可能无法撤回，所以动作要短，暂停发生在每个动作边界；不能声称可原子撤销一个已经点击的提交。恢复必须由用户主动释放控制权并重新观察桌面。

## 6. Windows 虚拟机和工作环境

### 6.1 首版固定 VM 契约

应用内部只有一个逻辑 VM 槽位 `managed-work-computer`，再加一个 `host-computer`。首次使用工作电脑时检查硬件加速、内存、磁盘及网络，初始化由应用一次完成；日常按需启动。用户看见准备进度、可恢复错误和修复入口，不接触 ISO、网卡类型、端口映射或 VM 创建表单。

固定的是镜像系列、系统版本、Guest Agent、设备和网络配置以及资源分配算法。资源算法可按宿主可用能力选择经过验证的内部档位，但首版不开放任意滑块或 QEMU 参数。资源不足时减少任务并发，无法满足最低条件则提示，不能静默把隔离任务改成本机执行。

基础系统只读，项目数据盘、浏览器身份和可清理缓存分开。包安装限制在项目虚拟环境/临时执行层，不能让 Bot 修改受管基础镜像。应用验证镜像与工具包 digest；升级时先保存任务检查点并停机，新基础镜像重建后挂载兼容数据盘；失败可回退。修复预览必须说明对哪些任务、文件与登录状态有影响。

只允许产品层的准备、启动、休眠/关闭、查看状态、受控修复和清理可回收缓存。Bot 无法调用建机、克隆、重置其他项目或配置宿主虚拟化的工具。Lifecycle 锁阻止重建与其他 Bot 的执行并发。

网络配置统一维护，模型 API 调用和 Bot 协作留在本机 agentd；guest 只负责工具和浏览器。详情页提供“模型连通 / 工作电脑联网 / 代理 / 开发服务预览”分项诊断，而不是把所有失败都标成“VM 离线”。

首版使用固定的一台 VM，节省的是配置组合与重复资源开销，并不消除硬件、磁盘或网络问题。镜像缓存占用、实际数据盘占用、可回收空间、空闲关闭和休眠恢复仍需实现和测试。

### 6.2 Provider 选择与后续扩展

| 目标环境 | 建议 Provider | 首版取舍 |
|---|---|---|
| Windows x64 | QEMU + WHPX + Linux guest | 首版唯一候选，验证稳定版本、网络和恢复行为后发布 |
| Windows Pro/Enterprise | Hyper-V Linux VM | 后续替代；使用平台生命周期 API，处理管理员初始化 |
| Windows 开发者 | 专用 WSL2 distribution | 后续兼容性研究；首版不提供切换，避免扩大支持矩阵 |
| macOS Apple Silicon | Apple Virtualization.framework + ARM64 Linux guest | 后续原生 helper；相同 workspace-agent 和镜像构建逻辑 |
| Linux 桌面 | QEMU/KVM | 后续 ComputerProvider，依据本机硬件能力选择 |

QEMU 的 [WHPX 文档](https://www.qemu.org/docs/master/system/whpx.html) 说明其依赖 Windows Hypervisor Platform；这与完整 Hyper-V 产品可用性不是同一判断。微软列出的 [Hyper-V Windows 版本和硬件要求](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/host-hardware-requirements) 应用于安装预检。[WSL 文档](https://learn.microsoft.com/en-us/windows/wsl/faq) 说明宿主文件集成能力，因此不能直接沿用其便利性默认配置作为隔离设计。

不要无提示退化为纯软件 TCG 仿真。没有可用加速、企业策略禁止虚拟化或硬件不适合时，说明限制，允许用户使用明确授权的本机模式；需要强隔离的任务保持等待。

### 6.3 Guest 镜像与资源

首版 guest 包含稳定 Linux 发行版、Git、ripgrep、Python、Node、Chromium、Playwright、文档生成与渲染工具、中文字体和轻量桌面。基础镜像只读，系统临时层与 workspace 数据盘分开。下载使用签名和 digest；更新采用新镜像重建并迁移工作数据，保留可回退版本。

建议实测起点：一台 guest 分配 4 vCPU、6 GB RAM、40 GB 可增长磁盘；宿主 16 GB 作为低并发验证档，32 GB 作为推荐档。大型编译和本地大模型单独估算。Bot 数量与 VM 数量脱钩，按任务资源预算做准入控制。

Windows 支持矩阵至少包括 Intel/AMD、Windows Home/Pro、BIOS 虚拟化开关、已有 WSL/Docker、企业安全软件、代理网络、休眠恢复、磁盘低空间和中文路径。ARM64 作为单独构建和测试目标，不能只用 x64 仿真宣称支持。

Guest Agent 用单一签名二进制/固定运行时启动；VM 控制通道只对本机受控端点开放。Provider 报告实际支持的 `snapshot`、`quiesce`、`pty`、`browser`、`desktop`、`gpu`，UI 根据能力显示操作。

### 6.4 文件和会话隔离

原始下载文件、依赖安装脚本和仓库测试都视为不可信代码。每个互信项目可共享缓存；分开的 Workspace 配置独立用户目录、进程身份和浏览器会话，按可验证的 OS 能力限制文件访问。首版仍共享 guest 内核，不支持独立 VM 的互不信任执行。编译缓存要带来源、工具链与权限标签，避免把另一个空间的私有文件带入缓存。

浏览器 profile 默认按 Space/用户/账号域分开。两个 Bot 共用登录身份时，必须是显式授权的共享资源；browser context 只是应用隔离，不应被描述为防恶意代码的完整安全边界。

文件发布执行规范化路径校验、符号链接/重解析点检查、目标版本比较和原子替换。Windows 大小写、保留文件名、长路径及 CRLF/LF 需在跨系统复制测试中覆盖。

### 6.5 原生 Office 与本机 Computer

Linux 路线覆盖文档文件和浏览器办公；依赖 Word/Excel 原生排版、VBA、COM、特定插件或 Windows 软件时，可以选择用户已安装软件的本机 Computer，或后续支持的独立 Windows guest。

Windows 原生自动化使用有交互桌面的用户会话，设置单应用资源锁及明确的接管流程。不能将 Office COM 当作无头 Windows Service 的通用服务器组件；微软对这种 [server-side Office Automation](https://support.microsoft.com/en-US/Visio/considerations-for-server-side-automation-of-office) 明确指出支持和可靠性问题。Windows/Office 安装及许可由部署方按其环境处理。

### 6.6 控制用户本机的具体实现

Host Agent 是在当前 Windows 用户交互会话中运行的签名辅助进程。建议用 C#/.NET 调用 Windows 原生 API，和 agentd 通过有用户 ACL 的命名管道通信；不让 Electron renderer 直接调用系统 API。

能力分开授权：文件读取、指定目录写入、浏览器自动化、限定应用控制、桌面输入、截图、终端执行、剪贴板。启用“用户本机”这个 Computer 不等于全部能力都被授予。默认给用户明确选择“仅文件”“指定应用”“完整交互桌面”的入口，已获授权范围内自动继续，避免每点击一次都询问。

控制策略按可靠性选用：受支持的应用 API/文档对象模型 → 浏览器语义操作 → Windows UI Automation → 截图加坐标输入。对于结构化接口能力更差的应用，可直接使用经过验证的视觉策略，不强制走低质量 accessibility 树。

[UI Automation](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-uiautomationoverview) 提供控件属性、模式和事件；[Windows 屏幕捕获](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture) 可用于选定窗口或屏幕画面；[SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput) 用于模拟输入，但受 UIPI 等系统限制。实现必须检查 API 结果，不能假定调用成功就完成动作。

每份 observation 记录 Computer、Windows session、窗口身份、屏幕布局、DPI、前台窗口、桌面 epoch 和时间。动作携带 observation ID、目标窗口与前置条件；窗口移动、页面改变、用户输入、分辨率改变后，旧截图坐标失效。多显示器负坐标、中文输入法、滚动、拖放、快捷键状态必须纳入验证。

用户可以通过托盘按钮、悬浮控制条和全局快捷键暂停。自动化期间持续显示正在操作的 Bot 和目标应用。检测到真实用户输入时，保守暂停受影响的桌面动作；区分注入输入以免自己触发自己。弹出系统 UAC、安全桌面、锁屏或需要用户完成的认证时等待用户，不自动提权。

默认新建产品专用浏览器 profile，另提供显式连接用户当前浏览器的方式。用户现有浏览器由扩展按 tab 授权控制，避免打开全局无认证调试端口。用户切换账号或跳转至未授权站点时重新校验。

本机操作的隔离能力必须如实展示：受控文件 API 可以约束目录，但同一用户下的任意 shell 或完整桌面操作者可能读取更多数据。DPAPI/用户级凭据加密保护静态存储，却不能对抗同一用户身份的任意恶意程序。若强文件隔离、网络隔离或凭据保护没有在 OS 层执行，就不能在 UI 中标作“沙箱安全”。需要这种边界的任务路由到 VM；广泛本机控制是用户主动选择的信任模式。

## 7. Harness 的实际执行流程

首版采用 [Hermes 风格的精简 Harness](Harness-Hermes-Lite.md)：AgentLoop、ContextManager、MemoryService、HistoryStore、SkillService、LearningWorker 六个模块。以下为总体流程，记忆版本、压缩提交、学习触发与验收以专项设计为准。

### 7.1 核心循环

```text
接受用户输入并更新 task spec revision
  → 获取 Run 租约和预算额度
  → 读取结构化任务状态、最近事件与环境版本
  → 按需装配规则、技能、记忆和证据
  → 模型决定：调用工具 / 继续计划 / 请求输入 / 候选完成
  → 工具意图先持久化
  → Gateway 验证权限、参数、资源版本与操作配额
  → 直接执行，或停为 WAITING_APPROVAL
  → 记录实际执行回执和产物引用
  → 更新进展；必要时压缩上下文或保存检查点
  → 达到验收条件后验证；不满足则在预算内修复
  → 交付结果及证据
```

AgentLoop 一轮只选一个清晰的下一步，允许多个独立只读工具批量执行。小任务可以直接执行；复杂任务建立可修订的阶段计划。计划不是必须一次完成的巨型 DAG，新的证据可以改变后续步骤。

所有模型请求携带 deadline、输出预算和可取消信号。`STOP` 是调度控制指令，优先于下一轮模型生成；已发生的外部操作不能靠取消撤回。

### 7.2 上下文构建

每次请求按以下顺序构造：稳定系统契约 → 当前授权上限与工具规则 → 项目和用户显式约束 → Task 当前状态 → 必要技能 → 近期对话与工具结果 → 按需检索的原始证据。

原始会话与模型上下文分开保存。大文件、网页全文、终端完整输出、图片和历史事件保存在外部索引/产物存储中，模型先获得摘要、范围、来源和可再读取引用。需要具体代码时使用 `rg`、文件范围、符号检索；普通文档使用文本索引加元数据筛选；有实测收益再增加向量检索。

预算按实际 tokenizer 和模型能力计算，从窗口减去输出和工具/控制余量后得到输入安全预算 B。初始在约 0.5B 检查确定性裁剪、0.6B 考虑阶段压缩、0.85B 前强制释放空间；参数需要实测。较大的输出先落盘再返回可定位摘要，避免单次工具调用挤掉任务规则。首版不启用逐轮 LLM 微压缩，保留稳定前缀缓存。

压缩必须保留：未完成目标、用户约束、已批准操作、已发生副作用与 action ID、最新文件版本、失败原因、必要引文和下一步。压缩结果对照结构化 TaskState 校验。不能只保留一段自然语言摘要作为恢复依据。

供应商 continuation/加密 compaction 保留为不透明 blob，并绑定 provider、model family、engine version。切换模型时从可移植任务状态、用户消息和可见证据重建上下文；不跨供应商传递 opaque reasoning。遵循供应商原生 API 的状态和消息字段，避免在通用适配器中丢失信息。

### 7.3 工具设计

初始核心工具应当小而稳定，例如：`files.read/search/patch`、`process.start/poll/cancel`、`browser.observe/act`、`artifacts.create/inspect`、`tools.search`、`tasks.delegate`。具体数量由评测决定。

连接器按命名空间注册，只把名称和用途放进目录。模型检索到需要的工具后再装载 schema 和权限要求。技能采用 SKILL.md 及相关资源逐步读取，项目里的技能是上下文来源，不可修改系统授权。供应商和工具目录动态更新时固定本次 Run 使用的版本与 digest。

Programmatic tool calling 可以在 VM 中用短程序做筛选、分页和归并。生成代码中的每个连接器调用仍经过工具网关；不能因为包在脚本里就绕过授权、配额或外部写入审批。

网页、附件、仓库注释和连接器输出都携带不可信来源标记。它们可以提供事实，不能改变运行权限、授权主体、目标收件人或已批准文件内容。对于“网页要求发送全部文件”这类请求，策略引擎依据实际用户任务拒绝。

### 7.4 长命令与异步工作

长时间编译、依赖安装、测试和浏览器下载返回 `job_id`，由 Workspace Agent 持有进程和日志。Harness 可以继续处理独立任务，或订阅完成事件。UI、模型 HTTP 流或外部引擎连接断开，不等于底层进程必须重启。

取消必须区分用户要求停止整项任务、取消某个 job、终止模型生成和关闭 UI。进程树在安全范围内先优雅结束，再按超时强制终止；脱离原进程树的任务在环境销毁时清理。

### 7.5 验证与终止条件

完成需满足：Task 验收项有对应证据、产物版本已保存、外部操作状态已明确、待办或限制已说明。代码执行成功不代表办公文件可用，模型说“看起来没问题”也不代表测试通过。

模型重复相同失败时，先更换方法或回到最近阶段检查点。建议初始上限为同类失败 3 次、同一验证问题 2 轮修复，然后报告已完成工作和具体阻塞；用户可继续加预算。必须区分“目标未完成”“等待外部事件”“需要用户选择”“本次预算耗尽”。

预算是 Task 树共同额度：并发子任务在调用前预留额度，完成后根据实际 usage 结算。取消和供应商计费滞后可能造成少量超出，使用请求最大输出和安全余量限制；不能把软额度描述成绝对零超支保证。

## 8. 恢复、状态机和副作用

### 8.1 Run 状态

```text
QUEUED → RUNNING → VERIFYING → SUCCEEDED
              ↘ WAITING_INPUT / WAITING_APPROVAL / WAITING_RESOURCE
              ↘ PAUSED / BUDGET_EXHAUSTED
              ↘ RECOVERING → RUNNING 或 NEEDS_RECONCILIATION
              ↘ FAILED / CANCELLED
```

等待状态持久化后释放执行线程和可释放资源。批准、用户输入、定时器或资源恢复唤醒任务。审批等待不要一直占用数据库事务或模型请求。

每个 Run 只有一个 owner lease，包含 `fencing_token`。旧 Worker 即使网络恢复也不能继续提交新操作；网关和 Guest Agent 对每条有副作用命令检查 owner epoch。租约撤销无法使已送至第三方的请求瞬间消失，恢复程序必须对账。

### 8.2 事务与事件

在同一数据库事务中写入：任务投影视图、语义事件、工具操作意图和待派发 outbox。派发者使用同一 `invocation_id` 重试。每个 Run 的事件拥有递增 `seq`，客户端提供 `after_seq` 恢复；无需全系统单一全局序号。

Token delta 可以暂存/合并；最终消息、用户命令、操作意图、状态变化和回执必须持久。不能只用 WebSocket 消息当唯一事件日志。

产物采用先写临时文件 → flush/校验 hash → 原子提交 blob → 数据库写引用。重启后清理未引用临时文件。跨数据库和对象存储不声称有单事务原子性，用 manifest、未引用对象清理和引用校验弥补。

### 8.3 外部操作语义

系统提供持久意图、至少一次派发及去重控制。只有在目标服务支持幂等请求或可以确认结果时，才能达到对该操作的有效一次执行；不承诺任意第三方 UI 上的通用 exactly-once。

| 操作 | 失败后的策略 |
|---|---|
| 搜索、读取、查询状态 | 按退避和 deadline 重试 |
| 创建本地产物 | 内容 hash、版本号及原子提交去重 |
| 对确定版本应用 patch | 检查 base hash；已应用则返回原回执；有冲突则重新计划 |
| 支持幂等键的外部 API | 重用原 `invocation_id`/幂等键并获取同一结果 |
| 支持 ETag 的外部编辑 | If-Match/CAS；资源改变时失效并重新生成可审核变更 |
| 点击发送、支付、提交等结果不明 | 标记 `UNKNOWN`，查询目标系统；无法核实则请求人处理，不能自动再点一次 |
| 浏览器已派发操作但 Worker 失联 | 回收租约、停止新动作；恢复后先截图/查询/对账，再继续 |

VM snapshot 用于加快环境重建，不作为发送邮件、修改 SaaS 或发布代码的撤销机制。它可能复制浏览器凭据，必须加密和受控访问。恢复 snapshot 后先清理旧租约和临时能力；checkpoint 的可移植逻辑状态与 VM 内存不是同一个东西。

### 8.4 必须实现的故障恢复用例

1. 模型流式返回到一半断网：保留已经确认的完整模型决定；不执行不完整工具参数；最多从最近安全步骤重试。
2. 工具意图写入后进程崩溃：同一 invocation 被重新派发，执行端先查询 journal。
3. 工具已执行但回执未写入：查询本地 job 或远程操作 ID；结果不明进入对账。
4. 浏览器动作执行后页面变化：用新的 observation 重建下一步；禁止复用旧坐标。
5. UI 重连：先加载快照及持久事件，再接实时流；去重重复事件。
6. approval 获准后任务内容改变：审批与旧操作 hash 绑定，新的操作必须重新匹配授权。
7. 用户撤销 OAuth：新调用立即失败并等待重新连接，不自动找另一个账号尝试。
8. 本地 Windows 休眠：Worker 心跳失效但任务不当作完成；恢复后对账并更新环境可用性。

## 9. Bot 直接交流与协作

### 9.1 协作模型

每个 Bot 有稳定身份、独立角色配置、记忆视图和持久邮箱。`agentd` 内的 Collaboration Bus 管理私聊及房间，不依赖 Bot 开着终端或运行在同一 Computer 上。Bot 离线时可收消息，消息经策略判断后才唤醒模型。

支持三种原语：

| 原语 | 使用方式 | 结果 |
|---|---|---|
| `send_message` | 直接向另一个 Bot 或房间发消息 | 持久消息，可附产物引用；发送成功只代表已入队 |
| `request_help` | 带问题、允许范围和回复截止时间 | 关联 request ID 的答复，不自动授予执行权限 |
| `delegate_task` | 明确目标、输入、验收、授权上限和预算 | 持久子 Task；可查询、取消和接收结果 |

用户可以建立“项目组”，选择参与 Bot 和允许的协作规则。房间无需每个 Bot 对每条消息都回答；使用 `@bot`、指定消息类型、任务分配或清晰的协作触发规则。每个房间可有协调者，但不是所有交流都必须经过协调者，点对点沟通是第一等能力。

### 9.2 消息协议和防循环

消息包含 `message_id`、`channel_id`、`from_bot_id`、收件人、`correlation_id`、`causation_id`、任务引用、产物引用、类型、TTL、剩余跳数和是否需要回复。消息使用至少一次交付和接收端去重，区分 `queued/delivered/acknowledged/task_created/completed`。

信息通知默认不触发回复。直接请求在用户配置的协作范围内可自动启动工作。重复消息、同一因果链里的 ping-pong、无进展往返和过期请求被抑制。建议默认一条因果链最多 4 层委派、一次协作会话最多 12 次自动往返；这些是初始预算策略，用户可按项目调整。

Bot 接到信息时若正在执行任务，放入邮箱，在模型或工具安全边界读取。紧急取消和权限撤销由协调器立即处理，不能等模型读到通知才生效。影响当前结论的新信息作为 steering event 加入，不覆盖用户原要求。

### 9.3 权限、预算与工作交接

Bot 发来的消息保留 Bot 来源，不能伪装成用户消息。接收方能执行的动作必须同时满足：自己的有效权限、目标 Computer binding、任务允许范围、用户批准的委派范围以及当前资源策略。若协调 Bot 有权要求专业 Bot 使用后者的能力，这个“可委派的能力范围”应由用户先配置；不能把 Bot 间请求变成绕过限制的途径。

每个父任务给子任务分配 budget reservation，预算从共同根任务结算。发送消息不能无限增加子任务、无限重试或引入新的收费模型。存在依赖环时返回可见错误，让协调者重新拆分工作。

交接包至少包含：已完成内容、产物版本、关键来源、验证记录、已发生的外部操作、未解决问题和下一步。不复制另一 Bot 的完整历史、全部私有记忆或账号凭据。上下文共享与权限共享是独立动作。

在同一个 Computer 上接续工作时，发送方先提交产物及状态，再释放对应 lease；接收方重新观察资源版本后获取 lease。不会因为对方在聊天里说“我让给你了”就转移电脑控制权。

### 9.4 合适的默认协作组织

初始提供研究、文档、开发、审核四个 Bot 模板，同时允许用户只创建一个通用 Bot。复杂工作可由用户指定主负责人，再让它自行寻求帮助。模型自发新增角色需满足项目配置的数量和预算限制。

一个 Bot 默认只有一个活跃修改型 Run，避免两项工作竞争自身计划和共享资源。以后可支持同角色多个执行实例；必须各自拥有上下文、任务、Computer 目标和资源租约，不能让“一个 Bot 的对话历史”成为进程间共享可变内存。

审核 Bot 使用不同上下文或干净 workspace；当共享同一 VM 和 OS 身份时，不能宣称其证据无法被开发 Bot 修改。强独立验证必须隔离测试环境，并由控制面保存只追加的检查结果。

## 10. 办公、代码和电脑操作的能力体系

### 10.1 工具路由

所有执行请求都声明 `computer_id`，服务型连接器另声明账号与连接器实例。工具调度优先选择可可靠验证结果的接口：结构化 API、文件工具和 shell；需要操作真实用户界面时采用浏览器或桌面控制。工具选择依据能力与实测，不依据固定“某类 Bot 只能用某类工具”。

| 任务 | 首选路径 | 交付证据 |
|---|---|---|
| 批量整理资料 | 文件工具、文本提取和搜索 | 来源文件、抽取范围、归纳结果 |
| 数据分析 | Python/SQL、表格计算引擎 | 输入快照、计算脚本、指标核对 |
| Word/PPT/Excel 生成 | 文档工具包、模板和渲染 | 原文件、预览、检查记录 |
| 代码修改 | Git worktree、搜索、patch、测试 | diff、基准版本、测试输出 |
| SaaS 办公 | 官方 API/连接器或受控浏览器 | 对象 ID、前后状态、操作回执 |
| 使用本机已有软件 | Host Agent + 应用 API/UIA/视觉 | Computer、窗口、操作前后证据 |

### 10.2 Office 文件质量闭环

办公文件流水线为：读取与定位来源 → 生成可编辑文件 → 重新读取结构与数值 → 计算/刷新 → 渲染 → 视觉检查 → 保存产物版本。OCR 内容附置信和页码，不把未核实识别结果默认为事实。

建议工具包包括 Python 的文档和数据处理工具、Node 的演示文稿生成工具、PDF 解析/渲染以及 LibreOffice 转换。具体依赖在实现时锁定版本并评估许可证；文件格式功能通过样例矩阵验收。

Excel 中写入公式不等于公式已计算。需要公式引擎、LibreOffice 或用户本机 Excel 重新计算，再核对关键单元格、错误值、引用、日期/币种和精度。涉及宏、外部链接、动态数据源和复杂图表时，显式标出支持情况，禁止默认启用附件宏。

Word/PPT 要检查字体替代、分页、表格溢出、图表裁剪、重叠和文本丢失。Linux 渲染通过不保证 Microsoft Office 完全同版式；对高保真要求，切到已授权的本机 Office 做最终检查。无法验证时保留限制，不伪造“已检查”。

产物保存为 `ArtifactVersion`，包含来源文档版本、生成工具、模板版本、检查器、预览和引用。先完成草稿和可审核变更，再根据既有授权判断是否发布或覆盖目标文件。

### 10.3 代码能力闭环

每个修改任务创建明确基准版本和独立 worktree；初期让同一仓库的一次最终整合由单一 integration task 完成。用户未提交的改动视作独立输入，先记录，不执行自动 reset/clean。

阅读项目规则、定位代码、编辑、运行相关测试、检查 diff 和产出说明是基本流程。项目规则影响工作方式，不能提高工具权限。依赖安装脚本和测试可能执行任意代码，优先在固定工作电脑的受限代码 Workspace 中运行。

长命令由 Job Manager 跟踪；测试输出附命令、cwd、环境版本、exit code 和日志引用。新测试应验证用户行为或修复场景，不能只复述实现。对不同 Run 的相同文件改动进行三方合并或冲突报告。

可以把补丁交给审核 Bot 在独立 Computer 验证。发布到本机工作目录、Git commit、push 和创建 PR 分成明确动作，分别匹配权限和当前任务授权；不把“测试通过”当作默认允许推送。

### 10.4 Computer-use observation/action 协议

每次 action 引用短期有效的 observation，包含 Computer、session、目标、预期前置条件和控制 epoch。电脑选错、窗口失焦、DPI 改变、账号变化或用户接管都使旧 observation 失效。

浏览器尽量使用稳定 locator、accessibility tree、明确页面状态和下载事件。纯视觉操作采用小步、观察、检查结果的循环；不缓存十几步坐标连续盲点。页面中的文字不能替代实际用户授权。

API 和浏览器有相同效果时，共享同一 action journal。比如连接器超时后改用浏览器发送邮件，必须先对账，不能把工具路径改变理解为“尚未执行”。

## 11. 权限与用户授权

有效权限由多项约束共同决定：用户 Grant、Bot 的能力上限、BotComputerBinding、Task 当前范围、委派上限、Computer 的实际可执行能力以及操作时的资源状态。明确 deny 优先；任何匹配链条缺失都不能自行升级权限。

本地个人版可提供三个默认工作方式：

| 方式 | 行为 |
|---|---|
| 观察与建议 | 读取指定资源、检索、分析；产物保存在专用目录 |
| 工作区自主执行 | 在已批准 workspace/VM 内修改、运行和验证；需要向外发布时再匹配授权 |
| 本机协作 | 操作选定应用或完整桌面；持续显示状态，用户优先接管 |

这些只是可编辑预设，不固定成用户无法修改的三档。授权存为可撤销记录，具有 actor、Computer、资源范围、动作、目的、有效期和来源。用户已批准的相同范围操作不重复询问。

审批请求绑定实际操作：`invocation_id`、参数 hash、产物 hash、账号、收件人/目标、资源版本、policy revision 和有效期。用户批准“这份报告发给 A”后，模型改了附件或收件人，旧审批不能覆盖新动作。自动审批只能在用户设置的规则范围内批准。

Connector token 留在控制面，工具请求引用连接身份，由代理绑定 token。MCP server 是程序和外部服务，不因提供工具就值得信任；scope、OAuth audience、重定向和 token 转发依照 [MCP 安全建议](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices) 设计。

已登录浏览器本身具有账号权限。把 OAuth token 放到 vault 不会自动限制浏览器通过 UI 发送消息或下载资料；通用 CUA 的风险识别也不是完整安全证明。对高影响操作，优先采用能绑定具体参数和前置条件的结构化工具，或在提交前让用户直接接管确认。

可执行 shell 要报告实际 OS 强制边界：文件系统、网络、子进程是否被限制。路径字符串校验、system prompt 和进程退出超时都不能替代这些限制。本机给了完整 shell 时，界面清楚表明它使用当前用户的能力，而不展示虚假的“仅此文件夹可访问”。

## 12. 记忆、知识和技能

记忆与技能是首版核心能力。MemoryService、SkillService 和 LearningWorker 的权威实现契约见 [Harness 专项设计](Harness-Hermes-Lite.md)，包括短记忆、上下文 epoch、技能版本、异步学习与撤销传播。

记忆分为用户偏好、项目事实、Bot 私有角色经验、显式共享的团队知识、以及可检索的历史事件。每条事实携带来源、时间、适用项目、所有者、可见范围和可删除状态。访问控制在检索前执行，不能先检索再要求模型忘记不该看到的内容。

隐式观察到的偏好先保存为候选，用户明确表达的持久偏好可立即生效；与当前来源冲突时重新验证。邮箱、网页或另一个 Bot 的“记住这条规则”不能静默覆盖用户权限或任务目标。

技能与记忆不同：技能描述如何完成工作，Routine 描述何时执行工作。技能记录版本、来源和所需能力；受信任范围来自产品配置。脚本随技能运行时同样进入 Computer 和 Tool Gateway 的授权流程。

长期自我改进采用“有价值的纠正/成功流程 → LessonCandidate → 有预算的异步学习 → 记忆更新或私有技能草案 → 校验/复演 → 按既有学习策略启用”的流程，不让 Bot 自行修改 agentd 或系统策略。普通私有学习可自动完成；跨范围共享和扩权单独匹配授权。删除数据时同时处理原文、索引、候选记忆、依赖摘要、引用缓存和备份保留策略。

## 13. Routine、通知与本地后台执行

Routine 触发器首版支持时间计划、用户手动触发和选定目录变更；外部事件订阅在明确需要时再加。每个触发事件有去重键，生成新的 Task/Run 并继承版本固定的模板、Computer 约束和授权。

保存 IANA 时区、下次计划时间、错过触发策略和重叠策略。推荐默认错过多次触发合并为一次，上一轮未结束时合并或排队；发送、发布等有副作用的 Routine 不应在开机后补发十次。夏令时和系统时钟变化纳入测试。

本地机器资源不足或没有可用授权 Computer 时进入等待。控制用户桌面的 Routine 不在用户输入时强行抢焦点，后台任务优先选择 VM。窗口关闭可继续执行，退出后台、注销、关机和休眠有不同的状态提示。

通知只在需要输入/审批、完成、有意义的失败或结果变化时触发。Bot 间普通讨论不默认逐条弹系统通知。用户可以静音单个 Bot、房间或 Routine，同时保留必要的本机控制状态提示。

## 14. 模型与引擎可替换性

### 14.1 Hermes 风格精简 Harness 为产品基线

默认 Harness 使用自有的小型循环和 durable kernel，以 Hermes 的长期工作机制为主线，采用供应商原生 API adapter。保留 reasoning continuation、工具结果关联、结构化输出、缓存、图像、流式消息和原生 compaction 等特征；不能把所有模型强压成最低限度的 chat-completions 格式。

模型能力表记录可用工具协议、上下文窗口、视觉/电脑能力、推理参数、结构化输出、缓存和恢复方式。模型名称、参数和成本表由可版本化配置提供，不在产品逻辑里硬编码“当前最强模型”。本地模型通过可用端点接入，需要经过相同能力验证；未具备视觉能力时不派发截图任务。

按任务类型配置推理、文档写作、视觉操作和评价的模型策略。默认主任务尽量保持模型连续性；成本压力时先减少无效上下文和重复工具调用，再考虑切小模型。模型故障切换产生新 decision boundary，保留既有副作用记录。

### 14.2 后续可选 Codex EngineAdapter

可通过固定版本的 Codex App Server 或 SDK 运行完整的代码子任务，以较低实现成本获得成熟代码 Harness 能力。产品负责 Task、Computer、账号、审批和产物；适配器负责生命周期和事件转换。

当前 [App Server 文档](https://learn.chatgpt.com/docs/app-server) 对相关接口及 WebSocket 传输有实验性提示。首个适配器使用本地进程 stdio、固定版本和契约回归，不依赖无认证 TCP 监听或未记录的私有协议。

外部引擎拥有自己的循环，外层只能作为任务协调器，不能再逐步强迫它执行另一套 planner。内置 shell 若无法完全重定向，就把外部引擎放进对应 VM 的受限运行环境，并通过网关访问外部连接器；不在宿主 agentd 的高权限环境中启动。

适配器必须声明：工具回执是否完整、是否支持暂停/steering、恢复是否依赖原版本、权限回调是否完整、是否能覆盖原生工具路由。缺失能力时限制支持的任务，不能给出与默认 Harness 相同的恢复保证。

第一版只实现一个 Hermes 风格精简 Harness，外部代码适配器延后。OpenHands、Codex 等可用于后续替换或对照，不同时维护多个产品默认内核。对外比较用相同模型、任务、工具和预算，避免把模型差异误算为 Harness 提升。

## 15. 技术栈与代码结构

| 层 | 建议 | 理由 |
|---|---|---|
| 桌面 | Electron + React + TypeScript | 集成文件预览、终端、桌面流和丰富工作台；后续跨平台 |
| 本地核心 | TypeScript/Node 独立 `agentd` 进程 | 与 UI/协议共享类型，便于扩展工具生态 |
| Windows helper | C#/.NET | UIA、Windows capture/input、进程与管道、VM 管理桥接 |
| 数据库 | SQLite WAL + FTS5 | 单机事务、恢复和文本检索；单一写入调度 |
| 产物 | 本地内容寻址文件 + 元数据索引 | 大日志、截图、文档不塞进消息表 |
| 虚拟化 | QEMU + WHPX，受管 Linux 镜像 | 独立内核环境与可控生命周期 |
| Guest 工具 | Python、Node、Playwright、Git、文档渲染工具 | 办公与代码工具共享受限工作环境 |
| 模型 | 原生 provider adapters | 保留供应商能力，支持本地端点 |
| 扩展 | MCP + SKILL.md + 自有权限 manifest | 工具、流程和权限各自可版本化 |

Electron renderer 必须开启隔离、限制 IPC、关闭 Node 集成；生成 HTML、网页和插件 UI 放在独立受限来源。具体落地遵循 [Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)。选择 Electron 的成本是安装包和内存，本地 VM 本身也有资源成本，应在 P0 测量。

```text
apps/
  desktop/                 # React UI + Electron main/preload
  agentd/                  # 本地核心进程入口
  cli/                     # 本地管理、诊断及导出
packages/
  domain/                  # Bot / Computer / Task / Artifact 及不变量
  protocol/                # 命令、事件和版本化 schema
  coordinator/             # Run 状态机、预算、恢复
  collaboration/           # 邮箱、房间、消息触发、委派
  harness/                 # Hermes 风格：循环、上下文、记忆、历史、技能、学习
  engines/                 # 后续外部引擎适配器
  model-providers/         # 原生模型 API
  tool-gateway/            # 参数、策略、审批、action journal
  computers/              # Registry / Binding / Router / Leases
  artifacts/              # 文件版本、预览、检查证据
  persistence/            # SQLite migrations / outbox / projections
  scheduler/              # Routine 与本地唤醒
  connectors/             # MCP 和经过审核的结构化连接器
native/windows-agent/     # 本机交互 helper
runtime/guest-agent/      # Linux VM 文件/命令/浏览器/桌面
runtime/images/           # 镜像定义与锁定依赖
evals/                    # 场景、故障注入、对照实验
```

本版只有本地命名管道和受控的 VM 通道，不实现公网 API、远程账号体系或分布式调度；以后确有需求再增加对应部署适配层。

交付物分别包括桌面安装包、签名 Windows helper、受管 guest 镜像及可选工具包；用户不应为了启动产品先自行安装 Node/Python。安装器只在启用虚拟化或必要系统组件时申请提升权限，日常 agentd 与本机交互进程使用普通用户身份。

应用与镜像分别版本化，升级前等待安全检查点，数据库迁移留备份并有明确的降级策略。镜像下载支持断点续传和 digest 校验。诊断包默认剔除凭据、文档正文和截图，用户可选择附加具体任务证据。SQLite 使用在线备份或一致性快照，不能只复制活动数据库主文件而漏掉 WAL。

开源发布时为核心、helper、镜像配方和第三方组件维护明确许可证及 SBOM；模型服务、浏览器账号和用户安装的 Office 不属于项目源代码的一部分。以独立进程集成工具时仍需检查其分发条件，不能把所有依赖统一标成项目许可证。

## 16. 数据与协议契约

主要表：`spaces`、`projects`、`bots`、`computers`、`bot_computer_bindings`、`workspaces`、`sessions`、`tasks`、`runs`、`steps`、`events`、`checkpoints`、`tool_invocations`、`resource_leases`、`grants`、`approvals`、`channels`、`messages`、`message_deliveries`、`delegations`、`artifacts`、`artifact_versions`、`routines`、`routine_firings`、`memory_facts`、`budget_reservations`、`outbox`。主要领域类型见 [contracts.ts](contracts.ts)，它是待实现的契约，不是运行时权限验证器。

关键约束：

- binding 是 Bot/Computer 的唯一有效授权关系，版本化更新，撤销立即阻止新动作。
- `events(run_id, seq)` 唯一，`tool_invocations.invocation_id` 唯一。
- 同一排他资源最多一个有效 lease，使用事务及 fencing token，过期旧令牌不可重新生效。
- `message_deliveries(message_id, recipient_bot_id)` 唯一，阻止消息重复启动任务。
- `routine_firings(routine_id, trigger_key)` 唯一，阻止重启后重复触发。
- Approval 绑定操作参数和产物版本，Task/Binding/Policy 版本变化后重新评估。
- 任务预算在 SQLite 事务内预留，不能并发读取余额后各自全部使用。

建议命令族：`bot.create/update`、`computer.status/prepare/start/stop`、`binding.grant/revoke`、`task.create/steer/pause/resume/cancel`、`message.send`、`delegation.create`、`lease.acquire/release`、`approval.resolve`、`artifact.export`、`routine.upsert`。Computer 注册和 VM 初始化只由应用内部 provisioning 服务调用，不能作为用户或 Bot 的通用工具。这些是本项目拟定义的协议，不是供应商 API。

每个命令有 `request_id`、`protocol_version`、用户/调用方身份、预期版本和幂等键。每个工具动作有 Computer、Workspace、绑定版本、租约 token、操作意图 hash 和必要的 observation ID。响应区分“已接受”“执行完成”“结果未知”，不能用统一 `ok: true` 混淆。

进程间使用结构化错误：`permission_denied`、`binding_revoked`、`lease_conflict`、`observation_stale`、`resource_changed`、`computer_asleep`、`budget_exhausted`、`needs_reconciliation`。UI 据此给出可操作状态，模型也据此决定重试还是换计划。

## 17. 工作台交互

侧栏默认只突出“待我处理”“Bot”“协作房间”，项目用于分组。任务、成果、例行任务放到相应 Bot 或房间内，避免首屏成为多个功能后台入口的合集。任务主视图包含对话和简短执行卡，右侧工作面板按需显示成果、电脑或计划。

固定提供“工作电脑”“我的电脑”两张状态卡；输入框旁显示当前执行位置。工作电脑详情显示运行状态、当前占用者、任务排队、资源开销和受控修复；我的电脑显示当前授权与接管。首版没有新增/克隆/导入电脑入口，也不向普通用户暴露资源租约、ComputerProvider 等实现名称。权限设置保留 Bot × 两个 Computer 的授权关系。

新建入口支持单 Bot 和协作房间。Bot 可以通过简短问题卡完成职责确认，问题支持推荐选项、自由补充和跳过；能力绑定由结构化授权完成。房间顶部保存目标、成员和下一交付，讨论中的消息可以关联任务，但普通发言不自动创建任务。详细界面观察与交互状态见 [GrokBot 实机观察](GrokBot-UX-Review.md)。

Bot 页面显示职责、记忆、关联 Computer、可协作对象、当前任务和消耗。用户可拖动任务到某个 Bot，或在房间里 `@` 指派；系统保存结构化目标，同时保留自然语言交流。

本机被控制时持续显示独立的控制条，不依赖任务窗口保持打开。接管后所有 Bot 的同一桌面控制都暂停，UI 清楚显示原因。用户可只暂停桌面控制而保留 VM 的后台代码任务。

审批展示具体账号、目标、前后差异或附件预览，并提供一次批准、在明确范围内持续允许和拒绝。日志默认呈现摘要和可展开证据，不展示模型未公开的内部推理。

第一版“小团队”指本机上组织多个 Bot 和项目、分享经过脱敏的角色/技能/产物包；不包含多人跨设备同时连入同一运行中的 agentd。这与本版只做本地的范围保持一致。

## 18. 质量指标与评测

建立自有办公、代码、电脑操作、协作和恢复数据集。按模型、引擎版本、工具集、操作系统及输入版本保存评测结果；所有指标是验收目标，尚未测得。

| 维度 | 第一阶段可测目标 |
|---|---|
| 本地运行 | 关闭 UI 后任务继续；agentd 重启后可恢复全部已持久化任务 |
| 副作用 | 故障注入场景中，不对未知结果进行盲目重复提交；所有写入都有 journal |
| 多对多 | 一个 Bot 使用两台 Computer 完成一项任务；三个 Bot 可共用一台 VM |
| 资源争用 | 并发桌面输入始终串行；到期/撤销 lease 的迟到动作被拒绝 |
| 本机接管 | 接管后停止新动作，目标 p95 在 1 秒内生效；已派发动作另行记录 |
| 办公 | 固定样例关键计算值正确，交付文件可打开，必检排版项有截图证据 |
| 代码 | 固定任务有补丁和有效测试；不覆盖用户未提交改动 |
| Bot 协作 | 消息不丢失、可去重，停止请求可打断自动对话，预算受共同上限约束 |
| 上下文 | 多轮压缩后仍保留用户关键约束及外部操作 ID |
| 本地隐私 | 完整离线配置下，对外网络访问为零；联网模式记录请求目的地和数据类别 |

初始维护约 60 个场景：20 个代码、20 个办公、10 个 Computer-use、10 个协作与授权；再加入断电、进程 kill、模型断流、磁盘满、旧租约重放和浏览器提交超时等故障矩阵。成功率、平均模型成本、完成时间、人工介入次数、误报完成比例和恢复正确率分别报告。

对照实验至少包括：单 Agent 基线、启用结构化检查点、工具按需加载、额外审核者、多 Bot 协作；固定同一模型和预算，或分别报告成本/成功率曲线。只有在办公或代码场景有明确收益时，才默认启用更复杂的机制。

关键验收场景：研究 Bot 在固定工作电脑读取网页并保存带来源笔记；文档 Bot 同时在另一个 Workspace 制作报告；两个 Bot 争用同一浏览器 tab 时租约正确排队；开发 Bot 在代码 Workspace 修复计算脚本，审核 Bot 从干净目录验证；文档 Bot 切到本机 Excel 检查报告；用户移动鼠标触发暂停；恢复后不重复提交任何外部操作。额外验证同时请求初始化只生成一台 VM、任何 Bot 都不能创建第二台 VM、整机修复不与活跃工作重叠。

## 19. 分阶段实现

按可验证产物推进，下面的时间仅作小型团队排期起点。单人兼顾 UI、Windows 原生、虚拟化和 Harness 时，完整本地 beta 可先按 10–16 周估算；熟悉这些技术的 2–3 人团队可以并行推进，但仍以验收门槛为准。

| 阶段 | 产物 | 退出条件 |
|---|---|---|
| P0：可行性验证 | WHPX VM 原型、Host Agent 原型、模型工具循环 | 在目标 Windows 机器上可靠启动 VM；能观察并操作测试应用；能打断；测得资源需求 |
| P1：本地纵向闭环 | Desktop + agentd + SQLite + 精简 Harness + Artifact Store | 一个 Bot 在 VM 和本机受控文件能力间工作；断流/重启恢复；可交付并检查一份报告或代码补丁 |
| P2：多对多与协作 | 固定 Computer Registry、Binding、资源锁、邮箱、房间、委派 | 多 Bot 共用工作电脑；一 Bot 跨工作电脑和本机；去重、取消和预算限制通过测试 |
| P3：办公与本机交互 | Office 质量流水线、UIA/视觉操作、浏览器会话、接管 | 实际 Word/Excel/网页任务稳定完成；本机用户输入优先；敏感动作授权正确 |
| P4：长期工作 beta | Routines、学习闭环、技能复用、安装更新 | 夜间 VM 工作、休眠恢复、镜像升级回退、诊断导出和跨任务经验复用评测通过 |

M:N 数据结构和 lease 协议从 P1 就存在，P2 补齐产品能力；不能在单 Bot 原型里把 `bot.vm_id` 写死再重构。本机观察、文件工具和暂停在 P0/P1 验证，复杂桌面流程到 P3 扩展。

首版不做：用户/Bot 自建或克隆 VM、自定义 VM 硬件和网络、独立多 VM 隔离、服务器、移动端、远程桌面服务、跨设备账号同步、公开插件市场、任意软件免配置自动化、无限制多 Agent 群聊。后续平台扩展聚焦 macOS/Linux ComputerProvider 和 Host Agent，保持相同任务与协作契约。

## 20. 优先实现的三个切片

第一，Computer 与权限切片：由应用初始化本机和唯一工作 VM，建立两个 Bot 的绑定，让两者竞争同一个桌面租约；验证用户接管、租约撤销和旧动作拒绝。这是多对多设计正确性的根基。

第二，可信产物切片：CSV → 计算脚本 → XLSX/DOCX → 渲染检查 → 用户指定路径，过程中在检查点强制结束 agentd，再恢复，确保文件版本和动作回执连续。

第三，协作切片：研究 Bot 直接请开发 Bot 修正数据脚本，开发 Bot 在工作电脑的代码 Workspace 交付 patch，文档 Bot 获取经授权的产物并在本机 Excel 验证。对消息重复投递和模型超时做故障注入，确认不会无限对话或重复启动任务。

这三个切片通过后，再扩大工具目录、模型种类与角色模板；实现顺序以可恢复执行、资源协调和实际成果质量为主线。

长期学习的追加验收：第一份报告完成后沉淀私有技能，第二份同结构新数据上的报告实际加载该技能并通过验证；用户纠正格式后新版本在下一次任务生效。只生成 SKILL.md 文件而从不检索和验证，不算学习闭环完成。
