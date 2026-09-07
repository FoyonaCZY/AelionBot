# 基础工具对照与改进

对照日期：2026-09-07。此轮围绕本机编码、工作电脑文件操作和结果读取，采用公开文档与源码中的具体机制。

## 参考依据

| 上游 | 观察到的机制 | Aelion 的采用方式 |
| --- | --- | --- |
| [Codex apply_patch](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/apply_patch.rs) | 解析并验证编辑，再通过文件系统及权限边界执行 | 局部编辑验证旧内容、文件版本和路径，复用现有审批与检查点 |
| [Claude Code 工具参考](https://code.claude.com/docs/en/agent-sdk/typescript) | 将文件读取、精确编辑、glob 和内容检索分为专门工具，提供读取范围与搜索输出模式 | 增加本机查找、内容检索、精确编辑及读取游标，降低对临时 shell 命令和整文件回传的依赖 |
| [Claude Code 执行循环](https://code.claude.com/docs/en/agent-sdk/agent-loop) | 允许只读工具并行执行 | 有界并发的批处理及时补充空闲槽位，独立读取不会等待无关的慢步骤 |
| [Gemini CLI 文件工具](https://geminicli.com/docs/tools/file-system/) / [编辑源码](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/edit.ts) | 工作目录边界、按行读取、忽略规则；编辑默认要求唯一匹配，多处替换需明确选择 | 保留 VM 工作目录限制，增加行范围与原文件哈希；未匹配、多处匹配或版本变化时要求重新读取 |

## 本轮改动

- `tools_batch` 支持本机读取、目录查看与检索。工具枚举和执行校验使用同一份注册表。错误分别指出步骤、工具、参数或依赖问题。
- 批处理采用持续补充任务的并发调度；失败依赖会跳过，即使没有 `$from` 引用也不会继续。输入在启动前复制，取消或权限拒绝会停止排队操作并撤回同批请求。规划阶段另有子工具限制。
- 每个批处理子步骤保存独立结果和执行记录，`read_result` 可读取自己子步骤的结果，并返回 `nextOffset`、`eof` 和截断信息。
- `host_find_files` 使用 glob 查找路径；`host_search_files` 支持单行文本或 JavaScript 正则、上下文、文件名/内容/匹配行数模式及分页。检索遵守选定目录及其子目录内的 `.gitignore`，跳过依赖缓存、链接、凭据和应用数据。
- 搜索在独立 Worker 中执行，限制并发、时间、读取量和返回数量。复杂正则不会占用主界面线程；达到扫描限制时需缩小范围。Worker 随客户端打包。
- 本机与 VM 文本读取提供行范围、可选行号、字符游标、文件哈希、EOF 和截断标记。保留旧的本机 `content`、VM `stdout` 及字符偏移调用；目录列表也支持分页。
- `host_file_patch` / `file_patch` 默认只替换唯一的原文匹配，并要求读取返回的 SHA-256。保留未修改内容、BOM、换行和文件权限；沿用写入审批和检查点。整文件写入可选择检查之前的哈希。
- 前台本机命令分别保留 stdout/stderr 的有界首尾，提供实际字节计数，避免大量标准输出挤掉最后的错误。修正长连续文本使旧脱敏正则反复回溯的问题。
- 后台日志保持已有进程 ID 和字节游标语义，补全 UTF-8 边界处理、待补齐字节及 `hasMoreLog`，避免分页拆坏中文和 emoji。

## 调用约定

1. 本机项目先查找文件和符号，再读取相关行。搜索返回的字符 `offset` 可用于 `host_file_read` 定位；修改前读取原文和 `sha256`。
2. 字符定位用 `offset`；行定位用 `startLine`（从 1 开始）和 `lineCount`，两种方式不混用。复制原文用于编辑时不要包含行号前缀。
3. 搜索的 `nextOffset` 是结果序号；文件读取和 `read_result` 是字符游标；后台日志是字节游标。应使用工具自己返回的游标。
4. `scanLimited=true` 表示检索没有覆盖全部范围，需要缩小路径或 glob；`eof` 仅表示本次结果集读完。
5. `read_result` 只能取回已经保存的工具记录。执行器省略的命令输出无法靠它恢复。需要完整日志时应在首次执行就重定向文件，不应为补输出重复有副作用的命令。
6. 后台日志有既有的 2 MB 保存上限。`hasMoreLog=false` 不表示任务完成，仍需核对进程状态、退出码和实际成果。

## 实现边界

文本文件工具保留 2 MB 的读取/精确编辑边界；其他编码和大型数据使用已有命令或专门文件工具。检索使用 Node.js Worker、[path.matchesGlob](https://nodejs.org/api/path.html#pathmatchesglobpath-pattern) 和 [ignore](https://github.com/kaelzhang/node-ignore)，不要求用户额外安装 ripgrep。正则语法与 ripgrep/PCRE 有差异；多行检索使用命令工具。

本机权限仍由会话模式决定；批处理、搜索和编辑不会授予或扩大权限。VM 代理和联网配置保持原有实现。

## 验证

- 完整测试：433 项，430 通过，3 跳过，0 失败；类型检查与生产构建通过。
- 使用独立资料目录、项目和本地模拟模型，在真实 Electron 客户端走通批量查找、内容搜索、读取原文、精确修改和读回验证；6 条执行记录全部成功，BOM 和 CRLF 保留。自动审批下常规项目操作未产生权限请求或权限模型调用。
- 实际 Electron ASAR 包验证搜索 Worker 正常启动和返回结果；开发与生产构建均包含 Worker。
- 1.5 MB 连续命令输出回归保留了最终 stderr 和真实退出码，修复后约 0.35 秒返回，原脱敏路径约需 100 秒。
- 发布文件审计通过。未运行真实用户模型请求或修改用户 VM。
