# OpenDesign 源码研究与 AelionBot 设计模块建议

研究日期：2026-09-15。仓库：nexu-io/open-design。当前检出版本：0.22.1，提交 d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4（提交日期 2026-09-14）。

源码已浅克隆到本项目的 .local/research/open-design。此次仅做静态源码阅读、目录统计和调用链核对，没有安装依赖、运行 OpenDesign、验证其外部服务或导入第三方资源到产品。下文区分“代码实现”“技能/策略要求”和“对本项目的建议”；没有把仓库中的指令作为本次执行指令。

## 结论

OpenDesign 的核心是把设计过程变成可以组合、选择、记录和复用的资源：场景负责流程，技能负责方法，设计系统负责视觉约束，模板负责具体起点，Agent 负责生成和修改，应用负责运行、预览和产物管理。

不能把它理解为“更多设计提示词”或“更强的网页编辑器”。它同时有真实执行代码和依靠 Agent 遵循的约定，而且不同版本策略并不一致。

本次目录统计得到 152 个含 DESIGN.md 的设计系统目录、163 个含 SKILL.md 的技能目录、14 个官方场景目录。这是当前提交的磁盘内容统计，不是 UI 实际上架数、经过验收的能力数，也不是截图上旧版的 72 / 31。内置目录、兼容目录和插件目录之间存在重组，不能直接相加。

## 一、各类设计工作流怎么实现

### 1. 三层分工

1. 场景包的 open-design.json 描述 taskKind、mode、输入字段、依赖资源、pipeline.stages、原子操作 atoms、repeat 和 until。
2. SKILL.md、场景提示资产和原子提示片段告诉 Agent 如何发现需求、确定方向、生成和迭代。SaaS 页面、PPT、图片、视频等主要复用运行基础设施，再切换任务约定和资源。
3. Daemon 解析插件、冻结资源快照、组装系统提示、启动 Agent，并把阶段/交互事件送到前端。pipeline.ts 负责阶段循环与终止条件，SQLite 保存迭代记录，SSE 传递进度。

