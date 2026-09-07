# VM 退出与安装恢复

## 退出

原实现仅在 macOS 退出时关闭 VM，Windows 会保留 detached 的 QEMU。现在退出协调器先取消工作，等待有界的后台清理，再在所有平台关闭 VM，最后保存状态并退出。重复退出在清理完成前持续阻止默认退出，避免跳过异步清理。

VM 首选 ACPI 正常关机，15 秒后仍运行则通过 QMP quit 结束；每条会改变 VM 状态的 QMP 命令都在同一连接内核验 UUID。Windows 最后回退到持有的进程句柄，并核对可执行文件、创建时间、UUID 及两个磁盘参数，避免只凭旧 PID 结束其他进程。退出标志阻止尚未完成的下载或启动链继续产生新 VM。

这处理正常退出及组件清理故障；不会把主机系统动画掉帧归因为唯一的 QEMU 残留问题。

## 安装

桌面准备拆为 desktop、office、browser 三个阶段；Bot 独立桌面运行时也使用同一安装器。APT 选项仅作用于这些命令，保留已有代理和系统源文件。

先使用现有源，失败后尝试[清华镜像](https://mirrors.tuna.tsinghua.edu.cn/help/debian/)、[中科大镜像](https://mirrors.ustc.edu.cn/help/debian.html)及 Debian 官方源。备用源写入 Aelion 状态目录，使用 Debian archive keyring 验证签名，通过 sourcelist/sourceparts 参数选用；成功源可在后续阶段复用。不会关闭签名校验，也不会因配置错误盲目更换源重复执行 dpkg。

连接及数据超时使用 [APT HTTP transport](https://manpages.debian.org/bookworm/apt/apt-transport-http.1.en.html) 的超时选项。进度读取 [APT Status-Fd](https://github.com/Debian/apt/blob/main/doc/progress-reporting.md) 的 dlstatus/pmstatus，下载阶段另检查缓存字节变化，连续 60 秒无进展会终止此次下载并回退。下载和配置分开执行，配置阶段保留较长时限，避免把字体或内核配置误判为下载停滞。

工作环境版本保持不变，健康桌面仍可直接使用；失败环境经「修复工作环境」或初始化重试部署新版脚本。脚本通过 SSH stdin 传输，避免随安装逻辑增大而超过命令参数长度限制。

验证包含模拟 QMP、真实 Windows 自建进程的归属保护、实际 Electron 窗口关闭及进程退出、安装进度界面、下载停滞和源回退。发布流水线另在一次性 Debian Bookworm 容器内安装签名 hello 软件包，验证不可用源回退及全局 APT/代理配置保持原样。
