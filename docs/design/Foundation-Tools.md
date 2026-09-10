# 基础工具补齐

本次补齐七项能力：交互终端、多文件补丁、JavaScript 工具编排、会话内提问、本机看图、统一工具发现、公开网页检索。没有增加子 Agent 创建能力。

## 工具与行为

| 能力 | 工具 | 行为 |
|---|---|---|
| 交互终端 | `terminal_start`、`terminal_input`、`terminal_read`、`terminal_stop` | 本机使用 PTY 或管道，VM 使用带 host-key 校验的 SSH 通道及 PTY；支持持续输入、尺寸设置、增量日志与实际退出码。 |
| 多文件补丁 | `apply_patch` | 支持 Add/Update/Delete/Move、多片段、唯一上下文匹配。整批预检；本机写入失败时回滚已应用部分，并避免覆盖回滚期间的新改动。 |
| 代码编排 | `code_exec` | `await tools.name(args)` 调用当前授权工具，返回 `{executionId,resultId,result}`；`emit` 或 `return` 输出需要交给模型的数据。支持并行与条件逻辑。 |
| 用户提问 | `request_user_input`、`user_input_wait` | 一至三个问题，可选项或自由填写，显示在输入框上方并发出浮动通知。默认允许 Bot 继续独立工作；答案进入原会话。 |
| 本机图片 | `view_image` | 经本机读取权限后读取图片，使用现有 Electron 图像解码与预览通道送给模型，保留图片来源及 hash。 |
| 工具发现 | `tool_search`、`mcp_list_resource_templates` | 搜索当前可用内置工具和已启用 MCP；支持完整 MCP 工具集合与资源模板、资源列表分页。 |
| 网页检索 | `web_search`、`web_read` | 搜索公开网页，提取正文、标题、链接；按 Bot 保存有期限的分页快照。默认 Bing RSS，失败后尝试 DuckDuckGo HTML。 |

## 运行与权限

- 本机终端启动和每次非空输入均经过既有权限模式。输入审批包含原命令、工作目录和待发送内容，不能把先前命令的许可当作后续输入许可。
- PTY 使用固定版本 `node-pty`；Windows 生命周期适配关闭其拥有的 ConPTY 句柄和读取 worker，避免自然退出后残留工作线程。最多同时十二个运行终端，每个 Bot 六个。任务取消、Bot 删除和应用退出均清理相应资源；主动停止与进程自身失败的退出码分别报告。
- VM 终端复用现有 SSH 身份与 host-key 校验，没有改变代理或联网配置。它只在现有工作电脑就绪时连接，工作目录限定为当前 Bot 的目录。
- 多文件补丁中的删除/移动有独立权限类型，不会冒充普通文件写入走低风险自动放行。文件检查点开启时记录所有相关路径及实际写入回执。原文采用 UTF-8，已有 BOM、换行和文件权限得到保留。
- 代码编排运行在独立 worker 中的 QuickJS/WASM，不暴露 Node、文件、网络或进程接口。所有外部能力必须经过主进程的工具校验、权限与执行账本。每次编排最多一百次调用、八个并发；QuickJS 内存为 32 MiB，单段连续计算有两秒中断保护。默认总时限两分钟，可在参数中指定至十分钟。权限拒绝会终止整个编排，不能通过 JavaScript catch 后换工具重试。
- 当前任务不可用的工具不能通过代码编排调用，规划模式仍限制为读取和规划操作。每个嵌套调用保留自己的执行记录与结果 ID。
- 用户提问不同于权限审批。选项没有预提交的默认答案，所有问题回答后才可提交；自由填写可替代预设选项。任务结束前会等待尚未回答的问题，取消后不接受旧请求的回答。
- 网页工具不携带登录 Cookie、不运行页面脚本；逐跳验证 URL 与 DNS，绑定到核验的公开 IP，拒绝内网、回环和元数据地址。正文最多 2 MiB，分页快照按 Bot 隔离。搜索服务限流或验证页面会明确报错，不伪造结果。

## 小上下文与打包

对于小于 32K 的主会话上下文，直接工具菜单保留常用工具及 `tool_search`、`code_exec`，其余工具通过发现后编排调用。完整的可调用清单仍按会话、功能开关与规划权限过滤。这避免新增工具定义使 8K 模型无法发送首个请求。

`node-pty` 作为原生运行依赖保留并从 ASAR 解包，加载器使用真实解包路径。QuickJS 包及 WASM 作为运行依赖保留，代码 worker 由构建脚本单独生成。包版本与许可证见 `package-lock.json`、`THIRD-PARTY-NOTICES.md`。

## 验证

- `foundation-tools.test.ts`：补丁操作/回滚、VM 同构补丁、网页解析/访问边界、工具发现、提问、代码隔离、真实管道与 PTY。
- `foundation-harness.test.ts`：小窗口发现后执行、多文件实际写入、独立读取与异步回答、图片进入模型上下文、工具 schema。
- `terminal-vm.test.ts`：本地模拟 SSH 服务验证 PTY/输入/退出，以及 Bot 删除时的终端隔离清理；不启动 QEMU。
- 独立浏览器验证选项、自定义回答、未完成禁用提交、失败重试、小窗口布局。
- 独立 Electron/ASAR 运行时验证原生 PTY、图像解码和 QuickJS/WASM 加载；不启动正式客户端。

设计参考为 Codex 的 shell/write_stdin、apply_patch、code mode、request_user_input、view_image 和工具发现接口。本项目保留自己的权限与会话模型，不引入 Codex 的子 Agent 生命周期。
