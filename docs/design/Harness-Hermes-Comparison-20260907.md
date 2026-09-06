# AelionBot 与 Hermes Harness 实现对照

研究日期：2026-09-07。结论：AelionBot 已有执行、上下文整理、历史回查、长期记忆、技能沉淀和多 Bot 协作的基本闭环。与当前 Hermes 相比，主要差距集中在复杂模型协议、错误恢复、长任务执行、完成验证，以及长期运行后的知识与存储治理。

本次固定 Hermes 到 [314e36536365281a5b1438e7026a4f226bedff5d](https://github.com/NousResearch/hermes-agent/tree/314e36536365281a5b1438e7026a4f226bedff5d)，提交时间为 2026-09-06 16:03:59 UTC；本项目以 [e8a5c1c10ea25be982cbe7256b07bc021c704444 / v0.4.3](https://github.com/FoyonaCZY/AelionBot/tree/e8a5c1c10ea25be982cbe7256b07bc021c704444) 的核心实现为准。官网相关修改不计入本次 Harness 对照。

方法：取得 96 个固定版本的源码、配置和测试文件，沿主循环、模型请求、工具分派、压缩、复盘、技能管理和持久化的关键调用链做静态审阅，并检查开关及回归测试。未执行 Hermes，也未进行同模型任务基准；因此下文区分代码事实与预期收益，不给出能力百分比或性能排名。完整文件 hash 见 [来源清单](hermes-comparison-20260907.sources.json)。

**1. 主循环与长任务预算：我们有闭环，但限制较硬。**

Aelion 的主路径是 `Harness.run → ContextEngine / prepareGroupContext → ModelClient → 串行工具 → 完成检查`。单次 run 固定最多 30 轮；相同工具及参数连续失败 3 次会暂停。它能避免一些无效循环，但无法按任务规模调整预算，也没有一等的执行计划、子步骤状态与任务验收要求。[Aelion 主循环](https://github.com/FoyonaCZY/AelionBot/blob/e8a5c1c10ea25be982cbe7256b07bc021c704444/electron/core/harness.ts#L205)

Hermes 将 preflight、请求组装、响应处理、工具执行、停止门禁和 finalizer 分开。当前配置 `agent.max_turns` 默认是 `None`，即不设固定轮数上限；可配置墙钟预算，达到约 80% 时提示收尾。`todo_list` 有稳定 ID、修订号和子任务关系，压缩后可重新注入。子 Agent 有单独的配置预算；当前配置默认 250 轮，不能理解为所有子任务共享一个严格的全局总预算。[主循环](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/conversation_loop.py#L1390)、[主任务预算默认值](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/hermes_cli/config_defaults.py#L49)、[子任务预算](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/hermes_cli/config_defaults.py#L1208)、[TodoStore](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/tools/todo_tool.py#L1)

建议：增加可配置的轮数、时间和 token 预算，以及可恢复的任务清单。保留明确的停止条件，逐步支持长任务；单纯提高 30 这个数字不能解决卡住、失败遗留或错误收尾。

**2. 多 Provider 配置已有，多协议运行时仍有明显差距。**

我们可配置多个 Provider、拉模型列表、为每个 Bot 选择模型，但请求统一走 `/chat/completions`。`WireMessage` 和 `Completion` 主要保留正文、工具调用和图像，解析器不保存原生 reasoning sidecar、签名或不透明续轮状态；参数选择主要根据模型名决定 `max_tokens` / `max_completion_tokens`。[ModelClient](https://github.com/FoyonaCZY/AelionBot/blob/e8a5c1c10ea25be982cbe7256b07bc021c704444/electron/core/model.ts#L22)、[消息类型](https://github.com/FoyonaCZY/AelionBot/blob/e8a5c1c10ea25be982cbe7256b07bc021c704444/src/shared.ts#L14)

Hermes 有 Anthropic Messages、Responses、Gemini Native 等适配路径，处理 thinking blocks、签名、工具结果配对，以及换路由后不再有效的不透明数据。例如 Anthropic 适配器保留并验证 thinking blocks；Responses 适配器识别 encrypted reasoning 的签发来源；Gemini 适配器处理 thought signatures。[Anthropic 转换](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/anthropic_message_convert.py#L235)、[Responses 续轮数据](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/codex_responses_adapter.py#L327)、[Gemini Native](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/gemini_native_adapter.py#L202)

影响判断：经兼容服务调用时，普通问答可以正常，但部分模型的复杂工具续轮、推理输出预算和长上下文能力可能无法完整使用。建议先建立 transport adapter 和可保留原生字段的消息格式，再逐个接入需要的协议。

**3. 网络异常、空响应和截断恢复：我们的处理更偏向直接结束。**

我们已对不支持 `stream_options` 做兼容重试，对明确的上下文溢出进行额外压缩重试，并拒绝执行断流中的不完整工具调用。但普通 429、5xx、网络断开通常直接抛错；`finish_reason=length` 也直接失败，没有文本续接、推理预算耗尽分类或已配置的备用模型恢复链。[响应与错误处理](https://github.com/FoyonaCZY/AelionBot/blob/e8a5c1c10ea25be982cbe7256b07bc021c704444/electron/core/model.ts#L27)、[溢出重试](https://github.com/FoyonaCZY/AelionBot/blob/e8a5c1c10ea25be982cbe7256b07bc021c704444/electron/core/harness.ts#L252)

Hermes 有独立错误分类、可中断退避、客户端重建和已配置的 fallback 路径。空响应会区分确定性空结果与可能恢复的失败，并考虑重试成本。截断处理区分正文可续接、工具参数截断、重复输出和思考耗尽预算。[错误分类](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/error_classifier.py#L25)、[恢复链](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/turn_api_error.py#L250)、[空响应保护](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/empty_response_guard.py#L229)、[截断恢复](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/turn_truncation.py#L1)

建议优先补有界的模型请求恢复，避免一次短暂抖动使整项工作失败。工具副作用与模型请求要分开处理，不能把重试模型请求变成重新执行已发生的工具操作。

**4. 完成验证存在一个已复现的具体缺口。**

我们有 `pendingFailures` 门禁，会要求模型处理尚未解决的失败。但这个 Map 以工具名为 key：同名工具后续成功，会删除之前的失败记录，即使操作的是另一文件。[失败记录更新](https://github.com/FoyonaCZY/AelionBot/blob/e8a5c1c10ea25be982cbe7256b07bc021c704444/electron/core/harness.ts#L313)

本次使用真实 `Harness`、模拟模型和模拟 VM 返回值进行隔离验证，没有调用模型 API 或操作真实文件：

| 步骤 | 模拟返回 / 实际 Harness 行为 |
|---|---|
| `file_write(A.txt)` | failed |
| `file_write(B.txt)` | done |
| 模型声称两个文件都完成 | run 被标为 completed |

问题说明：这不是“模型必然会这样做”的频率测量，而是现有完成检查确实可能放过这种结果。应把失败、成功与验收证据关联到调用 ID、目标文件和任务要求；B 成功不能替代 A 的修复。

Hermes 的文件修改结果按路径记录，后续同一路径成功才清除对应失败；它还提供 verify-on-stop 和 pre-verify hook 等停止门禁。需注意 `verify_on_stop` 当前默认关闭，不能说 Hermes 默认会替所有任务做独立验收。[按路径记录修改失败](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/turn_explainers.py#L177)、[停止门禁](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/turn_stop_gates.py#L104)、[开关默认值](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/verification_stop.py#L50)

**5. 单 Bot 的工具执行仍较简单。**

我们在提示词和请求参数中要求一次一个工具，即使收到多个调用也顺序执行。VM shell 命令和 Windows host 命令主要受 120 秒限制，没有一等的后台进程句柄、日志游标、等待完成事件。`python_execute` 也是通过 VM 启动 Python 程序。[顺序执行](https://github.com/FoyonaCZY/AelionBot/blob/e8a5c1c10ea25be982cbe7256b07bc021c704444/electron/core/harness.ts#L293)、[VM 执行](https://github.com/FoyonaCZY/AelionBot/blob/e8a5c1c10ea25be982cbe7256b07bc021c704444/electron/core/vm.ts#L247)、[Host 超时](https://github.com/FoyonaCZY/AelionBot/blob/e8a5c1c10ea25be982cbe7256b07bc021c704444/electron/core/host.ts#L57)

Hermes 会把批次划成安全并行段和串行屏障，考虑白名单、文件路径重叠和显式允许的 MCP。后台 terminal 返回可跟踪进程，支持 poll / wait / log；程序化工具调用可在一段 Python 中通过 RPC 调多个工具，本地后端有每会话的持久 kernel。[分段调度](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/run_agent.py#L1272)、[冲突规则](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/tool_dispatch_helpers.py#L27)、[后台进程](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/tools/terminal_tool_background.py#L129)、[程序化工具调用](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/tools/code_execution_tool.py#L1)

建议先支持独立读取的批处理和长进程句柄。桌面鼠标、键盘、用户确认等有共享状态的操作应保留串行边界。多 Bot 已能并行，不代表单 Bot 内部也具备这些能力。

**6. 上下文压缩已有实质实现，主要欠缺统一接口和更多恢复分支。**

我们已经具备 BPE 估计、工具/图像预算、完整 exchange 尾部保留、确定性工具裁剪、结构化摘要、原文锚点、压缩收益检查、修订/hash 防过期提交，以及一次格式修复和冷却。这些不应再列为缺失。[ContextEngine](https://github.com/FoyonaCZY/AelionBot/blob/e8a5c1c10ea25be982cbe7256b07bc021c704444/electron/core/context-engine.ts#L21)、[预算与裁剪](https://github.com/FoyonaCZY/AelionBot/blob/e8a5c1c10ea25be982cbe7256b07bc021c704444/electron/core/context-budget.ts#L24)

差异在于：Hermes 有可替换的 ContextEngine 生命周期和 request-time `select_context` 接口，以及更丰富的摘要失败分类、过度压缩保护、原生协议状态保留和恢复路径。我们的单聊与群聊目前是两套准备路径；群聊虽复用 token、摘要格式和裁剪函数，却没有完整复用单聊的 usage 校准、技能恢复快照和 epoch/修复机制。[Hermes 接口](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/context_engine.py#L56)、[压缩失败处理与恢复锚点](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/context_compressor.py#L568)、[Aelion 群聊压缩](https://github.com/FoyonaCZY/AelionBot/blob/e8a5c1c10ea25be982cbe7256b07bc021c704444/electron/core/group-history.ts#L37)

建议统一压缩引擎，保留 Bot / 群聊的数据作用域。`select_context` 是扩展接口，不能把默认空实现说成已经自动获得检索增强。Hermes 的逐轮微压缩默认关闭；原生压缩也有开关、模型和路由限制，应按需接入。[微压缩默认关闭](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/micro_compaction.py#L1)、[原生压缩条件](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/native_compaction.py#L29)

**7. 缓存和辅助任务成本还可以管理得更明确。**

我们的后台复盘会继承上下文及工具定义，输入过大时改用有界资料；这已经是在考虑缓存和成本。不过系统消息会混入本次任务、时间、记忆等变动内容，没有原生 cache-control 策略。`ModelClient` 解析了 cachedTokens，但当前 `model_usage` 只保存输入、输出和估计 token。[本项目用量表](https://github.com/FoyonaCZY/AelionBot/blob/e8a5c1c10ea25be982cbe7256b07bc021c704444/electron/core/cognitive-store.ts#L31)

Hermes 为特定供应商处理稳定前缀、cache breakpoints/TTL；默认记忆在 session 开始时冻结，复盘 fork 尽量复用父上下文字节，并可单独配置辅助模型。Aelion 的记忆是在新 run 时重新取快照，更新能更快进入下一次任务，但缓存边界更粗。[缓存标记](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/prompt_caching.py#L1)、[记忆快照](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/tools/memory_tool_store.py#L68)、[复盘缓存一致性](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/background_review.py#L825)

另一个可直接调整的点是：Aelion 每累计 3 次工作类工具调用额外请求模型汇报进度。所审阅的 Hermes 主路径主要通过工具生命周期通知和模型中间文本展示进展；其工具进度可聚合显示。本项目这项固定次数策略应单独评估是否有信息增量，而不是视作 Harness 必需开销。[Aelion 进度请求](https://github.com/FoyonaCZY/AelionBot/blob/e8a5c1c10ea25be982cbe7256b07bc021c704444/electron/core/work-progress.ts#L5)、[Hermes 工具通知](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/tool_executor.py#L905)

建议先补缓存 token、推理 token、模型请求耗时和辅助任务用量，再测真实缓存收益；仅靠静态源码不能量化节省比例。

**8. 技能沉淀基础接近，长期治理仍有差距。**

我们现在会在前台和复盘开始时提供技能清单，支持关键词搜索、分页、按需读正文、同名更新、版本记录、来源引用、后台先读后改及用户/外部技能保护。不能再把“Agent 不知道已有技能”列为当前缺陷。[技能清单](https://github.com/FoyonaCZY/AelionBot/blob/e8a5c1c10ea25be982cbe7256b07bc021c704444/electron/core/skill-catalog.ts#L7)、[复盘写入限制](https://github.com/FoyonaCZY/AelionBot/blob/e8a5c1c10ea25be982cbe7256b07bc021c704444/electron/core/learning-worker.ts#L92)

Hermes 进一步提供局部 patch、支持文件写入、结构 lint、使用记录、pin、生命周期标记、归档恢复与 curator。重复读取未变化技能时可返回短引用，压缩后重置该去重状态，避免正文已经丢出上下文却仍返回“读过了”。我们目前 `skill_read` 每次返回正文，`skill_save` 主要整体写入 SKILL.md；相同内容也会增加版本。[局部技能管理](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/tools/skill_manager_tool.py#L432)、[结构检查](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/tools/skill_linter.py#L1)、[重复读取去重](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/tools/skills_tool_dedup.py#L1)、[Aelion 保存](https://github.com/FoyonaCZY/AelionBot/blob/e8a5c1c10ea25be982cbe7256b07bc021c704444/electron/core/skill-library.ts#L132)

这里要区分读取去重与语义重复合并。Hermes 的 curator 可按使用时间维护生命周期，但 LLM 合并 `consolidate` 默认关闭；它也不是永不产生近似技能的保证。建议先补内容未变不写新版本、读取去重、局部修改和可恢复归档，再考虑按需的语义合并。[Curator 与默认值](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/curator.py#L25)

**9. 自动学习策略有值得保留的产品差异。**

Aelion 在成功任务满足工具次数或偏好信号时复盘，允许不保存；限制为 16 次模型调用、3 项知识更新和累计输入预算，队列落 SQLite，新前台任务会抢占。Hermes 的技能复盘有累计迭代触发间隔，默认初始化为 10，并在交付之后按条件启动；复盘同样有 16 轮限制，默认累计输入预算 600,000，可配置辅助模型。[Aelion 触发与队列](https://github.com/FoyonaCZY/AelionBot/blob/e8a5c1c10ea25be982cbe7256b07bc021c704444/electron/core/learning-worker.ts#L14)、[Hermes 触发](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/turn_finalizer.py#L588)、[Hermes 复盘预算](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/background_review.py#L148)

Hermes 当前技能/合并复盘提示词倾向积极更新，把没有产出的复盘视作错过学习机会；这比我们“看过已有技能后，由模型判断是否值得保存”的政策更积极。结合本产品此前对重复内容和资源消耗的要求，建议保留当前允许不保存的政策。Hermes 针对本地模型的 idle review queue 是内存中的 best-effort 队列，我们已落盘的队列也有自己的价值。[Hermes 技能复盘提示](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/background_review.py#L368)、[闲时队列边界](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/review_idle_queue.py#L1)

扩展层面，Hermes 的 MemoryManager 可将会话生命周期分发给内置和外部 memory provider；我们的 MemoryService 目前固定使用应用自己的 SQLite/Markdown 投影。外部记忆服务属于可选扩展，优先级低于当前执行可靠性问题。[MemoryManager](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/memory_manager.py#L1)

**10. 持久化与恢复已有基础，还没有形成完整的执行恢复机制。**

我们保存原始会话、工具结果、intent/result 日志及 SQLite 认知数据。应用重启后，运行中的任务标为 interrupted，未配对工具结果补为 unknown，并提醒先核对副作用；这是有意避免盲目重放。主状态仍通过同步原子替换整体写入 state.json。[Aelion 恢复](https://github.com/FoyonaCZY/AelionBot/blob/e8a5c1c10ea25be982cbe7256b07bc021c704444/electron/core/store.ts#L39)、[状态写入](https://github.com/FoyonaCZY/AelionBot/blob/e8a5c1c10ea25be982cbe7256b07bc021c704444/electron/core/store.ts#L59)

Hermes 的 transcript 有增量 SQLite flush、配对/元数据修复和多类恢复脚手架；工具完成通知在规范结果写入之后发出。另有可选文件系统 checkpoint/rollback，使用独立 shadow Git store 和写入 ledger，避免直接污染用户仓库。这与我们已经有的上下文 epoch 是不同层次的检查点。[增量持久化](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/session_persistence.py#L179)、[先写入再通知](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/tool_executor.py#L1010)、[文件检查点](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/tools/checkpoint_manager.py#L1)

建议增加逐调用执行状态和恢复核对流程，逐步把大体量主历史改为增量存储，并对文件修改提供可选回滚。这些措施仍不能保证任意外部操作“恰好执行一次”，未知结果必须有独立核对策略。

**11. 多 Agent 的组织方式不同，适合在现有群聊下补充任务协议。**

我们已有长期 Bot 身份、每 Bot 的模型/记忆/技能、单聊与群聊、私聊转主任务、事件分发以及独立工作桌面。Hermes 的 delegate_task/subagent lifecycle 更侧重父任务下的子任务：有角色、上下文、工具范围、句柄、等待/取消和结果回收；worktree 隔离是可选项，默认关闭。[Aelion 私聊调度](https://github.com/FoyonaCZY/AelionBot/blob/e8a5c1c10ea25be982cbe7256b07bc021c704444/electron/core/peer-chats.ts#L20)、[群聊调度](https://github.com/FoyonaCZY/AelionBot/blob/e8a5c1c10ea25be982cbe7256b07bc021c704444/electron/core/group-chats.ts#L25)、[Hermes 子任务生命周期](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/agent/subagent_lifecycle.py#L242)、[可选 worktree 隔离](https://github.com/NousResearch/hermes-agent/blob/314e36536365281a5b1438e7026a4f226bedff5d/tools/delegate_tool_config.py#L101)

建议在现有私聊/群聊之下增加统一任务委托记录：目标、输入、负责者、产物、验收证据、阻碍和成本。独立桌面已经解决鼠标争用，但我们的 Bot 仍共用一台 VM 和底层系统；桌面隔离与完整计算隔离需要分别描述。

**建议的实施顺序**

| 次序 | 工作包 | 可验证的完成标准 |
|---|---|---|
| 第一批 | 按调用与目标记录失败；完善模型请求恢复和原生消息字段 | A 失败/B 成功不能误完成；429 后能有界恢复；截断工具不执行；需要续传的原生字段可正确回放 |
| 第二批 | 可配置长任务预算、Todo/任务验收、后台进程句柄、安全批处理 | 超过 30 步仍能受预算约束地推进；长进程可等待和取消；冲突写入与桌面操作保持顺序 |
| 第三批 | 单聊/群聊统一上下文服务、缓存与辅助调用统计、进度节流 | 两类会话遵循相同压缩不变量；能按用途核算成本；无新增信息时不额外汇报 |
| 第四批 | 技能使用记录、读取去重、局部修改、归档与可选合并；执行恢复/回滚 | 技能增长有可观察依据；压缩后能重新获取全文；误改可恢复；未知副作用不会自动重放 |

对照评测应固定模型、工具、输入和预算。建议覆盖：失败文件与成功文件混合；429/断流/空响应/输出截断；长于 30 步的任务；超长工具输出后的继续执行；重复读取技能及压缩后再读；多个 Bot 协作时取消其中一个。记录成功率、误完成率、重复副作用、恢复耗时、输入/输出/缓存 token 和辅助调用占比，再决定哪些机制确实值得移植。

原有 `Harness-Implementation-v04.md` 是历史实施记录，其中“尚未实现群聊/多 Bot 协作”等条目已过时。本次研究不修改运行逻辑，也不以静态对照代替真实任务质量评测。
