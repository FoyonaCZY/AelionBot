# 通用 Bot 可优化点：对照成熟 coding agent 与通用 agent

审阅日期：2026-09-20。只读源码与公开产品说明，不改实现。

这不是“把市面上每个功能都抄过来”的清单。每条都先写 AelionBot 通用 Bot 现在实际怎么做，再对照一组代表性产品，最后标成 **适合（fit）**、**冲突（conflict）** 或 **暂缓（deferral）**。冲突的意思是：做了会抹掉这款产品自己的形态，而不是“技术上做不到”。

## 范围与局限

“市面上所有成熟 agent”无法穷尽，也不该穷尽。下面这组覆盖两条已经成熟的产品线，用来判断差距是不是该进通用 Bot：

| 类 | 产品 | 为什么放进来 |
| --- | --- | --- |
| 终端 / IDE coding agent | Claude Code、Cursor、OpenAI Codex（CLI 与 Cloud）、Cline | 分别代表权限与计划、编辑器内并行与云端环境、补丁式改文件与云端任务、IDE 里人在回路加浏览器 |
| 通用多步 / 电脑使用 agent | Claude（原 Cowork，含本机 computer use）、ChatGPT agent（原 Operator，云端虚拟电脑与浏览器）、Devin | 分别代表用户自己的桌面、供应商托管的浏览器/虚拟电脑、以 PR 为交付的软件工程师 |

没核到的行为不写。价格、模型榜和基准分数不比较。设计师 Bot、152 套设计系统和官网文案只在“通用 Bot 不该吞掉什么”时出现。

## 产品定位（与 README 一致）

`README.zh-CN.md` 把 AelionBot 定义成**通用多 Agent 桌面工作空间**。通用 Bot 和设计师是两种类型，不是同一个执行器的两种皮肤：

| | 通用 Bot | 设计师 |
| --- | --- | --- |
| 任务 | 调研、写作、办公、代码、桌面操作 | 网页原型、PPT、网站复刻、设计修改 |
| 执行位置 | 受管理的 Linux VM，另可按权限操作本机 | 默认工作目录下的 `designers/<bot>/<task>`，不要求 VM |
| 组织方式 | 对话、`/plan`、`/goal`、群聊与 Bot 私信 | 独立设计任务、设计约定与成果 |
| 人的位置 | 能看 VM 桌面，能暂停，能接管 | 在预览里改文件，不走通用 Bot 的 Linux 桌面 |

通用 Bot 的优化必须同时保住三件事：可观看、可暂停、可接管的 VM 桌面；由用户指定的多 Bot 交接（群聊和私信，不是模型私下孵化工人）；本机操作的许可层（每次询问 / 自动审批 / 完全访问）。`docs/USAGE.md` 写明本机权限是应用里的审批层，不是操作系统沙箱。

## 已经对齐、不必再当成缺口去抄的能力

这些在当前源码里已经有对应物。对照产品有类似东西，不构成“还没有”：

- 多文件补丁：`apply_patch`（`electron/core/foundation-tools.ts`）。设计说明写明参考 Codex，不引入 Codex 的子 Agent 生命周期（`docs/design/Foundation-Tools.md`）。
- 交互终端：`terminal_start` / `terminal_input` / `terminal_read`，本机 PTY 或 VM SSH。
- 先问再做：`request_user_input`。这和权限审批是两条线。
- 计划与持续目标：`/plan`、`/goal`、`task_update`、`goal_set`。完成必须引用成功执行的 `executionId`（`electron/core/harness.ts` 的工具说明，`docs/USAGE.md`）。
- 本机三档权限，自动审批参考过 Claude Code 权限模式和 Gemini CLI 写入策略（`docs/USAGE.md`）。
- 技能与 MCP：发现 `.agents/skills`，并读取 Claude Code、Cursor、Codex 等既有 MCP 配置（`docs/INTEGRATIONS.md`）。
- 选定本机项目后会注入该目录的开发约定，并明确 VM `/work` 与本机目录不是同一处（`electron/core/harness.ts` 在 `run.workspaceDir` 存在时追加的说明）。
- 并行只覆盖读取：`tools_batch` 不执行写入、命令或界面操作。

