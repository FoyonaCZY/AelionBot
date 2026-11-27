import type { JsonValue } from '@aelionsdk/core';

import { canonicalMaterialBytes, sha256Hex } from './canonical.js';
import type { MaterialDefinition, MaterialPackageReference } from './types.js';

export interface MaterialCompositionSlot {
  readonly id: string;
  readonly order: number;
  readonly enabled: boolean;
  readonly reference: MaterialPackageReference;
  readonly definition: MaterialDefinition;
  readonly parameters: Readonly<Record<string, JsonValue>>;
}

export interface MaterialFusionGroup {
  readonly slotIds: readonly string[];
  readonly fused: boolean;
  readonly barrierReason?: string;
}

export interface MaterialCompositionPlan {
  readonly slots: readonly MaterialCompositionSlot[];
  readonly fusionGroups: readonly MaterialFusionGroup[];
  readonly cacheKey: string;
  readonly qualityScale: number;
}

function fusionBarrier(slot: MaterialCompositionSlot): string | undefined {
  const { definition } = slot;
  if (definition.implementations.every((value) => value.type !== 'graph')) return 'native-code';
  if (definition.execution.temporal.stateful) return 'stateful';
  if (definition.execution.temporal.pastUs > 0 || definition.execution.temporal.futureUs > 0) {
    return 'temporal-neighborhood';
  }
  if (definition.execution.resolution.policy !== 'same-as-host') return 'resolution-change';
  if (definition.execution.spatialPadding.mode !== 'none') return 'spatial-padding';
  if (definition.execution.determinism === 'non-deterministic') return 'non-deterministic';
  return undefined;
}

function validateSlots(slots: readonly MaterialCompositionSlot[]): readonly MaterialCompositionSlot[] {
  if (slots.length > 64) throw new RangeError('Material composition supports at most 64 slots');
  const ids = new Set<string>();
  for (const slot of slots) {
    if (slot.id.length === 0 || ids.has(slot.id)) throw new TypeError('MATERIAL_SLOT_ID_INVALID');
    if (!Number.isSafeInteger(slot.order)) throw new RangeError('MATERIAL_SLOT_ORDER_INVALID');
    ids.add(slot.id);
  }
  return slots
    .filter((value) => value.enabled)
    .slice()
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

function buildFusionGroups(
  slots: readonly MaterialCompositionSlot[],
  maxFusedPasses: number,
): readonly MaterialFusionGroup[] {
  const groups: MaterialFusionGroup[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    groups.push({ slotIds: current, fused: current.length > 1 });
    current = [];
  };
  for (const slot of slots) {
    const barrier = fusionBarrier(slot);
    if (barrier !== undefined) {
      flush();
      groups.push({ slotIds: [slot.id], fused: false, barrierReason: barrier });
      continue;
    }
    if (current.length >= maxFusedPasses) flush();
    current.push(slot.id);
  }
  flush();
  return groups;
}

function canonicalParameters(parameters: Readonly<Record<string, JsonValue>>): JsonValue {
  return Object.fromEntries(Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right)));
}

