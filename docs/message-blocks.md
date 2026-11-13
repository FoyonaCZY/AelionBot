# 回复里的图表与交互内容

Bot 直接在回复正文里写围栏代码块，应用把它们画出来，不需要调用工具。分两类：

- **数据块**：```` ```chart ````、```` ```table ````、```` ```metrics ````、```` ```timeline ````、```` ```callout ````、```` ```calculator ````。正文是一个 JSON 对象（规格字段加可选的 `title`），由应用自己的组件渲染，样式统一。
- **小组件**：```` ```widget ````。正文是一段 HTML（可带 `<style>`、`<script>`），在沙箱 iframe 里运行，用于数据块表达不了的内容：卡面对比、示意图、带插图的步骤、小工具。

v0.52.x 及更早要先调用 `message_block` 工具存块，再在正文里写 `[[block:id]]` 标记。工具已经删除；旧消息里存在 run 上的块和标记照常显示（`MessageBlockContent`）。

## 1. 为什么改成写在正文里

- 一次回答不用多一轮工具调用，流式输出时块和正文一起出现。
- 模型用熟悉的 Markdown 写法就能用，不用记工具参数和标记。
- 预设的 6 种块覆盖不了“自定义卡片、示意图”这类需求；HTML 小组件补上了这一块，数据类内容仍走统一样式的数据块。

## 2. 数据块

规格和校验沿用原来的 `createMessageBlock`（`shared/chat/message-blocks.ts`）：图表点数、表格行列、计算器公式白名单（只有数字、输入 id、`+ - * /`、括号和 `min max round floor ceil abs`）、64 KB 上限都不变。

- `inlineBlock(type, json)` 把围栏正文解析成块；`{"title", ...spec}` 和 `{"title", "spec": {...}}` 两种写法都接受。
- 解析失败时显示“这个图表没能显示：原因”，不会白屏。
- `blockText` 生成纯文本版本，用于连接器和朗读（见第 5 节）。

## 3. 小组件沙箱

`src/chat/MessageVisual.tsx` 把 HTML 交给 `public/widget-frame.html`（构建时原样复制到 `dist/`）。

- iframe `sandbox="allow-scripts"`，**不加** `allow-same-origin`：不透明源，拿不到应用页面、存储和 cookie。
- 框架页面有自己的 CSP：`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:`。不能联网，也不能加载外链图片（外链图片可以把数据带出去）。
- 应用主窗口的 CSP 不放宽。`srcdoc` 和 `blob:` 的 iframe 会继承主窗口不允许内联脚本的策略，所以框架必须是一个独立的页面。
- 通信只用 `postMessage`，父窗口核对 `event.source === iframe.contentWindow`：
  - 框架发 `ready` 后，父窗口发 `render`，内容是 HTML 和解析好的主题色。主题色以 `--aelion-text`、`--aelion-muted`、`--aelion-surface`、`--aelion-border`、`--aelion-accent`、`--aelion-font` 这些 CSS 变量提供，配色方案跟随应用的深浅色。
  - 框架用 `ResizeObserver` 上报高度，父窗口按高度设置 iframe，最高 2400px。
  - `aelion.prompt(text)` 把一句追问填进当前会话的输入框，由用户决定是否发送，不会自动发出。每 0.8 秒最多一次，最长 2000 字。
- 流式输出时，如果最后一个围栏还没闭合，只显示“正在生成图示…”，不会渲染半截 HTML 或半截 JSON（`MessageMarkdown` 的 `openFenceStart`）。
- 小组件直接运行，不需要点击：它没有网络，也没有能把数据带出去的通道，能做的事只有展示和往输入框里填字。

2026-11-14 在 Electron 44 下验证过：主窗口用 `file://` 加 CSP 时框架能正常加载，内联脚本和 `onclick` 都能执行；访问父页面、cookie、`fetch`、外链图片都会被拦截。

## 4. 提示词

`harness` 的 `richReplies` 选项打开时，系统提示加入 `RICH_REPLIES` 段落：列出数据块的 JSON 格式和小组件的约束。条件与原来的 `message_block` 相同：只在应用里显示的会话（不含群聊协作、Bot 私聊、headless），并且上下文不小于 32k 或处于私聊工作会话。

## 5. 应用之外的地方

- **连接器**（飞书、企微、微信）：`visualsAsText` 把数据块换成文字，把小组件换成其中的可见文字（去掉 `<style>`、`<script>`、`<svg>`）。小组件没有文字时，提示“请在 AelionBot 里查看”。
- **朗读**：`spokenText` 先做同样的替换。
- **模型上下文**：围栏留在消息正文里，后续轮次模型能看到自己写过的内容。代价是小组件的 HTML 会占用上下文。

## 6. 测试

- `tests/message-blocks.test.ts`：规格校验、公式、计算器、旧标记分段、围栏解析、纯文本转换。
- `tests/system-prompt.test.ts`：只在 `richReplies` 时出现围栏说明。
- 沙箱行为（CSP、隔离、高度、`aelion.prompt`）目前靠在 Electron 里手动验证，没有自动化测试。
