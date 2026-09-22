# AelionBot 上下文管理全量梳理，以及与 Hermes、Codex 的比较

审阅日期：2026-09-08。AelionBot 基线为 `v0.10.1 / 8c11e6fd577e7eb31849792bcc78d7eb7485f294`。研究期间工作区从 v0.10.0 更新到了 v0.10.1，差异为消息样式和版本文件。结束核对时另有文档预览功能的并行未提交改动；已检查附件与主入口的差异，它们没有改变本报告描述的模型附件输入、读取分页或认知初始化。为可复核，源码链接与 hash 均固定在上述提交。

Hermes 固定到 `c8aa5608c24e3636e77c267650c0f1f52e44adb0`，Codex 开源仓库固定到 `2cbbf0c9b542a36a1c3284b5e804917635b6f666`。两者都是本次查询得到的 2026-09-08 提交，而不是沿用旧研究快照。来源及文件 hash 见同目录 `Context-Management-Comparison-20260908.sources.json`。

方法：追踪源码、调用点和已有测试；直接运行本项目的 tokenizer 和预算函数，测量工具定义开销。未向实际模型发送测试任务，未运行 Hermes/Codex 的对照任务，不能据此声称谁的记忆准确率或任务成功率更高。Codex 的比较对象是公开 CLI/core 源码和官方文档，不把开源 main 的功能开关视为所有桌面版、云端或当前账户均已启用，也不推断服务端压缩模型的内部算法。

## 1. 核心结论

AelionBot 已经不是“截取最近几条消息”的简单实现。主会话和群聊具有独立历史、token 预算、工具结果外置、结构化摘要、原子压缩检查点、历史回查、长期记忆、技能目录与任务状态重新注入。这些机制能够支持长任务继续执行。

但它仍然是**有损摘要 + 有限原文 + 按需回查**。保存了原始数据，不代表模型始终看得到，也不代表现有检索工具能找回所有范围、所有字符。

当前最值得关注的差距是：

1. 主会话和群聊共用新引擎，Bot 私聊接收/回信整理阶段仍走旧压缩路径。
2. token 估算采用统一 tokenizer 加只增不减的校准倍数，没有使用 Hermes/Codex 那种“实际用量锚点 + 新增内容估算”的主要思路。
3. 摘要上限 3,000 token，近期原文的目标预算上限 12,000 token，不会随大窗口继续增长；摘要生成前还会截短原始消息。
4. 最新人类要求有额外保护，较早用户要求没有一个独立、完整、可版本化的约束台账。
5. 主历史检索没有覆盖全部群聊与私聊执行记录；普通消息读取也不是无限分页原文读取。
6. 工具 schema、系统提示、群聊附加材料形成明显固定开销，小窗口可能连必要信息都装不下。
7. 已支持 Responses 原生推理字段回放，但没有接入 OpenAI 原生 compaction；二者是不同能力。

这些是源码层面的机制与边界判断，不是实测质量排名。

## 2. 先区分五种“上下文”

| 层次 | 保存什么 | 模型是否每次都看见 | 当前保存位置/结构 |
|---|---|---|---|
| 原始运行历史 | 用户消息、助手输出、调用参数、工具返回引用、图像引用 | 否，较早部分压缩后移出请求 | `conversations`、`groupContexts`、`peerContexts`，正式应用写入 `state.sqlite` |
| 本次模型输入 | 系统规则、任务状态、摘要、技能参考、近期历史、工具 schema、选中的图像 | 是 | 每轮由 Harness 和 ContextEngine 构造 |
| 压缩检查点 | 摘要、覆盖位置、版本、锚点、来源 hash、压缩统计 | 当前摘要会注入，旧检查点不会全部注入 | `cognition.sqlite` 的 `context_heads/context_epochs` |
| 长期记忆 | 用户偏好、跨任务工作知识 | 在一次 run 开始构造记忆快照 | `memory_facts`，镜像到 `MEMORY.md/USER.md` |
| 长期技能 | 可复用流程、参考文件、版本与来源 | 默认只看有预算限制的目录；正文按需读取 | SkillLibrary 管理的技能文件与元数据 |

模型服务商的 **prompt cache** 是另一回事：它可能让重复输入更便宜、更快，但通常不会把那些输入从上下文窗口中扣除。不能用“缓存命中”代替压缩，也不能把本地 tokenizer 缓存当作模型记忆。来源：[主状态持久化][A2]、[认知数据库][A3]、[记忆][A4]、[协议层][A10]。

## 3. 每次实际请求按什么顺序组装

主会话的结构可概括为：

```text
system：Bot 身份/职责 + 执行规则 + 环境/权限说明
        + 本轮长期记忆快照 + 技能目录 + 协作/附件等规则
system：当前任务状态
system：已保存的任务清单、计划或目标（存在时）
assistant：历史结构化摘要 + 来源锚点（发生过压缩时）
assistant：已用技能的有限参考快照（符合条件时）
user：若最新 user 消息已被覆盖，额外重新放入
原始历史中 through 之后的消息（部分工具输出可能变成摘要）
tools：本轮允许使用的工具定义
```

这里的 `through` 是历史数组中已被摘要覆盖的边界，不是聊天 UI 的“第几条气泡”。用户可见消息、内部 wire 历史、执行记录并不一一对应。[组装代码][A1]

### 3.1 系统提示包含什么

包括 Bot 名称和职责、中文与结果真实性要求、VM 工作目录和独立桌面说明、附件读写与发送规则、工具顺序/批量读取规则、本机文件检索与修改规则、本机权限模式说明、技能目录、Bot 私聊/群聊协作规则、任务清单与目标工具规则、记忆归属规则。

根据本次入口还会附加：

- 用户明确选择的 Bot 身份，避免同名混淆。
- 私聊原始任务和转入主会话的受托范围。
- 群成员、群事件、原始任务与近期已发布消息。
- 连续输入、表情回应、旧生成被中断后的处理规则。
- “继续原任务”提示，要求核对成功/未知操作，避免盲目重做。
- 单聊中最近的群内工作参考；群聊中该 Bot 自己的主会话参考。

系统提示在 run 启动时构造，**不是每一次工具返回后从所有数据源重新完整生成**。任务 frame 和失败列表会在每轮准备时更新；同一 run 中刚写入的长期记忆先通过工具结果体现，完整记忆快照通常到下一次 run 才重新构造。这种冻结也会影响缓存与知识可见性。[Harness][A0]

