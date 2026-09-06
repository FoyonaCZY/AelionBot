# macOS 双架构预览支持

## 平台边界

共享聊天、harness、模型、记忆、MCP 与技能代码。平台差异集中在 host-platform、command-permissions、vm-platform、mac-updater 和构建脚本。

| 平台 | 客户端 | Linux 工作电脑 | 加速 |
| --- | --- | --- | --- |
| Windows | x64 | Debian amd64 | WHPX |
| macOS 15+ Intel | x64 | Debian amd64 | HVF |
| macOS 15+ Apple Silicon | arm64 | Debian arm64 | HVF |

ARM 与 x64 的镜像分别固定版本与 SHA-512。不会将旧架构的 system.qcow2 静默换成另一镜像。Mac ARM 固件变量独立保存到数据目录，发行包中的代码固件只读。

Mac 的两种架构统一使用 Debian 提供的 Chromium，避免专有 Chrome 在软件模拟中触发图形和本地模型服务兼容性问题。Windows 继续使用原有 Chrome 安装流程。

## 构建与更新

- Mac 运行时从 Homebrew QEMU 复制当前架构的二进制、依赖库、固件和许可资料，修正动态库引用为包内相对路径并检查 CPU 架构。客户端无需安装 Homebrew。
- `build/entitlements.mac.plist` 为 Electron JIT 与 QEMU HVF 提供必要的签名权限。
- 未配置证书时使用临时签名，`mac-release.json` 标记手动更新；不尝试用未公证包自动替换用户应用。
- GitHub Secrets 可配置 `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。密钥由 GitHub 注入，源码中不保存证书或密码。
- 三个平台的构建和检查全部成功后，统一发布任务验证文件 SHA-512，合并 Mac 更新清单，生成 SHA256SUMS，再公开 Release。

## 验收

Windows 回归、两种 Mac 的 Node 测试、打包应用启动和设置窗口、QEMU 原生架构与动态依赖检查、Linux 实际启动、浏览器与独立桌面、写入后重启持久化。

Mac CI 会实际创建一个暂停的最小 VM 来探测 HVF，可用时使用硬件加速，否则使用 TCG。报告明确记录实际加速方式；不将 TCG 结果描述为 HVF 实机验证。GitHub 的 ARM Mac 运行器存在嵌套虚拟化限制，仍需对应实机反馈。

GitHub 托管 Intel Mac 曾触发上游已记录的 [IO-APIC 定时器启动问题](https://gitlab.com/qemu-project/qemu/-/issues/2832)。CI 会识别启动日志中的内核 panic，核对 VM 身份后关闭失败的测试实例；仅对这一明确的定时器错误最多尝试三次，其他错误直接停止。该处理只用于一次性测试 VM，不会重放 Bot 工具操作。

参考：[QEMU 虚拟化加速](https://www.qemu.org/docs/master/system/introduction.html)、[ARM virt](https://www.qemu.org/docs/master/system/arm/virt.html)、[GitHub Mac runner 限制](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、[electron-builder macOS](https://www.electron.build/v26/docs/mac/)。
