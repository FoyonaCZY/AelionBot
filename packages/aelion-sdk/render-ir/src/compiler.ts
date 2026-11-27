import { type AelionProject, type ItemEntity, type TrackEntity } from '@aelionsdk/project-schema';
import type { JsonObject } from '@aelionsdk/core';

import type {
  IrAudioClip,
  IrClip,
  IrMaterialDefinition,
  IrMaterialInstance,
  IrMediaSource,
  IrNestedSequenceSource,
  IrTextClip,
  IrTimeMapping,
  IrTrack,
  IrTransition,
  IrVisualProperties,
  RenderIr,
  RenderIrCompilation,
  RenderCompileOptions,
} from './types.js';

/**
 * Objects `deepFreezePlain` has already frozen, along with everything beneath
 * them.
 *
 * An incremental compile reuses most of the previous IR verbatim, and those
 * objects were deep-frozen by the compile that produced them. Re-walking them
 * dominated incremental compile time -- roughly three quarters of a no-op
 * compile at a thousand clips. Membership means the whole subtree is already
 * frozen, so the walk can stop at the first reused node.
 *
 * Entries are held weakly, so a released IR is still collectable.
 */
const deepFrozen = new WeakSet<object>();

/** Item types the Render IR can compile, as a set so the check is one lookup. */
const COMPILABLE_ITEM_TYPES: ReadonlySet<string> = new Set([
  'video',
  'image',
  'audio',
  'text',
  'caption',
  'nested-sequence',
  'generator',
  'shape',
  'material-content',
  'adjustment',
  // Compiles to no clip at all; see the Gap branch in the Track loop below.
  'gap',
]);

function deepFreezePlain<T>(value: T, seen = new WeakSet<object>()): Readonly<T> {
  if (value === null || typeof value !== 'object') return value;
  if (deepFrozen.has(value)) return value;
  if (seen.has(value)) return value;
  if (Array.isArray(value)) {
    seen.add(value);
    for (const entry of value) deepFreezePlain(entry, seen);
  } else {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    seen.add(value);
    // `for...in` over a plain object walks V8's enumeration cache without
    // materializing a key or value array for every node in the IR, which at a
    // thousand clips is tens of thousands of throwaway arrays per compile.
    for (const key in value) {
      deepFreezePlain((value as Record<string, unknown>)[key], seen);
    }
  }
  // Recorded only after the whole subtree is frozen, so membership never
  // promises more than has actually been done.
  deepFrozen.add(value);
  return Object.freeze(value);
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new TypeError(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function jsonObject(value: unknown, context: string): JsonObject {
  return object(value, context) as JsonObject;
}

function string(value: unknown, context: string): string {
  if (typeof value !== 'string') throw new TypeError(`${context} must be a string`);
  return value;
}

function number(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${context} must be a finite number`);
  }
  return value;
}

function boolean(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${context} must be boolean`);
  return value;
}

function enumValue<const TValues extends readonly string[]>(
  value: unknown,
  values: TValues,
  fallback: TValues[number],
  context: string,
): TValues[number] {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && values.includes(value)) return value as TValues[number];
  throw new TypeError(`${context} is unsupported`);
}

