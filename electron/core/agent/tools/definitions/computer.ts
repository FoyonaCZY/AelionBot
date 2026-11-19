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
const pointer = {
  x: { type: 'number' },
  y: { type: 'number' },
  toX: { type: 'number' },
  toY: { type: 'number' },
  button: { type: 'string', enum: ['left', 'middle', 'right'] },
  direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
  amount: { type: 'integer' },
  key: string,
  text: string,
  milliseconds: { type: 'integer' },
};
const steps = (actions: string[], properties: Record<string, unknown>) => ({
  type: 'array',
  minItems: 1,
  maxItems: 20,
  items: {
    type: 'object',
    properties: { action: { type: 'string', enum: actions }, ...properties },
    required: ['action'],
    additionalProperties: false,
  },
});
const vmStep = { ...pointer, pasteKey: { type: 'string', enum: ['CTRL+V', 'CTRL+SHIFT+V'] } };
const hostStep = { ...pointer, element: { type: 'integer' }, count: { type: 'integer' }, value: string };
export const COMPUTER_TOOLS: ToolDefinition[] = [
  tool(
    'request_user_control',
    '工作电脑遇到登录、验证码或其他需要人类处理的步骤时使用。暂停当前 Bot 并提醒用户接管 VM；用户点交还并继续后，返回新的 VM 截图。不能索取用户密码或假定登录成功，必须按新截图核对结果。',
    { reason: string },
    ['reason'],
  ),
  tool(
    'computer',
    '操作当前 Bot 专属的真实 Linux 桌面，不会切换其他 Bot 的桌面。先 screenshot 观察；鼠标与键盘动作必须携带最新截图的 observationId，坐标为截图原始像素。每次动作都会返回新截图。type 使用工作电脑剪贴板粘贴 Unicode 文本；终端中可指定 pasteKey=CTRL+SHIFT+V。open_app 可启动浏览器、文件管理器、文本编辑器、Writer、Calc、Impress 或终端；打开已有文档时把工作区内相对路径放到 path，不要只打开空白窗口再找文件。action=wait 最长等待 2 秒。action=batch 用同一个 observationId 按顺序执行 actions 里的多个动作，只在最后返回一张新截图；用于中途不会改变布局的连续操作，例如点击输入框、输入文字、按回车。',
    {
      action: {
        type: 'string',
        enum: [
          'screenshot',
          'click',
          'double_click',
          'move',
          'drag',
          'scroll',
          'key',
          'type',
          'wait',
          'open_app',
          'batch',
        ],
      },
      observationId: string,
      ...vmStep,
      app: { type: 'string', enum: ['browser', 'files', 'editor', 'writer', 'calc', 'impress', 'terminal'] },
      url: string,
      path: string,
      actions: steps(['click', 'double_click', 'move', 'drag', 'scroll', 'key', 'type', 'wait'], vmStep),
    },
    ['action'],
  ),
  tool(
    'python_execute',
    '直接在当前 Bot 工作目录执行 Python3 代码。code 是纯 Python 源码，不要拼接 shell 命令或多层引号。适合 CSV、Excel（openpyxl）、JSON、PDF 文本（pypdf/pdftotext）、计算和文件验证；exitCode 非零表示这次运行的结果，查看 stderr 后继续。',
    { code: string },
    ['code'],
  ),
];
// The description and the actions follow the system the app runs on: the menu bar is outside the window only on macOS.
function hostComputerTool(mac: boolean) {
  const stepActions = ['click', 'drag', 'scroll', 'type_text', 'press_key', 'set_value', 'wait'];
  return tool(
    'host_computer',
    `操作用户本机 ${mac ? 'macOS' : 'Windows'} 上的应用窗口。不需要鼠标和键盘的操作在后台完成，不改变用户正在用的窗口：get_window_state 观察窗口、带 element 编号的 click 和 scroll、set_value${mac ? '、select_menu' : ''}。按坐标的 click、drag、type_text、press_key 使用真实的鼠标和键盘，会把窗口带到前台并占用电脑，屏幕上出现提示，用户按 Esc 可随时取消。因此优先用 includeText=true 观察并按 element 编号操作，填写输入框优先用 set_value。只在命令、MCP 和工作电脑都无法完成、确实需要用户本机的应用或已登录账号时使用。流程：list_windows 找到窗口，或用 list_apps、launch_app 启动应用${mac ? '（在后台启动）' : '（新应用会来到前台）'}；get_window_state 返回截图和 observationId；click、drag、scroll、set_value 必须携带该窗口最新的 observationId，坐标为截图原始像素；type_text 和 press_key 发给该窗口当前的焦点${mac ? '，组合键用 CMD（如 CMD+S）' : ''}。includeText=true 时同时返回控件列表，click、scroll、set_value 可以用 element 编号代替坐标。${mac ? '应用的菜单栏不在窗口里：用 select_menu 选择其中的命令，menu 是路径，例如 “文件 > 导出为 PDF…”。' : ''}每次操作后返回新截图，之前的 observationId 随即失效。任务第一次调用时由用户批准一次，之后不再询问。终端应用、AelionBot 自身${mac ? '' : '、以管理员身份运行的窗口'}和系统安全提示无法操作，遇到时请用户处理。action=batch 用同一个 observationId 按顺序执行 actions 里的多个步骤，只在最后返回一张截图；用于中途不会改变布局的连续操作，例如点击输入框、输入文字、按回车。`,
    {
      action: {
        type: 'string',
        enum: [
          'list_apps',
          'list_windows',
          'launch_app',
          'get_window_state',
          ...stepActions,
          ...(mac ? ['select_menu'] : []),
          'batch',
        ],
      },
      app: string,
      window: { type: 'integer' },
      observationId: string,
      includeText: { type: 'boolean' },
      ...hostStep,
      ...(mac ? { menu: string } : {}),
      actions: steps(stepActions, hostStep),
    },
    ['action'],
  );
}
export const HOST_COMPUTER_TOOLS: ToolDefinition[] = [hostComputerTool(process.platform === 'darwin')];
