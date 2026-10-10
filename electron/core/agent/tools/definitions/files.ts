import type { ToolDefinition } from '../../../model/model';
import { READ_PAGE_FIELDS } from '../../../tools/file-text';
import { string, tool } from './shared';

const location = { type: 'string', enum: ['host', 'vm'] };

export const CHECKPOINT_TOOLS: ToolDefinition[] = [
  tool(
    'checkpoint_list',
    '查看自己的文件检查点。设置开启后 file_write 会保存旧版本；不包含 shell 或桌面程序修改的文件。',
    {},
    [],
  ),
  tool('checkpoint_restore', '恢复自己的文件检查点。文件在任务后被改动时拒绝覆盖；本机恢复需要确认。', { id: string }, [
    'id',
  ]),
];

export const SEARCH_TOOLS: ToolDefinition[] = [
  tool(
    'list_directory',
    '分页列出目录的直接子项。location 省略表示用户本机，只有 vm 才列出 Linux 工作电脑。path 省略时，本机用会话工作目录，工作电脑用当前 Bot 目录。offset 为项目偏移，limit 默认 250。返回 total、nextOffset 和 eof。',
    {
      path: string,
      location,
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 1000 },
    },
    [],
  ),
  tool(
    'find_files',
    '按 glob 查找文件，例如 **/*.go、src/**/*.ts。location 省略表示用户本机，只有 vm 才查找 Linux 工作电脑。path 默认本机会话工作目录。本机遵守检索目录内的 .gitignore，跳过依赖缓存、凭据和符号链接。返回 files 及 nextOffset/eof；scanLimited=true 时请缩小范围。',
    {
      path: string,
      location,
      pattern: { type: 'string', minLength: 1, maxLength: 500 },
      respectIgnore: { type: 'boolean' },
      offset: { type: 'integer', minimum: 0, maximum: 20000 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
    ['pattern'],
  ),
  tool(
    'search_files',
    '在目录或单个文件中按行检索。location 省略表示用户本机，只有 vm 才检索 Linux 工作电脑。默认 query 为普通文本；regex=true 使用正则，caseSensitive 默认 true。glob 限定文件。outputMode 可为 content、files 或 count。本机先脱敏再匹配，并跳过凭据、链接、二进制和过大文件。scanLimited=true 时缩小范围。检索结果不带 sha256，修改前仍需读取目标文件。',
    {
      path: string,
      location,
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
    ['query'],
  ),
];

export const FILE_TOOLS: ToolDefinition[] = [
  tool(
    'file_read',
    '分页读取 UTF-8 文件（最大 2 MB）。location 省略表示用户本机，只有 vm 才读取 Linux 工作电脑里当前 Bot 的目录。path 在本机可相对会话工作目录。默认读一页（按模型窗口最多 12000 字符），可按 nextOffset 继续；或用 startLine（从 1 开始）和 lineCount 按行读取，withLineNumbers 显示行号。两种定位方式不混用。maxChars 最大 32000，返回 eof、截断信息和原文件 sha256。',
    { path: string, location, ...READ_PAGE_FIELDS },
    ['path'],
  ),
  tool(
    'file_write',
    '写入 UTF-8 文件。location 省略表示用户本机，只有 vm 才写入 Linux 工作电脑。本机新建文件默认不覆盖，省略 expectedSha256，不能填零或猜测哈希；整文件覆盖须 overwrite=true，建议携带读取返回的 sha256。局部修改优先 file_patch。不要把脱敏占位符写回文件。',
    {
      path: string,
      content: string,
      location,
      overwrite: { type: 'boolean' },
      expectedSha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
    },
    ['path', 'content'],
  ),
  tool(
    'file_patch',
    '按原文精确修改文件。location 省略表示用户本机，只有 vm 才修改 Linux 工作电脑里的文件。先读取文件，把 sha256 传入 expectedSha256；oldText 不带行号前缀，默认须唯一匹配，多处替换须显式 replaceAll=true。保留其余内容、BOM、换行和文件权限，修改后返回新 sha256。',
    {
      path: string,
      location,
      oldText: { type: 'string', minLength: 1, maxLength: 256000 },
      newText: { type: 'string', maxLength: 256000 },
      expectedSha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
      replaceAll: { type: 'boolean' },
    },
    ['path', 'oldText', 'newText', 'expectedSha256'],
  ),
];
