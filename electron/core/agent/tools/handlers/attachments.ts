import { InputUpdated } from '../../run-updates';
import type { ToolContext, ToolHandler } from '../context';
import { requiredText } from '../validation';

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
    run.attachments = deps.attachments.forBot(bot.id, [
      ...new Set([...(run.attachments || []), ...fresh].map((file) => file.id)),
    ]);
    deps.store.save();
    return {
      attached: true,
      files: run.attachments,
      message: '文件已附在本次最终回复中，请继续完成回复，不要重复发送。',
    };
  },
};
