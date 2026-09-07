# 第三方运行时与参考来源

AelionBot 的构建和运行依赖以下上游项目；第三方组件的许可文本以随包文件和各项目原文为准。

| 组件 | 使用方式 | 来源与本地记录 |
|---|---|---|
| Electron / Chromium | Windows / macOS 客户端运行时 | `package-lock.json`；目录包中的 `LICENSE.electron.txt`、`LICENSES.chromium.html` |
| electron-updater / NSIS | GitHub Release 检查、下载校验和 Windows 更新安装 | 固定依赖见 `package-lock.json`；采用 electron-builder 生成的安装包与更新清单 |
| 7-Zip | 构建时解压固定版本 QEMU 安装包 | 官方发布来源与 SHA-256 固定在 `scripts/runtime-archiver.mjs`；构建缓存不随源码或客户端分发 |
| QEMU 11.1.0 | WHPX 固定 guest | [Windows 构建来源](https://qemu.weilnetz.de/w64/)；`runtime/qemu/aelion-runtime.json`；`COPYING*` 随运行时打包 |
| QEMU / Homebrew 原生依赖 | Mac ARM64 / Intel 工作电脑，HVF 加速 | [Homebrew QEMU](https://formulae.brew.sh/formula/qemu)；每个包的 `qemu/aelion-runtime.json` 记录实际版本、来源及构建阶段 SHA-256；许可资料和构建配方位于 `qemu/licenses` |
| Debian 12 genericcloud | 固定 amd64 / ARM64 基础镜像 | [官方镜像目录](https://cloud.debian.org/images/cloud/bookworm/20260903-2590/)；版本和 SHA-512 固定在 `runtime/guest-image.json` 与 `runtime/guest-image-arm64.json` |
| Google Chrome | 既有 Windows 工作电脑中的浏览器 | 保留此前安装的版本及许可记录；新建工作电脑不再依赖 Google 的安装包下载地址 |
| Chromium | 新建工作电脑中的浏览器 | 通过现有 Debian 签名软件源安装；版本和许可保留在 guest 的包管理记录及 `/usr/share/doc` |
| Thunar / LibreOffice / Arc / Adwaita | 文件管理、办公、桌面主题和图标 | 通过 Debian 软件源安装，对应版本和许可保留在 guest 的包管理记录及 `/usr/share/doc`；早期工作电脑中的 Papirus 主题保留其原许可记录 |
| noVNC、React、ssh2、ws、react-markdown | 桌面显示、界面、SSH、WebSocket、Markdown | 确切版本见 `package-lock.json`，许可文本随 npm 依赖保留 |
| remark-gfm、fflate | Markdown 表格和目录 ZIP 附件 | 确切版本见 `package-lock.json`，许可文本随 npm 运行依赖保留 |
| Model Context Protocol TypeScript SDK | 0.3 MCP 客户端，stdio / Streamable HTTP / SSE | [官方 SDK](https://github.com/modelcontextprotocol/typescript-sdk)；`@modelcontextprotocol/sdk@1.30.0` |
| yaml、smol-toml、jsonc-parser | 0.3 读取 Agent Skills 元数据和各 Agent 的 MCP 配置 | 确切版本见 `package-lock.json`；作为运行时依赖随目录包分发 |
| llama.cpp b10816 / Qwen3-1.7B-Q8_0 | 可选的本地测试模型，未放入客户端目录包 | `scripts/setup-local-model.ts` 固定下载来源、版本和 SHA-256；仅用于最初实证 |
| Hermes Agent | Harness 设计参考 | `docs/design/hermes-reference-manifest.json` 记录参考版本与来源；本项目实现自己的精简循环，未声称是 Hermes 官方发行版 |
| Hermes / Codex / OpenCode / Pi / OpenHands SDK | 0.4 上下文、历史及自动沉淀的源码对照 | 固定提交、文件 hash 和采用机制见 `docs/design/harness-reference-manifest-v04.json` 与 `Harness-Implementation-v04.md`；没有运行上游 Agent |
| js-tiktoken | 0.4 BPE token 预算估计 | 固定版本 `1.0.21`，许可文本随 npm 运行依赖保留；非匹配模型仍需 usage 校准 |

首次启动安装的 Linux 内核、XFCE、Chromium、Python、Git 等由 Debian 软件源提供，对应信息保留在 guest 的 `/usr/share/doc` 和包管理数据库中。
