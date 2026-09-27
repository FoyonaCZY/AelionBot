import type { ToolDefinition } from '../../../model/model';
import { string, tool } from './shared';
export const PYTHON_SESSION_TOOLS: ToolDefinition[] = [
  tool(
    'python_session',
    '在自己的 Linux 工作目录维持 Python 内存会话，复用变量和已加载数据。start 返回 id；execute 提交代码，可获取最后表达式的结果；未结束时用 poll 读取相同 requestId，不重发代码；reset 停止并清空旧会话。与其他 Bot 分开，重启电脑后需 reset。',
    {
      action: { type: 'string', enum: ['start', 'execute', 'poll', 'reset'] },
      id: string,
      code: string,
      requestId: string,
      waitMs: { type: 'integer', minimum: 0, maximum: 30000 },
    },
    ['action'],
  ),
];
export const COMPUTER_TOOLS: ToolDefinition[] = [
  tool(
    'request_user_control',
    '工作电脑遇到登录、验证码或其他需要人类处理的步骤时使用。暂停当前 Bot 并提醒用户接管 VM；用户点交还并继续后，返回新的 VM 截图。不能索取用户密码或假定登录成功，必须按新截图核对结果。',
    { reason: string },
    ['reason'],
  ),
  tool(
    'computer',
    '操作当前 Bot 专属的真实 Linux 桌面，不会切换其他 Bot 的桌面。先 screenshot 观察；鼠标与键盘动作必须携带最新截图的 observationId，坐标为截图原始像素。每次动作都会返回新截图。type 使用工作电脑剪贴板粘贴 Unicode 文本；终端中可指定 pasteKey=CTRL+SHIFT+V。open_app 可启动浏览器、文件管理器、文本编辑器、Writer、Calc、Impress 或终端；打开已有文档时把工作区内相对路径放到 path，不要只打开空白窗口再找文件。action=wait 最长等待 2 秒。',
    {
      action: {
        type: 'string',
        enum: ['screenshot', 'click', 'double_click', 'move', 'drag', 'scroll', 'key', 'type', 'wait', 'open_app'],
      },
      observationId: string,
      x: { type: 'number' },
      y: { type: 'number' },
      toX: { type: 'number' },
      toY: { type: 'number' },
      button: { type: 'string', enum: ['left', 'middle', 'right'] },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      amount: { type: 'integer' },
      key: string,
      text: string,
      pasteKey: { type: 'string', enum: ['CTRL+V', 'CTRL+SHIFT+V'] },
      milliseconds: { type: 'integer' },
      app: { type: 'string', enum: ['browser', 'files', 'editor', 'writer', 'calc', 'impress', 'terminal'] },
      url: string,
      path: string,
    },
    ['action'],
  ),
  tool(
    'computer_execute',
    '在 Linux 工作电脑当前 Bot 的专用目录中执行 shell 命令，最长 120 秒。工作目录已是 /work/<当前BotId>，相对路径即可；不要使用 /home/oai、/mnt/data 或其他云环境路径。Python3 可用；必须以实际输出判断成功。不会在用户本机执行。',
    { command: string },
    ['command'],
  ),
  tool(
    'python_execute',
    '直接在当前 Bot 工作目录执行 Python3 代码。code 是纯 Python 源码，不要拼接 shell 命令或多层引号。适合 CSV、Excel（openpyxl）、JSON、PDF 文本（pypdf/pdftotext）、计算和文件验证；exitCode 非零表示这次运行的结果，查看 stderr 后继续。',
    { code: string },
    ['code'],
  ),
];