### 3.2 程序重新注入的任务状态

主会话 frame 包含：

- 当前 run ID。
- 当前人类任务原文及来源消息 ID；对恢复任务会追溯原始人类消息。
- 最近两条其他人类请求，每条最多摘取 1,800 字符。
- 当前未解决的工具失败。
- 最近 8 个产物的名称、路径与 run ID。

此外，RunPolicy 注入保存的步骤清单；WorkItems 注入目标、状态、原因与总结。步骤完成需要引用实际成功执行的证据，不能只在摘要里写“完成”就通过验收。

这能降低摘要把失败写成成功的影响，但并不是所有事实都有程序化校验。自由文本约束、语义承诺和摘要事实仍可能被模型错误理解。[任务 frame][A1]、[任务策略][A12]、[计划/目标][A13]

## 4. token 如何计算、窗口如何配置

### 4.1 配置来源

默认模型和每个 Bot 的模型选择都带 `contextTokens`。输入允许范围为 8,000–1,000,000，初始值为 32,000。

从 Provider 拉取 `/models` 后，当前只保留模型 ID；**不会依据返回的模型元数据自动确定真实上下文容量**。把字段填写为 1,000,000，不会让实际只有 32K 的模型获得更大窗口。备用模型也没有独立的上下文容量记录与重新预算流程。[Provider 配置][A11]

### 4.2 估算公式

- 文本使用 `js-tiktoken` 的 `o200k_base`，不论当前是 OpenAI、Anthropic、Gemini 还是兼容 Provider。
- 每条消息加 5 token 开销，总请求再加 3。
- 消息正文与工具调用参数的 token 数，与 `native.data` 序列化 token 数取较大值，避免简单重复累计两份助手内容。
- 全部可用工具 schema 的 JSON 也计入预算。
- 图像另计预算，不把图片 ID 当成真实图像成本。
- 最后乘以校准系数，向上取整。

文本 token 结果按文本 SHA-256 缓存，缓存超过 2,048 项后清空。这只是减少本地重复分词的 CPU 工作。[预算代码][A5]

### 4.3 实际用量校准

初始系数为 1。如果 Provider 报告的 input token 比估算高出超过 2%，系数向上调整，再加约 5% 余量，最高 4；不会低于 1，也不会随低估风险消失自动下降。

校准按 `baseUrl + model` 生成键，保存在认知数据库；当前没有把 protocol 或 providerId 放入这个校准键。同一模型的主任务、群任务、压缩、后台复盘都可能贡献样本。

它属于**保守上调估算**，不是精确计费器。单次偏大的报告可能让后续长期偏保守；跨 tokenizer、图像与不透明推理字段的偏差，也没有分别建模。[校准代码][A1]

### 4.4 预算公式和实测数值

设窗口为 C：

```text
输出预留 O = min(4096, max(1024, floor(C × 20%)))
安全余量 S = max(768, min(8192, floor(C × 8%)))
输入预算 I = C − O − S
整理触发线 T = floor(I × 85%)
近期原文目标预算 = min(12000, max(1200, floor(I × 30%)))
摘要目标预算 = min(3000, max(600, floor(I × 12%)))
```

下表直接运行当前函数得到，不是手工估测。K 按十进制计。

| 配置窗口 | 输入预算 | 整理触发线 | 输出预留 | 近期原文目标 | 摘要上限 |
|---:|---:|---:|---:|---:|---:|
| 8,000 | 5,632 | 4,787 | 1,600 | 1,689 | 675 |
| 32,000 | 25,344 | 21,542 | 4,096 | 7,603 | 3,000 |
| 64,000 | 54,784 | 46,566 | 4,096 | 12,000 | 3,000 |
| 128,000 | 115,712 | 98,355 | 4,096 | 12,000 | 3,000 |
| 200,000 | 187,712 | 159,555 | 4,096 | 12,000 | 3,000 |
| 1,000,000 | 987,712 | 839,555 | 4,096 | 12,000 | 3,000 |

因此，“85% 压缩”指输入预算的 85%，不是完整窗口的 85%。32K 时约在总窗口 67.3% 的位置开始整理。

运行设置虽然默认 `maxOutputTokens=8192`，主 ContextEngine 传入的上限通常仍为 4096，ModelClient 再与运行设置取更小值。调大运行设置中的输出上限，不等于这条主路径自动获得更多输出空间。

当前全部 **71 个注册工具**的 schema 经 `textTokens(JSON.stringify(TOOLS))` 测得 **9,224 token**。实际会按可用服务、群聊/私聊、规划模式等过滤，不能把 9,224 当成每次请求的固定值；但这已经说明 8K 配置可能连完整工具模式的必要输入都容纳不了。[工具集合][A0]、[预算][A5]、[运行默认值][A14]

## 5. 每轮上下文整理的完整流程

### 5.1 不到触发线：直接继续

使用已有摘要边界之后的历史。工具执行不会必然触发一次压缩，也不会必然调用一次摘要模型。

### 5.2 超过触发线或被要求强制整理：先缩短旧工具输出

先计算保留尾部的边界。边界之前、超过 350 token 的工具消息尝试替换成确定性 digest，保留结果 ID、失败/退出码、路径、部分输出等。

这个阶段不调用模型，只处理请求副本，不修改原始 wire 历史。之后重新计数；如果已降到安全水平，可能无需生成历史摘要。

如果仍超过硬输入预算，再尝试对包括最近交换在内、具有 `resultId` 的大工具输出做 digest。这样一个刚返回的巨型结果也不会必然把会话堵死。[裁剪][A5]、[流程][A1]

### 5.3 必要输入本身过大：明确失败

系统提示、任务 frame、任务计划与工具 schema 本身如果已经超过 I，直接抛出 `ContextCapacityError`。不会通过删除当前任务要求强行继续。

因此压缩不是万能的。巨型用户要求、很长的角色设定、工具集合或不可压缩的任务状态，都可能造成无法恢复的容量错误。[容量保护][A1]

### 5.4 划分待摘要区和近期原文区

`exchanges()` 将一次助手 tool_calls、后续连续 tool 结果，以及相邻的带图像 user 观察消息视为一组；普通消息通常各自是一组。