function mediaSource(item: ItemEntity, assets: AelionProject['assets']): IrMediaSource {
  const source = object(item.source, `item ${item.id}.source`);
  const stream = object(source.stream, `item ${item.id}.source.stream`);
  const sourceRange = object(source.sourceRange, `item ${item.id}.source.sourceRange`);
  const timeMapping = object(source.timeMapping, `item ${item.id}.source.timeMapping`);
  const streamType = string(stream.type, 'stream.type');
  if (streamType !== 'video' && streamType !== 'audio') {
    throw new TypeError(`Unsupported stream type ${streamType}`);
  }
  const boundary = string(timeMapping.boundary, 'timeMapping.boundary');
  if (!['error', 'hold', 'loop', 'transparent'].includes(boundary)) {
    throw new TypeError(`Unsupported boundary ${boundary}`);
  }
  let compiledTimeMapping: IrTimeMapping;
  if (timeMapping.type === 'linear') {
    const rate = object(timeMapping.rate, `item ${item.id}.source.timeMapping.rate`);
    compiledTimeMapping = {
      type: 'linear',
      rate: {
        numerator: number(rate.numerator, 'rate.numerator'),
        denominator: number(rate.denominator, 'rate.denominator'),
      },
      reverse: boolean(timeMapping.reverse, 'timeMapping.reverse'),
    };
  } else if (timeMapping.type === 'curve') {
    if (!Array.isArray(timeMapping.points)) throw new TypeError('timeMapping.points must be an array');
    compiledTimeMapping = {
      type: 'curve',
      points: timeMapping.points.map((value, index) => {
        const point = object(value, `timeMapping.points[${index.toString()}]`);
        const interpolation = string(point.interpolation, 'timeMapping point interpolation');
        if (interpolation !== 'linear' && interpolation !== 'hold' && interpolation !== 'cubic') {
          throw new TypeError(`Unsupported TimeMap interpolation ${interpolation}`);
        }
        return {
          itemTimeUs: number(point.itemTimeUs, 'timeMapping point itemTimeUs'),
          sourceTimeUs: number(point.sourceTimeUs, 'timeMapping point sourceTimeUs'),
          interpolation,
        };
      }),
    };
  } else {
    throw new TypeError(`Unsupported time mapping for ${item.id}`);
  }
  const assetId = string(source.assetId, 'source.assetId');
  const asset = assets[assetId];
  let imageSequence: IrMediaSource['imageSequence'];
  if (asset?.kind === 'image-sequence') {
    const manifest = object(asset.imageSequence, `image-sequence Asset ${assetId}.imageSequence`);
    const frameDurationUs = number(manifest.frameDurationUs, `image-sequence Asset ${assetId}.frameDurationUs`);
    const frameAssetIds = manifest.frameAssetIds;
    if (
      !Number.isSafeInteger(frameDurationUs) ||
      frameDurationUs <= 0 ||
      !Array.isArray(frameAssetIds) ||
      frameAssetIds.length === 0 ||
      frameAssetIds.some((value) => typeof value !== 'string')
    ) {
      throw new TypeError(`image-sequence Asset ${assetId} has an invalid frame manifest`);
    }
    imageSequence = {
      frameDurationUs,
      frameAssetIds: frameAssetIds as string[],
    };
  }
  return {
    assetId,
    streamType,
    streamIndex: number(stream.index, 'stream.index'),
    sourceRange: {
      startUs: number(sourceRange.startUs, 'sourceRange.startUs'),
      durationUs: number(sourceRange.durationUs, 'sourceRange.durationUs'),
    },
    timeMapping: compiledTimeMapping,
    ...(compiledTimeMapping.type === 'linear'
      ? { rate: compiledTimeMapping.rate, reverse: compiledTimeMapping.reverse }
      : {}),
    boundary: boundary as IrMediaSource['boundary'],
    ...(imageSequence === undefined
      ? {}
      : {
          imageSequence: {
            frameDurationUs: imageSequence.frameDurationUs,
            frameAssetIds: [...imageSequence.frameAssetIds],
          },
        }),
  };
}

function nestedSequenceSource(item: ItemEntity): IrNestedSequenceSource {
  const source = object(item.source, `item ${item.id}.source`);
  const sourceRange = object(source.sourceRange, `item ${item.id}.source.sourceRange`);
  const timeMapping = object(source.timeMapping, `item ${item.id}.source.timeMapping`);
  const boundary = string(timeMapping.boundary, 'timeMapping.boundary');
  if (!['error', 'hold', 'loop', 'transparent'].includes(boundary)) {
    throw new TypeError(`Unsupported boundary ${boundary}`);
  }
  let compiledTimeMapping: IrTimeMapping;
  if (timeMapping.type === 'linear') {
    const rate = object(timeMapping.rate, `item ${item.id}.source.timeMapping.rate`);
    compiledTimeMapping = {
      type: 'linear',
      rate: {
        numerator: number(rate.numerator, 'rate.numerator'),
        denominator: number(rate.denominator, 'rate.denominator'),
      },
      reverse: boolean(timeMapping.reverse, 'timeMapping.reverse'),
    };
  } else if (timeMapping.type === 'curve') {
    if (!Array.isArray(timeMapping.points)) throw new TypeError('timeMapping.points must be an array');
    compiledTimeMapping = {
      type: 'curve',
      points: timeMapping.points.map((value, index) => {
        const point = object(value, `timeMapping.points[${index.toString()}]`);
        const interpolation = string(point.interpolation, 'timeMapping point interpolation');
        if (interpolation !== 'linear' && interpolation !== 'hold' && interpolation !== 'cubic') {
          throw new TypeError(`Unsupported TimeMap interpolation ${interpolation}`);
        }
        return {
          itemTimeUs: number(point.itemTimeUs, 'timeMapping point itemTimeUs'),
          sourceTimeUs: number(point.sourceTimeUs, 'timeMapping point sourceTimeUs'),
          interpolation,
        };
      }),
    };
  } else {
    throw new TypeError(`Unsupported nested Sequence time mapping for ${item.id}`);
  }
  return {
    sequenceId: string(source.sequenceId, `item ${item.id}.source.sequenceId`),
    sourceRange: {
      startUs: number(sourceRange.startUs, 'sourceRange.startUs'),
      durationUs: number(sourceRange.durationUs, 'sourceRange.durationUs'),
    },
    timeMapping: compiledTimeMapping,
    boundary: boundary as IrNestedSequenceSource['boundary'],
  };
}

