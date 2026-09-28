import { generateModelImage, storeImageRoutes } from '../../../image/image-generation';
import { imageFileName, imageJobFromArgs, imageReferences } from '../../../image/image-tool';
import type { ToolHandler } from '../context';

export const MEDIA_HANDLERS: Record<string, ToolHandler> = {
  open_preview: ({ bot, args, signal, runId, deps }) => {
    if (!deps.previews) throw Error('应用预览服务尚未就绪');
    return deps.previews.open(bot.id, runId, args, signal);
  },
  view_image: ({ bot, args, signal, runId, workspace, deps }) => {
    if (!deps.host) throw Error('本机图像工具不可用');
    return deps.host.viewImage(bot.id, runId, args, signal, workspace);
  },
  generate_image: async ({ bot, args, signal, runId, deps }) => {
    const access = deps.imageModel?.(bot.id);
    if (!access) throw Error('这个 Bot 没有配置生图模型');
    const job = imageJobFromArgs(args, access.config, (ids) =>
      imageReferences(deps.attachments.forBot(bot.id, ids), (id) => deps.attachments.bytes(id)),
    );
    const { bytes, mediaType, protocol } = await generateModelImage({
      model: deps.model,
      config: access.config,
      key: access.key,
      job,
      signal,
      botId: bot.id,
      runId,
      routes: storeImageRoutes(deps.store),
    });
    const file = deps.attachments.importForBot(bot.id, imageFileName(args.filename, mediaType), bytes);
    const run = deps.store.data.runs.find((item) => item.id === runId && item.botId === bot.id);
    if (run)
      run.attachments = deps.attachments.forBot(bot.id, [
        ...new Set([...(run.attachments || []), file].map((item) => item.id)),
      ]);
    return {
      attachmentId: file.id,
      name: file.name,
      bytes: file.size,
      mediaType,
      protocol,
      ...(job.aspect ? { aspect: job.aspect } : {}),
    };
  },
  video_frames: ({ bot, args, signal, runId, deps }) => {
    if (!deps.video) throw Error('视频检查器不可用');
    return deps.video.inspect(
      bot.id,
      runId,
      args,
      signal,
      deps.store.data.runs.find((run) => run.id === runId)?.workspaceDir,
    );
  },
};