从尾部向前累计 token，正常至少保留两个 exchange 单元；不足四组时常规边界返回 0，不直接压缩。这里不是“至少保留两个完整人类对话轮次”。

如果拟被压缩的前段存在缺失工具结果的交换，不跨过它。硬超限时，如果剩余交换全部完整，允许把整个剩余区都摘要化，再单独补回最新 user 消息。

尾部预算是目标值，不是绝对最大值；一个不可拆的巨大交换可能超出该值。边界计算主要看消息文本/原生数据，没有使用完整请求图像预算和校准后的每组成本，因此全请求计数仍需兜底。[边界算法][A5]

### 5.5 摘要模型到底看到了什么

摘要请求只提供：摘要专用 system 提示、旧摘要、本次待覆盖历史的序列化内容，以及目标大小。工具列表为空，不要求它继续执行原任务。

历史序列化包含 role、正文、工具名称/ID/参数、图像 ID。**不会把图像像素发送给摘要模型，也没有完整保留原生推理 sidecar。**

每条正文和每段调用参数先最多保留约 1,800 字符，采用约 65% 头部 + 35% 尾部，中间标记省略。总量仍超预算就反复减半；仍不够则按交换边界缩小本次覆盖区，后面可能再进行下一次摘要。

所以这是两层有损处理：先摘取原始材料，再让模型概括。长消息中间的关键约束或报错，可能在摘要生成前就已不可见。`abbreviated` 标记会告诉摘要模型材料不完整，但不能自动恢复省略内容。[序列化][A5]

### 5.6 摘要格式、校验和修复

摘要必须包含：`goal`、`constraints`、`done`、`pending`、`decisions`、`failures`、`next`。

提示词要求每个数组最多 8 项、每项最多 250 字符；实际解析器宽松一些，允许最多 16 项、每项最多 1,200 字符，goal 最多 1,000 字符。最终整体仍必须落在摘要 token 上限之内。

第一次格式不合格，会保存失败尝试，再发一次“只修复格式和压短、不补充事实”的模型请求。修复仍失败，拒绝提交本次摘要。JSON 结构正确并不等于语义正确；没有一个独立模型或程序逐条对照原文验证摘要事实。[校验与修复][A1]

### 5.7 成功后如何提交

- 校验待覆盖历史 SHA-256 未在生成期间变化。
- 校验上下文 revision 仍是预期版本。
- 重新估算新请求，要求至少减少 100 token。
- SQLite 事务同时记录新 epoch、边界、摘要、锚点和统计。
- 原始历史仍保留；下一次请求从新的 through 位置开始。
- 单次 prepare 最多成功压缩 8 段；不是最多 8 次网络请求，因为每段还可能有格式修复、网络重试或备用模型。

压缩失败后，该作用域进入 60 秒内存冷却；同模型配置下，即使 force 也会遇到这段冷却检查。冷却不随应用重启保存。只要当前请求仍低于硬输入预算，就可暂时带旧上下文继续；仍超限则报容量错误。来源：[ContextEngine][A1]、[原子提交][A3]。

## 6. 压缩后能保留什么，不能保证什么

| 内容 | 当前保护方式 | 边界 |
|---|---|---|
| 当前人类任务 | task frame 重新放入 | 主会话最强；群聊使用自己的事件 frame |
| 较早人类要求 | 最近两条节选 + 模型摘要 | 更早约束可能遗漏，不是完整约束清单 |
| 未解决失败 | 执行账本重新注入 | 不能完全覆盖模型理解错误或外部真实状态 |
| 计划/目标/验收步骤 | RunPolicy、WorkItems 重新注入 | 需要实际创建并维护计划；不是自动从所有对话抽取 |
| 最近原文 | 按 exchange 保留尾部 | 原文 token 目标最多 12K；硬压力下也可被摘要 |
| 路径/结果 ID | 机械锚点，最多 24 个 | 提取范围有限，不是完整实体索引 |
| 已加载技能 | 最多两个有限快照 | 不是所有技能全文，也不保证是文件最新版本 |
| 截图内容 | 最新图像 + 工具描述 | 被移出请求的图像像素不会由纯文本摘要完整保留 |
| 精确工具返回 | `resultId` 回查 | 工具最初就裁剪的数据不在归档里；需重读来源 |

机械锚点主要抽取工具结果 ID，以及结果中的 path、vmPath、sha256、commit 和调用参数中的 path。字段最多取 350 字符，最终去重后最多 24 项。不同于一个能自动维护全部 URL、PR、报错、版本和约束的实体数据库。

技能参考快照只在已经发生过压缩后考虑，最多两项；总预算为 `min(2500, 15% × I)`。群作用域还要求结果在该群 wire 历史里可见。快照注明来自历史版本，并指向原结果；需要最新正文应重新 `skill_read`。[快照和锚点][A1]

## 7. 工具结果、文件、图像与 MCP 如何避免撑满窗口

### 7.1 工具结果外置

主 Harness 将每次实际工具返回 JSON 保存到 `results/<resultId>.json`，然后写入消息 envelope：

- 返回文本长度不超过 7,000 字符：内嵌结果、resultId、executionId。
- 超过 7,000 字符：只带前 6,000 字符 preview 和 `truncated=true`，完整返回值仍在文件里。
- 压力进一步增大：ContextEngine 将这份 envelope 再缩成 digest。

“完整返回值”指工具交给 Harness 的返回值；不保证包含原始文件、命令或网页的全部数据。工具本身的扫描/文件页/输出限制仍然适用。

`read_result` 核对结果归属于当前 Bot，可以根据 offset 分页；使用通用文本页逻辑，默认 12,000 字符、最大 32,000 字符，并受页内行数限制。读回的这一页又成为新的工具结果，因此仍经过 envelope 和上下文预算。[结果写入][A0]、[结果读取][A8]、[文本分页][A15]

### 7.2 附件

文本附件随初始消息最多带 6,000 字符摘录，超长标记 truncated。`attachment_read` 每次最多返回 12,000 字符；二进制文件可以保存到工作目录，用程序或办公软件解析。不会无条件把整个 PDF/Office 文件原样塞入模型上下文。[附件][A16]

### 7.3 图像

实际发送时，在当前请求包含的所有图像引用中选择：

- 最近 2 张非附件图像，通常是工作电脑截图。
- 去重后的最近 10 张附件图像。

