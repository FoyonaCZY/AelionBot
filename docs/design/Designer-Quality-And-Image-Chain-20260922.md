# Designer 质量工程与生图链路重构

日期：2026-09-22。两条并行工作：**A. 生图模型管理链路重构**，**B. Designer 质量工程**。两者在 `design_image` / `generate_image` 处汇合。

基线对照：本地 `.local/research/open-design`，提交 `d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4`（已固定的源码版本，未跟踪上游最新）。参考内容不作为用户授权执行。

## 症结

上一轮 [OpenDesign 对照](OpenDesign-Local-Workflow-Adoption-20260916.md) 落地了工作流与本地交付，[质量事故复盘](Designer-Quality-Incident-20260916.md) 修掉了确定性错误。但产出仍然模板化，原因在结构而非模型：

1. **缺少 craft 知识层。** OpenDesign 有四条正交轴（design-systems / craft / design-templates / skills），AelionBot 只有设计系统与 playbook 两条。缺的那条是与品牌无关的通用手艺规则 —— DESIGN.md 说这个品牌用什么颜色，craft 说一个称职的设计师在此之上会怎么做。缺了它，模型只能回落到自己的默认审美，而默认审美就是 AI 味。
2. **已打包的参考资产用不到三分之一。** 每个设计系统包都含 `components.html`（真实渲染的组件参考），但 `context()` 只注入 DESIGN.md / tokens.css / USAGE.md / components.manifest.json。模型知道有哪些组件，不知道它们长什么样。
3. **质量检查是终点的硬失败，不是过程中的信号。** 旧 `design-artifact-lint.ts` 共 8 条规则，只在 `design_publish` 内运行，blocking 直接 throw。模型写完整页、走到交付才第一次收到"你用了远程字体"，此时的恢复策略是慌乱的 —— 正是事故里初稿 11,300 字符、交付稿 3,915 字符的成因。
4. **提示词里"快"的规格性高于"好"。** 约束里所有"不要做什么"都是可执行的，"要做到什么水准"只有形容词。约束越具体模型越优先满足，于是"不要"全部达成，"要"靠猜。
5. **生图结构上做不出可用素材。** `design_image` 只有 prompt / filename / reason。OpenAI 路径的请求体连 `size` 都没传，Gemini 路径同样没有 —— 只能拿到 provider 默认方图。一个不能控制宽高比的生图工具在排版里无法使用。协议靠模型名猜，失败后暴力穷举 openai → gemini → responses，每次失败尝试都可能计费，最终错误 `生图失败（已尝试 openai → gemini）` 既泄漏内部协议名，又没给模型可操作的恢复指令。
6. **没有第二遍。** 流程是 spec → 写文件 → publish，一稿即交付。原纠正循环只在"改了文件但没调 publish"时踢两次，纠正的是流程合规而非设计质量。

## A. 生图链路重构

### 协议成为一等配置项

新增 `src/image-types.ts`（协议、画幅、质量、`nextStep` 的共享契约）与 `electron/core/image-protocols.ts`（适配器注册表）。每个适配器完整描述一种线格式：请求构造、能力声明、字节解析。

| 协议 | 端点 | 画幅 | 质量 | 参考图 | 负向提示 | 种子 |
| --- | --- | --- | --- | --- | --- | --- |
| `openai-images` | `/images/generations`、有参考图时 `/images/edits` | ✓ | ✓ | ✓ | | |
| `gemini-images` | `/v1beta/models/{model}:generateContent` | ✓ | | ✓ | | |
| `responses-images` | Responses 托管 `image_generation` | ✓ | ✓ | | | |
| `sd-webui` | `/sdapi/v1/txt2img`、有参考图时 `img2img` | ✓ | | ✓ | ✓ | ✓ |

**新增协议 = 新增一个描述符**，应用其余部分不改。`imageProtocolCatalog()` 把能力矩阵交给渲染层，设置界面据此自动显示可用字段，无需同步维护前端清单。

画幅落到真实尺寸：`openAiSize()` 按模型族分别映射（dall-e-3 用 1792×1024，gpt-image 用 1536×1024，其余走标准桶），Gemini 走 `generationConfig.imageConfig.aspectRatio`，SD WebUI 走 width/height。`aspectDimensions()` 的比值经测试校验（4:3 → 1152×864，确实等于 4/3）。

