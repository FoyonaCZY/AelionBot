import type { ToolDefinition } from '../../../model/model';
import { string, tool } from './shared';
export const PREVIEW_TOOLS: ToolDefinition[] = [
  tool(
    'open_preview',
    '在 AelionBot 应用内展示文件、交互网页或视频项目。url 可打开 HTTP/HTTPS；VM localhost 地址会校验服务归属并建立临时本机转发，支持 WebSocket/热更新。先用 exec_command 启动自己的项目服务，关闭预览会释放转发但不会停止项目。path、attachmentId、url、videoProjectId 四选一。创建或修改可视成果或视频项目后，在展示有帮助时主动调用；无需让用户寻找路径。path 必须同时指定 location（vm 是自己的 Linux /work/<botId> 工作目录，host 是当前本机会话工作目录）；或用已收到的 attachmentId，或用 videoProjectId 打开可播放、可时间线微调的 Video Studio 项目。支持代码、文本、HTML、图片、音视频（mp4/webm/mov/mkv/m4v/m4a/mp3/wav）、PDF、PPT 等预览格式，文件不超过 100 MB。本机读取沿用当前权限并展示一个文件副本。placement 默认 side，用户要求大画布时用 full。只排队展示，不会切换用户的聊天，也不代表内容已经验收；不是给 Agent 读取文件的工具，不能用它代替 view_image、file_read 或 message_attach。不要反复自动弹出。',
    {
      path: string,
      url: {
        type: 'string',
        description: 'HTTP/HTTPS 网页地址。VM 前端使用 http://localhost:端口/路径 并指定 location=vm。',
      },
      location: { type: 'string', enum: ['vm', 'host'] },
      attachmentId: string,
      videoProjectId: { type: 'string', description: 'Video Studio 项目 ID，打开可交互播放与时间线预览。' },
      placement: { type: 'string', enum: ['side', 'full'] },
    },
    [],
  ),
  tool(
    'preview_mark',
    '在预览中的具体位置（或视频时间点）钉评论，请用户在那里做决定或确认，比如“这里的两种配色选哪个？”或“00:12 的转场节奏合适吗？”。会像 open_preview 一样打开这份预览（参数相同，path、attachmentId、url、videoProjectId 四选一，path 要写 location），并显示你的钉。marks 每条写 note；HTML 用 selector（CSS 选择器或 [data-design-id="…"]）定位，其他文件或视频帧用 box [x, y, w, h]（相对整页、PDF 某一页或视频画面的 0–1 比例；PDF 加 page，视频/视频项目加 timestampSec）。用户在钉上的回复会按编号随下一条消息发给你。只在需要用户针对某个位置作答时使用，不要用来罗列已完成的修改。',
    {
      path: string,
      url: string,
      location: { type: 'string', enum: ['vm', 'host'] },
      attachmentId: string,
      videoProjectId: { type: 'string', description: 'Video Studio 项目 ID' },
      placement: { type: 'string', enum: ['side', 'full'] },
      marks: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: {
          type: 'object',
          properties: {
            note: { type: 'string', description: '钉上显示的问题或说明，不超过 1000 字' },
            selector: { type: 'string', description: 'HTML 元素的 CSS 选择器' },
            box: {
              type: 'array',
              minItems: 4,
              maxItems: 4,
              items: { type: 'number', minimum: 0, maximum: 1 },
              description: '[x, y, w, h]，相对整页或当前页的比例',
            },
            page: { type: 'integer', minimum: 1, description: 'PDF 页码' },
            timestampSec: { type: 'number', minimum: 0, description: '视频或视频项目的播放时间点（秒）' },
          },
          required: ['note'],
          additionalProperties: false,
        },
      },
    },
    ['marks'],
  ),
];
