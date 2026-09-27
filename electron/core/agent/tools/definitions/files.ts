import type { ToolDefinition } from '../../../model/model';
import { READ_PAGE_FIELDS } from '../../../tools/file-text';
import { string, tool } from './shared';
export const CHECKPOINT_TOOLS: ToolDefinition[] = [
  tool(
    'checkpoint_list',
    '查看自己的文件检查点。设置开启后 file_write、host_file_write 会保存旧版本；不包含 shell 或桌面程序修改的文件。',
    {},
    [],
  ),
  tool('checkpoint_restore', '恢复自己的文件检查点。文件在任务后被改动时拒绝覆盖；本机恢复需要确认。', { id: string }, [
    'id',
  ]),
];
export const HOST_SEARCH_TOOLS: ToolDefinition[] = [
  tool(
    'host_list_directory',
    '分页列出用户本机目录的直接子项。path 省略时使用会话工作目录；offset 为项目偏移，limit 默认 250。按当前会话权限处理，返回 total、nextOffset 和 eof。',
    {
      path: string,
      reason: string,
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 1000 },
    },
    ['reason'],
  ),
  tool(
    'host_find_files',
    '按 glob 查找本机文件，例如 **/*.go、src/**/*.ts。path 默认会话工作目录。遵守检索目录内的 .gitignore，跳过依赖缓存、凭据和符号链接。返回可直接读取的 files 路径及 nextOffset/eof；scanLimited=true 时请缩小范围。沿用本机会话权限，可在 tools_batch 中使用。',
    {
      path: string,
      reason: string,
      pattern: { type: 'string', minLength: 1, maxLength: 500 },
      respectIgnore: { type: 'boolean' },
      offset: { type: 'integer', minimum: 0, maximum: 20000 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
    ['reason', 'pattern'],
  ),
  tool(
    'host_search_files',
    '在本机目录或单个文件中按行检索，默认 query 为普通文本；regex=true 使用 JavaScript 正则，caseSensitive 默认 true。glob 限定文件，respectIgnore 默认 true。outputMode 可为 content、files 或 count（匹配行数）；结果含行号和字符 offset，方便定位读取。先脱敏再匹配；跳过凭据、链接、二进制和过大文件。scanLimited=true 时缩小范围，eof=true 时停止翻页。修改前先读取文件的 sha256。沿用会话读取权限。',
    {
      path: string,
      reason: string,
      query: { type: 'string', minLength: 1, maxLength: 1000 },
      glob: { type: 'string', maxLength: 500 },
      regex: { type: 'boolean' },
      caseSensitive: { type: 'boolean' },
      respectIgnore: { type: 'boolean' },
      outputMode: { type: 'string', enum: ['content', 'files', 'count'] },
      contextLines: { type: 'integer', minimum: 0, maximum: 5 },
      offset: { type: 'integer', minimum: 0, maximum: 20000 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
    ['reason', 'query'],
  ),
];
export const HOST_FILE_TOOLS: ToolDefinition[] = [
  tool(
    'host_execute',
    '在本机执行命令（Windows 优先 PowerShell 7，未安装时为 Windows PowerShell 5.1；macOS zsh；实际 shell 见本机环境）。5.1 不支持 && 与 ||，用 ; 加 if($LASTEXITCODE -eq 0){...} 或分次调用。沿用 gh/git 登录和当前会话权限；拒绝时本次操作不执行，将结果交回模型继续处理其他已获允许的工作，不得重试或绕过拒绝。cwd 省略时使用选定工作目录。命令最多 6000 字符；默认 120 秒，timeoutMs 最长 600 秒。不接受交互输入；需要输入时用 stdin 一次性传入（例如 git commit -F -、node -），带 stdin 的命令每次单独审核，不匹配已保存的命令规则。stdout/stderr 分别保留有界首尾，返回实际退出码、字节计数及 truncated。需完整日志时首次执行就重定向文件；超时或取消后先核对结果，不盲目重试。长任务用 process_start。',
    {
      command: { type: 'string', minLength: 1, maxLength: 6000 },
      cwd: string,
      reason: string,
      timeoutMs: { type: 'integer', minimum: 100, maximum: 600000 },
      stdin: { type: 'string', maxLength: 262144 },
    },
    ['command', 'reason'],
  ),
  tool(
    'host_file_read',
    '读取本机 UTF-8 文件（最大 2 MB），按当前会话权限审批。path 支持相对工作目录。默认读一页（按模型窗口最多 12000 字符），可按 nextOffset 继续；或用 startLine（从 1 开始）和 lineCount 按行读取，withLineNumbers 显示行号。两种定位方式不混用。maxChars 最大 32000，返回 eof、截断信息和原文件 sha256。先脱敏再分页，行号保留原位置。',
    { path: string, reason: string, ...READ_PAGE_FIELDS },
    ['path', 'reason'],
  ),
  tool(
    'host_file_write',
    '写入本机 UTF-8 文件，按当前会话权限审批。新建文件默认不覆盖，省略 expectedSha256，不能填零或猜测哈希；整文件覆盖须 overwrite=true，建议携带读取返回的 sha256 到 expectedSha256，防止覆盖新改动。局部修改优先 host_file_patch。path 支持相对工作目录。不要把脱敏占位符写回文件。',
    {
      path: string,
      content: string,
      reason: string,
      overwrite: { type: 'boolean' },
      expectedSha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
    },
    ['path', 'content', 'reason'],
  ),
  tool(
    'host_file_patch',
    '按原文精确修改本机文件。先读取文件，把 sha256 传入 expectedSha256；oldText 不带行号前缀，默认须唯一匹配，多处替换须显式 replaceAll=true。保留其余内容、BOM、换行和文件权限，修改后返回新 sha256。沿用当前会话写入审批及检查点。',
    {
      path: string,
      reason: string,
      oldText: { type: 'string', minLength: 1, maxLength: 256000 },
      newText: { type: 'string', maxLength: 256000 },
      expectedSha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
      replaceAll: { type: 'boolean' },
    },
    ['path', 'reason', 'oldText', 'newText', 'expectedSha256'],
  ),
];
export const VM_FILE_TOOLS: ToolDefinition[] = [
  tool(
    'file_write',
    '向 Linux 工作电脑当前 Bot 目录写入 UTF-8 文件，支持工作区内的相对或绝对路径。原子保存并保留已有权限；覆盖时建议提供 expectedSha256，局部修改优先 file_patch。',
    { path: string, content: string, expectedSha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' } },
    ['path', 'content'],
  ),
  tool(
    'file_read',
    '分页读取 Linux 工作电脑当前 Bot 目录内的 UTF-8 文件（最大 2 MB）。默认读一页（按模型窗口最多 12000 字符），按 nextOffset 继续；也可用 startLine/lineCount 按行读取，withLineNumbers 显示行号。offset 与按行定位不混用。返回 path、原文件 sha256、nextOffset、eof 和截断信息；文本保留在 stdout。',
    { path: string, ...READ_PAGE_FIELDS },
    ['path'],
  ),
  tool(
    'file_patch',
    '精确修改 Linux 工作电脑当前 Bot 目录内的文件。先用 file_read 取得 sha256；oldText 须精确且默认唯一匹配（不要带行号），replaceAll=true 才全部替换。保留其余内容、BOM、换行和文件权限，文件变化时拒绝覆盖，沿用文件检查点。',
    {
      path: string,
      oldText: { type: 'string', minLength: 1, maxLength: 256000 },
      newText: { type: 'string', maxLength: 256000 },
      expectedSha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
      replaceAll: { type: 'boolean' },
    },
    ['path', 'oldText', 'newText', 'expectedSha256'],
  ),
];
