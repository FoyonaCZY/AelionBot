# AelionBot

运行在 Windows 上的本地 AI 工作伙伴。每个 Bot 可以使用独立的模型、记忆和工作桌面，在单聊、私聊和群聊中协作完成任务。

## 功能

- 多 Provider 配置，从兼容接口获取模型列表；每个 Bot 可独立选择模型。
- 单聊与群聊、Bot 间私聊、文件和图片附件、可查看的工具执行记录。
- 每个 Bot 使用独立 Linux 桌面，支持浏览器、文件、代码和办公任务。
- 私有长期记忆与技能、上下文压缩、历史检索、MCP 服务接入。
- 单聊和群聊定时任务，支持一次性、每天、工作日、每周及固定间隔。
- 本机操作权限确认与可管理的命令允许规则。
- 关于页面检查 GitHub Release，下载安装包并重启更新。

## 安装与使用

Windows 发行版使用 [GitHub Releases](https://github.com/FoyonaCZY/AelionBot/releases) 中的 `AelionBot-Setup-<版本>-x64.exe`。安装包包含客户端与 QEMU 运行时，工作电脑的系统镜像在首次准备时下载。

1. 在“设置 → 模型”添加 Provider，填写 Base URL 和 API Key，保存并拉取模型列表。
2. 选择默认模型；需要为某个 Bot 单独配置时，点击 Bot 名称打开资料弹窗。
3. 使用工作电脑前完成首次准备。该功能需要可用的硬件虚拟化和 Windows 虚拟机监控程序平台（WHPX）。
4. 发送消息或附件开始工作。操作本机时按提示决定是否允许，工作成果可从文件卡片保存。
5. “设置 → 关于 → 检查更新”可检查正式 Release；下载完成后点击“重启并更新”。

更新时程序文件会被替换，聊天、模型配置、记忆、附件和工作电脑镜像保存在独立的数据目录。运行中的任务需要先结束；工作电脑会安全关闭，并在更新后恢复。

## 本地开发

需要 Windows x64、Node.js 24 或更高版本。

```powershell
npm ci
npm run vm:prepare-runtime
npm run dev
```

也可以构建目录包，再通过项目内的启动脚本使用本地开发数据：

```powershell
npm run package:win
.\Start-AelionBot.cmd
```

本地启动脚本使用 `.local/app`；直接运行发行版默认使用 Electron 用户数据目录。系统镜像、工作文件与配置不会提交到源码仓库。

## 检查与发布

```powershell
npm run typecheck
npm test
npm run audit:publish -- --worktree
npm run package:release
```

正式安装包、差分更新信息和 `latest.yml` 输出到 `release/github`。修改 `package.json` 版本号并推送匹配的 `v<版本>` 标签后，GitHub Actions 会检查、打包并发布 Release；普通代码推送不会自动发布安装包。详见 [发布说明](docs/RELEASING.md)。

## 数据与权限

- 模型密钥由操作系统加密存储，不写入仓库或前端配置。
- 本机命令和文件操作遵循用户授权；允许规则可以在设置中关闭或删除。
- 定时调度需要客户端运行。关闭期间未执行的到期计划会在重开后补跑一次；已经启动的中断任务不会自动重试。
- 群聊只显示确认发布的完整回复，并抑制无新增信息的重复接话。普通附件阅读不会生成单聊中的群任务卡片。
- `.local`、构建目录、下载缓存、虚拟机磁盘、截图和本地验收报告已排除在 Git 提交之外。

## 文档

- [技能与 MCP](docs/INTEGRATIONS.md)
- [上下文与记忆实现](docs/design/Harness-Implementation-v04.md)
- [第三方组件说明](docs/THIRD-PARTY-NOTICES.md)
- [发布与自动更新](docs/RELEASING.md)
