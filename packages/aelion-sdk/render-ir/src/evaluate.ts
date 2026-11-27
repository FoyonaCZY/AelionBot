import type {
  ActiveAudioState,
  ActiveVisualState,
  IrBaseClip,
  IrClip,
  IrVisualClip,
  IrTextClip,
  IrNestedSequenceClip,
  IrGeneratorClip,
  IrMaterialContentClip,
  IrShapeClip,
  IrAdjustmentClip,
  IrMaterialInstance,
  EvaluatedMaterialInstance,
  RenderIr,
} from './types.js';
import { mapIrSourceTime } from './time-map.js';

function isAnimation(value: unknown): value is {
  readonly animation: {
    readonly keyframes: readonly {
      readonly timeUs: number;
      readonly value: import('@aelionsdk/core').JsonValue;
      readonly interpolation: string;
    }[];
  };
} {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return false;
  const animation: unknown = Reflect.get(value, 'animation');
  return (
    animation !== null &&
    !Array.isArray(animation) &&
    typeof animation === 'object' &&
    Array.isArray(Reflect.get(animation, 'keyframes'))
  );
}

function cubicBezierCoordinate(t: number, first: number, second: number): number {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * first + 3 * inverse * t * t * second + t * t * t;
}

function cubicBezierProgress(progress: number, easing: Readonly<Record<string, unknown>>): number {
  const x1 = numberProperty(easing.x1, 0);
  const y1 = numberProperty(easing.y1, 0);
  const x2 = numberProperty(easing.x2, 1);
  const y2 = numberProperty(easing.y2, 1);
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const middle = (low + high) / 2;
    if (cubicBezierCoordinate(middle, x1, x2) < progress) low = middle;
    else high = middle;
  }
  return cubicBezierCoordinate((low + high) / 2, y1, y2);
}

