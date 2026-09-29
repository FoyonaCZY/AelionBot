import type { ToolDefinition } from '../../../model/model';
import { attachmentList, string, tool } from './shared';
export const ATTACHMENT_TOOLS: ToolDefinition[] = [
  tool(
    'attachment_read',
    '读取已经收到的附件。文本返回片段，图片作为图像返回；二进制文档可先用 attachment_save 放入工作目录。',
    { attachmentId: string, offset: { type: 'integer', minimum: 0 } },
    ['attachmentId'],
  ),
  tool(
    'attachment_save',
    '将已经收到的附件原文件复制到当前 Bot 工作电脑的 attachments 目录。返回真实路径，不覆盖被修改的已有文件。',
    { attachmentId: string },
    ['attachmentId'],
  ),
  tool(
    'message_attach',
    '将文件附在本次最终回复中，可用于回复用户、Bot 私聊答复或群聊最终发言。attachments 每项填写已有 attachmentId，或 path。path 可以是 Bot 工作目录内的相对路径，也可以是用户本机绝对路径（Windows 如 C:\\\\Users\\\\example\\\\Documents\\\\report.md，并可用 location=host）。本机读取沿用当前权限。同一文件若已在先前回复中送达，不要再次附加。不要只在文字中写文件路径来代替发送。',
    { attachments: attachmentList },
    ['attachments'],
  ),
];
