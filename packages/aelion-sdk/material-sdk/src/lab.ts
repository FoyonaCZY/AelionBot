import type { Diagnostic, JsonValue } from '@aelionsdk/core';
import {
  compileMaterialGraph,
  compileMaterialGraphToWebGl2,
  compileMaterialGraphToWebGpu,
  type CompileMaterialOptions,
  type MaterialExecutionPlan,
} from '@aelionsdk/material-compiler';

import { packMaterialPackage } from './package.js';
import type { AuthoredMaterial, MaterialPackageFile, MaterialPackageMetadata, PackedMaterialPackage } from './types.js';
import { validateAuthoredMaterial } from './validation.js';

export interface MaterialLabBudgetReport {
  readonly nodes: number;
  readonly depth: number;
  readonly passes: number;
  readonly textureSamples: number;
  readonly intermediateTextures: number;
}

export interface MaterialLabBackendReport {
  readonly available: boolean;
  readonly graphHash?: string;
  readonly executionPlan?: MaterialExecutionPlan;
  readonly error?: string;
}

export interface MaterialLabReport {
  readonly timeUs: number;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly inputs: Readonly<Record<string, JsonValue>>;
  readonly diagnostics: readonly Diagnostic[];
  readonly budget: MaterialLabBudgetReport;
  readonly webgl2: MaterialLabBackendReport;
  readonly webgpu: MaterialLabBackendReport;
  readonly gpuTimingsUs: readonly number[];
}

export interface MaterialGoldenDiff {
  readonly passed: boolean;
  readonly comparedValues: number;
  readonly differingValues: number;
  readonly maximumError: number;
  readonly meanError: number;
}

function compilerType(type: string): 'float' | 'enum' | undefined {
  return ['float', 'integer', 'angle', 'duration'].includes(type) ? 'float' : type === 'enum' ? 'enum' : undefined;
}

function compileOptions(authored: AuthoredMaterial): CompileMaterialOptions {
  return {
    parameters: Object.fromEntries(
      authored.definition.parameters.flatMap((parameter) => {
        const type = compilerType(parameter.type);
        return type === undefined ? [] : [[parameter.id, type]];
      }),
    ),
    inputPorts: Object.fromEntries(
      authored.definition.ports
        .filter((port) => port.direction === 'input' && port.type === 'visual-frame')
        .map((port) => [port.id, 'visual-frame' as const]),
    ),
    systems: {
      sequenceTimeUs: 'float',
      itemTimeUs: 'float',
      itemDurationUs: 'float',
      normalizedItemTime: 'float',
      transitionProgress: 'float',
      frameIndex: 'float',
      frameDurationUs: 'float',
      qualityScale: 'float',
      randomSeed: 'float',
    },
    specializationValues: Object.fromEntries(
      authored.definition.parameters
        .filter((parameter) => parameter.affects === 'specialization')
        .map((parameter) => [parameter.id, parameter.default]),
    ),
  };
}

function backendReport(
  operation: () => {
    readonly graphHash: string;
    readonly executionPlan: MaterialExecutionPlan;
  },
): MaterialLabBackendReport {
  try {
    const value = operation();
    return { available: true, graphHash: value.graphHash, executionPlan: value.executionPlan };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : 'Backend failed' };
  }
}

function validParameterValue(type: string, value: JsonValue): boolean {
  if (type === 'boolean') return typeof value === 'boolean';
  if (['integer', 'duration'].includes(type)) return typeof value === 'number' && Number.isSafeInteger(value);
  if (['float', 'angle'].includes(type)) return typeof value === 'number' && Number.isFinite(value);
  if (type === 'enum' || type === 'string') return typeof value === 'string';
  return value !== null;
}

/** Headless Material Lab model shared by UI, CI and package authoring tools. */
export class MaterialLabSession {
  readonly #authored: AuthoredMaterial;
  readonly #parameters: Record<string, JsonValue>;
  readonly #inputs: Record<string, JsonValue> = {};
  readonly #gpuTimingsUs: number[] = [];
  #timeUs = 0;