每张本地估算为 `max(1024, ceil(width/768) × ceil(height/768) × 1024)` token，再纳入整体校准。协议层传高细节图像。旧截图不是每轮都发，即使其观察说明仍在历史里。

“最新 user 消息”的补回判断仅按 wire role 查找，图像观察也使用 user role，不能把它理解成单独对“最后人类发言”的类型化保护；主会话真正的人类任务主要由 task frame 兜底。[图像选择][A17]、[预算][A5]

### 7.4 MCP 与内置工具

模型看到的是 Aelion 注册的 `mcp_list_servers/mcp_list_tools/mcp_call` 等工具。远程 MCP 全量工具 schema 不会自动全部展开为顶层 tools；Bot 先发现再调用。`mcp_list_tools` 支持 query，单次最多列出 100 个工具。发现结果仍占用普通工具输出空间。

内置工具则在本轮过滤后整体提供，没有统一的语义相关性检索器自动挑最小工具集。规划模式、群聊和私聊会缩减可见工具，但普通完整主会话仍有较大的固定定义开销。[工具筛选][A0]、[MCP][A18]

## 8. 长期记忆与技能沉淀不是上下文压缩

### 8.1 记忆容量与来源

每个 Bot 的长期记忆分工作知识与用户偏好：

- 工作知识总长最多 2,200 字符。
- 用户偏好总长最多 1,375 字符。
- 单项最多 600 字符。
- 支持 add、replace、remove；replace/remove 需要能唯一匹配原文。
- 完全相同的规范化文本不重复新增，但没有向量语义去重。
- 数据库保存来源引用、修订号、增删改审计。
- 已删除内容有 tombstone；后台复盘不应自动把相同文本重新写回。
- 凭据模式与已知秘密会被拒绝保存。

这些限制是字符，不是 token。中文与英文同样字符上限对应的实际 token 数不同。记忆满了需要模型合并/替换；不会自动无限扩容。[MemoryService][A4]

### 8.2 跨 Bot 记忆归属

别人转述“用户要你记住”本身不构成可信来源。系统解析真实人类消息与记忆目标，发起方不能把接收方的语气/角色偏好存为自己的记忆。

接收 Bot 在经过核验并转入自己的主会话后，才实际写自己的记忆；运行结束前还检查是否已调用 memory 且得到 saved/duplicate，避免只口头承诺。来源引用许可不等于获得发起方其他私有历史读取权。[归属路由][A19]、[执行检查][A0]

### 8.3 技能目录与重复读取

每次 run 开始先注入技能名称/描述目录，优先当前 Bot 私有技能，再列共享技能；不包含其他 Bot 的私有技能。

目录预算为 `max(500, min(4000, 15% × I))` token，描述最多 160 字符。目录装不下时明确说明不完整，并提示用 `skills_list` 搜索或分页。

`skill_read` 如果确认相同 ID、hash、完整 body 已在当前 prepared context 的工具消息中，就返回 alreadyLoaded。只有目录、旧摘要、外置 preview 或已经被压缩掉的正文，不算全文已加载；这样允许必要的重新读取。

保存相同名称和完全相同正文/描述会 no-op；已有技能更新受 hash 检查和版本记录约束。模型被要求先比较已有用途，但没有一个保证语义上绝不重复的全局合并器。[目录][A6]、[读取去重][A0]、[技能库][A7]

### 8.4 后台复盘的独立上下文

不是每句聊天都学习。通常要主任务 completed，且至少 3 次工具调用，或请求包含明确长期偏好/纠正关键词；用户明确不学习、仅路由消息、目标属于其他 Bot、表情等有排除条件。群聊直接运行和私聊接收并不统一进入主会话的 afterRun 学习路径。

后台默认启用，前台结束后约 2.5 秒尝试调度；前台忙则推迟，新前台工作可以抢占并将复盘重新排队。同 Bot 新 queued 复盘会 supersede 旧 queued job，不保证逐一复盘每个 run。

复盘上下文使用上一轮准备好的请求材料、工具定义，以及当前记忆、当前技能目录和通常最近 32 条用户/工具来源候选，每条来源摘录约 700 字符。它不只是对最后一句助手答复做总结。

如果超过 `min(I,28000)` token 或模型名变化，会把继承材料序列化压短。每次复盘最多 16 轮、最多改 3 项不同知识，允许继续修正本次写入；累计输入预算约为 `min(100000,4C)`。每次模型请求超时 90 秒。

允许执行的后台工具仅有记忆、技能读取/保存和历史/结果读取；为缓存兼容仍可能传入更多继承的工具定义，但真正执行时被白名单拒绝。后台技能只能修改自己创建的技能，且先读后改；知识 revision 变化会拒绝过期写入。该白名单和版本检查是执行约束，不只是一句提示词。[复盘入口][A20]、[LearningWorker][A21]

## 9. 单聊、群聊、私聊和定时任务的上下文边界

| 场景 | 历史作用域 | 引擎 | 特殊点 |
|---|---|---|---|
| 人类与 Bot 单聊 | 按 botId 的长期主会话 | ContextEngine | 多个 run 共享该 Bot 主历史；run 不等于独立聊天窗口 |
| 群聊中的一个 Bot | 按 groupId + botId | ContextEngine | 各 Bot 压缩边界独立，发布历史相同，执行痕迹各自不同 |
| Bot 私聊接收、回信处理 | privateSessionId | Harness 旧压缩路径 | 只提供联络/读取附件/转主任务等少量工具 |
| 私聊转主任务 | 接收 Bot 的主会话 | ContextEngine | 加入受托任务及真实人类来源，使用接收方自己的记忆和工作环境 |
| 定时任务 | 目标单聊/群聊的现有入口 | 跟随目标作用域 | 不额外建立一套通用定时任务压缩算法 |

### 9.1 群聊

只把带真实 messageId 的已发布群消息加入群历史；未发布的生成草稿不作为真实发言。自己已发布的消息映射为 assistant，其他成员/事件映射为携带 sender/kind/seq 等身份字段的 user 消息。不能仅因为 wire role 是 user 就当成新的人类授权。

历史包含自己实际执行的工具调用与结果，新消息造成中断后这些证据保留。旧格式群历史会先备份，再剔除未发布草稿并重建。

每次群事件还会附加成员、原始任务、最近 8 条消息等信息。该 Bot 自己的主会话参考有约 6,500 字符的目标限制，包括最近任务、产物、记忆和主会话摘要；缩减逻辑最多把 recent 减到两条，所以 6,500 不是所有字段加起来的绝对硬上限。

