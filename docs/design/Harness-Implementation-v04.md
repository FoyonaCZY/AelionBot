# Harness 0.4：上下文与自动沉淀

这份文档记录本轮实际实现及其来源。此前的 [Hermes Lite 设计](Harness-Hermes-Lite.md) 仍是更大的目标架构；本文不代表其中的多 Bot 协作、全部知识治理和外部记忆供应商已经完成。

## 源码对照

2026-09-05 固定了以下公开仓库提交。完整文件清单、大小和 SHA-256 保存在 `harness-reference-manifest-v04.json`；原始源码仅供阅读，未作为运行时启动。

| 项目 | 固定提交 | 对照机制 | 本轮采用 |
|---|---|---|---|
| Hermes | `2afd17a9d722036272ea98437f23f81ccc2eec63` | [background_review.py](https://github.com/NousResearch/hermes-agent/blob/2afd17a9d722036272ea98437f23f81ccc2eec63/agent/background_review.py)、[技能写入保护](https://github.com/NousResearch/hermes-agent/blob/2afd17a9d722036272ea98437f23f81ccc2eec63/tools/skill_manager_guards.py) | 回合后受限复盘、前台抢占、记忆与用户偏好分桶、先读后改、按任务类别沉淀、保护用户及外部技能 |
| Codex | `a7a4321593c77933c18f84ba9bd28eba095759d8` | [compact.rs](https://github.com/openai/codex/blob/a7a4321593c77933c18f84ba9bd28eba095759d8/codex-rs/core/src/compact.rs)、[压缩生命周期](https://github.com/openai/codex/blob/a7a4321593c77933c18f84ba9bd28eba095759d8/codex-rs/core/src/compact_token_budget.rs) | 将当前状态与历史压缩区分，保留取消及压缩生命周期；不把旧摘要作为当前授权 |
| OpenCode | `e2894562f8ba943d72172d10b727c24d5f650c16` | [会话压缩](https://github.com/anomalyco/opencode/blob/e2894562f8ba943d72172d10b727c24d5f650c16/packages/opencode/src/session/compaction.ts)、[核心检查点](https://github.com/anomalyco/opencode/blob/e2894562f8ba943d72172d10b727c24d5f650c16/packages/core/src/session/compaction.ts) | 先清理旧工具正文，预留输出空间，再生成阶段摘要；处理供应商的上下文溢出响应 |
| Pi | `da840b6216578c2a571d0374ac6a2091a83f9d91` | [compaction.ts](https://github.com/earendil-works/pi/blob/da840b6216578c2a571d0374ac6a2091a83f9d91/packages/agent/src/harness/compaction/compaction.ts) | 按 token 保留尾部，避免切断工具调用与结果，结构化保留目标、约束、进展和下一步 |
| OpenHands SDK | `f47083cc370a85160f0348f32e531ee3514399e5` | [LLM condenser](https://github.com/OpenHands/software-agent-sdk/blob/f47083cc370a85160f0348f32e531ee3514399e5/openhands-sdk/openhands/sdk/context/condenser/llm_summarizing_condenser.py) | 独立压缩模块、原始历史与压缩视图分离、检查实际压缩收益 |

Claude Code 仅作为公开行为参考，依据其[上下文说明](https://code.claude.com/docs/en/how-claude-code-works)和[压缩后内容恢复说明](https://code.claude.com/docs/en/context-window)，没有将它描述为已经审阅过的开放源码实现。

这些对照是机制分析，没有做同模型、同任务的跨产品性能排名。OpenAI [原生压缩接口](https://developers.openai.com/api/docs/guides/compaction)具有自己的协议，本轮仍通过用户的 OpenAI 兼容 Chat Completions 服务生成可移植摘要，未声称支持不透明的原生压缩状态。

## 上下文处理

运行前组合以下内容：稳定系统规则与本次记忆快照、程序保留的当前请求与未解决工具错误、历史摘要及原始结果锚点、已使用技能的有限快照、最近完整交流单元。

1. 使用 `o200k_base` BPE 计算文本与工具定义，显式为图像预留空间；收到供应商 usage 后向上校准估计。它仍不是对任意模型都精确的 tokenizer。
2. 从窗口中扣除输出预留和控制余量，接近可用输入预算时才整理。默认输出预留上限 4096，控制余量约为窗口的 8%；参数属于 Aelion 的实现选择。
3. 对旧工具正文进行确定性裁剪，保留结果 ID、错误、退出码、文件位置以及首尾内容。原始 WireMessage 与完整结果不改写。
4. 按 token 选择保留尾部。工具调用、对应结果和随附截图作为一个完整单元；不跨越未完成的工具关系。
5. 摘要使用固定字段保存目标、约束、完成事项、待办、决定、错误和下一步。格式无效时仅允许一次受预算约束的格式修复。
6. 检查摘要大小、实际释放空间、原始范围 hash、取消状态和旧版本号，再提交新的压缩记录。失败保留原视图并进入冷却；当前必要内容本身过大时明确停止。
7. 供应商明确返回上下文溢出时，最多额外压缩一次并重试模型请求；已经执行过的工具不会被自动重放。

大历史在摘要输入中可能只提供单条内容的首尾，摘要会收到明确标记；因此不能把压缩视为无损。完整内容仍可通过来源 ID 回查。

## 历史和持久存储

`cognition.sqlite` 使用客户端内置 SQLite 和 FTS5。中文长词使用 trigram 全文检索，短查询有匹配回退；查询和展开都限制在当前 Bot。`history_search` 返回来源消息 ID，`history_read` 返回原消息片段及少量邻近记录。

SQLite 同时保存压缩版本、覆盖范围、尝试记录、知识修订、撤销标记、复盘队列和模型用量。现有 `state.json` 与完整工具结果继续保留，没有以迁移为由删除历史。`model_usage` 分开记录前台、压缩、格式修复和后台复盘。

## 学习 Hermes 的自动沉淀

本轮以 Hermes 的真实复盘路径为依据，不等同于它的独立 `/review` 全权限审查功能。

- 成功且包含至少三次工具调用的工作，或明确的长期偏好/纠正，会排入复盘。显式要求不沉淀的任务跳过。
- 复盘在前台空闲后运行。新任务会抢占它；待处理任务按 Bot 合并，队列落盘，关闭应用后可保留尚未执行的任务。
- 尽可能继承主任务上下文和相同工具定义以复用缓存。输入过大或模型改变时使用有界资料；不会声称一定命中供应商缓存。
- 可见工具定义与实际权限分开：执行层只允许记忆、技能及历史读取。电脑、命令、MCP、对外发送都不可由复盘调用。
- Aelion 的本机单次许可规则保持有效：后台只读应用自己的技能，或前台已读取并存档的外部技能副本，不直接打开新的外部文件。
- 每次最多十六次模型调用、三项不同知识更新，还有累计输入预算。允许继续修正或撤销本次已写入内容；允许没有任何值得保存的内容，不为了“学习数量”制造条目。
- 工作记忆和用户偏好分桶，有界容量分别为 2200 和 1375 字符。支持添加、替换和删除；保存来源引用并保留修订，不能用工具文字伪造用户偏好。
- 复盘写入前检查知识修订，删除记录保留撤销标记，旧复盘不能覆盖新修改或原样恢复已删除事实。
- 技能围绕可复用任务类别组织，包含适用条件、参数化输入、步骤、验证和限制。临时环境错误、一次性金额和 Bot UUID 不作为通用规则保存。
- 自动复盘只维护它自己创建的私有技能。用户创建/安装的技能与外部来源保持只读；修改自动技能前先读正文，并检查读取后的内容 hash。
- 私有技能每次修改保留正文版本和来源任务。自动形成的流程标记为从源任务观察得到，不等同于已经在所有环境独立验证。

`MEMORY.md`、`USER.md` 是各 Bot 的可读投影；原有设置页仍可查看记忆。“设置 → 记忆”可开启或关闭后台整理。关闭的是后台复盘，前台明确调用保存工具仍然可用。

## 当前边界

暂未实现：多 Bot 知识共享、协作房间、完整任务 DAG、原生供应商压缩状态、自动技能合并/晋升、外部记忆供应商、任意脚本的后台执行。复盘使用已有主模型，没有增加一套新的模型账号设置。

后台候选的来源可以被程序核对，但其语义仍由模型提炼，不能保证永远不会记错。版本、来源、容量与撤销机制用于限制影响并支持检查；不把这些机制说成自动事实验证器。

移除记忆不等于删除原始会话、备份或已经发送给模型的内容。本轮实现的是知识写入的撤销标记与旧复盘隔离，没有声称实现全存储的隐私擦除。
