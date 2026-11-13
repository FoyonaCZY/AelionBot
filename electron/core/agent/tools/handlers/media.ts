import { generateModelImage, storeImageRoutes } from '../../../image/image-generation';
import { imageFileName, imageJobFromArgs, imageReferences } from '../../../image/image-tool';
import type { ToolHandler } from '../context';
import { attachmentName } from '../../../attachments/attachments';
import { attachToReply, namedFile } from './attachments';

export const MEDIA_HANDLERS: Record<string, ToolHandler> = {
  open_preview: ({ bot, args, signal, runId, deps }) => {
    if (!deps.previews) throw Error('应用预览服务尚未就绪');
    return deps.previews.open(bot.id, runId, args, signal);
  },
  preview_mark: ({ bot, args, signal, runId, deps }) => {
    if (!deps.previews) throw Error('应用预览服务尚未就绪');
    if (args.marks === undefined) throw Error('preview_mark 需要 marks');
    return deps.previews.open(bot.id, runId, args, signal);
  },
  view_image: ({ bot, args, signal, runId, workspace, deps }) => {
    if (!deps.host) throw Error('本机图像工具不可用');
    return deps.host.viewImage(bot.id, runId, args, signal, workspace);
  },
  generate_image: async (context) => {
    const { bot, args, signal, runId, deps } = context;
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
    const file = attachToReply(context, imageFileName(args.filename, mediaType), bytes);
    return {
      attachmentId: file.id,
      name: file.name,
      bytes: file.size,
      mediaType,
      protocol,
      ...(job.aspect ? { aspect: job.aspect } : {}),
    };
  },
  transcribe_audio: async (context) => {
    const { args, signal, deps } = context;
    if (!deps.speech?.available('input')) throw Error('还没有设置语音识别');
    const file = await namedFile(context, args.file, '识别本机录音');
    const { text, seconds } = await deps.speech.transcribe(deps.attachments.bytes(file.id), signal);
    return {
      attachmentId: file.id,
      name: file.name,
      seconds: Math.round(seconds),
      text: text || '（没有识别到语音）',
    };
  },
  text_to_speech: async (context) => {
    const { bot, args, signal, deps } = context;
    if (!deps.speech?.available('output')) throw Error('还没有设置语音合成');
    const audio = await deps.speech.synthesize(String(args.text || ''), signal, bot.id),
      extension = audio.mime === 'audio/mpeg' ? '.mp3' : '.wav',
      stem = String(args.filename || 'speech').replace(/\.(mp3|wav)$/i, ''),
      file = attachToReply(context, attachmentName(stem + extension), audio.bytes);
    deps.store.save();
    return {
      attachmentId: file.id,
      name: file.name,
      bytes: file.size,
      delivery: '音频已附在本次最终回复中，不用再次附加。',
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