反向在单聊中，最近四个有工具调用的群任务会以短参考注入。它不等同于把全部群任务气泡再写入单聊原始历史。群模式禁止直接改长期记忆/技能和部分跨 Bot 委托工具，避免把群讨论直接转成私有知识修改。[群历史][A9]、[群参考][A22]、[群调度][A23]

### 9.2 私聊旧路径

使用 `JSON UTF-8 字节数 / 3` 粗估系统提示和近期上下文；超过配置窗口 60%，且消息数大于 10，才尝试摘要。通常保留末尾约 8 条，边界落在 tool 结果中则向后移动。

摘要是最多 1,500 字的自由文本，非空且比旧段短就可接受；没有新引擎的 JSON schema 校验、摘要修复、源 hash 校验和统一图像/schema 计数。最终粗估超过窗口 90% 就报错。

接收方通常先看到私聊请求、原始任务、最近两次自身任务状态；要开展工具工作则进入自己的主会话。发起方整理回信时最多截取 16,000 字符的答复，超长可通过私聊读取工具查看。[私聊调度][A24]、[旧路径][A0]

### 9.3 定时任务

定时触发携带计划身份与原任务，沿现有单聊/群聊执行入口推进；它不会自动清空历史，也不会默认复制所有 Bot 的上下文。权限审核还区分用户创建的计划与 Bot 创建的计划，不能把 Bot 自己写入的定时 prompt 无条件当成人类新授权。[群定时入口][A23]、[权限来源][A25]

## 10. 历史回查的实际范围与短板

`history_search` 使用 `cognition.sqlite` 的 SQLite FTS5 trigram，支持中文片段；查询长度至少 3 个字符时走 FTS，短查询走 LIKE。默认 8 条、最多 20 条。它不是 embedding/向量检索，也不是自动把所有相关旧对话加入每次模型请求。

当前同步对象是 `store.data.messages`。`peerMessages`、`groupRunMessages` 和群发布 transcript 没有全部进入这个统一索引。工具消息的 FTS 文本使用最多约 4,000 字符 digest；不是对外置结果文件全文建索引。

`history_read` 根据本 Bot 的来源消息 ID 返回相邻记录，前后各最多 3 条；每条仍最多摘取 2,200 字符。没有为普通超长用户/助手消息提供 offset 页参数。所以模型被提示“用 history_read 找精确原文”，但实际上对超长普通消息可能只能拿到首尾片段。

还有另外的读取入口：

- `group_read`：要求群成员资格，每次返回最后 10 条，单条最多 2,400 字符，能向前翻消息页。
- `bot_read_messages`：读取自己参与的私聊，每次最多 10 条，单条最多 4,000 字符。
- `read_result`：凭自己拥有的结果 ID 分页读取归档工具输出，所有权检查覆盖主会话、私聊和群执行记录。

因此“保存没有丢”和“恢复链路完整”需要分别验收。原始持久化较完整，模型可用检索覆盖仍不完整。[认知检索][A3]、[群读取][A23]、[私聊读取][A24]、[结果所有权][A8]

## 11. 协议状态、推理、缓存和切换模型

目前支持 Chat Completions、Responses、Anthropic Messages、Gemini 四条协议路径。助手的 native 数据按 protocol 与 `providerId/baseUrl/model` 键匹配后回放；切换到不兼容的身份时丢弃 native sidecar，使用通用正文和工具调用构造请求。

Responses 会请求并保存 `reasoning.encrypted_content`，采用 `store:false` 加完整 input 数组方式调用；没有 `previous_response_id` 续链，也没有发送 `context_management` 或调用 `/responses/compact`。不透明推理字段的保存不等于已经拥有服务端压缩。

Anthropic 将开头系统段合并，并放一个 ephemeral cache 标记。其他服务商可有自动缓存，但 Aelion 没有对它们统一设置缓存断点。system 的任务参考、群参考和技能目录会变化，task frame 紧随其后也不断变化；缓存效果必须看真实 usage，不能因为“传了 cache_control”就断言高命中率。

主摘要可以在换模型后继续使用，窗口按当前选择重新计算。原生不透明状态却可能因模型/路由变化失效。当前校准键没有 protocol，备用模型共用原容量，且 ContextEngine 的 usage 归因使用当前配置模型：这些都属于多模型场景值得补充测试的边界。[协议][A10]、[ModelClient][A26]、[校准][A1]

## 12. 不止主任务在消耗模型上下文

| 用途 | 上下文来源 | 当前限制/行为 |
|---|---|---|
| 主任务/群任务 | 前述上下文引擎 | 动态预算、工具 schema、图像 |
| 历史摘要/结构修复 | 待覆盖历史节选或已有候选摘要 | 无工具，同 Bot 模型，独立模型调用 |
| 后台复盘 | 已准备请求 + 当前知识 + 证据索引 | 独立白名单、轮数与输入累计预算 |
| 阶段性进度 | 任务摘录 + 最近 3 个相关工具步骤 + 可选最新截图 | 任务最多 1,800 字符、单步结果最多 1,100 字符，输出 256 token，30 秒超时 |
| 本机自动权限审核 | 程序提取的人类来源 + 本次拟操作 | 使用默认审核模型，无工具；payload 超 240,000 字符或估算超过该模型 75% 时转人工确认；输出 768 token，20 秒，无自动重试 |
| 创建 Bot 问候 | Bot 名称、职责 + 问候专用提示 | 无主历史、无工具，输出 1,024 token，45 秒 |

阶段性回复需要“有新的实际结果 + 达到时间间隔”，默认 60 秒，不是每次工具调用都回复。它是额外模型调用，成功的进度文本还会进入单聊历史或作为已发布群消息进入群历史。[进度][A27]、[权限审核][A25]、[问候][A28]

运行预算和上下文预算也不同：默认单次 run 最多 120 轮、60 分钟，累计 token 预算默认 0 表示不设该项上限；输入窗口预算则每次请求仍然生效。压缩会减少后续请求大小，但自身消耗调用、token 和时间。[运行设置][A14]

## 13. 持久化、重启和容量错误恢复