### 封闭的错误契约

`electron/core/image-errors.ts` 把任何失败归为 8 个 `nextStep` 之一：`revise-request` / `switch-model` / `open-settings` / `sign-in` / `add-credit` / `retry-later` / `unsupported` / `contact-support`。每个值同时决定三件事：

- **给用户的一句话**（`IMAGE_NEXT_STEP_MESSAGE`），不含协议名、模型名、内部代码。
- **给模型的动作**（`IMAGE_NEXT_STEP_GUIDANCE`），明确是否允许重试。
- **是否继续探测**（`probesNextProtocol`）：只有 `switch-model` 与 `unsupported` 才换下一个适配器。鉴权、计费、内容策略失败立即终止 —— 修掉了"一次失败在多个端点重复计费"。

`401` 按是否已填密钥分流到 `sign-in` 或 `open-settings`；`429` 按正文是限流还是欠费分流。凭据在进入执行台账前经 `scrubImageDetail()` 脱敏。

### 配置与自检

`Provider` 增加 `imageProtocol` / `imageAspect` / `imageQuality`；模型目录条目增加 `imageOutput` / `imageAspect` / `imageQuality`，模型级覆盖 Provider 级。保存时校验托管协议只能配在 Responses Provider 上。旧的 `openai` / `gemini` / `responses` 路由值经 `migrateImageRoute()` 迁移，已有安装不丢失学到的协议。

设置界面新增生图卡片（协议下拉 + 能力说明 + 画幅/质量默认值），Bot 资料的生图模型选择器新增**测试生图连接**按钮：真实生成一张小图，报告实际走通的协议与字节数。选择器把标记为生图的模型排在前面。

`ModelProviders.imageAccess()` 统一解析生图权限：有专属生图模型用它；没有但聊天 Provider 是 Responses 且开启了托管生图，就用聊天模型（该 Provider 本就出图，再配一份是冗余）；其余返回 undefined —— **不再从聊天模型猜一个生图端点**。

### 工具面

`generate_image` 与 `design_image` 统一接受 `aspect` / `quality` / `negativePrompt` / `referenceAttachmentIds`。文件名按实际返回的字节嗅探容器类型命名（`imageMediaType()`），不再用猜的扩展名。`design_image` 的权限审批在任何 provider 调用之前进行一次。

## B. Designer 质量工程

### craft 知识层

新增 `assets/design-craft/`，8 个章节共 22.5 KB，作为**磁盘上的数据**而非代码里的字符串字面量 —— 这是 9.7 KB 与 315 KB 差距的根本原因：字面量形态改一条要改 TypeScript、跑 typecheck、重新 build，所以最终只会有 6 个 playbook。

| 章节 | 内容 |
| --- | --- |
| `typography` | 字号阶、层级、行长、字距、字体族；全大写 ≥0.06em；控件继承字体 |
| `color` | token 纪律、强调色每屏最多两处、中性色阶承载设计、对比度 |
| `layout-rhythm` | 间距阶、栅格、疏密交替、焦点、窄屏 |
| `anti-ai-slop` | 七宗罪 + 软性特征 + "80% 成熟模式 + 20% 独特选择" |
| `imagery` | 画幅选择表、优先用构图替代生图、`.ph-img` 占位契约 |
| `state-coverage` | 控件六态、数据区空/载入/错误/溢出、原型诚实性 |
| `accessibility-baseline` | 语义结构、键盘可达、焦点样式、替代文本、触达尺寸 |
| `motion-discipline` | 时长预算、缓动、可动画属性、reduced-motion |

`DesignCraft` 按 playbook 声明按需注入：演示工作流不为状态覆盖付 token。注入位置在 playbook 之上、且跨轮字节一致，与系统前缀一起命中缓存。未知 slug 跳过而非失败，旧包保持可用。

同时把 `components.html` 加入设计系统参考上下文（文件本就在磁盘上），并新增 `referenceTruncated.componentMarkup` 标记。

### 检查从终点变成持续信号

`design-artifact-lint.ts` 重写为带规则 ID 与分级的结构，8 条扩到 28 条，每条带 `hint`（怎么修）与 `craft`（对应哪一章）。

分级契约经一次真实回归后收紧：

