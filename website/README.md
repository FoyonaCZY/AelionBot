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

静态构建输出到 `website/dist/`。官网复用 `docs/assets/` 中的 Logo 和应用截图，版本号取自根目录 `package.json`。协作示例只用于介绍功能；下载、代码与反馈入口指向项目的 GitHub 页面。

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

准备发布时，把 `draft` 改为 `false`，执行 `npm run site:test` 和 `npm run site:build`，提交文章与图片，再将新的官网构建同步到服务器。文章上线地址为 `https://aelion.chat/blog/<slug>/`。构建会同步更新列表、独立文章页面和站点地图。

这里的“草稿”只控制官网展示；本仓库是公开的，提交到 GitHub 的 Markdown 文件仍然可以被查看。需要保密的内容请留在仓库之外。

## 线上部署

官网地址为 <https://aelion.chat/>，`www.aelion.chat` 和 HTTP 访问统一跳转到此地址。

- Nginx 配置模板：`deploy/nginx.conf`。线上配置单独启用，保留服务器既有站点。
- 发布目录：`/var/www/aelion.chat/releases/`；`/var/www/aelion.chat/current` 指向当前版本。
- 证书覆盖两个域名，保存在 `/etc/letsencrypt/live/aelion.chat/`。
- HTTP 证书验证目录为 `/var/www/letsencrypt`，由 Certbot 自动续期；续期成功后通过 `aelion-nginx.sh` 部署钩子检查并平滑重载 Nginx。

更新时将新的静态构建放入独立版本目录，检查文件后切换 `current` 链接。HTML 页面要求重新验证缓存，带哈希的资源文件使用长期缓存。博客使用实际生成的目录和 `index.html`，不依赖把所有路径回退到首页；未发布或不存在的文章返回 404。