## 优化项

### 1. 本机仓库上的查找与诊断还停在通用文本工具

**现状。** 本机查找是 `host_find_files`（glob）和 `host_search_files`（单行文本或 JavaScript 正则），在 Worker 里跑，不要求用户安装 ripgrep。文本读取和精确编辑上限 2 MB；多行检索要改走命令（`docs/design/Basic-Tools-Review.md`，工具定义在 `electron/core/harness.ts`）。没有语言服务、诊断或“跑这个仓库自己的测试命令并引用输出”的专用工具。改代码靠读文件、补丁和 `host_execute`。

**对照。** Claude Code 把读、精确编辑、glob 和内容检索分成专用工具，并允许只读并行（项目自己的对照记录在 `docs/design/Basic-Tools-Review.md`）。Cursor 为代码库做语义索引，大仓库靠缓存块嵌入加快首次查询（[Cursor 索引说明](https://cursor.com/blog/secure-codebase-indexing)）。Cline 在 IDE 里改文件、跑命令，并用人在回路批准每一步（[Cline 扩展说明](https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev)）。

**判断：适合。** 通用 Bot 做本机代码时，检索慢、2 MB 截断、没有项目诊断，会逼模型用 PowerShell/zsh 绕路，审批更吵，也更容易漏掉测试。可以加有界的本机检索（例如可选 ripgrep）和“读取编辑器/编译器诊断、运行用户已有的测试命令”。仍然走现有权限和执行账本。

**不要做成：** 把通用 Bot 收成 Cursor 那种编辑器。内联补全、Tab 接受补丁，和“对话旁边看文件、VM 里看桌面”不是同一产品。那是冲突，不是下一张工单。

### 2. Git 和 PR 只有“自己会敲命令”

**现状。** 没有 `git_status` / `git_diff` / `git_commit` 工具。本机 `host_execute` 可以使用用户已登录的 `git` 和 `gh`，命令最长 6000 字符、默认 120 秒，不接受交互输入（`electron/core/harness.ts`）。破坏性 git 操作只靠权限模式和模型自觉。

**对照。** Codex CLI 有 `codex review`，Cloud 任务的 diff 用 `codex apply` 应用到本地，冲突时 `git apply` 失败即非零退出（[Codex CLI 参考](https://developers.openai.com/codex/cli/reference/)）。Devin 的交付物是沙箱里做完后的 pull request，并有自动自检（第三方对 Devin 的综述，见文末来源；不把某一篇评测分数当成事实）。Cursor 可以在浏览代码时改 PR、推分支（[Cursor changelog](https://cursor.com/changelog)）。

**判断：适合，但自动推送是冲突。** 适合把 `status` / `diff` / 暂存说明做成只读或可审批的结构化结果，让模型少用一条含糊的 `git add -A && git commit`。推送、强推、合并仍然每次询问。不要学云端 agent 默认开 PR。通用 Bot 的代码成果应留在用户选定的目录和对话附件里，由人决定要不要送上远程。

### 3. 文件检查点盖不住 shell 和桌面改动

**现状。** `checkpoint_list` 写明：开启后只覆盖 `file_write` 和 `host_file_write`，不含 shell 或桌面程序改过的文件（`electron/core/harness.ts`）。实现上限是单文件 2 MB（`electron/core/file-checkpoints.ts`）。`computer` 用真实应用改文档时，不进这套检查点。

**对照。** Claude Code 和 Codex 改的是用户仓库里的文件，撤销单位是 git 工作区，不是“只记住走了写文件工具的那几次”。Codex Cloud 的 diff 用 `codex apply` 落回本地，冲突时 `git apply` 失败即停（[Codex CLI 参考](https://developers.openai.com/codex/cli/reference/)）。ChatGPT agent 和 Devin 的虚拟电脑本身可丢弃，所以它们不太依赖应用内的单文件检查点。

**判断：适合。** 在本机项目上，用用户仓库自己的 git 作为撤销，比再做一套 2 MB 文件备份更贴 coding agent 的习惯，也和上面的结构化 git 是一件事。VM 里由 LibreOffice 或浏览器下载改过的文件，适合在 Bot 工作目录内做一次任务前快照，而不是把整块系统盘当成撤销栈。整盘快照已经属于 VM 存储策略（`docs/vm-storage.md`），不要和文件检查点混成一个按钮。

### 4. 两个执行位置容易让模型和用户都选错

**现状。** 系统提示在有本机项目目录时要求：围绕该项目用 `host_*`，VM `/work/<botId>` 是另一处（`electron/core/harness.ts`）。桌面、浏览器、Writer/Calc/Impress 在 VM。调研示例却是“资料伙伴在 VM 里收集”（`README.zh-CN.md`）。`web_search` / `web_read` 又不进 VM。

**对照。** Claude Code 和 Cline 默认就在你打开的那个仓库里。ChatGPT agent 的浏览器和终端都在供应商的虚拟电脑里，不碰到用户磁盘，除非走连接器。Devin 的编辑器、shell、浏览器在同一个沙箱里。

**判断：适合把路由说清楚，冲突于合成一个位置。** 优化是让通用 Bot 在任务开始时显式选定“这次的主现场”：本机项目、VM 工作目录，或两者之间的交付（例如 VM 里做出的报告再 `message_attach`）。不要取消 VM，也不要让本机仓库变成唯一执行面。那会拆掉“可观看的工作电脑”和“本机项目按权限改”这两条产品线。

### 5. 桌面操作是像素循环，等待上限 2 秒

**现状。** `computer` 先截图，再用 `observationId` 和像素坐标点击、打字、滚动。`action=wait` 最长 2 秒（工具说明，以及 `electron/core/computer.ts` 里 `Math.min(2000, ...)`）。`open_app` 只有浏览器、文件、编辑器、Writer、Calc、Impress、终端。`request_user_control` 在登录和验证码时把 VM 交给用户，交还后必须按新截图核对，不能假设登录成功。

**对照。** Claude 的 computer use（Cowork / Claude Desktop，Pro 与 Max，beta）直接操作用户 macOS 或 Windows 屏幕：点击、输入、打开应用；macOS 15+ 可以在后台窗口工作，不抢走用户的键鼠（[Claude 帮助中心](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork)）。ChatGPT agent 继承原 Operator 的云端浏览器，看渲染后的页面而不是只读 HTML（[Operator 并入 ChatGPT agent 的公开记述](https://aiwiki.ai/wiki/openai_operator)）。Cline 的浏览器步骤会带回截图和控制台日志（[Cline 扩展说明](https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev)）。Devin 后来给自己的环境加了 Linux 桌面，用来点自己做出的界面并回放录像（第三方综述，见来源）。

**判断：适合加强 VM 里的观察，冲突于去开用户自己的桌面。** 适合在现有 Bot 桌面里增加可核对的浏览器信号：可访问性树或 DOM 摘要、控制台错误，仍然把画面留在用户能接管的那块 VNC 上。纯像素加 2 秒等待，对要登录、要等渲染的调研和办公很脆。

直接去点用户的 Windows/macOS 桌面是冲突。那样用户不能在侧栏里看同一块受管理的 Linux 桌面，暂停和接管的对象也不再是 VM。Claude 自己的说明也把“用你的电脑”和“云端任务够不到本机文件”分开；AelionBot 已经选了 VM 作为可观看的手。

### 6. 公开网页工具不跑脚本、不带登录

**现状。** `web_search` 走公共搜索，限流就报错，不编造结果。`web_read` 只取公开 HTTP/HTTPS 正文，不带 Cookie，不执行页面脚本，拒绝内网、回环和元数据地址（`electron/core/foundation-tools.ts`，`docs/design/Foundation-Tools.md`）。需要登录或前端渲染的页面，只能改用 VM 里的浏览器。

**对照。** ChatGPT agent / 原 Operator 的价值就是在隔离浏览器里点真正渲染出来的页面，并在后果大时停下来等人（公开记述见上）。Claude 也有内置浏览器和 Claude in Chrome，本机浏览器要求桌面应用开着（[Cowork 云端说明](https://support.claude.com/en/articles/15811196-what-to-expect-with-claude-cowork-in-the-cloud)）。

**判断：把“该用浏览器”路由做好是适合；给 `web_read` 加登录态是冲突。** 静态抓取适合公开文档。登录后的后台、单页应用应打开 VM 浏览器，让用户看得见，并在验证码处走 `request_user_control`。若 `web_read` 开始携带用户 Cookie 或访问内网，就绕过了桌面接管和现有网络边界。

### 7. 没有模型私下孵化的子 Agent

**现状。** 协作单位是用户创建的 Bot。`bot_delegate_task` 发出带验收条件的委托，排队不等于完成，禁止轮询；回执要 `executionId`（`electron/core/harness.ts`）。群聊由人拉人，`README.zh-CN.md` 写明“谁负责什么，由你决定”。`docs/design/Foundation-Tools.md` 写明没有增加子 Agent 创建。群聊任务里还拿掉了 `history_search`、`memory`、`bot_delegate_task` 等（`harness.ts` 对 `options.groupOrigin` 的过滤）。

**对照。** Claude Code 有内置 Explore/Plan 子代理和可自定义子代理，权限从父会话继承，也可用权限规则禁止 `Agent` 工具（[子代理文档](https://code.claude.com/docs/en/sub-agents)，2026-09-15）。Cursor Projects 的协调者不写代码，把工作分给大量子代理，在云端电脑上跑，合上笔记本也不停（[Cursor changelog，2026-09-10](https://cursor.com/changelog)）。

**判断：隐藏子代理是冲突；把已有委托显示清楚是适合。** 用户是按职责建 Bot 的。模型再偷偷开一串工人，许可、记忆和“你在看哪一块桌面”都会拆开。只读探索若要做，也必须出现在当前任务的执行记录里，不能写文件，不能变成第二个未命名 Bot。Cursor 那种云端协调者加上千子代理，和本地多伙伴桌面不是同一形态。

### 8. 计划和目标会停，云端产品默认继续跑

**现状。** `/plan` 先列出步骤，用户点开始才允许改项目。`/goal` 持续执行到有证据或明确阻碍；达到预算或应用退出就留下进度，不自动重跑（`docs/USAGE.md`）。定时任务执行时应用要开着（`README.zh-CN.md`）。连续三次只回复、不推进未完成任务，会停止自动重试（`electron/core/harness.ts` 的 `continueUnfinishedWork`）。

**对照。** Claude Code 的 plan 模式在改动前先探索（[权限模式](https://code.claude.com/docs/en/permission-modes)，2026-09-16）。Claude 把原 Cowork 并进对话后，不碰本机的任务可以在云端继续，合上电脑也行；本机文件、本机 MCP 和 computer use 仍要桌面应用开着（[云端 Cowork 说明](https://support.claude.com/en/articles/15811196-what-to-expect-with-claude-cowork-in-the-cloud)）。Cursor 云端代理和定时订阅同样不依赖笔记本合着。

**判断：证据门和“退出不自动重跑”应保留（冲突于改成云端常驻）。适合把恢复说清楚。** 通用 Bot 的长任务绑在这台电脑和这台 VM 上。优化是应用再次打开时，把暂停的目标、未完成计划和定时任务显示成可继续，而不是悄悄再跑一遍。不要为了“合上笔记本还在做”把执行搬到供应商云上。那样 VM 桌面和本机许可都不在用户眼前。

### 9. 本机许可不是沙箱

**现状。** 三档：每次询问、自动审批（工作目录内普通读写和能识别的简单文件命令）、完全访问。自动审批不放行敏感配置和越界写入。VM 接管和远程 MCP 仍走各自流程。文档明确这不是操作系统沙箱（`docs/USAGE.md`）。

**对照。** Claude Code 另有 sandbox 开关，bypass 模式被文档限制在隔离环境；deny 规则在多种模式下仍然生效（[权限模式](https://code.claude.com/docs/en/permission-modes)）。Codex CLI 也有 sandbox 与审批档（CLI 参考中的 `sandbox` / `execpolicy`）。Cline 的默认姿势是每步批准，而不是沙箱（扩展说明）。

**判断：适合给本机命令加可选的操作系统级限制；把“完全访问”再放宽是冲突。** 沙箱应包住 `host_execute` 和本机终端：默认工作目录、禁止摸到凭据路径，逃逸时回到询问。VM 不受这层沙箱管辖，否则“工作电脑里的浏览器和办公软件”会被误伤。完全访问已经是用户显式选择，不要再做一个绕过询问、又没有沙箱的模式。

### 10. 上下文压缩有硬顶，群聊里不能回查历史

**现状。** `contextBudget` 把近期原文尾部限制在 `min(24000, max(1200, 输入预算的 30%))`，摘要限制在 `min(3000, max(600, 输入预算的 12%))`（`electron/core/context-budget.ts`）。任务帧会重新注入当前要求和最近两条其他人类请求（每条最多 1800 字），并提示用 `history_search` 找回原文（`electron/core/context-engine.ts`）。群聊来源的运行会去掉 `history_search` 和 `history_read`（`electron/core/harness.ts`）。小于 32K 的主会话只把常用工具放进菜单，其余靠 `tool_search`（`docs/design/Foundation-Tools.md`）。没有为计数单独打一次模型请求（`docs/context-counting.md`）。

**对照。** 2026-09-08 的 Hermes/Codex 对照（`docs/design/Context-Management-Comparison-20260908.md`）描述的是当时 v0.10.1，其中“token 校准只增不减”“私聊走旧压缩”已不能当作今天的行为。今天的预算函数和 `ContextEngine.prepare` 路径以上面的源码为准。Claude Code 用子代理把探索挡在主上下文外面。Cursor 用项目级长期上下文，跨云端和本机同步（changelog 中的 Projects）。

**判断：适合把群聊里的回查补上，冲突于为了窗口去删掉多 Bot 隔离。** 摘要上限 3000 对长调研会丢约束。适合让摘要预算随窗口变大而变大，同时保留“最新人类要求重新注入”和“摘要不是授权”。群聊里禁用历史检索，是为了不把别的私聊混进来；优化应是允许检索**这个群自己的**记录，而不是打开所有 Bot 的记忆。私聊和群聊隔离是产品规则（README：群聊不混入无关私聊），放宽隔离是冲突。

小上下文把 `computer` 等工具藏进 `tool_search`，可能让通用 Bot 在小模型上根本不碰桌面。这是暂缓：先看真实小窗口会话是否因此失败，再改菜单，不要凭感觉把全部工具塞回 8K 请求。

### 11. 办公成果在 VM，视觉交付在设计师

**现状。** 通用 Bot 用 VM 里的 Writer、Calc、Impress，以及预装技能里的办公脚本（`docs/bundled-skills.md`：脚本是 AelionBot 自己的实现，不打包 Anthropic 的 DOCX/PPTX/XLSX 技能正文）。技能要求看真实导出，而不是只信脚本退出码。设计师另有 `design_deck` 等，在本机 `designers/` 里出可编辑 PPTX，不启动 VM（`README.zh-CN.md`，`electron/core/designer-loop.ts`）。

**对照。** Claude 在 2026-09-16 把文档和幻灯片放进同一条对话，可下载 PowerPoint 或 PDF（[Claude 博客](https://claude.com/blog/cowork-is-now-claude)）。ChatGPT agent 在虚拟电脑里处理文件和表格。两者都不区分“通用执行者”和“预装设计系统的设计师”。

**判断：适合把交接做明确，冲突于把设计师流水线并进通用 Bot。** 通用 Bot 应继续在 VM 里算表、导出文档，并核对打开后的结果。需要版式和设计系统时，用现有群聊或私信把资料交给设计师，而不是让通用 Bot 再长出一套 152 个设计系统。Claude 把 Docs/Slides 收进同一个聊天，符合它“一个 Claude”的形态，不符合这里“类型分开、执行位置分开”。

### 12. 没有 Bot 时，侧栏仍显示“正在等待工作电脑桌面”

**现状。** `computerDesktopReady` 为真（VM `ready`、应用环境好、没有维护、不需要重启）时，侧栏渲染 `Vnc`。`Vnc` 没有 `url` 就显示“正在等待工作电脑桌面”（`src/ui.tsx`，`src/App.tsx`）。拉 URL 的 `ensureComputerDesktop` 在没有 `desktopBot` 时直接返回。没有 Bot 时这个等待不会结束。桌面是按 Bot 开的（`electron/core/vm.ts` 的 `ensureBotDesktop`）。

**对照。** 这不是某一家竞品的功能缺口。Claude 和 ChatGPT 的电脑使用都发生在已经开始的会话里。Devin 的桌面属于那个工程会话。

**判断：适合。** 没有通用 Bot 时，侧栏应说明“创建通用 Bot 后才会打开它的桌面”，或显示工作电脑已就绪但未绑定会话。继续转圈会让人以为 VM 没启动。设计师类型本来就不走这块桌面，更不应显示这条等待。

### 13. 群聊没有自己的权限档

**现状。** 权限按 Bot 保存。从群聊接下来的工作沿用该 Bot 的档，群聊没有单独的选择（`docs/USAGE.md`）。一个设成完全访问的 Bot，在群里被 @ 到，本机操作不再询问。

**对照。** Claude Code 子代理可以单独指定 `permissionMode`，父会话的 deny 仍然适用（子代理文档）。Cline 默认每步都问。

**判断：适合让继承看得见，冲突于在群里再发明一套更弱的隐式许可。** 群消息里应标出“将使用某某 Bot 的完全访问”。若要收紧，应收紧到该 Bot 的设置，而不是群聊偷偷降级或升级。不要为了好看，让群聊绕过 Bot 已经保存的规则。

### 14. 技能包进 VM 之后，原环境的工具并不跟着走

**现状。** 共享技能只发现 `.agents/skills`。`skill_materialize` 把包复制到该 Bot 的 VM 工作目录。文档写明其他 Agent 的工具名、登录态和 Windows 程序不会跟着走，脚本得能在 Linux VM 里跑（`docs/INTEGRATIONS.md`）。`allowed-tools` 不授予新权限。

**对照。** Cline 可以让模型自己写一个 MCP 并装进扩展，工具以后留在 IDE 主机上（扩展说明）。Claude Code 的技能和钩子跑在用户本机仓库旁。Cursor 云端代理要单独准备依赖装好的环境（changelog 里的 cloud agent builds）。

**判断：适合做执行前检查，冲突于为了兼容技能去改 VM 的联网和登录策略。** 在 materialize 之前说明这个技能依赖哪一种位置（本机还是 VM），缺了什么命令。不要把技能作者机器上的 Windows 可执行文件或浏览器配置文件装进 VM。那既破坏隔离，也超出现有“不复制凭据”的规则。

### 15. 本机改动直接落在用户目录，没有工作树隔离

**现状。** 本机读写相对会话选定的工作目录（`docs/USAGE.md`；有目录时 `electron/core/harness.ts` 把 `host_*` 的默认位置指到该目录）。并行的是多个 Bot 的 VM 目录 `/work/<botId>`（`electron/core/vm.ts` 的 `ensureBotDesktop`），不是同一个 git 仓库的多个 worktree。`tools_batch` 不能并行写（`electron/core/harness.ts`）。

**对照。** Cursor 3 用 `/worktree` 把并行 agent 分到不同检出（第三方对 Cursor 3 Agents Window 的整理，指向 Cursor 3.0 changelog）。Claude Code 也有 worktree 入口。Devin 的云端环境本来就不是用户当前检出。

**判断：暂缓。** 对“两个通用 Bot 同时改同一本机仓库”有用。但产品默认是人选定一个目录，并在对话旁看到这个目录里的文件。自动再建 worktree，用户会找不到成果，也和“文件留在工作空间”冲突一半。只有在用户明确要求并行改同一仓库时才值得做，且成果必须能指回原目录。在那之前，靠不同 Bot 的 VM 目录隔离已经覆盖“各做各的分析”这种协作，不必先抄 IDE 的 worktree。

## 按判断归类

**适合先做（不改变三种形态）：**

1. 无 Bot 时不要显示不会结束的桌面等待（第 12 条）。改动面在展示，不在 VM。
2. 本机项目的检索、诊断和测试输出，仍走权限和账本（第 1 条）。
3. 结构化、默认可撤销的 git 查看；推送保持询问（第 2、3 条）。
4. 任务开始时写明主现场是本机、VM，还是两边交接（第 4 条）。
5. VM 浏览器补充可访问性或控制台信息，保留接管（第 5、6 条）。
6. 群聊可检索本群记录；摘要预算随窗口增长；权限继承要在群里看得见（第 10、13 条）。
7. 再次打开应用时露出可继续的目标、计划和定时任务，不自动重跑（第 8 条）。
8. 技能 materialize 前检查运行位置（第 14 条）。

**冲突，不要排进通用 Bot：**

- 用用户整机桌面替换 Linux VM 桌面。
- 模型私下创建子代理，或云端协调者在合上电脑后继续改本机文件。
- `web_read` 携带登录 Cookie 或访问内网。
- 把完全访问再做成无沙箱、无询问。
- 把设计师的设计系统和 PPT 流水线并进通用 Bot，使用户不再区分类型。
- 为了对齐 Cursor，把产品收成带 Tab 补全的 IDE。

**暂缓，等有具体失败再做：**

- 小窗口是否因工具被折叠而不再使用桌面（第 10 条末）。
- 本机 git worktree（第 15 条）。
- 多个模型并行试同一改动（Cursor 的 best-of-n、Codex Cloud 的 attempts）。会多份互相覆盖的本机改动，和单工作目录的许可模型不合，除非隔离做得和 worktree 一样可见。

## 来源

产品行为以仓库内文件为准，路径写在各条里。对照产品只采用这次能打开的公开说明：

- Claude Code 权限模式：https://code.claude.com/docs/en/permission-modes （页面时间 2026-09-16）
- Claude Code 子代理：https://code.claude.com/docs/en/sub-agents （页面时间 2026-09-15）
- Claude computer use（原 Cowork）：https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork （2026-09-16）
- Claude 云端任务与本机能力的分界：https://support.claude.com/en/articles/15811196-what-to-expect-with-claude-cowork-in-the-cloud （2026-09-16）
- Claude 文档/幻灯片并入同一对话：https://claude.com/blog/cowork-is-now-claude （2026-09-16）
- Cursor 更新：https://cursor.com/changelog （2026-09-10 的 Projects 描述）
- Cursor 代码索引：https://cursor.com/blog/secure-codebase-indexing
- Codex CLI：https://developers.openai.com/codex/cli/reference/
- Cline：https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev
- Operator 并入 ChatGPT agent 的公开年表：https://aiwiki.ai/wiki/openai_operator （页面写明独立 Operator 站点于 2025-08-31 下线）

Devin 的 PR、桌面回放和 Outposts 来自第三方综述，不把评测分数写进建议。Cline 桌面版（2026-09-14 的公告）和 Cursor 3 的 worktree 细节同样只作方向参考，不作为“因此 AelionBot 必须有并行会话”的依据。
