# AelionBot 官网

使用 Node.js 24 和 `package.json` 固定的 pnpm 12.5.1，在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm run site:dev
```

本地地址：<http://127.0.0.1:4173/>。预览服务运行期间，页面会随源码更新。

```sh
pnpm run site:build
pnpm run site:preview
```

静态构建输出到 `website/dist/`，版本号取自根目录 `package.json`。首页及博客界面默认英文，可切换简体、繁体中文；语言会保存在本机，`?lang=en` / `?lang=zh-CN` / `?lang=zh-TW` 链接优先于保存的选择。博客正文保留作者撰写的语言。

README 英文入口为根目录 `README.md`，中文为 `README.zh-CN.md`，两份 README 分别引用对应语言界面的截图。产品画面使用 `docs/assets/screenshots/` 中的实际前端截图：14 个界面、三种语言，共 42 张，拍摄清单记在 `product-capture.json`。截图环境在 `tools/product-capture/`：`preview.tsx` 直接导入当前 App 组件，`scene.ts` 提供三种语言的虚构示例数据（对话、群聊、计划、设计任务、狼人杀对局等），不读取真实会话、不连接模型或 VM。页面注明“当前界面截图 · 示例数据”。旧矢量界面不再用于首页和 README 的产品展示。

更新截图时，启动 `pnpm run site:dev`，再运行 `node website/tools/capture-screens.mjs`（`--lang en,zh-CN`、`--shots workspace,design` 可以只拍一部分，`--out` 指定输出目录）。截图尺寸为 1400×900。截图是完整组件渲染结果，不手工重绘按钮、布局或桌面内容。App 的接口或状态结构变化后，先打开 `tools/product-capture/?lang=en&shot=workspace` 确认页面能渲染，再补 `scene.ts` 里缺的数据。

Bot 主视觉和成果插画由网页直接绘制，滚动动效遵循系统的减少动态效果设置。下载、代码与反馈入口指向项目的 GitHub 页面。

## 产品导览视频

首页第一节之后是导览视频（`src/VideoSection.tsx`，文案在 `src/home-content.ts` 的 `tour`）。视频 `src/media/aelionbot-tour.mp4` 为 9 分 38 秒、1080p、H.264 + AAC，约 40 MB，中文解说并烧录中文字幕；封面 `aelionbot-tour-poster.webp`。页面只加载封面，访客点击播放后才请求视频。

视频随网站构建打包（带内容哈希、长期缓存），所以替换时整个部署包要控制在接收端 50 MiB 的上限内；`audit:publish` 只对 `website/src/media/*.mp4` 放宽到 48 MB。更新视频时用较高的 CRF 重新压制（当前 CRF 29、`-tune animation`、音频 96 kbps），不要提交原始母版。

## 首页功能介绍

首页以通用多 Agent 系统为主定位，先展示完整工作台、群聊分工与 Linux VM，再介绍每个 Bot 都内置的设计能力，最后是 Terminal-Bench 评测成绩。三种语言文案位于 `src/capability-content.ts`，展示组件是 `src/CapabilitySections.tsx`；评测区块的文案在 `src/benchmark-content.ts`，组件是 `src/BenchmarkSection.tsx`；主标题、FAQ 和下载文案在 `src/site-i18n.ts`；截图列表和界面功能标签在 `src/product-scenes.ts`。设计系统、工作电脑和群聊均使用真实组件截图，可点击放大。官网不打包完整设计资源库。

更新文案时同步维护根目录的英文和中文 README。设计不再是单独的 Bot 类型：每个 Bot 都能做设计，设计任务在本机 `designers` 目录进行，不需要 VM；不要将群聊描述成自动切换 Bot 类型，也不要承诺默认读取无关私聊。设计系统数量和来源以 `assets/design-systems/catalog.json` 为准。评测成绩只引用 `docs/terminal-bench.md` 里写明的数字和条件，榜单数字更新时同步修改官网和两份 README。

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

运行 `pnpm run site:dev` 后：

- 已发布文章列表：<http://127.0.0.1:4173/blog/>
- 模板的草稿预览：<http://127.0.0.1:4173/blog/_preview/my-first-post/>
- 其他草稿预览：`http://127.0.0.1:4173/blog/_preview/<slug>/`

草稿预览仅存在于本地开发服务。文章支持代码高亮与复制、表格、图片、引用和自动目录。图片放入 `website/public/blog-media/`，正文写 `![说明](/blog-media/图片名.png)`。

准备发布时，把 `draft` 改为 `false`，执行 `pnpm run site:test` 和 `pnpm run site:build`，提交文章与图片并推送到 `main`。GitHub Actions 会自动构建并发布到官网。文章上线地址为 `https://aelion.chat/blog/<slug>/`，列表和站点地图一起更新。

这里的“草稿”只控制官网展示；本仓库是公开的，提交到 GitHub 的 Markdown 文件仍然可以被查看。需要保密的内容请留在仓库之外。

## 线上部署

`public/oauth/client-metadata.json` 是 AelionBot 的公开 OAuth 客户端元数据（CIMD），供币安等服务识别桌面客户端，不含密钥。必须先将此文件部署到 `https://aelion.chat/oauth/client-metadata.json`，再发布依赖它的桌面版本；确认响应为 HTTP 200、`Content-Type: application/json`，且内容与文件一致。`client_id` 必须等于该公开地址，`redirect_uris` 必须与 `shared/app-connectors.ts` 的 `OAUTH_REDIRECT_URL` 同步。使用此元数据的登录在端口被占用时会报错，不会换端口。

官网地址为 <https://aelion.chat/>，`www.aelion.chat` 和 HTTP 访问统一跳转到此地址。

- Nginx 配置模板：`deploy/nginx.conf`。线上配置单独启用，保留服务器既有站点。
- 发布目录：`/var/www/aelion.chat/releases/`；`/var/www/aelion.chat/current` 指向当前版本。
- 证书覆盖两个域名，保存在 `/etc/letsencrypt/live/aelion.chat/`。
- HTTP 证书验证目录为 `/var/www/letsencrypt`，由 Certbot 自动续期；续期成功后通过 `aelion-nginx.sh` 部署钩子检查并平滑重载 Nginx。

推送官网相关修改到 `main` 会触发 [Deploy website 工作流](../.github/workflows/website.yml)，也可以在 Actions 手动运行。工作流完成测试、构建与文件校验后，使用专用账号切换 `current`；检查失败会恢复上一版。部署配置、重试和回滚方式见 [部署说明](deploy/README.md)。

HTML 页面要求重新验证缓存，带哈希的资源文件使用长期缓存。博客使用实际生成的目录和 `index.html`，未发布或不存在的文章返回 404。
