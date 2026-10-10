import type { ToolDefinition } from '../../../model/model';
import { string, tool } from './shared';
export const PREVIEW_TOOLS: ToolDefinition[] = [
  tool(
    'open_preview',
    '在 AelionBot 应用内展示文件或交互网页。url 可打开 HTTP/HTTPS；VM localhost 地址会校验服务归属并建立临时本机转发，支持 WebSocket/热更新。先用 exec_command 启动自己的项目服务，关闭预览会释放转发但不会停止项目。path、attachmentId、url 三选一。创建或修改可视成果后，在展示有帮助时主动调用；无需让用户寻找路径。path 必须同时指定 location（vm 是自己的 Linux /work/<botId> 工作目录，host 是当前本机会话工作目录）；或用已收到的 attachmentId。支持代码、文本、HTML、图片、PDF、PPT 等现有预览格式，文件不超过 25 MB。本机读取沿用当前权限并展示一个文件副本。placement 默认 side，用户要求大画布时用 full。只排队展示，不会切换用户的聊天，也不代表内容已经验收；不是给 Agent 读取文件的工具，不能用它代替 view_image、file_read 或 message_attach。不要反复自动弹出。',
    {
      path: string,
      url: {
        type: 'string',
        description: 'HTTP/HTTPS 网页地址。VM 前端使用 http://localhost:端口/路径 并指定 location=vm。',
      },
      location: { type: 'string', enum: ['vm', 'host'] },
      attachmentId: string,
      placement: { type: 'string', enum: ['side', 'full'] },
    },
    [],
  ),
];
