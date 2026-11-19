/**
 * Shared argument handling for the two image tools, so `generate_image` and `design_image` read prompt, aspect, quality
 * and negative prompt alike. Each finds its own reference images: generate_image by attachment or path, design_image by
 * attachment ID.
 */
import type { ModelConfig } from '../../../shared/types/core';
import { asImageAspect, asImageQuality } from '../../../shared/types/image-types';
import { imageExtension, type ImageJob } from './image-generation';
import type { ImageReference } from './image-protocols';

const SUPPORTED_REFERENCE = /^image\/(png|jpeg|webp|gif)$/;

/** At most this many reference images go with one generation. */
export const MAX_REFERENCES = 4;

/** The attachment IDs design_image names as reference images. */
export function referenceAttachmentIds(args: Record<string, unknown>) {
  return Array.isArray(args.referenceAttachmentIds)
    ? (args.referenceAttachmentIds.filter((value) => typeof value === 'string').slice(0, MAX_REFERENCES) as string[])
    : [];
}

/** Tool arguments win; the model catalog supplies the default when the agent did not choose. */
export function imageJobFromArgs(
  args: Record<string, unknown>,
  config: Pick<ModelConfig, 'imageAspect' | 'imageQuality'>,
  reference?: ImageReference[],
): ImageJob {
  const negative = typeof args.negativePrompt === 'string' ? args.negativePrompt.trim() : '';
  return {
    prompt: typeof args.prompt === 'string' ? args.prompt : '',
    aspect: asImageAspect(args.aspect) || config.imageAspect,
    quality: asImageQuality(args.quality) || config.imageQuality,
    ...(negative ? { negativePrompt: negative.slice(0, 1000) } : {}),
    ...(reference?.length ? { reference } : {}),
  };
}

/** Names the file after what the provider actually returned rather than what the model guessed. */
export function imageFileName(requested: unknown, mediaType: string, fallback = 'generated') {
  const raw = typeof requested === 'string' && requested.trim() ? requested.trim() : fallback;
  const base =
    raw
      .replace(/\.[a-z0-9]{1,5}$/i, '')
      .replace(/[^\p{L}\p{N}._-]/gu, '-')
      .replace(/^[-.]+/, '')
      .slice(0, 60) || fallback;
  return `${base}.${imageExtension(mediaType)}`;
}

export function imageReferences(
  attachments: Array<{ id: string; name: string; mime: string }>,
  bytes: (id: string) => Buffer,
): ImageReference[] {
  return attachments.map((file) => {
    if (!SUPPORTED_REFERENCE.test(file.mime)) throw Error(`参考图 ${file.name} 不是受支持的图片格式`);
    return { bytes: bytes(file.id), mediaType: file.mime, name: file.name };
  });
}
