# AelionBot 官网

在仓库根目录运行：

```sh
npm ci
npm run site:dev
```

本地地址：<http://127.0.0.1:4173/>。预览服务运行期间，页面会随源码更新。

```sh
npm run site:build
npm run site:preview
```

静态构建输出到 `website/dist/`，版本号取自根目录 `package.json`。首页及博客界面默认英文，可切换简体、繁体中文；语言会保存在本机，`?lang=en` / `?lang=zh-CN` / `?lang=zh-TW` 链接优先于保存的选择。博客正文保留作者撰写的语言。

README 英文入口为根目录 `README.md`，中文为 `README.zh-CN.md`。两者与官网共用 `docs/assets/product/` 的矢量功能示意图，图中文字有对应语言版本，放大仍清晰。图片是示意而非真实截图；旧 PNG 不再用于首页和 README。修改示意内容后运行 `node website/scripts/product-visuals.mjs` 重建 SVG。每组图片约 3 KB，构建时单独输出并按内容哈希缓存。

Bot 主视觉和成果插画由网页直接绘制，滚动动效遵循系统的减少动态效果设置。下载、代码与反馈入口指向项目的 GitHub 页面。

## 写技术博客

文章放在 `website/content/posts/`。复制 `_template.md`，换一个文件名，修改开头的文章信息并撰写 Markdown 正文。

```yaml
---
title: "我的技术笔记"
description: "这篇文章介绍的问题和解决方式。"
date: "2026-09-07"
slug: "my-technical-note"
author: "FoyonaCZY"
tags: [Agent, 开发实践]
draft: true
---
```

- `title`、`description` 和 `date` 为必填项；日期格式是 `YYYY-MM-DD`。
- `slug` 决定文章地址，只使用小写英文、数字和短横线；省略时使用文件名。
- `author` 默认是 `FoyonaCZY`，`tags` 可以省略。
- 只有明确设置 `draft: false` 才会进入官网构建；省略 `draft` 或设置为 `true` 都不发布。

运行 `npm run site:dev` 后：

- 已发布文章列表：<http://127.0.0.1:4173/blog/>
- 模板的草稿预览：<http://127.0.0.1:4173/blog/_preview/my-first-post/>
- 其他草稿预览：`http://127.0.0.1:4173/blog/_preview/<slug>/`

草稿预览仅存在于本地开发服务。文章支持代码高亮与复制、表格、图片、引用和自动目录。图片放入 `website/public/blog-media/`，正文写 `![说明](/blog-media/图片名.png)`。

准备发布时，把 `draft` 改为 `false`，执行 `npm run site:test` 和 `npm run site:build`，提交文章与图片并推送到 `main`。GitHub Actions 会自动构建并发布到官网。文章上线地址为 `https://aelion.chat/blog/<slug>/`，列表和站点地图一起更新。

这里的“草稿”只控制官网展示；本仓库是公开的，提交到 GitHub 的 Markdown 文件仍然可以被查看。需要保密的内容请留在仓库之外。

## 线上部署

官网地址为 <https://aelion.chat/>，`www.aelion.chat` 和 HTTP 访问统一跳转到此地址。

- Nginx 配置模板：`deploy/nginx.conf`。线上配置单独启用，保留服务器既有站点。
- 发布目录：`/var/www/aelion.chat/releases/`；`/var/www/aelion.chat/current` 指向当前版本。
- 证书覆盖两个域名，保存在 `/etc/letsencrypt/live/aelion.chat/`。
- HTTP 证书验证目录为 `/var/www/letsencrypt`，由 Certbot 自动续期；续期成功后通过 `aelion-nginx.sh` 部署钩子检查并平滑重载 Nginx。

推送官网相关修改到 `main` 会触发 [Deploy website 工作流](../.github/workflows/website.yml)，也可以在 Actions 手动运行。工作流完成测试、构建与文件校验后，使用专用账号切换 `current`；检查失败会恢复上一版。部署配置、重试和回滚方式见 [部署说明](deploy/README.md)。

HTML 页面要求重新验证缓存，带哈希的资源文件使用长期缓存。博客使用实际生成的目录和 `index.html`，未发布或不存在的文章返回 404。
