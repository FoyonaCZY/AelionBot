# AelionBot 开发约定

AelionBot 是 Electron 桌面应用：主进程（`electron/`）运行 Bot、模型、工具、工作电脑 VM 和存储；渲染进程（`src/`）是 React 界面。用 pnpm（版本由 `package.json` 的 `packageManager` 固定），Node 24。

## 目录与边界

- `shared/`：两个进程共用的代码，不能依赖 React 或 DOM。IPC 频道只在 `shared/ipc.ts` 定义一次，主进程与 preload 按同一契约做类型检查；`electron/ipc/` 按领域注册。
- `electron/` 不得 import `src/`（oxlint `no-restricted-imports` 会报错），需要共用就移到 `shared/`。
- `electron/core/` 按领域划分：agent、context、model、tools、vm、designer、group、memory、persona 等。`src/` 按功能划分。
- 所有 Bot 都由 `electron/core/agent/harness.ts` 的 Harness 运行，设计任务也是（v0.42 起）。`bot-runtime.ts` 里 `engine === 'designer'` 只用来拒绝续跑旧设计师引擎的任务。
- `harness.ts`（约 100 KB）、`group/group-chats.ts`、`vm/vm.ts` 是最大、风险最高的文件。改之前先读调用方，小步修改。
- 工具定义在 `electron/core/agent/tools/definitions/`，实现在 `tools/handlers/`，系统提示在 `agent/prompts/`。工具描述和提示词会原样发给模型，改动会影响模型行为和提示缓存，只在确有需要时修改。

## 常用命令

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test                                    # 全量，tests/*.test.ts
node --import tsx --test tests/xxx.test.ts   # 单个文件
pnpm run lint && pnpm run format:check && pnpm run knip
pnpm run build
python -m unittest discover -s tests -p bundled_skill_helpers_test.py   # 需要 openpyxl、python-pptx
```

- CI 只在 Linux 上跑 format:check、lint、knip 和 `audit:publish`，Windows 上看不到这些失败，提交前在本地跑一遍。
- 依赖 Python 的测试读取 `AELION_TEST_PYTHON`，未设置时用 PATH 上的 `python`/`python3`。部分测试依赖本地模型或 VM，本机环境不全时会失败；判断失败是不是改动引入的，先用 `git stash` 在干净工作树上对比。
- 不要为了改几个文件就运行 `pnpm run format`，它会重写整个仓库。只格式化改动过的文件。

## 代码约定

- Prettier：120 列、单引号、尾逗号；EditorConfig：2 空格、UTF-8；`.cmd`/`.ps1` 用 CRLF。
- 错误使用 `shared/errors.ts` 的 `AppError` 并带上稳定的 code，测试断言 code，不断言中文文案。
- 界面文案的 key 就是简体中文原文（`shared/i18n`）。新增或修改中文文案，要同步更新 `shared/i18n/locales/en.ts` 和 `zh-TW.ts`。
- knip 会检查未使用的文件、导出和依赖，删掉功能时把对应导出一起清理掉。
- 测试共用 `tests/helpers.ts`。等待异步结果用轮询，不用固定 sleep；不要写扫描源码文本的测试。

## 内置技能（`assets/skills`）

- 8 个技能包均为手工维护。每个 `SKILL.md` 末尾都有一段相同的 “Aelion workspace and delivery”，改其中一份就要同步改全部 8 份，`tests/bundled-skills.test.ts` 会检查关键句。
- 技能里引用的工具名必须是当前真实存在的工具；新增或改名工具时，检查技能文本是否要跟着改。
- 新增上游来源需要在 `manifest.json` 记录固定的 commit、sha256 和许可证，规则见 `docs/bundled-skills.md`。

## 提交与发版

- 提交信息用 Conventional Commits：`feat(scope): ...`、`fix:`、`perf:`、`test:`、`docs:`。功能提交和发版提交分开。
- 发版流程见 `docs/RELEASING.md`：发版提交只改 `package.json` 的 version，并新增 `docs/releases/vX.Y.Z.md`（`# AelionBot vX.Y.Z`，下面先 `## 简体中文` 再 `## English`，各自按功能分 `###` 小节）。提交信息写 `Release vX.Y.Z: 摘要`。打 tag `vX.Y.Z` 后先推 main，再推 tag；tag 会触发 `.github/workflows/release.yml`。
- 发版前先跑 `git status`，确认功能代码已经提交；本地打包是从工作区构建的，它正常不能证明 tag 里包含了这些代码。提交后用 `git show --name-only HEAD` 核对。
- 提交前运行 `pnpm run audit:publish --worktree`，暂存后再运行一次 `pnpm run audit:publish`。`.local/`、`output/`、`release/`、`runtime/` 下的下载内容和任何密钥都不进仓库。