function animationTime(
  animation: Readonly<Record<string, unknown>>,
  sequenceTimeUs: number,
  ownerStartUs: number,
): number {
  return animation.timeSpace === 'sequence' ? sequenceTimeUs : sequenceTimeUs - ownerStartUs;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function infinityTime(timeUs: number, firstUs: number, lastUs: number, mode: unknown): number {
  const durationUs = lastUs - firstUs;
  if (durationUs <= 0 || (mode !== 'cycle' && mode !== 'ping-pong')) return timeUs;
  const progress = positiveModulo(timeUs - firstUs, durationUs);
  if (mode === 'cycle') return firstUs + progress;
  const cycle = Math.floor((timeUs - firstUs) / durationUs);
  return Math.abs(cycle) % 2 === 0 ? firstUs + progress : lastUs - progress;
}

function interpolateJson(
  from: import('@aelionsdk/core').JsonValue,
  to: import('@aelionsdk/core').JsonValue,
  progress: number,
): import('@aelionsdk/core').JsonValue {
  if (typeof from === 'number' && typeof to === 'number') return from + (to - from) * progress;
  if (Array.isArray(from) && Array.isArray(to) && from.length === to.length) {
    return from.map((value, index) => interpolateJson(value, to[index] ?? value, progress));
  }
  if (
    from !== null &&
    to !== null &&
    typeof from === 'object' &&
    typeof to === 'object' &&
    !Array.isArray(from) &&
    !Array.isArray(to)
  ) {
    const keys = Object.keys(from);
    if (keys.length === Object.keys(to).length && keys.every((key) => Object.hasOwn(to, key))) {
      return Object.fromEntries(
        keys.map((key) => [key, interpolateJson(from[key] ?? null, to[key] ?? null, progress)]),
      );
    }
  }
  return from;
}

function easingProgress(progress: number, from: Readonly<Record<string, unknown>>): number {
  const easing = objectProperty(Reflect.get(from, 'easing'));
  if (easing.type === 'steps') {
    const count = Math.max(1, Math.floor(numberProperty(easing.count, 1)));
    return easing.position === 'start'
      ? Math.min(1, Math.ceil(progress * count) / count)
      : Math.floor(progress * count) / count;
  }
  return from.interpolation === 'cubic-bezier' ? cubicBezierProgress(progress, easing) : progress;
}

function bezierComponent(progress: number, from: number, handleOut: number, handleIn: number, to: number): number {
  const inverse = 1 - progress;
  return (
    inverse * inverse * inverse * from +
    3 * inverse * inverse * progress * handleOut +
    3 * inverse * progress * progress * handleIn +
    progress * progress * progress * to
  );
}

/**
 * Interpolate a value between two keyframes using explicit Bézier handles
 * (`handleOut` on the from keyframe, `handleIn` on the to keyframe). Handles
 * are value-space tangents: for a scalar value the tangent is the `y`
 * component (added to the value), and for a `{x,y}` vector both components
 * are added as the control point offset. Falls back to plain progress-based
 * interpolation when neither endpoint carries a handle.
 */
function interpolateWithHandles(
  fromValue: import('@aelionsdk/core').JsonValue,
  toValue: import('@aelionsdk/core').JsonValue,
  progress: number,
  fromKeyframe: Readonly<Record<string, unknown>>,
  toKeyframe: Readonly<Record<string, unknown>>,
): import('@aelionsdk/core').JsonValue {
  const handleOut = objectProperty(Reflect.get(fromKeyframe, 'handleOut'));
  const handleIn = objectProperty(Reflect.get(toKeyframe, 'handleIn'));
  if (Object.keys(handleOut).length === 0 && Object.keys(handleIn).length === 0) {
    return interpolateJson(fromValue, toValue, progress);
  }
  if (typeof fromValue === 'number' && typeof toValue === 'number') {
    const outTangent = numberProperty(handleOut.y, 0);
    const inTangent = numberProperty(handleIn.y, 0);
    return bezierComponent(progress, fromValue, fromValue + outTangent, toValue + inTangent, toValue);
  }
  if (
    fromValue !== null &&
    toValue !== null &&
    typeof fromValue === 'object' &&
    typeof toValue === 'object' &&
    !Array.isArray(fromValue) &&
    !Array.isArray(toValue)
  ) {
    const outX = numberProperty(handleOut.x, 0);
    const outY = numberProperty(handleOut.y, 0);
    const inX = numberProperty(handleIn.x, 0);
    const inY = numberProperty(handleIn.y, 0);
    const scalar = (key: string): number | undefined => {
      const fromScalar = fromValue[key];
      const toScalar = toValue[key];
      if (typeof fromScalar !== 'number' || typeof toScalar !== 'number') return undefined;
      const out = key === 'x' ? outX : outY;
      const inn = key === 'x' ? inX : inY;
      return bezierComponent(progress, fromScalar, fromScalar + out, toScalar + inn, toScalar);
    };
    const x = scalar('x');
    const y = scalar('y');
    if (x !== undefined && y !== undefined) return { x, y };
  }
  return interpolateJson(fromValue, toValue, progress);
}

export function evaluateAnimatedValue(
  value: import('@aelionsdk/core').JsonValue,
  sequenceTimeUs: number,
  ownerStartUs = 0,
) {
  if (!isAnimation(value)) return value;
  const animation = value.animation as unknown as Readonly<Record<string, unknown>>;
  let timeUs = animationTime(animation, sequenceTimeUs, ownerStartUs);
  const keyframes = value.animation.keyframes;
  if (keyframes.length === 0) return null;
  const firstKeyframe = keyframes[0];
  const lastKeyframe = keyframes.at(-1);
  if (firstKeyframe === undefined || lastKeyframe === undefined) return null;
  if (timeUs < firstKeyframe.timeUs) {
    timeUs = infinityTime(timeUs, firstKeyframe.timeUs, lastKeyframe.timeUs, animation.preInfinity);
  } else if (timeUs > lastKeyframe.timeUs) {
    timeUs = infinityTime(timeUs, firstKeyframe.timeUs, lastKeyframe.timeUs, animation.postInfinity);
  }
  const right = keyframes.findIndex((keyframe) => keyframe.timeUs > timeUs);
  if (right === 0) {
    if (animation.preInfinity === 'none') return null;
    if (animation.preInfinity !== 'linear' || keyframes.length < 2) return keyframes[0]?.value ?? null;
  }
  if (right < 0) {
    if (animation.postInfinity === 'none') return null;
    if (animation.postInfinity !== 'linear' || keyframes.length < 2) {
      return keyframes.at(-1)?.value ?? null;
    }
  }
  const toIndex = right === 0 ? 1 : right < 0 ? keyframes.length - 1 : right;
  const from = keyframes[toIndex - 1];
  const to = keyframes[toIndex];
  if (from === undefined || to === undefined) return null;
  if ((from.interpolation !== 'linear' && from.interpolation !== 'cubic-bezier') || to.timeUs === from.timeUs) {
    return from.value;
  }
  let progress = (timeUs - from.timeUs) / (to.timeUs - from.timeUs);
  const hasBezierHandle =
    from.interpolation === 'cubic-bezier' &&
    (Reflect.get(from, 'handleOut') !== undefined || Reflect.get(to, 'handleIn') !== undefined);
  if (hasBezierHandle) {
    return interpolateWithHandles(from.value, to.value, progress, from, to);
  }
  progress = easingProgress(progress, from);
  return interpolateJson(from.value, to.value, progress);
}

export function evaluateAnimatableNumber(
  value: import('@aelionsdk/core').JsonValue | undefined,
  sequenceTimeUs: number,
  ownerStartUs: number,
  fallback: number,
): number {
  const evaluated = value === undefined ? undefined : evaluateAnimatedValue(value, sequenceTimeUs, ownerStartUs);
  return numberProperty(evaluated, fallback);
}

export function evaluateMaterialInstance(
  material: IrMaterialInstance,
  sequenceTimeUs: number,
  ownerStartUs = 0,
): EvaluatedMaterialInstance {
  return {
    id: material.id,
    parameters: Object.fromEntries(
      Object.entries(material.parameters).map(([id, value]) => [
        id,
        evaluateAnimatedValue(value, sequenceTimeUs, ownerStartUs),
      ]),
    ),
    resourceBindings: material.resourceBindings,
    inputBindings: material.inputBindings,
  };
}

function contains(startUs: number, durationUs: number, timeUs: number): boolean {
  return timeUs >= startUs && timeUs < startUs + durationUs;
}

function mapBaseClipSourceTime(
  clip: IrBaseClip & { readonly source: IrVisualClip['source'] },
  sequenceTimeUs: number,
  allowOutsideItem = false,
): number | null {
  const localUs = sequenceTimeUs - clip.range.startUs;
  return mapIrSourceTime(
    allowOutsideItem ? { ...clip.source, boundary: 'hold' } : clip.source,
    clip.range.durationUs,
    localUs,
    {
      allowOutsideItem,
    },
  );
}

export function mapClipSourceTime(clip: IrVisualClip, sequenceTimeUs: number): number | null {
  return mapBaseClipSourceTime(clip, sequenceTimeUs);
}

/** Resolve a compiled media source to the concrete Asset and timestamp to decode. */
export function resolveMediaSourceFrame(
  source: IrVisualClip['source'],
  sourceTimeUs: number,
): {
  readonly assetId: string;
  readonly streamIndex: number;
  readonly sourceTimeUs: number;
} | null {
  const sequence = source.imageSequence;
  if (sequence === undefined) {
    return { assetId: source.assetId, streamIndex: source.streamIndex, sourceTimeUs };
  }
  if (!Number.isSafeInteger(sourceTimeUs) || sourceTimeUs < 0) return null;
  const index = Math.floor(sourceTimeUs / sequence.frameDurationUs);
  const assetId = sequence.frameAssetIds[index];
  return assetId === undefined ? null : { assetId, streamIndex: 0, sourceTimeUs: 0 };
}

function isVisualRenderClip(
  clip: IrClip,
): clip is
  | IrVisualClip
  | IrTextClip
  | IrNestedSequenceClip
  | IrGeneratorClip
  | IrShapeClip
  | IrMaterialContentClip
  | IrAdjustmentClip {
  return (
    clip.kind === 'visual-clip' ||
    clip.kind === 'text-clip' ||
    clip.kind === 'nested-sequence-clip' ||
    clip.kind === 'generator-clip' ||
    clip.kind === 'shape-clip' ||
    clip.kind === 'material-content-clip' ||
    clip.kind === 'adjustment-clip'
  );
}

function mapNestedSourceTime(
  clip: IrNestedSequenceClip,
  sequenceTimeUs: number,
  allowOutsideItem = false,
): number | null {
  return mapIrSourceTime(
    {
      assetId: clip.source.sequenceId,
      streamType: 'video',
      streamIndex: 0,
      sourceRange: clip.source.sourceRange,
      timeMapping: clip.source.timeMapping,
      boundary: allowOutsideItem ? 'hold' : clip.source.boundary,
    },
    clip.range.durationUs,
    sequenceTimeUs - clip.range.startUs,
    { allowOutsideItem },
  );
}

function numberProperty(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function objectProperty(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

export function evaluateAudioState(ir: RenderIr, startUs: number, durationUs: number): ActiveAudioState {
  if (
    !Number.isSafeInteger(startUs) ||
    !Number.isSafeInteger(durationUs) ||
    startUs < 0 ||
    durationUs <= 0 ||
    startUs + durationUs > ir.durationUs
  ) {
    throw new RangeError('Audio evaluation range is outside the Render IR duration');
  }
  const hasSoloTrack = ir.tracks.some(
    (track) => track.kind === 'audio' && track.enabled && objectProperty(track.audio).solo === true,
  );
  return {
    startUs,
    durationUs,
    clips: ir.tracks
      .filter((track) => {
        if (track.kind !== 'audio' || !track.enabled) return false;
        const audio = objectProperty(track.audio);
        return audio.muted !== true && (!hasSoloTrack || audio.solo === true);
      })
      .flatMap((track) =>
        track.clips.flatMap((clip) => {
          if (clip.kind !== 'audio-clip' || !clip.enabled) return [];
          const overlapStart = Math.max(startUs, clip.range.startUs);
          const overlapEnd = Math.min(startUs + durationUs, clip.range.startUs + clip.range.durationUs);
          if (overlapStart >= overlapEnd) return [];
          const sourceStartUs = mapBaseClipSourceTime(clip, overlapStart);
          if (sourceStartUs === null) return [];
          const trackAudio = objectProperty(track.audio);
          const gainDb =
            evaluateAnimatableNumber(trackAudio.gainDb as import('@aelionsdk/core').JsonValue, overlapStart, 0, 0) +
            evaluateAnimatableNumber(clip.audio.gainDb, overlapStart, clip.range.startUs, 0);
          const pan =
            evaluateAnimatableNumber(trackAudio.pan as import('@aelionsdk/core').JsonValue, overlapStart, 0, 0) +
            evaluateAnimatableNumber(clip.audio.pan, overlapStart, clip.range.startUs, 0);
          return [
            {
              clip,
              sourceStartUs,
              sequenceStartUs: overlapStart,
              durationUs: overlapEnd - overlapStart,
              gain: 10 ** (gainDb / 20),
              pan: Math.max(-1, Math.min(1, pan)),
              trackAudio: track.audio ?? {},
            },
          ];
        }),
      ),
  };
}

export function evaluateVisualState(ir: RenderIr, timeUs: number): ActiveVisualState {
  if (!Number.isSafeInteger(timeUs) || timeUs < 0 || timeUs >= ir.durationUs) {
    throw new RangeError('timeUs is outside the Render IR duration');
  }
  const transition = ir.transitions.find((value) => contains(value.range.startUs, value.range.durationUs, timeUs));
  const transitionInputIds =
    transition === undefined ? undefined : new Set([transition.fromItemId, transition.toItemId]);
  const clips = ir.tracks
    .filter((track) => (track.kind === 'visual' || track.kind === 'caption') && track.enabled)
    .flatMap((track) =>
      track.clips
        .filter(
          (
            clip,
          ): clip is
            | IrVisualClip
            | IrTextClip
            | IrNestedSequenceClip
            | IrGeneratorClip
            | IrShapeClip
            | IrMaterialContentClip
            | IrAdjustmentClip =>
            isVisualRenderClip(clip) &&
            clip.enabled &&
            (contains(clip.range.startUs, clip.range.durationUs, timeUs) || transitionInputIds?.has(clip.id) === true),
        )
        .map((clip) => ({
          clip,
          sourceTimeUs:
            clip.kind === 'visual-clip'
              ? mapBaseClipSourceTime(clip, timeUs, transitionInputIds?.has(clip.id) === true)
              : clip.kind === 'nested-sequence-clip'
                ? mapNestedSourceTime(clip, timeUs, transitionInputIds?.has(clip.id) === true)
                : null,
          materials: clip.materialInstanceIds.flatMap((id) => {
            const value = ir.materials[id];
            return value?.enabled === true ? [value] : [];
          }),
        })),
    );
  const transitionMaterial = transition === undefined ? undefined : ir.materials[transition.materialInstanceId];
  return {
    timeUs,
    clips,
    ...(transition === undefined || transitionMaterial?.enabled !== true
      ? {}
      : {
          transition: {
            transition,
            progress: (timeUs - transition.range.startUs) / transition.range.durationUs,
            material: transitionMaterial,
          },
        }),
  };
}
