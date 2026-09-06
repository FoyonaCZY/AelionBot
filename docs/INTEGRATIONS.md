# 复用已有技能与 MCP

AelionBot 0.3 启动时自动扫描已有 Agent 的目录和配置文件。原文件保留在原处；在设置中可以查看来源、重新扫描和添加自选位置。

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
| Claude / Cursor | `~/.claude/skills`、`~/.cursor/skills` |
| Codex | `~/.codex/skills`、`$CODEX_HOME/skills`，包括 `.system` |
| Hermes | `$HERMES_HOME/skills`、`~/.hermes/skills`、`%LOCALAPPDATA%/hermes/skills` |
| OpenCode | `~/.config/opencode/skills`、`$XDG_CONFIG_HOME/opencode/skills` |
| 项目 | 项目及仓库内祖先目录下的 `.agents/skills`、`.claude/skills`、`.codex/skills`、`.cursor/skills`、`.opencode/skills` |
| Aelion 共享补充 | `~/.aelion/skills` |
| Aelion 私有 | `<数据目录>/bots/<botId>/skills/<技能名>/SKILL.md` |

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
