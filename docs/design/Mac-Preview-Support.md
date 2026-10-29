# macOS 预览支持

## 平台边界

共享聊天、harness、模型、记忆、MCP 与技能代码。平台差异集中在 host-platform、command-permissions、vm-platform、mac-updater 和构建脚本。

| 平台 | 客户端 | Linux 工作电脑 | 加速 |
| --- | --- | --- | --- |
| Windows | x64 | Debian amd64 | WHPX |
| macOS 15+ Apple Silicon | arm64 | Debian arm64 | HVF |

Mac 只支持 Apple Silicon。v0.50.3 是最后一个提供 Intel（x64）安装包的版本，之后的 Release 不再构建 Intel 包，应用在 Intel Mac 上也不再提供工作电脑运行时。

ARM 与 x64 的镜像分别固定版本与 SHA-512。不会将旧架构的 system.qcow2 静默换成另一镜像。Mac ARM 固件变量独立保存到数据目录，发行包中的代码固件只读。

Mac 使用 Debian 提供的 Chromium，避免专有 Chrome 在软件模拟中触发图形和本地模型服务兼容性问题。Windows 继续使用原有 Chrome 安装流程。

## 构建与更新

- Mac 运行时从 Homebrew QEMU 复制 arm64 二进制、依赖库、固件和许可资料，修正动态库引用为包内相对路径并检查 CPU 架构。客户端无需安装 Homebrew。
- `build/entitlements.mac.plist` 为 Electron JIT 与 QEMU HVF 提供必要的签名权限。
- 未配置证书时使用临时签名，`mac-release.json` 标记手动更新；不尝试用未公证包自动替换用户应用。
- GitHub Secrets 可配置 `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。密钥由 GitHub 注入，源码中不保存证书或密码。
- Windows 与 Mac 的构建和检查全部成功后，统一发布任务验证文件 SHA-512，生成 Mac 更新清单 `latest-mac.yml` 和 SHA256SUMS，再公开 Release。
- GitHub 托管 Mac 没有嵌套虚拟化，QEMU 只能走 TCG。在 TCG 里安装 XFCE、LibreOffice 和 Chromium 实测超过 40 分钟，并常在配置阶段失败。默认 Desktop release 因此与 Windows x64 对齐：源码审计、测试、打包 QEMU、签名校验、启动应用；不在托管 runner 上引导 Linux 桌面。完整 guest 冒烟仅在本机 HVF 或显式 `vm_smoke` 时运行。

## 验收

Windows 回归、Apple Silicon Mac 的 Node 测试、打包应用启动和设置窗口、QEMU 原生架构、HVF 能力与 hypervisor 权限检查。

默认 CI 不把 TCG 下的 Linux 桌面安装当作发布门槛。本机或开启 `vm_smoke` 时，脚本会先探测 HVF；探测失败则立即退出，避免再跑 40 分钟的软件模拟。不将 TCG 结果描述为 HVF 实机验证。GitHub 的 ARM Mac 运行器明确[不支持嵌套虚拟化](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。

x86 guest 可能触发上游已记录的 [IO-APIC 定时器启动问题](https://gitlab.com/qemu-project/qemu/-/issues/2832)，此前在 GitHub 托管 Intel Mac 上出现过。一次性测试 VM 和镜像预装仍会识别该 panic 并最多重试三次；该处理不会重放 Bot 工具操作。

参考：[QEMU 虚拟化加速](https://www.qemu.org/docs/master/system/introduction.html)、[ARM virt](https://www.qemu.org/docs/master/system/arm/virt.html)、[GitHub Mac runner 限制](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、[electron-builder macOS](https://www.electron.build/v26/docs/mac/)。
