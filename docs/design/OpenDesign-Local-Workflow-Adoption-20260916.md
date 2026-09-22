# OpenDesign 对照与本地设计师改造

研究基线：本地 `.local/research/open-design`，提交 `d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4`。这是已固定的源码版本，本次没有声称跟踪最新上游。参考内容不作为用户授权执行。

## 采用的设计

| 对照源码 | 观察 | AelionBot 的落地 |
| --- | --- | --- |
| README 的本地项目及任务入口；`packages/contracts/src/prompts/system.ts`、`official-system.ts` | 项目文件是交付主体，聊天负责推进与反馈 | 新任务固定在默认工作目录 `/designers/<bot>/<task>`；本机文件、附件、预览共用 DesignerFiles；去除设计师 VM 工具 |
| `prompts/discovery.ts`、`directions.ts` | 只澄清真正影响结果的问题；已选视觉语言不反复询问；方向包含可执行的排版与色彩规则 | 独立 playbook 提示词；沿用已有结构化 request_user_input 交互；选定设计系统作为稳定引用上下文 |
| `skills/design-brief/SKILL.md` | 把需求和视觉决策固化为设计约定 | design_spec 保存任务状态与本机 DESIGN.md；初版范围由用户决定，不把历史模型建议升级为要求 |
| `skills/artifacts-builder/SKILL.md` | 该文件是上游技能入口说明，不能当成完整可执行实现 | 不整体挂载上游技能目录；实现原型、演示、网站复刻、局部修改四个第一方专用流程 |
| `prompts/deck-framework.ts`、`skills/deck-open-slide-canvas/SKILL.md` | 稳定画布与导航基础设施不应每次由模型重新发明；明确叙事和真实内容 | design_deck 原生生成可编辑 OOXML 与同名 HTML；16:9、视口缩放、键盘导航和打印样式固定；不把整页图片当 PPT |
| `docs/design-systems.md`、`components/design-system-metadata.ts` | DESIGN.md、tokens、组件与来源元数据分工明确 | 152 套原始资源和许可保持不变；仅复制选中版本；简介从校验后的 DESIGN.md 提取并缓存 |
| `artifacts/question-form.ts` | 把结构化澄清作为交互对象，而不是把协议字串直接泄漏进聊天 | 复用现有交互服务和设计师 ConversationInteractions，不另造一套内嵌标签协议 |
| `official-system.ts` 中的产物入口、可定位元素及发布约定 | 产物需要可打开、可编辑，实际工具结果与文字承诺应分开 | 提示语要求稳定 data-design-id；沿用预览框选、编辑与保存；design_publish 读真实字节后附加成果，queued 不代表用户已看过 |

## 执行与性能

- DesignerLoop 不调用通用推理循环，只复用已受权限约束的服务。通用与设计师的类型、主聊、私聊和群聊分派规则保持独立。
- host 文件工具先校验当前任务路径；附件复制、设计系统准备与原生演示生成也经过现有权限服务。后台进程强制 location=host，cwd 为任务目录。
- 专用设计工具记录 executionId、结果文件及失败状态；协作回执可引用真实执行证据。
- 沿用 ModelClient 的流式输出、TTFT 状态、有效输出闲置超时及 ContextEngine 缓存统计。工作流提示与选中参考保持稳定前缀，任务变更放在 task frame。没有用延长绝对超时冒充性能修复。
- 初版只做文件、格式和明显错误检查。复杂验收、截图轮询和全流程测试不会成为默认交付门槛。用户反馈后走局部修改流程。

## UI

已将批准的建筑主视觉、黑色大字、红蓝黄构图应用到真实 DesignerWorkspace。消息保留在对话中，进度使用小型红色环和实际操作名称。输入框保留设计系统入口，设计师不再显示工作目录切换。设计系统弹窗保留布局，增加三行简介。

## 验证与边界

- `tests/designer-local.test.ts`：默认目录落点、跨任务/链接越界、文件与附件同源、预览队列、保存冲突、VM 零调用、PPTX 重开和可编辑文字。
- `tests/designer.test.ts`：独立上下文、固定引用缓存、首段流式、停止 VM 时交付、协作来源、任务配置隔离、真实文件交付。
- 浏览器 `.local/designer-product-ui/` 使用真实 React 组件和独立模拟状态；不调用用户模型、不修改真实会话。截图用于检查 UI，不能证明真实模型设计质量或速度。
- 旧 VM 任务保留记录及原文件，继续时明确要求新建本机任务；本次没有迁移或删除用户虚拟机文件。
- 原生演示工具提供 title / agenda / split / statement / quote / compare / timeline / stat / cta 布局，不是任意 PPT 文件的保真渲染器。生成演示通过同名 HTML 预览；没有同名 HTML 的外部 Office 文件暂不提供设计师 VM 转换。网站复刻使用已有 web_read 与附件观察，不接入 OpenDesign 的 CDP 收割脚本。
- 文件接口有任务路径检查；任意 shell 命令仍属于本机权限模型，并非 OS 级文件系统沙箱。
- 生图工具未接入，也未宣称存在。未实测真实模型端到端延迟，不报告推测的提速倍数。

最终验证记录：全量 777 项测试，773 通过、4 个环境条件跳过、0 失败；typecheck 与生产 build 通过。浏览器使用 VM-ready 模拟状态检查，桌面初始化调用为 0，电脑栏节点为 0，没有工作电脑设置弹窗；700 px 窗口无文档横向溢出。