  public constructor(authored: AuthoredMaterial) {
    this.#authored = structuredClone(authored);
    this.#parameters = Object.fromEntries(
      authored.definition.parameters.map((parameter) => [parameter.id, structuredClone(parameter.default)]),
    );
  }

  public setTime(timeUs: number): void {
    if (!Number.isSafeInteger(timeUs) || timeUs < 0) throw new RangeError('MATERIAL_LAB_TIME_INVALID');
    this.#timeUs = timeUs;
  }

  public setParameter(id: string, value: JsonValue): void {
    const definition = this.#authored.definition.parameters.find((parameter) => parameter.id === id);
    if (definition === undefined) throw new ReferenceError(`MATERIAL_LAB_PARAMETER_MISSING: ${id}`);
    if (!validParameterValue(definition.type, value)) {
      throw new TypeError(`MATERIAL_LAB_PARAMETER_TYPE_INVALID: ${id}`);
    }
    if (
      typeof value === 'number' &&
      ((definition.range?.min !== undefined && value < definition.range.min) ||
        (definition.range?.max !== undefined && value > definition.range.max))
    ) {
      throw new RangeError(`MATERIAL_LAB_PARAMETER_RANGE_INVALID: ${id}`);
    }
    this.#parameters[id] = structuredClone(value);
  }

  public setInput(id: string, descriptor: JsonValue): void {
    const port = this.#authored.definition.ports.find((value) => value.id === id && value.direction === 'input');
    if (port === undefined) throw new ReferenceError(`MATERIAL_LAB_INPUT_MISSING: ${id}`);
    this.#inputs[id] = structuredClone(descriptor);
  }

  public recordGpuTiming(totalUs: number): void {
    if (!Number.isSafeInteger(totalUs) || totalUs < 0) throw new RangeError('GPU_TIMING_INVALID');
    this.#gpuTimingsUs.push(totalUs);
    if (this.#gpuTimingsUs.length > 256) this.#gpuTimingsUs.shift();
  }

  public analyze(options: { readonly budget?: CompileMaterialOptions['budget'] } = {}): MaterialLabReport {
    const validation = validateAuthoredMaterial(this.#authored, options);
    const graph = this.#authored.graph;
    if (graph === undefined) {
      return {
        timeUs: this.#timeUs,
        parameters: structuredClone(this.#parameters),
        inputs: structuredClone(this.#inputs),
        diagnostics: validation.diagnostics,
        budget: { nodes: 0, depth: 0, passes: 0, textureSamples: 0, intermediateTextures: 0 },
        webgl2: { available: false, error: 'Material has no graph implementation' },
        webgpu: { available: false, error: 'Material has no graph implementation' },
        gpuTimingsUs: [...this.#gpuTimingsUs],
      };
    }
    const compile = {
      ...compileOptions(this.#authored),
      ...(options.budget === undefined ? {} : { budget: options.budget }),
    };
    const analysis = compileMaterialGraph(graph, compile);
    const webgl2 = backendReport(() => compileMaterialGraphToWebGl2(graph, compile));
    const webgpu = backendReport(() => compileMaterialGraphToWebGpu(graph, compile));
    const plan = webgl2.executionPlan ?? webgpu.executionPlan;
    return {
      timeUs: this.#timeUs,
      parameters: structuredClone(this.#parameters),
      inputs: structuredClone(this.#inputs),
      diagnostics: [...validation.diagnostics, ...analysis.diagnostics],
      budget: {
        nodes: analysis.order.length,
        depth: analysis.depth,
        passes: plan?.passes.length ?? analysis.estimatedPasses,
        textureSamples: analysis.estimatedTextureSamples,
        intermediateTextures: plan?.intermediateTextureCount ?? 0,
      },
      webgl2,
      webgpu,
      gpuTimingsUs: [...this.#gpuTimingsUs],
    };
  }

  public exportPackage(
    metadata: MaterialPackageMetadata,
    files: readonly MaterialPackageFile[] = [],
  ): Promise<PackedMaterialPackage> {
    return packMaterialPackage({ metadata, materials: [this.#authored], files });
  }
}

export function compareMaterialGolden(
  actual: Uint8Array | Uint8ClampedArray,
  expected: Uint8Array | Uint8ClampedArray,
  tolerance = 2,
): MaterialGoldenDiff {
  if (actual.length !== expected.length) throw new RangeError('MATERIAL_GOLDEN_SIZE_MISMATCH');
  if (!Number.isSafeInteger(tolerance) || tolerance < 0 || tolerance > 255) {
    throw new RangeError('MATERIAL_GOLDEN_TOLERANCE_INVALID');
  }
  let differingValues = 0;
  let maximumError = 0;
  let totalError = 0;
  for (let index = 0; index < actual.length; index++) {
    const error = Math.abs((actual[index] ?? 0) - (expected[index] ?? 0));
    if (error > tolerance) differingValues++;
    maximumError = Math.max(maximumError, error);
    totalError += error;
  }
  return {
    passed: differingValues === 0,
    comparedValues: actual.length,
    differingValues,
    maximumError,
    meanError: actual.length === 0 ? 0 : totalError / actual.length,
  };
}