正式 Electron 入口启用增量 `state.sqlite`，WAL 和 FULL 同步，拆分存储消息、run 和各作用域 wire 历史；关闭时还写出 JSON 快照。`cognition.sqlite` 另存摘要、记忆、索引、复盘与统计，工具结果另存 JSON 文件，事件日志另存 JSONL。没有把这几种资源合成一个跨文件事务。[状态数据库][A33]、[正式入口][A34]

重启后：运行中任务变 interrupted，运行中执行变 unknown，缺失配对的工具调用补 unknown 结果，未完成计划暂停，后台 running job 重新排队。原始执行结果不会自动当作未执行重放。

容量不足时 run 记录 `contextIssue`：模型配置键、容量、估算和输入预算等。模型配置没变化时，继续按钮逻辑可阻止原样重试；调整模型/容量后继续原任务会继承原人类来源与执行证据，并在主引擎首轮要求整理。

源码风险：摘要边界是数组位置，重启补齐工具结果时当前只直接调整 legacy contextOffsets；认知数据库 head 的对应位置校验并不是一套完全的事件 ID 迁移机制。正常摘要禁止覆盖未配对交换，有助于规避；但历史修复、迁移或插入发生在已覆盖前缀内，仍值得增加专门回归测试。这里只标注实现边界，未在真实数据复现损坏。[Store 恢复][A2]、[ContextIssue][A29]、[恢复测试][A30]

### 13.1 统计数据的含义

ContextEngine 对外提供 estimatedTokens、inputBudget、toolTokens、imageTokens、epoch、compactions、prunedOutputs 和 lastIssue。这里的 compactions/prunedOutputs 是最近一次 prepare 中的计数，不是该 Bot 历史累计次数；epoch 则是持久化摘要版本。

即时统计保存在按 botId 索引的内存 Map，重启后不会从 epoch 自动恢复这一份视图，某个群任务也会更新该 Bot 的最近统计。它不等于按每个群和私聊分别展示实时用量。toolTokens/imageTokens 是估算分项，总 estimatedTokens 还包含整体校准，不能简单把分项相加当作服务商计费。

主状态的 modelUsage 与认知库 model_usage 是两套记录用途，不能直接拼在一起求和，否则可能重复统计同一次调用。主 ModelClient 会记录成功和失败请求；认知统计主要记录调用完成后的用途与校准数据。[ContextEngine][A1]、[ModelClient][A26]、[认知数据库][A3]

## 14. 与 Hermes 的具体比较

以下针对所固定的当前版本，不能沿用“所有窗口到 50% 就压缩”这样的老概括。

| 方面 | AelionBot 当前 | Hermes 当前公开实现 |
|---|---|---|
| 引擎扩展 | 固定 ContextEngine，私聊还有旧路径 | ContextEngine 抽象，可显式配置插件替代默认 compressor |
| token 判断 | o200k 全量估算 + 向上校准 | 实际 Provider 用量锚点 + 后续新增消息粗估，锚点可持久化恢复 |
| 触发阈值 | 输入预算的 85%，固定公式 | 配置默认 0.50，但小于 512K 窗口会 raise-only 到至少 0.75；再考虑输出预留、最小阈值和上限；特定 Codex OAuth 路由另有策略 |
| 压缩入口 | 主/群每轮请求前；溢出重试 | Agent 多个检查点 + Gateway hygiene 兜底 |
| 尾部策略 | 最多 12K 的目标预算；至少两个 exchange | 默认 lean，尾部目标按窗口 2.5% 并限制在 10K–25K，结合近期消息保护与压力降级；另有 legacy |
| 用户要求/精确标识 | 当前任务 frame、较早两条摘录、24 个锚点 | lean 额外组织用户原文、会话日志、机械标识索引与 session_search 恢复指针；仍受预算限制 |
| 摘要模型 | 同 Bot 当前模型，经一般 fallback | 独立 auxiliary compression 路由/后备链与专用超时控制 |
| 整理失败 | 不提交无效摘要；内存冷却 60 秒 | 分类型失败处理与持久化递增冷却，手动/已证实溢出有专门恢复入口 |
| 原文归档 | 主状态保留 + epoch | 默认 in_place，旧消息软归档、稳定 session ID，可继续检索 |
| 更小粒度整理 | 压力时确定性工具 digest | 可选 proactive prune、micro compaction、idle compaction；默认并非全部打开 |
| 原生压缩 | 尚未接入 | 指定模型和路由可选原生 Responses compaction；app-server 会话可由 Codex 自己负责 |
| 长期知识 | 每 Bot 有界记忆 + 技能复盘 | 有界文件记忆之外还有 memory provider 生命周期和可插拔接口 |
| 缓存 | Anthropic 主要一个 system 标记 | 有系统与滚动近期消息断点的缓存策略 |

来源：[引擎接口][H1]、[当前压缩器][H2]、[用量锚点][H3]、[配置默认值][H4]、[缓存策略][H5]、[记忆管理器][H6]。

### 14.1 Hermes 哪些地方确实更值得借鉴

最直接的是实际用量锚点、独立摘要路由、稳定 session 归档、精确原文/实体恢复通道，以及按原因区分整理失败。它们分别解决过早压缩、辅助成本、长期恢复和卡死问题。

默认配置里 micro_compact、独立 proactive prune 与 idle_compact 都是关闭的，不能把“支持”写成“每轮都执行”。Hermes 也明确注意到高频重写历史会破坏 prompt-cache 前缀，存在成本和停顿之间的取舍。[配置][H4]

### 14.2 Hermes 也不是无损、不会失败

默认 compressor 仍然有损。模型返回鉴权/配额、网络、截断或空内容等终止型摘要失败时，当前代码保留消息；其他失败是否中止受 `abort_on_summary_failure` 控制，该开关默认 false，部分场景仍可能使用本地 fallback 替代摘要。

这比“摘要失败必然丢光中段”或“任何失败都绝不损失上下文”都更复杂。源码的失败分类优先于文档中的概括描述。[失败分类及组装][H2]

Hermes 的 `lcm` 是可选择的替代引擎示例，不能据此说默认引擎已经是无损上下文管理。当前官方说明中还存在与源码细节不同步的段落，本报告对阈值和失败行为优先采用固定版本代码。[接口][H1]、[官方说明][H7]

## 15. 与 Codex 的具体比较

### 15.1 Codex 没有唯一一条压缩路径

固定版本的 `CompactTask` 根据 TokenBudget 功能开关、Provider remote compaction 能力和 RemoteCompactionV2 开关分派：