/**
 * Serializes a value for fingerprint comparison.
 *
 * A fingerprint is only ever compared against the fingerprint the previous
 * compile recorded for the same entity, so it needs one property: two entities
 * that differ must serialize differently. Canonical ordering buys the stronger
 * property that two *equal* entities always agree even if their keys were
 * written in a different order -- which here would at worst cause a recompile
 * that produces the same clip, and costs a hand-written walk over every value
 * in the Sequence to avoid. `JSON.stringify` is exact for the plain JSON an
 * admitted Project contains, and the engine runs it natively.
 */
function fingerprintOf(value: unknown): string {
  return JSON.stringify(value);
}

function clipFingerprint(
  item: ItemEntity,
  materials: Readonly<Record<string, IrMaterialInstance>>,
  assets: AelionProject['assets'],
): string {
  const source = object(item.source ?? {}, `item ${item.id}.source`);
  const sourceAssetId = typeof source.assetId === 'string' ? source.assetId : undefined;
  const sourceAsset = sourceAssetId === undefined ? undefined : assets[sourceAssetId];
  return [
    fingerprintOf(item),
    ...(sourceAsset?.kind === 'image-sequence' ? [fingerprintOf(sourceAsset.imageSequence ?? null)] : []),
    ...item.materialInstanceIds.map((id) => materialFingerprint(materials[id])),
  ].join('|');
}

function materialFingerprint(instance: IrMaterialInstance | undefined): string {
  if (instance === undefined) return 'null';
  return fingerprintOf({
    id: instance.id,
    definition: {
      packageId: instance.definition.packageId,
      packageVersion: instance.definition.packageVersion,
      packageIntegrity: instance.definition.packageIntegrity,
      materialId: instance.definition.materialId,
    },
    enabled: instance.enabled,
    previewPolicy: instance.previewPolicy,
    parameters: instance.parameters,
    resourceBindings: instance.resourceBindings,
    inputBindings: instance.inputBindings,
    program:
      instance.program === undefined
        ? null
        : {
            backend: instance.program.backend,
            nodeSet: instance.program.nodeSet,
            graphHash: instance.program.graphHash,
          },
  });
}

