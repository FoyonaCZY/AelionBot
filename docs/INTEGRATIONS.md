# 复用已有技能与 MCP

AelionBot 自动从 `.agents/skills` 发现共享技能，并扫描兼容的 MCP 配置文件。原文件保留在原处；在设置中可以查看来源、重新扫描和添加自选位置。

## 技能目录

推荐共享目录为 `%USERPROFILE%\.agents\skills`，每个技能一个目录：

```text
~/.agents/skills/my-skill/
  SKILL.md
  scripts/
  references/
  assets/
```

`SKILL.md` 使用 [Agent Skills 格式](https://agentskills.io/specification)：YAML frontmatter 中包含 `name`、`description`，随后是 Markdown 正文。该规范规定技能包格式；不同 Agent 的发现目录仍存在差异。

```markdown
---
name: csv-review
description: 检查 CSV 数据并核对汇总结果。
---

读取输入文件，检查必需列，计算结果，并重新读取输出核对。
```

启动会扫描：

| 范围 | 兼容位置 |
|---|---|
| 用户共享 | `~/.agents/skills` |
| 项目共享 | 项目及仓库内祖先目录下的 `.agents/skills` |
| Aelion 内置 | `<数据目录>/skills/builtin` |
| Aelion 私有 | `<数据目录>/bots/<botId>/skills/<技能名>/SKILL.md` |

共享技能只自动发现 `.agents/skills`，不再扫描其他 Agent 的私有技能目录或它们的环境变量指定位置。手动添加的自选目录仍按用户配置加载。

项目位置默认为客户端启动目录，可通过 `AELION_PROJECT_DIR` 指定。`AELION_CONFIG_HOME` 可覆盖 `~/.aelion`。环境变量取自客户端启动环境。

技能目录按真实路径去重；不同来源的同名技能分别保留，Bot 用来源 ID 区分。启动只提供技能元数据，正文和资源按需读取。旧版 Aelion 的内置、私有技能首次启动自动迁移为 `SKILL.md` 文件，之后以文件为准；旧 JSON 记录仅保留作迁移备份。

Bot 可以直接读取包内相对文本资源，也可以把整个技能包同步到自己的工作电脑目录再执行脚本。同步保留 `scripts/references/assets` 的相对关系，上限 500 个文件、16 MB；不复制凭据文件、依赖缓存或越出技能包的链接。

其他 Agent 的专属工具名、登录态和 Windows 程序不会随技能自动迁移。脚本需要能在工作电脑的 Linux 环境运行，并具备相应依赖。技能声明的 `allowed-tools` 不授予新的执行权限。

## MCP 配置

MCP 协议没有规定所有客户端共用的全局配置目录。Aelion 的自有配置为 `%USERPROFILE%\.aelion\mcp.json`，使用常见的 `mcpServers` 结构，同时读取各客户端既有位置：

| 来源 | 自动读取的配置 |
|---|---|
| Claude Code | `~/.claude.json` 的全局及当前项目配置；项目 `.mcp.json` |
| Cursor | `~/.cursor/mcp.json`、项目 `.cursor/mcp.json` |
| Codex | `$CODEX_HOME/config.toml` 或 `~/.codex/config.toml`；项目 `.codex/config.toml` |
| Hermes | `$HERMES_HOME/config.yaml` 或 `~/.hermes/config.yaml`；`%LOCALAPPDATA%/hermes/config.yaml` |
| OpenCode | 用户配置目录及项目的 `opencode.json` / `opencode.jsonc` |
| VS Code | `%APPDATA%/Code/User/mcp.json`、项目 `.vscode/mcp.json` |
| Claude Desktop | `%APPDATA%/Claude/claude_desktop_config.json` |

示例（地址和命令需替换为实际服务）：

```json
{
  "mcpServers": {
    "local-service": {
      "command": "node",
      "args": ["C:/tools/my-mcp/server.mjs"],
      "enabled": false
    },
    "remote-service": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${MY_SERVICE_TOKEN}" },
      "enabled": false
    }
  }
}
```

在“设置 → MCP”启用服务，点击“测试连接”可检查握手和工具目录。外部来源首次启用一次，之后按需连接；来源配置改变后需要重新确认启用。启动扫描不会批量启动全部服务。启用偏好和自选路径单独保存在 `~/.aelion/integrations.json`，不会改写原配置。

stdio 服务运行在 **Windows 本机**，需要原配置声明的 Node.js、Python、uv 等依赖；HTTP/SSE 连接对应服务。MCP 不运行在技能包的 Linux 副本中。Bot 调用前可以查看服务位置和工具参数。

已支持工具、资源、提示模板，以及工具返回的 PNG/JPEG/WebP 图像；支持 stdio、Streamable HTTP、SSE，并在明确的 HTTP 协议不兼容状态下回退到 SSE。来源中的工具包含/排除列表和明确 deny 规则会保留，其他客户端的逐项审批策略不会自动变成 Aelion 的授权。

支持常用环境变量引用 `${VAR}`、`${env:VAR}`、`${VAR:-default}`、`${workspaceFolder}`、`${userHome}`、`{env:VAR}`，以及 Codex 的环境变量头配置。缺少变量会在设置中提示，不会默默使用空凭据。不会自动读取其他 Agent 的 OAuth 登录缓存或 `.env` 文件；交互式 VS Code inputs、mTLS、WebSocket 传输尚未支持。

格式参考：[Claude Code](https://code.claude.com/docs/en/mcp)、[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[Hermes MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp/)、[OpenCode MCP](https://opencode.ai/docs/mcp-servers/)、[MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/client)。

## 连接器（飞书、企业微信、微信）

连接器把 IM 账号接到某个 Bot：在 IM 里私聊它，Bot 在这台电脑上工作，把答复和文件发回去。在“插件 → 连接器”里添加和管理。

- 所有平台都由本机主动连出去（飞书、企业微信是 WebSocket 长连接，微信是长轮询），不需要公网地址或内网穿透。
- 每个外部私聊或企业微信群对应 Bot 的一个工作会话，名称带平台名，侧栏里用消息图标标出。会话的本机权限继承连接器设置，也可以在每个会话里单独调整。
- 私聊里只有主人和主人确认过的人能使用。其他人发来消息会收到 6 位配对码，在连接器详情里允许或拒绝。企业微信群以机器人后台配置的人员名单为准。
- 只有从 IM 发来的消息和这个会话里的定时任务，答复才会发回 IM；在电脑上发的消息只在电脑上答复。发回 IM 的只有最终回复和它的附件；任务进行中，飞书在你的消息上显示“敲键盘”表情，微信显示“正在输入”，企业微信不显示。被新消息打断或手动停止的任务不发消息，失败时发一条说明。
- 需要本机权限时，审批卡片发给主人，可以在 IM 里“允许一次”或“拒绝”；没有按钮的平台回复“同意 编号”或“拒绝 编号”。接管工作电脑、操作本机屏幕仍需回到电脑前。
- IM 里可以用 `/new`（开始新会话）、`/stop`（停止当前任务）、`/status`、`/help`。
- 托盘里一直有 AelionBot 图标。“关闭窗口后保持连接”默认打开：有启用的连接器时，关闭窗口只隐藏到托盘，从托盘菜单退出。
- 凭证用系统加密存储保存在数据目录的 `connectors.json`。

| 平台 | 添加方式 | 说明 |
| --- | --- | --- |
| 飞书 | 扫码创建（推荐），或填写自建应用的 App ID / App Secret | 扫码会自动创建应用并申请所需权限，扫码人成为主人。手动方式见添加对话框里的步骤：开通 `im:message`、`im:message.p2p_msg:readonly`、`im:message:send_as_bot`、`im:resource`，先在 AelionBot 里连上，再在开放平台把事件与回调都设为长连接，订阅 `im.message.receive_v1` 和 `card.action.trigger`，发布应用。暂不支持 Lark 国际版 |
| 企业微信 | 智能机器人 API 模式的 BotID / Secret | 连接方式选“使用长连接”。同一个机器人只能保持一个连接，在别处连接后这里会显示“已在其他设备连接”。主动推送只能发给最近说过话的人 |
| 微信（实验） | 扫码登录 | 依赖微信 ClawBot 插件，只能回复对方发来的消息，不能主动发起对话，可能被微信限制 |
