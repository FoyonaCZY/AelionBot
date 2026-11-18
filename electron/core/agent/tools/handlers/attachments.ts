import { ATTACHMENT_LIMITS } from '../../../../../shared/types/attachment-types';
import { InputUpdated } from '../../run-updates';
import type { ToolContext, ToolHandler } from '../context';
import { requiredText } from '../validation';

/**
 * One file the model named by attachment ID or path, as an attachment of the Bot. A path on the user's computer is
 * read with the run's permissions, as message_attach reads it.
 */
export async function namedFile({ bot, signal, runId, name, deps }: ToolContext, ref: unknown, reason: string) {
  const workspace = deps.store.data.runs.find((item) => item.id === runId)?.workspaceDir;
  const [file] = await deps.attachments.prepare(
    bot.id,
    [ref],
    signal,
    deps.host
      ? (path) =>
          deps
            .host!.readPreviewFile(bot.id, runId, { path, reason, tool: name }, signal, workspace)
            .then((read) => read.bytes)
      : undefined,
  );
  if (!file) throw new Error('没有指定文件');
  return file;
}

/**
 * Keeps a file the Bot made as an attachment of this run's final reply, as generate_image does. Once the reply holds
 * all one message can, the file is still kept for the Bot, just not attached (`attached` is false).
 */
export function attachToReply({ bot, runId, deps }: ToolContext, name: string, bytes: Buffer) {
  const file = deps.attachments.importForBot(bot.id, name, bytes),
    run = deps.store.data.runs.find((item) => item.id === runId && item.botId === bot.id);
  if (!run) return { file, attached: false };
  const reply = deps.attachments.forReply(bot.id, run.attachments, [file]);
  run.attachments = reply.attachments;
  return { file, attached: !reply.left.length };
}

const REPLY_FULL = `本次回复的附件已满（每条消息最多 ${ATTACHMENT_LIMITS.count} 个、共 ${ATTACHMENT_LIMITS.totalBytes / 1024 / 1024} MB）`;

/** Tells the model a file it made is kept but did not fit in the reply, so it neither stops nor makes it again. */
export const replyFull = (file: { id: string }) =>
  `${REPLY_FULL}，这个文件没有附在回复里，但已经做好并保存为附件 ${file.id}，不要重新生成；需要时用 attachment_save 存到工作电脑。`;

/** Resolves the attachments of an outgoing collaboration message into attachment ids. */
export async function forwardAttachments({ bot, args, name, signal, runId, deps }: ToolContext) {
  if (args.attachments === undefined) return args;
  const current = deps.store.data.runs.find((item) => item.id === runId);
  const files = await deps.attachments.prepare(
    bot.id,
    args.attachments,
    signal,
    deps.host
      ? (path) =>
          deps
            .host!.readPreviewFile(
              bot.id,
              runId,
              { path, reason: '将本机文件附到协作消息', tool: name },
              signal,
              current?.workspaceDir,
            )
            .then((file) => file.bytes)
      : undefined,
  );
  if (deps.runUpdated(runId)) throw new InputUpdated();
  return { ...args, attachmentIds: files.map((file) => file.id) };
}

export const ATTACHMENT_HANDLERS: Record<string, ToolHandler> = {
  attachment_read: ({ bot, args, deps }) =>
    deps.attachments.read(bot.id, requiredText(args, 'attachmentId', 100), Number(args.offset) || 0),
  attachment_save: ({ bot, args, signal, deps }) =>
    deps.attachments.materialize(bot.id, requiredText(args, 'attachmentId', 100), signal),
  message_attach: async ({ bot, args, signal, runId, deps }) => {
    const run = deps.store.data.runs.find((run) => run.id === runId && run.status === 'running');
    if (!run || deps.runUpdated(runId)) throw new InputUpdated();
    const files = await deps.attachments.prepare(
      bot.id,
      args.attachments,
      signal,
      deps.host
        ? (path) =>
            deps
              .host!.readPreviewFile(
                bot.id,
                runId,
                { path, reason: '将本机文件附到当前回复', tool: 'message_attach' },
                signal,
                run.workspaceDir,
              )
              .then((file) => file.bytes)
        : undefined,
    );
    if (!files.length) throw new Error('请选择要发送的附件');
    const delivered = new Set(
      deps.store.data.messages
        .filter(
          (message) =>
            message.botId === bot.id && message.role === 'assistant' && message.runId && message.runId !== runId,
        )
        .flatMap((message) => message.attachments || [])
        .map((file) => file.id),
    );
    const fresh = files.filter((file) => !delivered.has(file.id));
    if (!fresh.length)
      return {
        attached: false,
        alreadyDelivered: true,
        files: [],
        message: '这些文件已在先前回复中送达，无需重复附加。请直接完成文字回复。',
      };
    const reply = deps.attachments.forReply(bot.id, run.attachments, fresh);
    run.attachments = reply.attachments;
    deps.store.save();
    if (reply.left.length)
      return {
        attached: reply.left.length < fresh.length,
        files: run.attachments,
        notAttached: reply.left.map((file) => file.name),
        message: `${REPLY_FULL}，notAttached 里的文件没有附上。在回复里告诉用户它们在哪里，不要重复附加。`,
      };
    return {
      attached: true,
      files: run.attachments,
      message: '文件已附在本次最终回复中，请继续完成回复，不要重复发送。',
    };
  },
};