1. 本地编排的文本摘要：向模型请求接力摘要，然后重建历史；“本地”指由客户端编排，不代表完全离线。
2. 远端 compact：使用服务商提供的压缩返回窗口。
3. Remote V2：有单独的保留消息、图像预算和输出形状校验路径。
4. TokenBudget 路径：不进行模型/服务端摘要，启动新的 context window，走相同压缩生命周期。

第 4 项和 V2 的存在只证明源码支持，不能证明当前用户的 Codex 安装或托管服务采用它们。Aelion 目前没有这种多策略分派。[分派代码][C1]、[本地摘要][C2]、[远端压缩][C3]、[V2][C4]、[TokenBudget][C5]

### 15.2 token 统计和阈值

Codex ContextManager 使用服务端最后一次 token 用量，加上最后一个模型输出之后新增本地内容的估算；还根据服务端是否已经计入旧 reasoning 做不同处理。完整本地估算仍存在，图像/音频/加密内容有专门处理。它也不是完全没有估算。[ContextManager][C6]

自动压缩阈值可配置，未指定时走模型默认值。当前公开配置还能区分统计完整活动上下文，还是只统计保留前缀之后新增的正文。不能给所有模型套一个统一“95%”答案；源码里的有效窗口比例、模型窗口元数据、自动压缩阈值是不同字段。[模型元数据][C7]、[官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)

### 15.3 约束和环境不是只靠摘要传递

源码将初始上下文重建与压缩摘要分开，压缩发生在一轮开始前还是执行中，决定重新注入的位置；还保存 world-state 基线、上下文版本、消息 envelope 元数据等。换模型时会处理 compaction compatibility hash 变化，以及切到更小窗口之前的压缩需求。[压缩重建][C2]、[切换与触发][C8]

