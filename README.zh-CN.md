<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img src="docs/assets/logo-light.svg" alt="AelionBot" width="280">
  </picture>

  <p><a href="README.md">English</a> · <strong>简体中文</strong></p>
  <h1>一群 AI 伙伴，在你的电脑上分工干活</h1>
  <p>
    <a href="https://github.com/FoyonaCZY/AelionBot/releases/latest"><strong>下载 Windows / macOS 版</strong></a> &nbsp; · &nbsp;
    <a href="https://aelion.chat/?lang=zh-CN">官网</a> &nbsp; · &nbsp;
    <a href="https://aelion.chat/blog/?lang=zh-CN">博客</a>
  </p>
  <p><a href="https://github.com/FoyonaCZY/AelionBot/actions/workflows/ci.yml"><img src="https://github.com/FoyonaCZY/AelionBot/actions/workflows/ci.yml/badge.svg" alt="CI"></a></p>
  <img src="docs/assets/product/companions.svg" alt="蓝、紫、绿三位 AelionBot 伙伴" width="100%">
</div>

<br>

AelionBot 是一个多 Agent 桌面应用。你创建几个 Bot，各给一份职责、一个模型和一组工具，然后单独交办任务，或者拉进同一个群让它们分工协作。

- **群聊协作，没有主持人**：消息平等发给每个成员，Bot 自己认领任务、交接文件、互相补充。你随时插话、改要求。
- **执行在本机**：通用 Bot 使用你电脑上的一台 Linux 虚拟机（浏览器、终端、办公软件），也能按你设定的权限操作本机文件和命令。
- **模型自己选**：用自己的 API Key，兼容 OpenAI 接口、Anthropic、Gemini，支持本地模型和 MCP。应用本身免费。

<img src="docs/assets/screenshots/workspace-zh-CN.png" alt="多 Agent 工作台：伙伴列表、任务对话、文件与工作电脑" width="100%">

## 能做什么

| | |
| --- | --- |
| **通用 Bot** | 调研、写作、数据分析、写代码、操作桌面。每个 Bot 有自己的工作目录和虚拟机桌面，你可以旁观、暂停或接管 |
| **设计师** | 做网页原型、可编辑的 PPTX、网站复刻。预装 152 套设计系统，不需要虚拟机 |
| **文件与预览** | 网页、图片、PDF、文档在对话旁预览；网页可以框选标注、选中元素直接改 |
| **AI 游戏** | 群聊里玩十二人狼人杀，真人上桌或旁观全 AI 对局（[规则](docs/werewolf-twelve.md)） |
| **其他** | 附带数据分析 / 表格 / PDF / PPT 技能，定时任务，中英繁界面 |

一个典型用法：资料伙伴收集来源存成 `research.md`，数据伙伴核对样本、生成对比表，写作伙伴汇总成报告。三位在同一个群里接力，中途你可以补充要求，或 @ 某位继续。

<img src="docs/assets/screenshots/collaboration-zh-CN.png" alt="群聊协作：不同伙伴分享资料、交付文件" width="100%">

## 开始使用

1. [下载安装](https://github.com/FoyonaCZY/AelionBot/releases/latest)，支持 Windows 10+（64 位）和 macOS（Intel / Apple 芯片）。
2. 连接一个模型服务。
3. 创建一个通用 Bot 或设计师，交给它一件事；需要协作时建群、拉人、分工。

工作电脑（Linux VM）约需 4 GB 内存和几十 GB 磁盘，建议电脑内存 16 GB 以上。只用设计师可以不启动虚拟机。

## 本地开发

需要 Node.js 24 和 pnpm 12.5.1（固定在 `package.json`）。

```sh
pnpm install --frozen-lockfile
pnpm run typecheck && pnpm test
pnpm run dev
```

依赖变更需一起提交 `pnpm-lock.yaml`。使用工作电脑前运行 `pnpm run vm:prepare-runtime`，打包见[发布说明](docs/RELEASING.md)。

## 了解更多

[版本更新](https://github.com/FoyonaCZY/AelionBot/releases) · [反馈](https://github.com/FoyonaCZY/AelionBot/issues) · [设计师架构](docs/designer-bots.md) · [群聊协议](docs/group-protocol-v2.md) · [VM 存储](docs/vm-storage.md) · [第三方声明](docs/THIRD-PARTY-NOTICES.md)

<sub>截图取自当前 App 前端，示例对话与文件是虚构的。设计系统来自 OpenDesign，品牌风格参考不代表官方合作。</sub>
