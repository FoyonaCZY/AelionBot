---
title: "第一篇技术笔记"
description: "用一两句话介绍文章要解决的问题。"
date: "2026-09-06"
slug: "my-first-post"
author: "FoyonaCZY"
tags:
  - Agent
  - 开发实践
draft: true
---

这是一份写作模板，默认不会出现在公开博客中。复制这个文件并修改上方信息，完成正文后，将 `draft` 改为 `false`，再构建和发布官网。

## 从一个问题开始

介绍背景：遇到了什么问题，原来的做法有什么限制，这篇笔记准备记录什么。

## 记录实现过程

代码块可以指定语言，以获得语法高亮。

```typescript
interface Task {
  title: string;
  status: 'pending' | 'completed';
}

const task: Task = {
  title: '整理一份技术笔记',
  status: 'pending',
};
```

| 需要说明的内容 | 可以记录什么 |
| --- | --- |
| 设计选择 | 为什么采用这个方案 |
| 验证过程 | 如何确认实际效果 |
| 限制 | 哪些情况还需要继续处理 |

## 放入图片和链接

将图片放入 `website/public/blog-media/`，然后使用这样的地址：

```markdown
![图的说明](/blog-media/my-diagram.png)
```

可以附上[项目仓库](https://github.com/FoyonaCZY/AelionBot)或其他参考资料。

## 这次学到了什么

写下验证结果、仍然存在的问题，以及下次会怎样改进。