export async function createMaterialCompositionPlan(
  slots: readonly MaterialCompositionSlot[],
  options: {
    readonly qualityScale?: number;
    readonly outputWidth: number;
    readonly outputHeight: number;
    readonly workingColorSpace: string;
    readonly maxFusedPasses?: number;
  },
): Promise<MaterialCompositionPlan> {
  const ordered = validateSlots(slots);
  const qualityScale = options.qualityScale ?? 1;
  const maxFusedPasses = options.maxFusedPasses ?? 8;
  if (!(qualityScale > 0 && qualityScale <= 1)) throw new RangeError('QUALITY_SCALE_INVALID');
  if (!Number.isSafeInteger(maxFusedPasses) || maxFusedPasses <= 0 || maxFusedPasses > 16) {
    throw new RangeError('MAX_FUSED_PASSES_INVALID');
  }
  if (
    !Number.isSafeInteger(options.outputWidth) ||
    !Number.isSafeInteger(options.outputHeight) ||
    options.outputWidth <= 0 ||
    options.outputHeight <= 0
  ) {
    throw new RangeError('MATERIAL_OUTPUT_SIZE_INVALID');
  }
  const fusionGroups = buildFusionGroups(ordered, maxFusedPasses);
  const keyValue: JsonValue = {
    protocol: 'aelion-material-composition/1',
    output: {
      width: options.outputWidth,
      height: options.outputHeight,
      workingColorSpace: options.workingColorSpace,
      qualityScale,
    },
    slots: ordered.map((slot) => ({
      id: slot.id,
      packageId: slot.reference.packageId,
      packageVersion: slot.reference.packageVersion,
      packageIntegrity: slot.reference.packageIntegrity,
      materialId: slot.reference.materialId,
      parameters: canonicalParameters(slot.parameters),
    })),
    fusionGroups: fusionGroups.map((group) => ({
      slotIds: [...group.slotIds],
      fused: group.fused,
      ...(group.barrierReason === undefined ? {} : { barrierReason: group.barrierReason }),
    })),
  };
  return {
    slots: ordered,
    fusionGroups,
    cacheKey: `sha256:${await sha256Hex(canonicalMaterialBytes(keyValue))}`,
    qualityScale,
  };
}

export interface AdaptiveMaterialQualityOptions {
  readonly targetFrameMs: number;
  readonly levels?: readonly number[];
  readonly recoveryFrames?: number;
}

/** Hysteresis controller for preview quality; offline rendering should always use scale 1. */
export class AdaptiveMaterialQualityController {
  readonly #targetFrameMs: number;
  readonly #levels: readonly number[];
  readonly #recoveryFrames: number;
  #levelIndex = 0;
  #averageFrameMs = 0;
  #samples = 0;
  #underBudgetFrames = 0;

  public constructor(options: AdaptiveMaterialQualityOptions) {
    if (!Number.isFinite(options.targetFrameMs) || options.targetFrameMs <= 0) {
      throw new RangeError('TARGET_FRAME_TIME_INVALID');
    }
    const levels = [...(options.levels ?? [1, 0.75, 0.5, 0.25])];
    const invalidLevel = levels.some((value, index) => {
      const previous = levels[index - 1];
      return !(value > 0 && value <= 1) || (previous !== undefined && value >= previous);
    });
    if (levels.length === 0 || invalidLevel) {
      throw new RangeError('QUALITY_LEVELS_INVALID');
    }
    const recoveryFrames = options.recoveryFrames ?? 30;
    if (!Number.isSafeInteger(recoveryFrames) || recoveryFrames <= 0) {
      throw new RangeError('RECOVERY_FRAMES_INVALID');
    }
    this.#targetFrameMs = options.targetFrameMs;
    this.#levels = levels;
    this.#recoveryFrames = recoveryFrames;
  }

  public get qualityScale(): number {
    const value = this.#levels[this.#levelIndex];
    if (value === undefined) throw new RangeError('QUALITY_LEVELS_INVALID');
    return value;
  }

  public reportFrame(frameMs: number): number {
    if (!Number.isFinite(frameMs) || frameMs < 0) throw new RangeError('FRAME_TIME_INVALID');
    this.#averageFrameMs = this.#samples === 0 ? frameMs : this.#averageFrameMs * 0.8 + frameMs * 0.2;
    this.#samples++;
    if (this.#averageFrameMs > this.#targetFrameMs * 1.1) {
      this.#levelIndex = Math.min(this.#levelIndex + 1, this.#levels.length - 1);
      this.#underBudgetFrames = 0;
    } else if (this.#averageFrameMs < this.#targetFrameMs * 0.75) {
      this.#underBudgetFrames++;
      if (this.#underBudgetFrames >= this.#recoveryFrames) {
        this.#levelIndex = Math.max(0, this.#levelIndex - 1);
        this.#underBudgetFrames = 0;
      }
    } else {
      this.#underBudgetFrames = 0;
    }
    return this.qualityScale;
  }

  public reset(): void {
    this.#levelIndex = 0;
    this.#averageFrameMs = 0;
    this.#samples = 0;
    this.#underBudgetFrames = 0;
  }
}