function compileClip(
  item: ItemEntity,
  materials: Readonly<Record<string, IrMaterialInstance>>,
  assets: AelionProject['assets'],
): IrClip {
  const base = {
    id: item.id,
    trackId: item.trackId,
    range: { ...item.range },
    enabled: item.enabled,
    materialInstanceIds: [...item.materialInstanceIds],
    dependencyEntityIds: [item.id, ...item.materialInstanceIds],
    fingerprint: clipFingerprint(item, materials, assets),
  };
  if (item.type === 'video' || item.type === 'image') {
    const source = mediaSource(item, assets);
    const visual = object(item.visual, `item ${item.id}.visual`);
    const mask = object(visual.mask ?? {}, `item ${item.id}.visual.mask`);
    const maskSourceId =
      typeof mask.sourceItemId === 'string' && mask.sourceItemId.length > 0 ? mask.sourceItemId : undefined;
    return {
      ...base,
      dependencyEntityIds: [
        ...base.dependencyEntityIds,
        source.assetId,
        ...(source.imageSequence?.frameAssetIds ?? []),
        ...(maskSourceId === undefined ? [] : [maskSourceId]),
      ],
      kind: 'visual-clip',
      source,
      visual: visual as unknown as IrVisualProperties,
    };
  }
  if (item.type === 'audio') {
    const source = mediaSource(item, assets);
    return {
      ...base,
      dependencyEntityIds: [...base.dependencyEntityIds, source.assetId],
      kind: 'audio-clip',
      source,
      audio: object(item.audio, `item ${item.id}.audio`) as IrAudioClip['audio'],
    };
  }
  if (item.type === 'text') {
    const box = object(item.box, `item ${item.id}.box`);
    const paragraphs = item.paragraphs;
    if (!Array.isArray(paragraphs)) throw new TypeError(`item ${item.id}.paragraphs must be an array`);
    return {
      ...base,
      kind: 'text-clip',
      role: 'text',
      box: {
        x: number(box.x, 'text box.x'),
        y: number(box.y, 'text box.y'),
        width: number(box.width, 'text box.width'),
        height: number(box.height, 'text box.height'),
      },
      overflow: string(item.overflow, 'text overflow') as IrTextClip['overflow'],
      writingMode: string(item.writingMode, 'text writingMode') as IrTextClip['writingMode'],
      paragraphs: paragraphs.map((paragraphValue, paragraphIndex) => {
        const paragraph = object(paragraphValue, `paragraphs[${paragraphIndex.toString()}]`);
        if (!Array.isArray(paragraph.runs)) throw new TypeError('text paragraph.runs must be an array');
        return {
          style: jsonObject(paragraph.style, 'text paragraph.style'),
          runs: paragraph.runs.map((runValue, runIndex) => {
            const run = object(runValue, `text run[${runIndex.toString()}]`);
            return {
              text: string(run.text, 'text run.text'),
              style: jsonObject(run.style, 'text run.style'),
            };
          }),
        };
      }),
      visual: object(item.visual, `item ${item.id}.visual`) as unknown as IrVisualProperties,
    };
  }
  if (item.type === 'caption') {
    const box = object(item.box, `item ${item.id}.box`);
    return {
      ...base,
      kind: 'text-clip',
      role: 'caption',
      box: {
        x: number(box.x, 'caption box.x'),
        y: number(box.y, 'caption box.y'),
        width: number(box.width, 'caption box.width'),
        height: number(box.height, 'caption box.height'),
      },
      overflow: item.overflow === 'clip' ? 'clip' : 'auto-fit',
      writingMode: 'horizontal-tb',
      paragraphs: [
        {
          style: jsonObject(item.style, `item ${item.id}.style`),
          runs: [
            {
              text: string(item.text, `item ${item.id}.text`),
              style: jsonObject(item.style, `item ${item.id}.style`),
            },
          ],
        },
      ],
      visual: object(item.visual, `item ${item.id}.visual`) as unknown as IrVisualProperties,
    };
  }
  if (item.type === 'nested-sequence') {
    const source = nestedSequenceSource(item);
    return {
      ...base,
      kind: 'nested-sequence-clip',
      source,
      dependencyEntityIds: [...base.dependencyEntityIds, source.sequenceId],
      visual: object(item.visual, `item ${item.id}.visual`) as unknown as IrVisualProperties,
    };
  }
  if (item.type === 'generator') {
    return {
      ...base,
      kind: 'generator-clip',
      generator: jsonObject(item.generator, `item ${item.id}.generator`),
      visual: object(item.visual, `item ${item.id}.visual`) as unknown as IrVisualProperties,
    };
  }
  if (item.type === 'shape') {
    return {
      ...base,
      kind: 'shape-clip',
      shape: jsonObject(item.shape, `item ${item.id}.shape`),
      visual: object(item.visual, `item ${item.id}.visual`) as unknown as IrVisualProperties,
    };
  }
  if (item.type === 'material-content') {
    const materialInstanceId = string(item.materialInstanceId, `item ${item.id}.materialInstanceId`);
    const contentMaterial = materials[materialInstanceId];
    if (contentMaterial === undefined) {
      throw new ReferenceError(`item ${item.id} references missing MaterialInstance ${materialInstanceId}`);
    }
    const materialInstanceIds = [...new Set([...base.materialInstanceIds, materialInstanceId])];
    return {
      ...base,
      materialInstanceIds,
      dependencyEntityIds: [...new Set([...base.dependencyEntityIds, materialInstanceId])],
      fingerprint: `${base.fingerprint}|${materialFingerprint(contentMaterial)}`,
      kind: 'material-content-clip',
      materialInstanceId,
      visual: object(item.visual, `item ${item.id}.visual`) as unknown as IrVisualProperties,
    };
  }
  if (item.type === 'adjustment') {
    return {
      ...base,
      kind: 'adjustment-clip',
      visual: object(item.visual, `item ${item.id}.visual`) as unknown as IrVisualProperties,
    };
  }
  throw new TypeError(`Render IR cannot compile item type ${item.type}`);
}