证据：[新生成场景](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/plugins/_official/scenarios/od-new-generation/open-design.json)、[调度器](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/apps/daemon/src/plugins/pipeline.ts)、[实际调用入口](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/apps/daemon/src/server.ts#L10607)。

### 2. 场景对照

| 场景 | 清单声明的主要步骤 | 实现上应如何理解 |
|---|---|---|
| 新生成 / 默认设计 | 需求澄清 → 方向和计划 → 写文件/实时产物 → critique | 常规生成流程，先确定需求和方向，再产生可预览文件 |
| 已有设计精修 | 方向 → patch-edit → critique → handoff | 以现有产物为基础做小补丁，不必重新跑完整需求发现 |
| Figma 迁移 | figma-extract → token-map → 生成 → critique | Figma 提取、设计 token 对齐和生成组成一个场景；外部鉴权与实际效果本次未运行 |
| 代码迁移 | code-import → design-extract/token-map → rewrite-plan → patch-edit/build-test → diff-review → handoff | 显式保留“导入、映射、验证、交付”步骤；清单约定构建与测试通过或达到 8 次上限 |
| 媒体生成 | 发现需求 → 计划 → image/video/audio → critique | 系统提示会根据媒体 surface 切换，不给图片或音频任务硬塞网页布局规则 |
| 网页效果提取 | capture → model → rebuild → critique | 把参考页/效果的捕获、抽象和重建分开 |
| React / Vue / Next.js 导出 | handoff | 场景阶段较薄，实际转换主要靠技能指导 Agent；不是一个通用、确定性的 HTML→框架编译器 |
| 插件创作 / 分享 | 澄清与计划 → 生成插件 → review；或检查项目 → 打包 | 已有设计成果进一步包装为可复用资源 |

常规 critique 清单常见终止表达式为 critique.score>=4 或 iterations>=3；调度器还有全局迭代上限，默认 10。这里描述的是机制与声明，不代表每次都发生了真实视觉评审。

证据：[精修](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/plugins/_official/scenarios/od-design-refine/open-design.json)、[代码迁移](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/plugins/_official/scenarios/od-code-migration/open-design.json)、[Figma 迁移](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/plugins/_official/scenarios/od-figma-migration/open-design.json)、[React 导出技能](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/plugins/_official/scenarios/od-react-export/SKILL.md)。

### 3. 必须保留的实现边界

当前 server.ts 默认使用原子操作 registry，显式设置 OD_PIPELINE_RUNNER=stub 才退回旧 stub。但 registry 也不等于严格执行引擎：built-ins.ts 对大量原子操作注册的是返回空 signals 的 permissive worker，真正工作由 Agent CLI 执行。registry.ts 在没有观测结果时提供 critique.score=4、preview.ok=true、user.confirmed=true 的默认信号。

所以，阶段事件可以用于展示和记录，却不能单凭“阶段完成”认定文件已生成、网页已检查或用户已确认。这个区别对我们的进度 UI 尤其重要。我们应保存 unknown / pending / observed-pass / observed-fail，而不是默认成功。

证据：[原子 worker 注册](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/apps/daemon/src/plugins/atoms/built-ins.ts)、[默认信号](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/apps/daemon/src/plugins/atoms/registry.ts)。

### 4. 新版 OD Next 是另一套策略

当前源码同时包含 OD Next V2。其策略校验代码严格要求 discovery、plan、generate 三个阶段；不是所有场景都必须有 critique。其 general-orchestration.md 还明确采用 ship-on-write：写出主要 HTML 即视作交付，不在生成后做截图、渲染、测试或正式验收。

OD Next 值得借鉴的是 Task Profile、Design Spec、RunManifest、canonical deliverable、Full Plan / Direct Edit 等版本化对象：需求、设计决策、产物和运行绑定可追踪，局部修改有自己的最小变更约定。不能同时宣称它“默认每次生成都经过视觉验收”。本次未运行这套新策略的端到端流程。

建议我们保留任务约定与版本绑定，但不采用跳过验证的交付边界。保存、字体回退、焦点、快捷键、响应式等问题需要在真实渲染和交互中发现。

证据：[策略阶段限制](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/apps/daemon/src/plugins/strategy-stage-policy.ts)、[新版编排约定](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/plugins/_official/scenarios/od-next-strategy/assets/general-orchestration.md)、[任务结构 schema](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/packages/contracts/src/plugins/strategy-v2.ts)。

## 二、设计系统是什么、来自哪里、怎么接入

### 1. 它是资源包，不只是配色

典型包结构：

~~~text
design-system/
  manifest.json                 标识、来源、导入模式和资源路径
  DESIGN.md                     风格、布局、排版、组件和禁用模式
  USAGE.md                      告诉 Agent 怎么使用这个包
  tokens.css                    可执行的 CSS token 约定
  design-tokens.json            结构化 token
  tailwind-v4.css                框架适配
  components.manifest.json       组件摘要
  components.html               实际参考组件
  preview/                      配色、字体、间距等预览
  source/evidence.md            来源说明
  source/tokens.source.json     原始提取值
  source/token-contract.report.json  映射、置信度与回退报告
~~~

包可标为 normalized、hybrid、verbatim，用来控制规范化与保留原始项目表达的程度。旧版仅含 DESIGN.md 的目录仍兼容。

证据：[Atelier Zero 清单](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/design-systems/atelier-zero/manifest.json)、[资源注册与读取](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/apps/daemon/src/design-systems/index.ts)。

### 2. 来源至少分五类

| 来源 | 已读到的实现 | 不应误解为 |
|---|---|---|
| 内置精选设计包 | 仓库维护的 DESIGN.md、CSS、组件样例和派生资源 | 每个包都是品牌官方发布或实时抓取的组件库 |
| 本地项目 | 扫描项目文件、CSS 变量、Tailwind 线索、字体与资源，输出统一设计包 | 自动完整理解所有组件的交互和状态 |
| GitHub 仓库 | 浅克隆 → 本地项目导入器 → 保存来源记录 | 安装依赖、运行项目后做全面还原 |
| shadcn registry | 读取 cssVars 的 theme/light/dark 与组件 files → 物化为临时项目 → 复用导入器 | 换了主题之后就保证生成代码和组件库完美一致 |
| 网站 / 用户品牌参考 | Brand Kit 路径：预取素材形成首屏种子，再由 Agent 根据真实 DOM/CSS 和素材逐步补齐 | 单张截图可以准确还原字体、所有状态或响应式规则 |

网站提取技能要求测量语义色、字体、真实字重、Logo 候选、图片和文案，写 brand.json，由程序渲染 brand.html。除了 Agent 流程，brands/engine 还有确定性 Seed→tokens→light/dark/compact→kit/artifacts 的派生逻辑；主题变体不必每次让模型重新发明。

证据：[本地导入](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/apps/daemon/src/design-systems/import.ts)、[GitHub 导入](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/apps/daemon/src/design-systems/github-import.ts)、[shadcn 导入](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/apps/daemon/src/design-systems/shadcn-import.ts)、[网站品牌提取方法](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/skills/brand-extract/SKILL.md)、[确定性品牌引擎](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/apps/daemon/src/brands/engine/README.md)。

### 3. 内置品牌包的溯源需要谨慎

Airbnb 的 DESIGN.md 标题写的是 Inspired by Airbnb。它的 source/evidence.md 明确说明，这是从 OpenDesign 自己维护的内置样例回填出来的，并不声称重新抓取了品牌网站或官方仓库。

因此我们可以学习它表达品牌规律的方法，但不能把“Airbnb 风格”标为“Airbnb 官方设计系统”，也不能把这里提到的字体名称当成已经提供了可分发字体文件。仓库主包标 Apache-2.0，部分场景 manifest 标 MIT，skills/README 也要求看各自 LICENSE；后续真要引入资源，应逐包记录实际来源、许可证和资产文件，不能根据顶层标识一概处理。

证据：[品牌设计说明](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/design-systems/airbnb/DESIGN.md)、[来源证据](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/design-systems/airbnb/source/evidence.md)、[技能许可说明](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/skills/README.md)。

### 4. 接入 Agent 的关键是分层注入

实际调用链大致为：项目/请求/插件快照选择设计系统 → Daemon 加载设计包 → composeSystemPrompt 注入本轮需要的内容 → Agent 按约定生成 → 预览与修改。

提示组装不是把整个库全部塞进去：

- 推送层：USAGE.md、DESIGN.md、tokens.css、精简组件清单。
- 拉取层：较大的组件示例、来源证据、主题样例等仅给索引，按允许路径读取。
- 组件清单存在时优先用摘要，没有时才回退到整份 components.html。
- 品牌 token 约定决定具体数值，craft 规则约束字体层级、留白、对比、装饰使用方式；冲突时品牌 token 数值优先。
- 已选设计系统时，方向库的完整候选目录可以省略，避免模型重新选风格，也减少上下文消耗。
- 网站复刻会特意跳过项目/应用品牌覆盖，否则会把参考站错误地改成自己的品牌。

这仍主要是给模型的约束，不能把提示中的“必须使用 tokens”理解成所有生成结果都已经通过代码级 token 校验。

证据：[提示组装](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/apps/daemon/src/prompts/system.ts#L1273)、[实际选择与复刻例外](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/apps/daemon/src/server.ts#L9749)。

### 5. Token 来源可审计

token-contract.ts 为映射结果记录 source、line、reason、confidence，并区分 high/medium/low/fallback/alias；报告有 source-backed 数量、回退比例、评级和是否建议重建。

对我们，这比“AI 提取完成”一句提示更有价值：用户应能知道某个色值来自实际 CSS，某个字体是推断，某个值是缺失后的默认值。

证据：[token 映射和报告结构](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/apps/daemon/src/design-systems/token-contract.ts)。

## 三、对 AelionBot 设计模块的建议

### 已有基础与差距

我们已经有 VM 工具、技能目录、URL 预览与端口转发、文件树、源码编辑、标注、元素属性编辑、拖动缩放、快捷键和保存。web-ui-design 技能也要求真实浏览器验证。当前研究到的缺口主要是：缺少独立设计系统资源库、明确绑定到项目/任务的设计约定，以及把生成、局部修改、复刻、验证区别对待的设计编排层。

对应本项目入口：assets/skills/web-ui-design/SKILL.md、electron/core/skill-catalog.ts、electron/core/agent-previews.ts、electron/core/preview-feedback.ts、electron/core/html-preview-edits.ts、electron/preview-dom-editor.ts、src/FilePreview.tsx、src/WebElementInspector.tsx。

### 优先级 P0：让设计决策和用户修改稳定下来

1. 增加轻量 DesignSession：taskKind、target、designSystemId/version、designSpec、canonicalArtifact、baselineRevision、lockedRequirements、pendingEdits。项目或任务拥有设计系统绑定，Bot 是执行者；不要让不同任务共用一个可变全局风格。
2. 把全新设计、局部精修、参考复刻、框架迁移分成四种明确模式。只改一个按钮时，不重新询问全部需求，也不重新生成整页。
3. 把用户通过画布改过的文字、字体、位置记录成带版本的 UserEditLedger，并在后续 Agent 上下文中标明已确认约束。保存文件并不足以保证下一轮模型不覆盖用户微调。
4. 让预览获得键盘焦点、输入框撤销与画布撤销分离、未保存保护、冲突检测成为统一适配层要求。这次网页和原生视图暴露的交互差异说明，需要共用同一套行为测试。

### 优先级 P1：先做小而完整的设计系统库

建议先做 3–5 套可验证的自有设计包，而不是一次复制 152 套。每套必须同时覆盖正文、标题、按钮、表单、列表、空状态、加载态、错误态和深浅主题。

建议最小结构：manifest.json + DESIGN.md + tokens.css + components.html + sources.json。组件多了再加精简 manifest。界面提供“当前项目使用的设计系统”与实例预览；技能仍回答“怎么做”，设计系统回答“做成什么样”。它们可以统一出现在插件资源中心，但数据模型不要混成同一种 Skill。

实例编辑与系统编辑应有明确区别：“只改当前元素”写局部 patch；“修改设计 token”影响全部绑定实例，并先展示影响范围。否则用户以为只改一处，实际改变整个项目。

### 优先级 P1：把真正的验证结果用于进度和完成状态

建议工作流：读取当前项目和参考 → 形成简短需求/设计约定 → 实现或局部修改 → 打开真实预览 → 检查交互/布局 → 带证据交付。

质量信号建议来自真实结果：主流程交互是否成功、控制台是否有关键错误、字体是否加载、窄屏是否溢出、保存后刷新是否保留、构建是否通过。无法运行时保留“未验证”。明确规定最多修复轮数与预算，禁止 unknown 自动转为 pass，也不将模型自评 4 分冒充用户确认。

### 优先级 P2：稳定元素标识与源码映射

OpenDesign 使用 data-od-id 定位元素，并通过结构化 patch 修改文字、图片、属性、样式和 token；部分动态内容会借助 JSON override 与运行时应用脚本维持修改。

我们可以学习稳定 ID 与结构化 patch，但不要照搬动态覆盖脚本到任意 React/Vue 项目：它可能与应用自身状态重渲染竞争。对新生成 HTML，可从生成时附稳定元素 ID；对源码项目，逐步加入 source file/component/位置映射；映射不可靠时继续发修改清单给 Bot，并保留现有 revision 校验。不要为了减少一次保存报错就放弃原始源码一致性检查。

证据：[编辑 patch 与动态 override](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/apps/web/src/edit-mode/source-patches.ts)、[编辑数据结构](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/apps/web/src/edit-mode/types.ts)。

### 优先级 P2：可复现、低成本、可复用

- 运行快照固定 skill、设计系统、模板的版本和来源摘要，升级资源不回写历史运行。OpenDesign 的 applied_plugin_snapshots 值得借鉴。
- 每轮只注入当前设计包和相关组件摘要；组件全文和素材按需读取。与我们已有技能清单按预算展示的机制可以自然结合。
- 内置包按需物化进 VM，按版本和内容摘要复用；引用中的资源固定保留，失去引用的缓存按配额回收，避免设计资源再次加剧 VM 空间增长。
- 品牌提取先展示程序生成的近似首屏，再逐项替换为有来源证据的值；进度显示已完成的真实模块，减少只有“正在思考”的等待。
- 允许把一次验收通过的成果整理为模板或设计包，但必须区分原始内容、用户私有资产和可以分享的通用结构。

证据：[插件快照](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/apps/daemon/src/plugins/snapshots.ts)、[快照绑定入口](https://github.com/nexu-io/open-design/blob/d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4/apps/daemon/src/plugins/resolve-snapshot.ts)。

## 建议实施顺序

第一步：DesignSession + 局部精修模式 + 用户修改账本，先解决“越改越漂”和修改被覆盖。

第二步：3–5 套自有设计系统、项目级选择、统一 token 与组件预览。

第三步：真实预览验证和证据化进度，再逐步加入本地项目/网站提取。

第四步：稳定 ID / 组件源码映射、模板沉淀、资源版本快照与缓存回收。

本轮没有修改 AelionBot 业务代码，也没有引入 OpenDesign 的依赖或品牌资产。以上建议是基于源码的工程判断，不是对所有 OpenDesign 路径的运行效果背书。
