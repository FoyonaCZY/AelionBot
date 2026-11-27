import type { JsonObject, JsonValue } from '@aelionsdk/core';

export interface AssetRepresentation {
  readonly id: string;
  readonly role: 'original' | 'proxy' | 'thumbnail' | 'waveform';
  readonly locator: JsonValue;
  readonly durationUs?: number;
  readonly width?: number;
  readonly height?: number;
  readonly contentHash?: string;
  readonly sourceStartUs?: number;
}

export interface SelectRepresentationOptions {
  readonly purpose: 'preview' | 'export' | 'thumbnail' | 'waveform';
  readonly maxDimension?: number;
  readonly sourceDurationUs?: number;
  readonly durationToleranceUs?: number;
}

export interface RepresentationSelection {
  readonly representation: AssetRepresentation;
  readonly usedProxy: boolean;
  readonly diagnostics: readonly string[];
}

function object(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined;
}

function representation(value: JsonValue): AssetRepresentation | undefined {
  const entry = object(value);
  if (
    entry === undefined ||
    typeof entry.id !== 'string' ||
    (entry.role !== 'original' && entry.role !== 'proxy' && entry.role !== 'thumbnail' && entry.role !== 'waveform') ||
    entry.locator === undefined
  ) {
    return undefined;
  }
  return {
    id: entry.id,
    role: entry.role,
    locator: entry.locator,
    ...(typeof entry.durationUs === 'number' ? { durationUs: entry.durationUs } : {}),
    ...(typeof entry.width === 'number' ? { width: entry.width } : {}),
    ...(typeof entry.height === 'number' ? { height: entry.height } : {}),
    ...(typeof entry.contentHash === 'string' ? { contentHash: entry.contentHash } : {}),
    ...(typeof entry.sourceStartUs === 'number' ? { sourceStartUs: entry.sourceStartUs } : {}),
  };
}

export function selectAssetRepresentation(
  asset: Readonly<JsonObject>,
  options: SelectRepresentationOptions,
): RepresentationSelection {
  const values = Array.isArray(asset.representations)
    ? asset.representations.flatMap((value) => {
        const parsed = representation(value);
        return parsed === undefined ? [] : [parsed];
      })
    : [];
  const original =
    values.find((value) => value.role === 'original') ??
    ({
      id: `${typeof asset.id === 'string' ? asset.id : 'asset'}:original`,
      role: 'original',
      locator: asset.locator ?? null,
      ...(options.sourceDurationUs === undefined ? {} : { durationUs: options.sourceDurationUs }),
    } satisfies AssetRepresentation);
  if (options.purpose === 'export') {
    return { representation: original, usedProxy: false, diagnostics: [] };
  }
  const role = options.purpose === 'preview' ? 'proxy' : options.purpose === 'thumbnail' ? 'thumbnail' : 'waveform';
  const diagnostics: string[] = [];
  const candidates = values
    .filter((value) => value.role === role)
    .filter((value) => {
      if (options.sourceDurationUs === undefined || value.durationUs === undefined) return true;
      const tolerance = options.durationToleranceUs ?? 1_000;
      const consistent = Math.abs(value.durationUs - options.sourceDurationUs) <= tolerance;
      if (!consistent) diagnostics.push('MEDIA_PROXY_DURATION_MISMATCH');
      return consistent;
    })
    .sort((left, right) => {
      const leftSize = Math.max(left.width ?? Number.MAX_SAFE_INTEGER, left.height ?? 0);
      const rightSize = Math.max(right.width ?? Number.MAX_SAFE_INTEGER, right.height ?? 0);
      const target = options.maxDimension ?? Number.MAX_SAFE_INTEGER;
      const leftPenalty = leftSize > target ? leftSize - target + target : target - leftSize;
      const rightPenalty = rightSize > target ? rightSize - target + target : target - rightSize;
      return leftPenalty - rightPenalty || left.id.localeCompare(right.id);
    });
  const selected = candidates[0];
  return selected === undefined
    ? { representation: original, usedProxy: false, diagnostics }
    : { representation: selected, usedProxy: selected.role === 'proxy', diagnostics };
}

/** Proxy and source use the same normalized presentation timeline. */
export function proxyPresentationTimeUs(sourceTimeUs: number, representation: AssetRepresentation): number {
  if (!Number.isSafeInteger(sourceTimeUs) || sourceTimeUs < 0) {
    throw new RangeError('sourceTimeUs must be a non-negative safe integer');
  }
  const mapped = sourceTimeUs - (representation.sourceStartUs ?? 0);
  if (mapped < 0 || (representation.durationUs !== undefined && mapped >= representation.durationUs)) {
    throw new RangeError('Source time is outside the representation timeline');
  }
  return mapped;
}
