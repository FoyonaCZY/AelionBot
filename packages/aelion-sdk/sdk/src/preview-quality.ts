import type { AelionPreviewQualityOptions } from './types.js';

export interface NormalizedPreviewQuality {
  readonly quality: 'draft' | 'full';
  readonly renderScale: number;
}

export function normalizePreviewQuality(options: AelionPreviewQualityOptions = {}): NormalizedPreviewQuality {
  const quality = options.quality ?? 'full';
  const renderScale = options.renderScale ?? (quality === 'draft' ? 0.5 : 1);
  if (!Number.isFinite(renderScale) || renderScale <= 0 || renderScale > 1) {
    throw new RangeError('renderScale must be greater than 0 and at most 1');
  }
  return Object.freeze({ quality, renderScale });
}
