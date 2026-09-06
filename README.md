<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-light.svg">
    <img src="docs/assets/logo-light.svg" alt="AelionBot" width="390">
  </picture>
</p>

<h3 align="center">组建你的 AI 工作团队</h3>

<p align="center">把资料和想法发给伙伴，和它们一起推进手头的工作。</p>

<p align="center">
  <a href="https://aelion.chat/">官网</a>
  &nbsp;·&nbsp;
  <a href="https://aelion.chat/blog/">技术博客</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/FoyonaCZY/AelionBot/releases">下载 Windows / Mac 版</a>
  &nbsp;·&nbsp;
  <a href="#用在哪些工作里">应用场景</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/FoyonaCZY/AelionBot/issues">反馈建议</a>
</p>

AelionBot 是一个桌面 AI 工作空间。你可以创建各有分工的 Bot，让它们处理资料、撰写内容或制作小工具。简单的事情单独聊，需要配合的工作拉个群，在同一个地方沟通、查看进展和接收成果。

macOS 15 及以上提供 Apple Silicon 和 Intel 两种预览包，已附带对应的工作电脑运行时。Mac 预览包使用临时签名，尚未公证；首次打开和手动更新说明见 [Mac 预览版说明](docs/releases/v0.6.0.md)。

## 可以做什么

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>按职责组建团队</h3>
      <p>给每位 Bot 起个名字，安排它负责的工作。可以让一位整理资料，另一位专心写作，各自保留对话和工作记录。</p>
      <p><img src="docs/assets/screenshots/bot-team.png" alt="Bot 职责与资料" width="440"></p>
    </td>
    <td width="50%" valign="top">
      <h3>单聊与群聊</h3>
      <p>和一位伙伴聊需求，或把几位伙伴拉进群里协作。可以 @ 指定成员，Bot 之间也能私聊交换信息。</p>
      <p><img src="docs/assets/screenshots/group-chat.png" alt="Bot 群聊协作" width="440"></p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>独立工作电脑</h3>
      <p>每位 Bot 都有独立的工作桌面，可以浏览网页、处理文件和使用应用。你能查看进展，或亲自接管电脑。</p>
      <p><img src="docs/assets/screenshots/computer.png" alt="伙伴的工作电脑" width="440"></p>
    </td>
    <td width="50%" valign="top">
      <h3>资料随消息发送</h3>
      <p>把文档、表格和图片随消息发过去，和伙伴围绕材料开展工作。完成的文件可以在对话中查看、保存。</p>
      <p><img src="docs/assets/screenshots/attachments.png" alt="发送附件与查看成果" width="440"></p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>保留协作记忆</h3>
      <p>伙伴可以记住你的偏好和已确认的信息，积累处理同类工作的经验。长期项目也能沿用之前的记录。</p>
      <p><img src="docs/assets/screenshots/memory.png" alt="伙伴的记忆" width="440"></p>
    </td>
    <td width="50%" valign="top">
      <h3>安排例行工作</h3>
      <p>给单个 Bot 或群聊安排任务，约定某个时间执行，也可以每天、每周或按间隔重复。</p>
      <p><sub>按计划执行时，需要保持应用开启。</sub></p>
      <p><img src="docs/assets/screenshots/scheduled-tasks.png" alt="定时任务" width="440"></p>
    </td>
  </tr>
</table>

工作进展会显示在聊天里。需要你确认的本机操作会先提出请求，允许的范围也可以调整。

### 工作目录、计划与目标

- 输入框左下角的 **＋** 可以上传附件、选择本机工作目录。目录按单聊或群聊保存，显示为可移除的标签；本机命令的默认目录和文件的相对路径使用该目录。已经开始的任务保留原目录，目录选择不会增加操作权限。
- 输入 **`/plan 任务内容`**，Bot 先调查并生成带有验收条件的步骤清单。计划显示在输入框上方，点击 **开始执行** 后才允许实际修改项目。
- 输入 **`/goal 目标内容`**，Bot 会建立目标并持续执行、核对结果；遇到阻碍会说明原因。卡片支持暂停、继续、查看步骤和完成依据。达到运行预算或应用退出时保留进展，不自动重复执行。
- Bot 也能在已授权的任务范围内主动设置计划或目标，使用同一套步骤、执行记录和权限机制。输入 `/` 可以选择指令，附件、粘贴和 `@` 提及仍然可用。

## 用在哪些工作里

| 你正在做的事 | 可以交给伙伴的工作                       |
| ------ | ------------------------------- |
| 资料调研   | 阅读文件和网页，提取要点，整理成附有来源的主题摘要。      |
| 内容准备   | 搜集素材、整理提纲、起草文章，让不同伙伴分别参与撰写和校对。  |
| 数据报表   | 核对几份表格，汇总数据，整理结果并说明值得关注的变化。     |
| 网页与小工具 | 描述想要的功能，让伙伴协助编写、检查并交付可继续修改的文件。  |
| 例行工作   | 按约定时间整理周报、汇总项目记录，或根据现有材料生成待办清单。 |

例如，你可以在群里提出一个具体任务：

> “这几份材料是下周分享要用的。资料助手先核对内容，写作助手整理成十分钟的讲稿；有遗漏或拿不准的地方，在群里告诉我。”

之后可以继续补充文件、调整要求，或让某位伙伴接着修改其中一部分。