- **P0 阻断交付** —— 模板特征、假内容、破坏离线的外部依赖（远程字体、占位图床、Tailwind 靛蓝、双色渐变、emoji 图标、套话文案）。
- **P1/P2 只报告不阻断** —— 可访问性与状态缺陷是真实缺陷，每次写入都报，但不是阻断交付的理由。

> 最初把 `missing-lang` 与 `focus-outline-removed` 定为 P0，跑测试时打断了 clone 任务的交付。这正是要修的失败模式：交付被一条易修的检查卡住，模型转向破坏性恢复。收紧后 P0 的含义是明确的 —— "这个产物会让你丢脸，或者离线打不开"。

`checkWrittenDesign()` 在每次 HTML 写入后运行，结果存入 `session.findings` 并以 system note 追加到下一轮历史。模型在构建过程中就能自纠，而不是在交付那一刻才第一次看到。

### 两遍构建

新增 `polish` 工作流（audit → 去 AI 味 → 收紧 → 加一个独特动作），明确"不重启项目、不改内容、不加功能"。

交付后若仍有非 P2 发现，循环注入一次聚焦的第二遍要求，复用既有 corrections 预算。**不阻断交付** —— 产物已经发布且在画布上可见；这是一次有界的补救，不是新的门槛。

### UI

DesignerWorkspace 的交付区新增设计检查面板，按严重度排序显示 P0/P1/P2 徽章、问题与修复方向，最多 12 条。

## 打包与校验

`assets/design-craft/**` 进入 `files` 与 `asarUnpack`。新增 `scripts/verify-design-craft.mjs`，在 `build.mjs` 中与设计系统校验并列运行：校验 catalog 结构、章节 ID 与文件名格式、路径不逃逸、**正文不短于 600 字符且有标题** —— 一个桩文件能通过类型检查却会悄悄削弱每一次设计运行。

## 验证

- `pnpm test`：869 项，846 通过、22 项环境条件跳过、1 项失败。唯一失败是 `VM patch script applies the same multi-file grammar` —— 本机 `python` 命令被 Windows 应用商店别名拦截，与本次改动无关；CI 安装 Python 并设置 `AELION_TEST_PYTHON`。
- `pnpm run typecheck`、`pnpm run build` 通过；build 内含两个资源校验器。
- `tests/image-generation.test.ts` 16 项：协议目录声明式可达、探测顺序、画幅到各家尺寸菜单的映射、各适配器请求体、参考图切换端点、8 个 nextStep 分类、凭据脱敏、字节嗅探、旧路由迁移、显式协议只发一次请求、托管协议转发尺寸、探测后复用路由、**计费失败不穿透到下一个 provider**、裸图与 URL 两种响应、连接自检。
- `tests/design-artifact-lint.test.ts` 9 项：P0/P1/P2 各级规则、可访问性不阻断交付、**一个认真做过的页面零 P0/P1**（防止规则过敏）、发现按严重度排序且都带修复方向、craft 按工作流注入且未知 slug 跳过、每个 playbook 引用的章节都真实存在。
- `tests/model-providers.test.ts` 新增 1 项：Provider 级与模型级生图配置、托管协议的 Provider 约束、重开后保留、聊天专用设置不泄漏到生图端点。

发现并修复的一处本机问题：`assets/design-systems` 工作副本为 CRLF（`.gitattributes` 的 `eol=lf` 规则晚于文件检出加入），导致 152 包完整性校验失败。重新检出后 4010 个文件、31.8 MB 全部校验通过。这是本机检出状态，不是仓库内容问题。

## 边界

- 本次没有做跨模型 A/B 对比，**未宣称修复后的真实模型输出已达到目标美学质量**。craft 与 linter 改变的是模型收到的指导和反馈时机，不能替代对真实产出的人工评审。
- 未引入 `design-templates` 轴。OpenDesign 有 114 个模板（106 个带可运行 `example.html`），这是本次差距分析中仍然空缺的一条，需要独立的内容工作，不适合用两三个桩模板冒充。
- linter 是静态文本检查，不渲染页面。对比度、焦点顺序、实际布局溢出仍然只能靠真实截图观察，`design_check` 的证据要求未放宽。
- `sd-webui` 适配器按 Automatic1111 / Forge 的公开接口实现，未在真实实例上端到端实测。
- 生图未实测各家 provider 的真实延迟与配额行为，`nextStep` 分类基于 HTTP 语义与常见错误正文，不是对某一家服务的独立鉴定。