function material(
  instance: Record<string, unknown>,
  resolveMaterialProgram: RenderCompileOptions['resolveMaterialProgram'],
): IrMaterialInstance {
  const definition = object(instance.definition, 'material definition');
  const compiledDefinition = {
    packageId: string(definition.packageId, 'definition.packageId'),
    packageVersion: string(definition.packageVersion, 'definition.packageVersion'),
    packageIntegrity: string(definition.packageIntegrity, 'definition.packageIntegrity'),
    materialId: string(definition.materialId, 'definition.materialId'),
  } satisfies IrMaterialDefinition;
  const parameters = object(instance.parameters, 'material.parameters') as IrMaterialInstance['parameters'];
  const resourceBindings = object(
    instance.resourceBindings ?? {},
    'material.resourceBindings',
  ) as IrMaterialInstance['resourceBindings'];
  const inputBindings = object(
    instance.inputBindings ?? {},
    'material.inputBindings',
  ) as IrMaterialInstance['inputBindings'];
  const program = resolveMaterialProgram?.(compiledDefinition, parameters);
  return {
    id: string(instance.id, 'material.id'),
    definition: compiledDefinition,
    enabled: boolean(instance.enabled, 'material.enabled'),
    previewPolicy: instance.previewPolicy === 'skippable-when-degraded' ? 'skippable-when-degraded' : 'required',
    parameters,
    resourceBindings,
    inputBindings,
    ...(program === undefined ? {} : { program }),
  };
}

function contentDuration(project: AelionProject, trackIds: readonly string[]): number {
  return trackIds.reduce((sequenceEnd, trackId) => {
    const track = project.tracks[trackId];
    if (track === undefined) return sequenceEnd;
    return track.itemIds.reduce((trackEnd, itemId) => {
      const item = project.items[itemId];
      return item === undefined ? trackEnd : Math.max(trackEnd, item.range.startUs + item.range.durationUs);
    }, sequenceEnd);
  }, 0);
}

export class IncrementalRenderCompiler {
  #previous: RenderIr | undefined;
  #compiling = false;
  /**
   * Track fingerprints keyed by the source track object.
   *
   * A track fingerprint serializes the whole Track, and a Track carries every
   * item id on it, so recomputing it for a thousand-clip track dominated the cost
   * of an incremental compile even when nothing on that track changed. Commits
   * share structure: editing one item leaves every untouched track at the same
   * object identity, so identity is a sound key and an edited track simply misses.
   */
  readonly #trackFingerprints = new WeakMap<object, string>();

  /**
   * Creates an isolated compiler that reuses this compiler's immutable baseline.
   * Compiling on the fork cannot advance or corrupt the parent baseline; a host
   * can promote the fork only after its surrounding transaction commits.
   */
  public fork(): IncrementalRenderCompiler {
    const fork = new IncrementalRenderCompiler();
    fork.#previous = this.#previous;
    return fork;
  }

