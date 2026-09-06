# 发布与自动更新

更新来源固定为 [FoyonaCZY/AelionBot](https://github.com/FoyonaCZY/AelionBot)。客户端只检查公开的正式 Release，不自动切换预发布版或降级。

## 生成发行包

在 Windows x64 和 Node.js 24+ 环境运行：

```powershell
npm ci
npm run vm:prepare-runtime
npm run typecheck
npm test
npm run package:release
```

输出目录是 `release/github`，更新需要同一构建产生的三个文件：

- `AelionBot-Setup-<版本>-x64.exe`
- 对应的 `.exe.blockmap`
- `latest.yml`

构建脚本会核对清单版本、安装包大小、SHA-512 和差分文件。安装包包含客户端、依赖、QEMU 和组件许可文件；不包含 `.local`、模型密钥、聊天、系统磁盘或工作磁盘。QEMU 和解压工具的下载版本及校验值固定在构建脚本中。

目前未配置代码签名。后续配置 Windows 签名证书时，应通过 CI Secret 提供证书和口令，并启用对应的 electron-builder 签名选项，不要将证书或密钥提交到仓库。

## 发布新版本

1. 修改 `package.json` 的版本号，并更新锁文件。
2. 提交前运行 `npm run audit:publish -- --worktree`；暂存后再运行 `npm run audit:publish` 检查实际暂存内容。
3. 推送代码和匹配的版本标签，例如 `v0.4.1`。

```powershell
git tag v0.4.1
git push origin main
git push origin v0.4.1
```

GitHub Actions 会检查源码、运行测试、构建安装包，先上传到草稿 Release，再将完整 Release 公开。标签必须与 `package.json` 版本一致。已公开的版本不会被该流程覆盖，需要使用新版本号。

普通代码推送只更新源码，不发布安装包。也可手动运行 workflow 验证构建，或将本地生成的三个文件上传到对应 Release。不要只上传源码 ZIP，也不要漏掉 `latest.yml`。

## 客户端更新行为

“设置 → 关于 → 检查更新”查询正式 Release。发现新版本后可下载，支持取消和重试；只有校验通过的安装包才会进入“重启并更新”状态。

安装前检查任务与人工接管状态，安全关闭工作电脑，再由 NSIS 替换当前程序目录。启动上下文写在独立的用户配置目录，保存当前数据位置、项目配置位置和工作电脑恢复标记，避免使用开发启动脚本的用户在更新后看到空白数据。

聊天、记忆、附件与虚拟机磁盘不属于安装目录。若自定义数据目录位于程序目录内部，自动安装会拒绝继续，避免安装程序覆盖数据。下载失败、取消或校验失败不会安装更新。

实现使用 [electron-updater 的 Windows NSIS 更新流程](https://www.electron.build/v26/docs/features/auto-update/)。