项目约束还来自 AGENTS.md：官方文档说明按全局、项目根到工作目录的层级合并，并有默认 32 KiB 总读取上限。Aelion 目前的任务 frame 有相同的“程序重注入重要状态”方向，但没有同等完整的分层项目指令与世界状态机制。[AGENTS.md 官方说明](https://learn.chatgpt.com/docs/agent-configuration/agents-md)

### 15.4 远端压缩保留的是不透明状态

OpenAI 官方 API 区分 Responses 请求中的服务端自动 compaction 与独立 `/responses/compact`。返回的压缩项不应解析为可读摘要；独立接口返回的是下一轮完整的规范窗口，应按返回结果继续，而不是只取压缩项。公开信息不支持“压缩绝对无损”的结论。[官方 Compaction](https://developers.openai.com/api/docs/guides/compaction)

Aelion 的 JSON 摘要便于审计、跨 Provider，但无法凭这一点复刻服务端对推理续接状态的处理；单纯复制 Codex 摘要提示词也不能获得同等的模型侧能力。

### 15.5 近期原文和工具配对

Codex 本地摘要路径对保留用户消息设置 20,000 token 预算；当前 Remote V2 定义 64,000 token 的保留消息预算，还有单独的 agent 消息和图像规则。它们对应不同分支，不能理解为每次都同时留 20K + 64K。[本地历史重建][C2]、[V2 保留逻辑][C4]

ContextManager 对缺少返回的调用补结果、去除孤立结果、按输入模态去除不支持的媒体；删除参与调用配对的旧项也会处理对应项。Aelion 已有配对保护和重启补 unknown，但类型化历史规范化范围较小。[Codex 规范化][C9]、[Aelion 边界][A5]

### 15.6 技能与长期记忆

Codex 官方技能文档同样采用先目录、后正文。当前目录最多约模型窗口的 2%；不知道窗口时按 8,000 字符处理，大目录先缩描述，必要时省略条目。Aelion 的目录预算是输入预算 15% 且最多 4K token，更偏固定封顶。[技能官方说明](https://learn.chatgpt.com/docs/build-skills)

也不能再把 Codex 概括为“只有 AGENTS.md、没有自动记忆”。当前官方配置已经有记忆生成、使用、提取模型，以及候选空闲时间、年龄与数量等控制。其可用性和开启状态仍须看具体客户端与功能配置；不是 Aelion 每 Bot 2,200/1,375 字符记忆桶的同一产品语义。[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)

## 16. 三者的总体差异

| 维度 | AelionBot | Hermes | Codex 公开实现 |
|---|---|---|---|
| 主要组织单位 | 长期 Bot + 主会话 + 群/私聊 | Agent/session + 多入口 Gateway | Thread/turn + 模型请求状态 |
| 基本续聊方式 | 文本摘要、原文尾部、任务 frame | 摘要、不同尾部策略、归档回查 | 多压缩策略，包含不透明远端状态 |
| 重要信息保留 | 当前任务、失败、计划、有限锚点 | 保护头尾、用户引用、实体索引、恢复指针 | 初始环境/约束重建、类型化上下文、保留消息 |
| 使用量反馈 | 全量 tokenizer 估算、向上校准 | 真实锚点 + 增量估算 | 服务端用量 + 本地新增内容/模态修正 |
| 归档恢复成熟度 | 数据保留较好，统一检索覆盖不足 | session 归档与检索配套较多 | rollout/历史状态与客户端工具体系；不等同于 Aelion 的检索 API |
| 跨模型普适性 | 通用 JSON 摘要、四种协议 | 多路由、多引擎与辅助模型策略 | 更贴近 Codex/Responses 能力，亦有本地摘要分支 |
| 多 Agent 特色 | 具名长期 Bot、群聊与记忆归属 | 委托子 Agent 与 session 隔离 | 多 Agent 与 thread 上下文机制 |
| 可观察性 | epoch、尝试记录、估算、用量、知识审计 | 冷却、压缩指标、归档与多阶段状态 | 压缩生命周期、trace、模型兼容信息与使用量 |

无法仅凭静态源码说“我们已经追平”“Hermes 一定更强”或“Codex 压缩不会忘”。有意义的比较应固定模型、任务、工具与成本预算，测量可恢复性和完成质量。

## 17. 我建议的改进顺序

此节是建议，本次没有修改运行逻辑。

### 优先级一：先保证细节确实能找回

1. 将主会话、群执行、私聊执行统一纳入带作用域和权限检查的历史索引。
2. 普通消息也提供 offset/长度分页；工具大结果提供全文关键词定位，不只检索 digest。
3. 创建独立的人类约束/决策记录：来源 ID、适用任务、被哪个后续要求覆盖、仍有效与否。压缩不能成为唯一约束来源。
4. 把私聊旧路径迁到同一个 ContextEngine，统一预算、配对和失败行为。

### 优先级二：减少不必要的压缩与固定开销

5. 引入实际使用量锚点 + 增量估算，协议/模型变化时失效重建；分离图像与不透明数据估算。
6. 用模型元数据确定窗口与输出限制，同时保留用户覆盖；fallback 使用自己的容量与兼容性信息。
7. 按能力组按需暴露工具，或提供工具发现机制；为 system、tools、知识目录、任务状态分别设预算与诊断。
8. 将稳定规则、当前任务和动态观察分层，尽量保持稳定前缀，真实统计缓存命中与辅助调用占比。

### 优先级三：提高长任务压缩质量

9. 摘要/尾部预算随窗口和任务类型调整，不永久把大窗口的长期状态压到 3K。
10. 将精确用户要求、路径/URL/版本/错误码机械抽取出来，与模型生成叙述分开保存。
11. 增加独立摘要模型与超时/后备配置；Provider 已确认溢出时允许一次绕过常规冷却的有界恢复。
12. 在明确兼容的 Responses 路由支持原生 compaction，并保留通用摘要作为另一策略；不默认对所有兼容 URL 发送新字段。

### 优先级四：建立可重复评测

建议场景：长中文任务中间有关键限制；跨三次以上压缩保留精确路径/版本；超大工具输出中间有失败；大量截图后回查旧截图；从大窗口切小窗口；群消息到来中断工具轮次；私聊委托记忆；摘要模型超时/错误/JSON 不合法；重启后恢复；缓存前缀变化。

指标：约束保留率、精确事实回查成功率、错误宣称完成次数、重复副作用次数、压缩前后输入大小、压缩等待时间、主任务/摘要/复盘/进度/审核的 token 分布，以及相同成本下的任务完成率。

## 18. 现有验证证据与尚未覆盖的部分

现有测试已覆盖：token 含工具/图像、工具配对、结构化压缩、错误/取消摘要不推进边界、源前缀变化拒绝提交、连续 epoch 与重启恢复、超大最新工具输出、巨型必要任务拒绝、群作用域隔离、中文搜索与 Bot 所有权、记忆修订竞争、后台权限白名单、技能目录和读取约束。

本次阅读了这些测试，但未把过去通过记录冒充为本次重新执行结果。实际新执行的是当前预算函数和 71 个工具定义的 token 测量。

尚缺对照证据：真实不同 Provider 的计数偏差、语义摘要准确率、长期多次压缩后的约束漂移、完整群/私聊检索恢复，以及 Hermes/Codex 同模型同任务的成功率和成本比较。静态发现的风险应先补回归，再做真实模型评测。[认知测试][A31]、[容量恢复测试][A30]、[群历史测试][A32]

## 来源索引

以下源码链接均固定 commit，便于复核。报告针对的是这次基线，不保证未来版本行为不变。

[A0]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/harness.ts
[A1]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/context-engine.ts
[A2]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/store.ts
[A3]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/cognitive-store.ts
[A4]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/memory-service.ts
[A5]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/context-budget.ts
[A6]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/skill-catalog.ts
[A7]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/skill-library.ts
[A8]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/tool-results.ts
[A9]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/group-history.ts
[A10]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/model-protocol.ts
[A11]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/model-providers.ts
[A12]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/runtime-policy.ts
[A13]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/work-items.ts
[A14]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/src/runtime-types.ts
[A15]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/file-text.ts
[A16]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/attachments.ts
[A17]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/src/model-images.ts
[A18]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/mcp-runtime.ts
[A19]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/memory-routing.ts
[A20]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/cognition.ts
[A21]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/learning-worker.ts
[A22]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/group-context.ts
[A23]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/group-chats.ts
[A24]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/peer-chats.ts
[A25]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/host-approvals.ts
[A26]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/model.ts
[A27]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/work-progress.ts
[A28]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/bot-greetings.ts
[A29]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/src/context-issue.ts
[A30]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/tests/context-recovery.test.ts
[A31]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/tests/cognition.test.ts
[A32]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/tests/group-history.test.ts
[A33]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/core/state-database.ts
[A34]: https://github.com/FoyonaCZY/AelionBot/blob/8c11e6fd577e7eb31849792bcc78d7eb7485f294/electron/main.ts
[H1]: https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/context_engine.py
[H2]: https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/context_compressor.py
[H3]: https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/usage_anchor.py
[H4]: https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/hermes_cli/config_defaults.py
[H5]: https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/prompt_caching.py
[H6]: https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/memory_manager.py
[H7]: https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/website/docs/developer-guide/context-compression-and-caching.md
[C1]: https://github.com/openai/codex/blob/2cbbf0c9b542a36a1c3284b5e804917635b6f666/codex-rs/core/src/tasks/compact.rs
[C2]: https://github.com/openai/codex/blob/2cbbf0c9b542a36a1c3284b5e804917635b6f666/codex-rs/core/src/compact.rs
[C3]: https://github.com/openai/codex/blob/2cbbf0c9b542a36a1c3284b5e804917635b6f666/codex-rs/core/src/compact_remote.rs
[C4]: https://github.com/openai/codex/blob/2cbbf0c9b542a36a1c3284b5e804917635b6f666/codex-rs/core/src/compact_remote_v2.rs
[C5]: https://github.com/openai/codex/blob/2cbbf0c9b542a36a1c3284b5e804917635b6f666/codex-rs/core/src/compact_token_budget.rs
[C6]: https://github.com/openai/codex/blob/2cbbf0c9b542a36a1c3284b5e804917635b6f666/codex-rs/core/src/context_manager/history.rs
[C7]: https://github.com/openai/codex/blob/2cbbf0c9b542a36a1c3284b5e804917635b6f666/codex-rs/models-manager/src/model_info.rs
[C8]: https://github.com/openai/codex/blob/2cbbf0c9b542a36a1c3284b5e804917635b6f666/codex-rs/core/src/session/turn.rs
[C9]: https://github.com/openai/codex/blob/2cbbf0c9b542a36a1c3284b5e804917635b6f666/codex-rs/core/src/context_manager/normalize.rs
