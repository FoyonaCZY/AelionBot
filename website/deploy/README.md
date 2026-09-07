# 官网自动部署

[Deploy website](../../.github/workflows/website.yml) 在 `main` 上的官网、博客、图片、图标、依赖或版本信息变化后自动运行。也可以在 GitHub Actions 中选择该工作流并点击 **Run workflow**。安装包发布使用独立工作流。

工作流使用 Node.js 24，运行网站测试与部署测试、构建静态页面、生成逐文件 SHA-256 清单，然后通过 SSH 把压缩包交给服务器。它会检查公开页面、全部构建资源、两个域名的跳转和草稿 404，成功后在 Actions 的部署记录中显示官网链接。

## GitHub 配置

仓库环境名为 `website-production`，部署分支限定为 `main`。

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Environment variable | `WEBSITE_HOST` | 官网服务器地址 |
| Environment variable | `WEBSITE_PORT` | SSH 端口 |
| Environment variable | `WEBSITE_USER` | `aelion-deploy` |
| Environment secret | `WEBSITE_DEPLOY_KEY` | 专用 Ed25519 部署私钥 |
| Environment secret | `WEBSITE_KNOWN_HOSTS` | 已核对的 SSH 服务器公钥记录，包含非默认端口 |

工作流校验服务器公钥，不在运行时自动信任 `ssh-keyscan` 的结果。更换服务器时，先核对新主机身份，再更新环境配置。私钥只保存在 GitHub 加密 Secret 中，不提交到仓库。

## 服务器配置

首次配置由服务器管理员执行：

```sh
sudo bash install.sh /path/to/deployment-key.pub /path/to/receive.py
```

`install.sh` 需要已存在的 `/var/www/aelion.chat/current` 站点与 Nginx HTTPS 配置。它创建 `aelion-deploy` 专用账号，并安装接收程序到 `/usr/local/libexec/aelion-website-deploy`。账号没有 sudo 权限，账号目录、授权公钥和接收程序由 root 持有。

部署公钥设置了 `restrict` 和固定命令，只接受 `deploy <commit SHA> <workflow run number> <attempt>`；不提供终端、端口转发、SFTP 或任意命令。GitHub Actions 使用专用私钥，服务器管理员自己的登录私钥不交给工作流。

接收程序只在该官网目录内工作，拒绝目录穿越、链接、特殊文件、未列入清单的文件、草稿路径及校验失败的资源。压缩包上限为 50 MiB，解压内容上限为 250 MiB，接收和发布最多运行三分钟。

## 切换与回滚

- 新版放入 `releases/ci-<run>-<attempt>-<sha>/`，检查后原子切换 `current`。
- 服务器本地 HTTPS 检查失败会恢复之前的链接；构建、上传或校验失败不会替换在线页面。
- 工作流串行发布，服务器也会加锁，并拒绝旧运行覆盖较新的部署。
- 最近五个自动部署版本与前一版会保留。新版本还保留上一版的图片和脚本，供已经打开页面的访客完成加载。
- `/deployment.json` 记录当前提交、运行编号和文件校验值，便于核对线上版本。

构建或网络失败时，可以在 Actions 中重新运行失败任务。重新运行会使用新的 attempt 编号。

需要主动回退时，由管理员先检查目标版本位于该站点的 `releases/` 目录，再切换链接：

```sh
sudo ln -s /var/www/aelion.chat/releases/<已核对的版本目录> /var/www/aelion.chat/.manual-rollback
sudo mv -Tf /var/www/aelion.chat/.manual-rollback /var/www/aelion.chat/current
```

随后检查首页、博客和 `/deployment.json`。正常发布会沿用仓库的新运行编号继续推进。Nginx 配置没有变化时，切换静态版本不需要重启服务。
