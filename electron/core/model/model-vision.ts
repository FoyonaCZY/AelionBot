import type { ModelConfig, WireMessage } from '../../../shared/types/core';
import { AppError } from '../../../shared/errors';
export class ModelImageUnsupportedError extends AppError {
  constructor(model: string, detail?: string) {
    super(
      'model.image_unsupported',
      `当前模型或服务不支持图片输入（${model}）。请为这个 Bot 选择支持图片的模型；图片附件和原始对话已保留。${detail ? '\n服务返回：' + detail : ''}`,
    );
    this.name = 'ModelImageUnsupportedError';
  }
}
export class ModelRequestTooLargeError extends AppError {
  constructor(model: string, detail?: string) {
    super(
      'model.request_too_large',
      `模型服务拒绝了这个请求：内容过大（HTTP 413），图片或文本超过了服务的请求体上限。工作记录和原始图片已保留；可以减少图片、压缩后重试，或新建会话继续。${detail ? '\n服务返回：' + detail : ''}`,
    );
    this.name = 'ModelRequestTooLargeError';
  }
}
/** DeepSeek documents a 48 MiB request body; keep a large margin for text and tool schemas. */
const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024;
/**
 * Keeps the request's inline images under a byte budget by replacing the oldest optional ones with a note.
 * Images the current input or tool step depends on stay. Measuring goes through the same resolver that builds the
 * request, so the budget counts the encoded payload rather than a guess from pixel dimensions.
 */
export function trimImagesToBudget(
  messages: WireMessage[],
  required: ReadonlySet<string>,
  resolve: (id: string) => string,
  budget = MAX_REQUEST_IMAGE_BYTES,
) {
  const entries = messages.flatMap((message) =>
      (message.images || []).map((image) => ({ image, bytes: resolve(image.id).length })),
    ),
    total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (total <= budget) return { messages, dropped: 0 };
  const drop = new Set<string>();
  let bytes = total;
  for (const entry of entries) {
    if (bytes <= budget) break;
    if (required.has(entry.image.id) || drop.has(entry.image.id)) continue;
    drop.add(entry.image.id);
    bytes -= entry.bytes;
  }
  if (!drop.size) return { messages, dropped: 0 };
  let dropped = 0;
  const trimmed = messages.map((message) => {
    const removed = (message.images || []).filter((image) => drop.has(image.id));
    if (!removed.length) return message;
    dropped += removed.length;
    const kept = message.images!.filter((image) => !drop.has(image.id));
    return {
      ...message,
      images: kept.length ? kept : undefined,
      content:
        (message.content || '') +
        `\n[为控制请求大小，已省略 ${removed.length} 张较早的图片；需要细节时请重新读取附件或重新截图。]`,
    };
  });
  return { messages: trimmed, dropped };
}
export function imageInputRejected(status: number, text: string) {
  return (
    [400, 404, 422].includes(status) &&
    /no endpoints found that support image input|(?:does not|doesn't|cannot|not).*support.{0,30}(?:image|vision)|(?:image|vision).{0,40}(?:not supported|unsupported)|不支持.{0,10}(?:图片|图像)/i.test(
      text,
    )
  );
}
export function imageCapability(value: any): boolean | undefined {
  const modalities =
    value?.architecture?.input_modalities ?? value?.input_modalities ?? value?.supported_input_modalities;
  if (Array.isArray(modalities) && modalities.length && modalities.every((item) => typeof item === 'string'))
    return modalities.includes('image') || modalities.includes('image_url');
  for (const result of [value?.supports_images, value?.supportsImages, value?.capabilities?.vision])
    if (typeof result === 'boolean') return result;
  const modality = value?.architecture?.modality;
  if (typeof modality === 'string' && modality.includes('->')) return modality.split('->')[0].includes('image');
  return undefined;
}
export function omitHistoricalImages(
  messages: WireMessage[],
  required: ReadonlySet<string>,
  config: ModelConfig,
  detail?: string,
) {
  if (messages.some((message) => message.images?.some((image) => required.has(image.id))))
    throw new ModelImageUnsupportedError(config.model, detail);
  return messages.map((message) =>
    message.images?.length
      ? {
          ...message,
          images: undefined,
          content:
            (message.content || '') +
            '\n[历史图片未发送：当前模型或服务不支持图片。可以继续处理文字，但不能声称已查看图片内容；需要图片细节时请切换支持图片的模型。]',
        }
      : message,
  );
}