  #trackFingerprint(track: TrackEntity): string {
    const cached = this.#trackFingerprints.get(track);
    if (cached !== undefined) return cached;
    const fingerprint = fingerprintOf(track);
    this.#trackFingerprints.set(track, fingerprint);
    return fingerprint;
  }

  /** Releases the incremental baseline retained for clip/transition reuse. */
  public clear(): void {
    if (this.#compiling) {
      throw new Error('IncrementalRenderCompiler does not support clearing during compilation');
    }
    this.#previous = undefined;
  }

  public compile(
    project: AelionProject,
    sequenceId: string,
    revision: bigint,
    optionsOrAffectedRanges: RenderCompileOptions | RenderIrCompilation['stats']['affectedRanges'] = {},
  ): RenderIrCompilation {
    if (this.#compiling) {
      throw new Error('IncrementalRenderCompiler does not support reentrant compilation');
    }
    this.#compiling = true;
    try {
      const options: RenderCompileOptions = Array.isArray(optionsOrAffectedRanges)
        ? { affectedRanges: optionsOrAffectedRanges }
        : (optionsOrAffectedRanges as RenderCompileOptions);
      const nestedSequenceStack = options.nestedSequenceStack ?? [];
      if (nestedSequenceStack.includes(sequenceId)) {
        throw new TypeError(`NESTED_SEQUENCE_CYCLE: ${[...nestedSequenceStack, sequenceId].join(' -> ')}`);
      }
      const sequence = project.sequences[sequenceId];
      if (sequence === undefined) throw new RangeError(`Sequence ${sequenceId} does not exist`);
      const materials = Object.fromEntries(
        Object.entries(project.materialInstances).map(([id, value]) => [
          id,
          material(value, options.resolveMaterialProgram),
        ]),
      );
      let compiledClips = 0;
      let reusedClips = 0;
      let compiledTransitions = 0;
      let reusedTransitions = 0;
      const previousClips = new Map(
        (this.#previous?.tracks ?? []).flatMap((track) => track.clips.map((clip) => [clip.id, clip] as const)),
      );
      const previousTransitions = new Map((this.#previous?.transitions ?? []).map((value) => [value.id, value]));
      const affectedEntityIds = new Set(options.affectedEntityIds ?? []);
      const canReuseByEntity = this.#previous !== undefined && options.affectedEntityIds !== undefined;

      const tracks: IrTrack[] = sequence.trackIds.map((trackId) => {
        const track = project.tracks[trackId];
        if (track === undefined) throw new RangeError(`Track ${trackId} does not exist`);
        // A plain loop rather than `flatMap`: the reuse path runs once per item on
        // every commit, and wrapping each result in a throwaway single-element array
        // was the largest remaining cost of an incremental compile.
        const clips: IrClip[] = [];
        for (const itemId of track.itemIds) {
          const item = project.items[itemId];
          if (item === undefined) throw new RangeError(`Item ${itemId} does not exist`);
          if (!COMPILABLE_ITEM_TYPES.has(item.type)) {
            throw new TypeError(`Render IR cannot compile item type ${item.type}`);
          }
          // A Gap is time and nothing else. It still lengthens the Sequence,
          // because `contentDuration` reads the Project rather than the clip
          // list, but it produces no clip for the renderer or the mixer to
          // consider.
          if (item.type === 'gap') continue;
          const previous = previousClips.get(itemId);
          if (
            canReuseByEntity &&
            previous !== undefined &&
            !previous.dependencyEntityIds.some((id) => affectedEntityIds.has(id))
          ) {
            reusedClips += 1;
            clips.push(previous);
            continue;
          }
          const candidate = compileClip(item, materials, project.assets);
          if (previous?.fingerprint === candidate.fingerprint) {
            reusedClips += 1;
            clips.push(previous);
            continue;
          }
          compiledClips += 1;
          clips.push(candidate);
        }
        return {
          id: track.id,
          kind: track.kind,
          enabled: Boolean(track.enabled),
          ...(track.kind === 'audio'
            ? {
                audio: object(track.audio, `track ${track.id}.audio`) as NonNullable<IrTrack['audio']>,
              }
            : {}),
          clips,
          materialInstanceIds: [...track.materialInstanceIds],
          fingerprint: this.#trackFingerprint(track),
        };
      });

      const transitions: IrTransition[] = sequence.transitionIds.map((id) => {
        const value = project.transitions[id];
        if (value === undefined) throw new RangeError(`Transition ${id} does not exist`);
        const previous = previousTransitions.get(id);
        if (
          canReuseByEntity &&
          previous !== undefined &&
          !previous.dependencyEntityIds.some((entityId) => affectedEntityIds.has(entityId))
        ) {
          reusedTransitions += 1;
          return previous;
        }
        const candidate: IrTransition = {
          id,
          trackId: value.trackId,
          fromItemId: value.fromItemId,
          toItemId: value.toItemId,
          range: { ...value.range },
          materialInstanceId: value.materialInstanceId,
          dependencyEntityIds: [id, value.fromItemId, value.toItemId, value.materialInstanceId],
          fingerprint: [fingerprintOf(value), materialFingerprint(materials[value.materialInstanceId])].join('|'),
        };
        if (previous?.fingerprint === candidate.fingerprint) {
          reusedTransitions += 1;
          return previous;
        }
        compiledTransitions += 1;
        return candidate;
      });

      const format = object(sequence.format, 'sequence.format');
      const frameRate = object(format.frameRate, 'sequence.format.frameRate');
      const duration = object(sequence.duration, 'sequence.duration');
      const nestedSequenceIds = new Set(
        tracks.flatMap((track) =>
          track.clips.flatMap((clip) => (clip.kind === 'nested-sequence-clip' ? [clip.source.sequenceId] : [])),
        ),
      );
      const subgraphs = Object.fromEntries(
        [...nestedSequenceIds].map((nestedSequenceId) => [
          nestedSequenceId,
          new IncrementalRenderCompiler().compile(project, nestedSequenceId, revision, {
            ...(options.resolveMaterialProgram === undefined
              ? {}
              : { resolveMaterialProgram: options.resolveMaterialProgram }),
            nestedSequenceStack: [...nestedSequenceStack, sequenceId],
          }).ir,
        ]),
      );
      const ir: RenderIr = {
        irVersion: '1.0.0',
        projectId: project.projectId,
        sequenceId,
        revision,
        width: number(format.width, 'format.width'),
        height: number(format.height, 'format.height'),
        frameRate: {
          numerator: number(frameRate.numerator, 'frameRate.numerator'),
          denominator: number(frameRate.denominator, 'frameRate.denominator'),
        },
        sampleRate: number(format.sampleRate, 'format.sampleRate'),
        channelLayout: string(format.channelLayout, 'format.channelLayout'),
        workingColorSpace: string(format.workingColorSpace, 'format.workingColorSpace'),
        colorPrimaries: enumValue(
          format.colorPrimaries,
          ['bt709', 'display-p3', 'bt2020'],
          format.workingColorSpace === 'display-p3-linear'
            ? 'display-p3'
            : format.workingColorSpace === 'rec2020-linear'
              ? 'bt2020'
              : 'bt709',
          'format.colorPrimaries',
        ),
        transferFunction: enumValue(
          format.transferFunction,
          ['srgb', 'gamma22', 'pq', 'hlg'],
          'srgb',
          'format.transferFunction',
        ),
        matrixCoefficients: enumValue(
          format.matrixCoefficients,
          ['rgb', 'bt709', 'bt2020-ncl'],
          'rgb',
          'format.matrixCoefficients',
        ),
        colorRange: enumValue(format.colorRange, ['full', 'limited'], 'full', 'format.colorRange'),
        chromaSubsampling: enumValue(
          format.chromaSubsampling,
          ['rgb', '4:4:4', '4:2:2', '4:2:0'],
          '4:4:4',
          'format.chromaSubsampling',
        ),
        alphaMode: enumValue(format.alphaMode, ['opaque', 'premultiplied'], 'premultiplied', 'format.alphaMode'),
        toneMapping: enumValue(format.toneMapping, ['none', 'bt2390', 'reinhard'], 'none', 'format.toneMapping'),
        bitDepth: format.bitDepth === 10 ? 10 : 8,
        backgroundColor: jsonObject(format.backgroundColor, 'format.backgroundColor'),
        durationUs:
          duration.mode === 'fixed'
            ? number(duration.durationUs, 'duration.durationUs')
            : Math.max(
                contentDuration(project, sequence.trackIds),
                ...transitions.map((value) => value.range.startUs + value.range.durationUs),
              ),
        tracks,
        transitions,
        materials,
        subgraphs,
      };
      const frozenIr = deepFreezePlain(ir) as RenderIr;
      const stats = deepFreezePlain({
        compiledClips,
        reusedClips,
        compiledTransitions,
        reusedTransitions,
        affectedRanges: (options.affectedRanges ?? []).map((range) => ({ ...range })),
      }) as RenderIrCompilation['stats'];
      this.#previous = frozenIr;
      return {
        ir: frozenIr,
        stats,
      };
    } finally {
      this.#compiling = false;
    }
  }
}
