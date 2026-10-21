# 连接器方案（飞书、企业微信等）

状态：飞书、企业微信、微信（实验）已实现，钉钉不做。调研日期 2026-10-14。使用说明见 [INTEGRATIONS.md](../INTEGRATIONS.md#连接器飞书企业微信微信)。

> 2026-10-20 更新：企业微信群的 @ 消息已支持——群消息不在应用层再按 owner/白名单过滤，权限由企业微信机器人后台的人员名单控制；回复发回群，审批仍走私聊。飞书和微信的群消息仍然丢弃。下面“不做群聊”的描述保留为 2026-10-14 的方案记录。

实现与方案的出入：

- 飞书直接用 SDK 的 `createLarkChannel()`（长连接、去重、CardKit 流式、卡片按钮都在里面），扫码用 `registerApp()`。SDK 在主进程打包时是 external，首次启用飞书时才加载。
- 企业微信没有用官方 SDK，基于已有的 `ws` 自己实现帧协议；微信基于 `fetch` 自己实现 iLink 协议。
- 权限模式：新建连接器会话时把连接器的模式写入这个会话，修改连接器时同步到它的全部会话；桌面端的会话权限选择器锁定，主进程也拒绝单独修改。
- 运行结束的时机不改 Harness：聊天队列启动运行时由 `Connectors.wrapRun` 包一层，用 `onStarted` 拿到运行 ID，`harness.run` 返回即运行已收尾。流式内容每秒从 `harness.streams.snapshot()` 读取。
- 不推流式内容：IM 里只发最终回复和附件，进行中用平台的提示代替（飞书给最新一条消息加 `Typing` 表情回应，微信用“正在输入”，企业微信没有）。流式卡片会让中间文字出现又被替换，看起来像消息消失。
- 没加入群聊相关的设计（第六节里的群聊策略、第五节的群聊映射均不实现）。

目标：用户在飞书、企业微信等 IM 里直接给自己的 Bot 发消息。Bot 在这台电脑上干活，把答复和文件发回去；绑定会话里的定时任务结果也推送过去。

已定的决定（2026-10-14）：

- 名称叫“连接器”，放在插件页，与“技能”“MCP”并列。代码里统一用 `connector`。
- 用户用的是飞书（不是 Lark 国际版）。首批做飞书，其次企业微信，之后是钉钉和个人微信。
- 每个外部私聊对应 Bot 的一个工作会话。
- 权限模式在插件页按连接器选择，这个连接器的所有会话都跟随它。
- 在连接器会话里从桌面端发消息，答复不同步到 IM。
- 允许在 IM 里批准本机操作。
- 关闭窗口后保持连接默认打开，插件页里可以随时关闭。
- 不做群聊。

## 一、范围

要做的：

- 私聊：外部用户 ↔ 绑定的 Bot，文字、图片、文件双向收发，平台支持时流式显示答复。
- 远程审批和提问：权限请求、`ask` 提问可以在 IM 里答复。
- 推送连接器会话里定时任务的结果。
- 第四期接办公能力：用连接器的凭证接入官方 MCP，让 Bot 能读写飞书文档、企微文档和日程。

不做的：

- 群聊。群里的消息一律丢弃，不进入 Bot，也不回复。
- 把桌面端发起的对话同步到 IM。
- 部署成服务器给全公司使用（多租户、高可用）。
- Webhook 回调模式，因为桌面端没有公网地址。
- Lark 国际版。很多 Lark 租户的后台没有长连接选项，暂不支持。

## 二、平台调研

### 2.1 总览

| | 飞书 | 企业微信 | 钉钉 | 个人微信 |
| --- | --- | --- | --- | --- |
| 形态 | 企业自建应用 + 机器人 | 智能机器人（API 模式） | 企业内部应用 + 机器人 | ClawBot 插件 |
| 收消息 | WebSocket 长连接 | WebSocket 长连接 | Stream（WebSocket） | HTTP 长轮询 |
| 需要公网 | 否 | 否 | 否 | 否 |
| 凭证 | App ID + App Secret | BotID + Secret | Client ID + Client Secret | 扫码得到 bot_token |
| 一键创建 | 有，SDK `registerApp()` 扫码 | 有，但接口没有公开 | 未找到 | 扫码登录 |
| 流式答复 | CardKit 流式卡片 | `stream` 消息，10 分钟内结束 | AI 卡片（需要卡片模板） | 无，只有“正在输入” |
| 按钮回调 | `card.action.trigger`，走长连接 | `template_card_event`，5 秒内更新 | 卡片回调，走 Stream | 无 |
| 主动发消息 | 可以 | 用户先在会话里发过消息才行 | 可以 | 不能主动发起 |
| 官方 Node SDK | `@larksuiteoapi/node-sdk` 1.75.0，MIT | `@wecom/aibot-node-sdk` 1.0.7，MIT | `dingtalk-stream` 2.1.6-beta.1，MIT | 无独立 SDK，协议在 OpenClaw 插件里 |
| 成熟度 | 官方文档完整 | 官方文档完整，长连接 2026 年才推出 | 官方文档完整 | 协议没有正式文档，有条款风险 |

### 2.2 飞书

- **长连接**：Node SDK 1.24.0 起提供 `WSClient`。只要能访问外网，不需要公网 IP、域名或内网穿透。鉴权只在建连时做一次，之后推送的事件是明文，不用自己验签解密。
- **事件**：收消息订阅 `im.message.receive_v1`，需要 `im:message` 相关权限，应用必须发布并通过审核。
- **3 秒限制**：事件要在 3 秒内处理完，否则会重推。处理函数只把事件入队，下载附件等耗时工作异步进行，并按 `message_id` 去重。
- **集群模式**：同一个应用同时有多个客户端连接时，每条消息只随机发给其中一个。所以一个应用不能在两台电脑上同时用，界面上要提示。每个应用最多 50 个连接。
- **卡片回调**：Node SDK 的 README 写着长连接“只支持事件订阅”，但新版官方文档《使用长连接接收回调》的示例已经用长连接处理 `card.action.trigger`（Node SDK 1.36.0 起）。远程审批的按钮依赖这一点，需要实测；不行就退回文字回复（见第八节）。
- **扫码一键创建**：`lark.registerApp()` 实现了 OAuth 2.0 设备授权（RFC 8628）。拿到链接后渲染成二维码，用户用飞书扫码确认，返回 `client_id`、`client_secret`，以及扫码人的 `open_id` 和 `tenant_brand`。
  - `appPreset` 可以预填应用名称和头像，用 Bot 的名字和头像。
  - `addons` 可以增量申请权限、事件和回调，`createOnly: true` 避免误选已有应用。
  - 文档说明“事件订阅方式”属于敏感配置，不能通过 `addons` 设置，需要调用“更新应用开发配置”接口。默认模板是否已经选好长连接**需要实测**。OpenClaw 的扫码流程能直接用长连接，说明多半可行。
  - 扫码人的 `open_id` 直接作为绑定人，不用另外配对。
  - 返回的 `tenant_brand` 是 `lark` 时提示暂不支持。
- **流式卡片**：用 CardKit v1。先创建 JSON 2.0 卡片实体，设 `streaming_mode: true`，用 `card_id` 发消息，再反复调用 `PUT /cardkit/v1/cards/:card_id/elements/:element_id/content` 写入全量文本（旧文本是新文本的前缀时显示打字机效果），最后关闭 `streaming_mode`。
  - 同一张卡片的 `sequence` 必须严格递增。
  - 卡片实体有效期 14 天。
  - 需要 `cardkit:card:write` 权限。
  - 流式状态下的卡片不能转发，结束后要关闭流式模式。
  - 同一卡片里的 `element_id` 不能重复（错误码 300301）。
- **高层封装**：新版 SDK 有 `createLarkChannel()`，把长连接、消息标准化、私聊/群聊策略、去重、流式答复（内部用 CardKit）、媒体上传下载、卡片交互和自动重连都包好了。可以直接用，省掉大部分适配代码。它的 `policy` 里有关闭群聊的选项。
- **体积**：SDK 解压后约 30 MB，单文件构建约 6 MB，依赖 axios 和 protobufjs。

### 2.3 企业微信

- **长连接**：智能机器人 → API 模式 → 连接方式选“使用长连接”。连接 `wss://openws.work.weixin.qq.com`，发送 `aibot_subscribe` 并带上 `bot_id` 和 `secret`，此后每 30 秒发一次 `ping`。长连接和回调地址只能二选一。
- **单连接**：每个机器人只能保持一个有效连接，新的订阅会顶掉旧连接（旧连接收到 `disconnected_event`）。
- **收消息** `aibot_msg_callback`：
  - 用 `msgid` 去重。
  - `chattype` 是 `single` 或 `group`。群消息只在 @ 机器人时推送，`text.content` 带 @ 提及；应用层不按 owner/白名单过滤，能 @ 到 Bot 的人由企业微信机器人后台的人员名单决定。发送人在 `from.userid`，群会话在 `chatid`。
  - `msgtype` 有 text、image、mixed、voice、file、video。
  - 媒体给出 `url`（5 分钟内有效）和 `aeskey`，用 AES-256-CBC 解密。
- **答复** `aibot_respond_msg`：
  - `msgtype: stream`，同一个 `stream.id` 反复推送更新，最后设 `finish: true`。
  - 从第一次推送起 10 分钟内必须结束。
  - 收到消息后 24 小时内可以回复。
  - Markdown 最多 20480 字节。
- **主动推送** `aibot_send_msg`：只能发给已经和机器人说过话的会话。
- **频率限制**：每个会话的回复和主动消息合计每分钟 30 条、每小时 1000 条；上传素材每个机器人每分钟 30 次。没有写明流式更新是否计入这个额度，所以保守处理：更新间隔不少于 1 秒，进度只改同一条消息。
- **按钮**：模板卡片的按钮点击产生 `template_card_event`，5 秒内用 `aibot_respond_update_msg` 更新卡片，可以用来做审批。
- **官方 SDK**：`@wecom/aibot-node-sdk`，约 0.5 MB。提供 `WSClient`、`replyStream`、`replyTemplateCard`、`sendMessage`、`uploadMedia`（分片上传）、`downloadFile`（自动解密）。自动重连默认最多 10 次，需要改成无限重试。
- **扫码一键创建**：官方 CLI `@wecom/wecom-openclaw-cli` 调用 `work.weixin.qq.com/ai/qc/generate?source=wecom-cli` 拿到 `scode`，再轮询 `query_result` 得到 `botid` 和 `secret`。这个接口没有公开文档，`source` 是他们 CLI 自己的标识，**不冒用**。第一版让用户手动填 BotID 和 Secret，附分步说明和后台链接。
- **MCP**：机器人编辑页的“可使用权限”里可以授权文档、消息、日程、会议等能力，然后复制 streamable HTTP 地址，形如 `https://qyapi.weixin.qq.com/mcp/...?apikey=...`。授权 7 天有效。10 人及以下的团队以授权成员身份调用，10 人以上以机器人身份调用，能用的能力也不同。

### 2.4 钉钉

- 企业内部应用里添加机器人能力，消息接收模式选 Stream。官方 `dingtalk-stream` SDK 很小（34 KB）。同一组 Client ID 和 Secret 同时只能有一个 Stream 服务。
- **流式答复**：AI 卡片。先用 `createAndDeliver` 创建并投放卡片（单聊的空间类型是 `IM_ROBOT`），然后反复调用 `PUT /v1.0/card/streaming`，最后一帧设 `isFinalize`。需要先在卡片平台建好模板。已知的坑：
  - 模板结束后渲染 `staticMsgContent`，没填就会变成空白。
  - 不要在收尾时再整卡更新一次。
- 没有找到官方的扫码建机器人接口。第一版不做卡片，只发 Markdown。

### 2.5 个人微信（ClawBot）

- 2026 年 3 月腾讯发布“微信 ClawBot”插件，底层是 iLink 协议，以 `@tencent-weixin/openclaw-weixin`（MIT，当前 2.4.10）发布。
- **流程**：
  1. `get_bot_qrcode` 获取二维码，`get_qrcode_status` 轮询，扫码后得到 `bot_token`。
  2. `getupdates` 长轮询收消息，服务器最多挂 35 秒。游标 `get_updates_buf` 必须持久化，否则会重复收到旧消息。
  3. `sendmessage` 回复，必须原样带上收到消息里的 `context_token`。
  4. 另有 `sendtyping` 显示“正在输入”，媒体走 CDN（AES-128-ECB）。
- **限制**：每个 ClawBot 绑定一个微信用户，同时只能连一个 Agent 实例；不能主动发起对话，所以定时推送不可靠。
- **风险**：
  - 协议细节来自社区对官方 npm 包的分析，没有正式文档，包里还带着 `ilink_appid` 等标识。
  - 《微信 ClawBot 功能使用条款》没有限定只能接 OpenClaw，但第 4.7 条写明腾讯可以决定能连接的第三方 AI 服务类型和范围，并可以拦截。
  - 只作为“实验性”提供。

### 2.6 其他平台

Telegram 长轮询、Slack Socket Mode、Discord Gateway 也不需要公网地址，同一套框架可以直接接，按需求排期。

## 三、现状

| 关注点 | 现在的实现 | 对连接器的意义 |
| --- | --- | --- |
| 插件页 | `src/settings/PluginsPage.tsx` 只有技能和 MCP，偏好存在 `~/.aelion/integrations.json`（`electron/core/extensions/integrations.ts`） | 新增“连接器”分类 |
| 输入入口 | `ChatPinQueue.send` / `schedule`（`electron/core/agent/chat-pins.ts`）写入消息并按通道排队。主聊天和每个工作会话各一条通道，可以并发；新输入会让同一通道里正在运行的任务让路 | 外部消息走同一入口 |
| 工作会话 | `WorkSession` 有独立的历史、上下文、文件夹、权限和定时任务 | 一个外部私聊对应一个工作会话 |
| 权限模式 | `hostPermissionModes`，键是 `bot:<id>` 或 `session:<id>`。`HostApprovals.scopeFor` 规定：会话设过自己的模式就用自己的，否则跟随 Bot 主会话 | 每个工作会话都保存自己的模式；连接器设置同步到它的会话，单个会话仍可再调整 |
| 流式文本 | `ReplyStreams`（`electron/core/agent/reply-streams.ts`）按 100 ms 节流，只有一个全局 `onEmit` | 需要加按运行订阅的接口 |
| 最终答复 | `presentation: 'answer'` 的 assistant 消息；`message_attach` 把文件挂在最终答复上 | 回推内容的来源 |
| 运行收尾 | `Harness.finishRun` 是运行唯一的收尾点 | 在这里发 `runFinished` 事件 |
| 交互 | `Interactions`：`host_permission`、`user_input`、`vm_takeover`，现在只能在界面里答复 | 远程审批调用 `approve` 和 `answer` |
| 密钥 | `safeStorage` 加密（`ModelProviders` 的 codec） | 连接器凭证照此存储 |
| 生命周期 | `window-all-closed` 时调用 `app.quit()`（`electron/main.ts`） | 要支持关窗口后保持连接 |
| 依赖 | 已有 `ws`、`undici` | 企微、钉钉、微信不一定需要新依赖 |

## 四、整体结构

```text
飞书 / 企业微信 / 钉钉 / 微信
        │  从本机出站的长连接（WebSocket / 长轮询）
        ▼
ConnectorAdapter（electron/core/connectors/adapters/<平台>.ts）
        │  统一成 InboundMessage / OutboundReply
        ▼
ConnectorHub（electron/core/connectors/connector-hub.ts）
  ├─ 访问控制：只接受绑定人和白名单；群消息丢弃
  ├─ 会话映射：外部私聊 → Bot 的工作会话
  ├─ 去重、指令（/new /stop /status /help）
  ▼
ChatPinQueue.send ──► BotRuntime / Harness（不改主流程）
                              │
ConnectorOutbox ◄─────────────┘  订阅 ReplyStreams、runFinished、Interactions
  ├─ 流式卡片和进度
  ├─ 最终答复、附件上传、长文本分段
  └─ 审批卡片、提问
        │
        ▼
      各平台
```

适配器接口（示意）：

```ts
interface ConnectorAdapter {
  readonly platform: 'feishu' | 'wecom' | 'dingtalk' | 'weixin';
  readonly capabilities: { streaming: boolean; cards: boolean; proactive: boolean; files: boolean };
  /** 建立连接并持续自动重连，直到 signal 取消。 */
  start(signal: AbortSignal): Promise<void>;
  status(): ConnectorStatus; // connecting | connected | displaced（被其他设备顶掉） | needs-config | error
  onMessage(handler: (message: InboundMessage) => void): void;
  onAction(handler: (action: CardAction) => void): void;
  send(target: ConnectorTarget, reply: OutboundReply): Promise<SentRef>;
  /** 没有流式能力的平台返回 undefined，由 Outbox 退化为“正在输入”加最终消息。 */
  stream?(target: ConnectorTarget): { update(text: string): Promise<void>; finish(text: string): Promise<void> };
  download(resource: ResourceRef, signal: AbortSignal): Promise<{ name: string; bytes: Buffer }>;
}

interface InboundMessage {
  connectorId: string; // 本地连接器 ID
  messageId: string; // 平台消息 ID，用于去重
  chatId: string; // 私聊会话 ID
  isGroup: boolean; // 为 true 时 Hub 直接丢弃
  senderId: string;
  senderName?: string;
  text: string;
  quoted?: string;
  resources: ResourceRef[];
  sentAt: string;
}
```

## 五、会话映射

- **连接器与 Bot**：一个连接器（一个飞书应用或一个企微机器人）只绑定一个 Bot，对外的名字和头像与 Bot 保持一致（飞书扫码创建时用 `appPreset` 预填）。想在飞书里用多个 Bot，就为每个 Bot 各建一个应用。
- **外部私聊与工作会话**：映射键是 `connectorId + chatId`。第一次收到消息时自动建一个工作会话，名称例如“飞书 · 张三”。
  - `WorkSession` 新增可选字段 `connector: { connectorId, platform, chatId, title }`，侧栏的会话行显示平台小图标。
  - 历史和上下文隔离、独立文件夹、与主聊天并发（`run-lanes.ts`），这些都直接沿用。
  - 用户回到电脑前，可以在桌面端的同一个会话里接着聊。按已定的决定，这时候的答复不发到 IM。
- **消息来源**：`ChatMessage` 新增 `connector: { connectorId, messageId, senderId, senderName }`。界面上标出“来自飞书”，模型输入里也带上来源。
- **IM 内的指令**：由 Hub 处理，不交给模型。
  - `/new`：归档当前会话，下一条消息开新会话。
  - `/stop`：取消这个会话的通道。
  - `/status`：Bot 状态和当前任务。
  - `/help`。
  - `/plan`、`/goal` 照常交给 Bot。

## 六、访问控制与安全

Bot 能在本机执行命令、读写文件。连接器等于在 IM 里开了一个远程入口，所以默认要收紧。

- **绑定人**：
  - 飞书扫码创建：扫码人的 `open_id` 自动成为绑定人。
  - 企微、钉钉和手动配置的飞书：第一次有人私聊时，在 IM 里回复一个 6 位配对码，用户在桌面端确认后才绑定（参考 OpenClaw 的 pairing）。
  - 个人微信：ClawBot 本来就只绑定扫码人。
- **陌生人**：默认拒绝，消息不进入 Bot 上下文。最多回复一次“未授权”，之后静默。插件页可以加白名单；白名单里的人各自对应一个会话，他们触发的审批仍然发给绑定人。
- **群聊**：不做。群消息丢弃；飞书扫码创建时也不申请群消息权限。
- **权限模式**：
  - 插件页按连接器选择（每次询问 / 自动审批 / 完全访问），新建时默认自动审批。
  - 存成连接器配置的 `permissionMode`；建会话时写入该会话自己的权限，升级时也会给缺少模式的会话补齐连接器模式。
  - 连接器的模式会同步到它的所有会话；桌面端仍允许单独修改某个会话，修改只影响该会话。
- **远程审批**：允许，见第八节。只提供“允许一次”和“拒绝”，不提供“总是允许”，长期规则仍在桌面端设置。
- **Computer Use 和接管**：远程触发时不弹出“允许 Bot 使用你的屏幕”的确认，直接回复“需要在电脑前处理”。
- **数据外发**：答复和附件会经过飞书或企微的服务器，添加连接器时提示一次。附件上传前检查大小，超过平台限制就改成文字说明。
- **凭证**：App Secret、Bot Secret、bot_token 用 `safeStorage` 加密，存在数据目录的 `connectors.json`。快照只给渲染进程 `hasSecret`，诊断日志里脱敏（`diagnostic-redaction.ts`）。
- **单连接冲突**：企微新连接会顶掉旧连接，飞书多个客户端会随机分发消息。检测到被顶掉时状态显示“已在其他设备连接”，不自动抢回来，避免两台电脑互相踢。

## 七、消息收发

收消息：

1. 适配器收到事件后立即确认（飞书要求 3 秒内），按 `messageId` 去重，每个连接器保留最近 2000 个 ID。
2. Hub 丢弃群消息，做访问控制和指令识别，再找到或创建工作会话。
3. 有附件时先下载（企微的地址 5 分钟后失效，要立即下载），用 `Attachments.importFiles` 导入，得到附件 ID。
4. 调用 `ChatPinQueue.send({ botId, sessionId, message, attachmentIds, replyToMessageId })`。连续发来的多条消息、新输入让当前任务让路，都和桌面端的行为一致。
5. 引用的消息作为回复上下文传入（`replyInput`）。语音消息优先用平台给的转写文字，没有就作为附件。
6. 消息超过 32000 字时截断并提示，这是 `validateChatInput` 的上限。

发答复（ConnectorOutbox）：

- **发哪些**：只发两类运行的答复：输入来自 IM 的运行，以及连接器会话里定时任务的运行。桌面端发起的运行不发。
- **流式**：
  - 飞书用 CardKit 流式卡片。
  - 企微用 `stream` 消息：快到 10 分钟时先结束当前这条，剩下的内容另发一条。
  - 钉钉第一版不流式。
  - 微信发“正在输入”，最后发整条。
  - 更新间隔不少于 1 秒。
- **进度**：Bot 的中间步骤（`presentation: 'progress'`）不逐条发出，只在卡片顶部保留一行状态，例如“正在运行命令…”。最终答复覆盖它。
- **格式**：Markdown 转成各平台支持的子集。飞书卡片用 markdown 组件；企微 markdown 最多 20480 字节；钉钉用 markdown；微信只发纯文本。超过长度上限的内容按段落拆分。
- **附件**：`message_attach` 附加的文件逐个上传。超过大小限制或上传失败时，改发文件名和“请在电脑上查看”。
- **失败和取消**：发一条简短说明，不带堆栈。
- **主动推送**：企微只能推送给最近说过话的会话，微信不能主动发起对话。推送失败时结果留在桌面端，并记一条事件。

## 八、远程审批与提问

Outbox 监听 `Interactions` 的变化，只处理连接器会话的运行。审批和提问只发给绑定人：

| 请求 | 飞书、企微、钉钉 | 个人微信，以及卡片回调不可用时 |
| --- | --- | --- |
| `host_permission`（等待中，不含审核模型正在审的） | 卡片：操作摘要、命令或路径、风险说明，按钮“允许一次 / 拒绝”。点击后先校验点击人是绑定人，再调用 `interactions.approve(id, allow)` | 文字：“回复 1 允许、2 拒绝（#A3F）” |
| `user_input` | 有选项的问题做成按钮；自由回答的问题，把绑定人的下一条消息当作答案，调用 `interactions.answer` | 文字编号 |
| `vm_takeover`、Computer Use | 提示“需要你在电脑前处理”，请求留在桌面端 | 同左 |

不管在 IM 还是桌面端处理，处理完都把卡片更新为“已允许 / 已拒绝 / 已失效”。

## 九、关窗口后保持连接

- 插件页的连接器分类里有一个开关“关闭窗口后保持连接”，默认打开，随时可以关。
- 打开时，只要有启用中的连接器，关窗口就只隐藏窗口，托盘显示连接状态，菜单项为“打开 AelionBot”和“退出”。
- 没有启用中的连接器时，或者关掉这个开关后，关窗口和现在一样直接退出。
- 应用更新、`before-quit` 的流程不变。
- 睡眠和断网后，在 `powerMonitor` 的 `resume` 事件和网络恢复时立即重连。离线期间的消息平台会不会补发，飞书和企微都没写明，需要实测。微信靠持久化的游标可以补收。
- 收到离线期间积压的旧消息（例如超过 10 分钟）时，先回复“刚上线，看到你之前的消息”再处理。
- 开机自启以后再看，这次不做。

## 十、界面

- **插件页**：`PluginFilter` 增加 `'connectors'`，筛选里显示为“连接器”，顶部按钮增加“添加连接器”。连接器卡片显示平台图标、名称、绑定的 Bot、状态（已连接 / 连接中 / 需要配置 / 已在其他设备连接 / 连接失败）和开关。分类里还有“关闭窗口后保持连接”开关。
- **添加连接器对话框**：先选平台。
  - 飞书：“扫码创建（推荐）”显示二维码并实时更新状态；也可以手动填写 App ID 和 App Secret，界面上列出所需的权限和事件。
  - 企业微信：填写 BotID 和 Secret，附分步说明和后台入口。
  - 个人微信：扫码登录，标注“实验性”。
  - 最后选择绑定的 Bot 和权限模式。
- **详情页**：
  - 绑定的 Bot、权限模式、绑定人、白名单。
  - 关联的会话列表，可以跳转到对应会话。
  - 测试连接、最近错误、断开并删除。
- **侧栏**：连接器会话显示平台小图标。
- **文案**：新增中文文案时同步更新 `shared/i18n/locales/en.ts` 和 `zh-TW.ts`。

## 十一、数据与代码结构

新增：

```text
shared/types/connector-types.ts              平台、配置视图、状态、InboundMessage 等
electron/core/connectors/connector-store.ts  connectors.json（凭证加密）、去重 ID、游标
electron/core/connectors/connector-hub.ts    访问控制、会话映射、指令
electron/core/connectors/connector-outbox.ts 流式、最终答复、附件、审批卡片
electron/core/connectors/format.ts           Markdown 转各平台格式、按长度分段
electron/core/connectors/adapters/{feishu,wecom,dingtalk,weixin}.ts
electron/ipc/register-connectors.ts
src/settings/{ConnectorCard,ConnectorDetails,AddConnectorDialog}.tsx
tests/connectors-*.test.ts                   用 ws 搭本地假服务器，不连真实平台
```

对现有代码的改动（都很小）：

- `shared/ipc.ts`：连接器的增删改、启停、开始和取消扫码、测试连接、保持连接开关。
- `shared/types/core.ts`：`WorkSession.connector`、`ChatMessage.connector`、`Snapshot.connectors`。
- `harness.ts`：在 `finishRun` 里发出 `runFinished(run)`，只加一个事件，不改流程。
- `reply-streams.ts`：增加 `subscribe(runId, listener)`。现有的 `onEmit` 只服务界面，不和连接器共用。
- `host-approvals.ts`：`scopeFor` 和 `modeFor` 识别连接器会话。
- `Interactions`：增加变更监听，或者让 Outbox 在 `changed` 里比较 `snapshot()`。
- `main.ts`：创建 Hub 和 Outbox；增加托盘；`window-all-closed` 按开关决定是否退出。
- `docs/THIRD-PARTY-NOTICES.md`、`docs/INTEGRATIONS.md`。

依赖选择：

- 飞书：用官方 SDK。它的长连接是 protobuf 帧，自己实现不划算，而且 `registerApp()` 和 `createLarkChannel()` 能省很多事。SDK 构建产物约 6 MB，主进程打包时设为 external，第一次启用飞书时再 `require`，不拖慢启动。
- 企业微信：`@wecom/aibot-node-sdk` 体积小，协议也简单，用 SDK 或基于现有 `ws` 自己写都可以。自己写没有新依赖，也能把重连改成无限重试。
- 钉钉：`dingtalk-stream` 很小，可以直接用。
- 个人微信：基于 `undici` 自己实现，约几百行，不依赖 OpenClaw 插件包。

## 十二、分期

1. **第一期：框架和飞书**
   - Hub、会话映射、Outbox（流式卡片、最终答复、附件）。
   - 访问控制和按连接器设置的权限模式。
   - 远程审批卡片和提问。
   - 关窗口后保持连接、托盘。
   - 插件页的连接器分类、添加对话框和详情页。
   - 飞书扫码创建和手动配置。
2. **第二期：企业微信**
   - 长连接，手动填写凭证，配对码。
   - stream 流式答复、模板卡片审批。
3. **第三期：钉钉和个人微信**
   - 钉钉 Stream，只发 Markdown。
   - 个人微信，实验性。
4. **第四期：办公能力**
   - 飞书：连接器应用的 tenant_access_token 直接给 `mcp.feishu.cn/mcp` 用（请求头 `X-Lark-MCP-TAT`，目前是内测，主要是云文档）。现在的 MCP 运行时只支持静态请求头，需要加一个会自动刷新的令牌来源。
   - 企微：一键导入机器人的 MCP 地址。

每一期都按仓库约定跑 typecheck、lint、knip、format:check、test、build。

## 十三、需要实测

- 飞书扫码创建的应用，是否默认就用长连接接收事件；不是的话，扫码后调用“更新应用开发配置”接口设置。
- 飞书 `card.action.trigger` 能否通过长连接收到。决定审批用按钮还是退回文字回复。
- 断网或休眠期间的消息，飞书和企微会不会补发。
- 企微的流式更新是否计入每分钟 30 条的额度。

## 参考

- 飞书：[使用长连接接收事件](https://feishu.apifox.cn/doc-7518429)、[使用长连接接收回调](https://open.larkoffice.com/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/callback-subscription/configure-callback-request-address)、[Node SDK](https://github.com/larksuite/node-sdk)（`registerApp`、`docs/channel.md`）、[流式更新卡片](https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview?lang=zh-CN)、[开发者调用远程 MCP 服务](https://open.feishu.cn/document/mcp_open_tools/developers-call-remote-mcp-server?lang=zh-CN)、[Lark 长连接问题](https://github.com/openclaw/openclaw/issues/51663)
- 企业微信：[智能机器人长连接](https://developer.work.weixin.qq.com/document/path/101463)、[aibot-node-sdk](https://github.com/WecomTeam/aibot-node-sdk)、[API 模式机器人文档使用说明](https://developer.work.weixin.qq.com/document/path/101468)、[企业微信接入 OpenClaw](https://work.weixin.qq.com/nl/index/openclaw)、[官方 OpenClaw 插件](https://github.com/WecomTeam/wecom-openclaw-plugin)
- 钉钉：[dingtalk-stream](https://www.npmjs.com/package/dingtalk-stream)、[AI 卡片流式更新](https://open.dingtalk.com/document/development/api-streamingupdate)、[卡片示例](https://github.com/open-dingtalk/dingtalk-card-examples)、[openclaw-channel-dingtalk 的 AI 卡片说明](https://github.com/soimy/openclaw-channel-dingtalk/blob/main/docs/user/features/ai-card.md)
- 个人微信：[iLink 协议拆解](https://github.com/x1ah/wechat-ilink-demo)、[协议说明](https://github.com/hao-ji-xing/openclaw-weixin/blob/main/weixin-bot-api.md)、[ClawBot 使用条款讨论](https://news.qiniu.com/archives/1774336786737)
- 参考实现：[OpenClaw 渠道](https://docs.openclaw.ai/channels)、[openclaw-china](https://github.com/BytePioneer-AI/openclaw-china)
