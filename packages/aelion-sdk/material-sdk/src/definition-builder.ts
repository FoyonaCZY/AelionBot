import type { JsonValue } from '@aelionsdk/core';

import {
  MATERIAL_DEFINITION_SCHEMA,
  MATERIAL_NODE_SET,
  MATERIAL_PROTOCOL_VERSION,
  type AuthoredMaterial,
  type BundledMaterialResource,
  type MaterialDefinition,
  type MaterialDisplay,
  type MaterialExecutionContract,
  type MaterialImplementation,
  type MaterialKind,
  type MaterialParameter,
  type MaterialPort,
  type MaterialResourceSlot,
  type MaterialScope,
} from './types.js';
import type { MaterialGraph } from '@aelionsdk/material-compiler';

export interface MaterialDefinitionBuilderOptions {
  readonly id: string;
  readonly kind: MaterialKind;
  readonly display: MaterialDisplay;
  readonly scopes?: readonly MaterialScope[];
}

const DEFAULT_EXECUTION: MaterialExecutionContract = {
  color: { input: 'working-linear', output: 'working-linear' },
  alpha: {
    input: 'premultiplied',
    output: 'premultiplied',
    preservesTransparency: true,
  },
  resolution: { policy: 'same-as-host' },
  spatialPadding: { mode: 'none' },
  temporal: { pastUs: 0, futureUs: 0, stateful: false, seekPolicy: 'stateless' },
  determinism: 'strict',
  supports: { realtime: true, offline: true, alpha: true, hdr: false, tiled: true },
};

function hostPort(id: string, direction: 'input' | 'output', role: 'source' | 'from' | 'to' | 'result'): MaterialPort {
  return { id, direction, type: 'visual-frame', role, binding: 'host', required: true };
}

function defaultPorts(kind: MaterialKind): MaterialPort[] {
  switch (kind) {
    case 'visual-filter':
      return [hostPort('source', 'input', 'source'), hostPort('result', 'output', 'result')];
    case 'visual-transition':
      return [hostPort('from', 'input', 'from'), hostPort('to', 'input', 'to'), hostPort('result', 'output', 'result')];
    case 'visual-generator':
      return [hostPort('result', 'output', 'result')];
    case 'visual-effect':
      return [hostPort('source', 'input', 'source'), hostPort('result', 'output', 'result')];
  }
}

function defaultScopes(kind: MaterialKind): MaterialScope[] {
  return kind === 'visual-transition'
    ? ['transition']
    : kind === 'visual-generator'
      ? ['item']
      : ['source', 'item', 'track', 'sequence'];
}

export class MaterialDefinitionBuilder {
  readonly #options: MaterialDefinitionBuilderOptions;
  readonly #ports: MaterialPort[];
  readonly #parameters: MaterialParameter[] = [];
  readonly #bundledResources: BundledMaterialResource[] = [];
  readonly #resourceSlots: MaterialResourceSlot[] = [];
  readonly #implementations: MaterialImplementation[] = [];
  #execution: MaterialExecutionContract = DEFAULT_EXECUTION;
  #splitPolicy: MaterialDefinition['splitPolicy'] = 'copy';
  #graph: MaterialGraph | undefined;
  #graphPath: string | undefined;

  constructor(options: MaterialDefinitionBuilderOptions) {
    this.#options = options;
    this.#ports = defaultPorts(options.kind);
  }

  port(port: MaterialPort): this {
    this.#ports.push(port);
    return this;
  }

  parameter(parameter: MaterialParameter): this {
    this.#parameters.push(parameter);
    return this;
  }

  floatParameter(
    id: string,
    options: {
      readonly default: number;
      readonly min?: number;
      readonly max?: number;
      readonly step?: number;
      readonly label?: string;
      readonly group?: string;
      readonly order?: number;
      readonly unit?: MaterialParameter['unit'];
      readonly animatable?: boolean;
      readonly affects?: MaterialParameter['affects'];
    },
  ): this {
    const range =
      options.min === undefined && options.max === undefined && options.step === undefined
        ? undefined
        : {
            ...(options.min === undefined ? {} : { min: options.min, softMin: options.min }),
            ...(options.max === undefined ? {} : { max: options.max, softMax: options.max }),
            ...(options.step === undefined ? {} : { step: options.step }),
          };
    return this.parameter({
      id,
      type: 'float',
      default: options.default,
      ...(range === undefined ? {} : { range }),
      ...(options.unit === undefined ? {} : { unit: options.unit }),
      animatable: options.animatable ?? true,
      interpolation: 'linear',
      affects: options.affects ?? 'uniform',
      ui: {
        control: 'slider',
        group: options.group ?? 'main',
        order: options.order ?? this.#parameters.length,
        label: options.label ?? id,
      },
    });
  }

  enumParameter(
    id: string,
    options: {
      readonly default: string;
      readonly values: readonly string[];
      readonly label?: string;
      readonly group?: string;
      readonly order?: number;
      readonly affects?: MaterialParameter['affects'];
    },
  ): this {
    return this.parameter({
      id,
      type: 'enum',
      default: options.default,
      values: options.values,
      animatable: false,
      interpolation: 'hold',
      affects: options.affects ?? 'specialization',
      ui: {
        control: 'select',
        group: options.group ?? 'main',
        order: options.order ?? this.#parameters.length,
        label: options.label ?? id,
      },
    });
  }

  bundledResource(resource: BundledMaterialResource): this {
    this.#bundledResources.push(resource);
    return this;
  }

  resourceSlot(resource: MaterialResourceSlot): this {
    this.#resourceSlots.push(resource);
    return this;
  }

  graph(path: string, graph: MaterialGraph): this {
    this.#graphPath = path;
    this.#graph = graph;
    this.#implementations.push({ type: 'graph', graph: path, nodeSet: MATERIAL_NODE_SET });
    return this;
  }

  /** Adds trusted executable code. The package still requires explicit host authorization. */
  trustedImplementation(implementation: Exclude<MaterialImplementation, { type: 'graph' }>): this {
    this.#implementations.push(implementation);
    return this;
  }

  execution(contract: MaterialExecutionContract): this {
    this.#execution = contract;
    return this;
  }

  splitPolicy(policy: MaterialDefinition['splitPolicy']): this {
    this.#splitPolicy = policy;
    return this;
  }

  build(): AuthoredMaterial {
    const definition: MaterialDefinition = {
      $schema: MATERIAL_DEFINITION_SCHEMA,
      protocolVersion: MATERIAL_PROTOCOL_VERSION,
      id: this.#options.id,
      kind: this.#options.kind,
      display: this.#options.display,
      scopes: this.#options.scopes ?? defaultScopes(this.#options.kind),
      ports: [...this.#ports],
      parameters: [...this.#parameters],
      bundledResources: [...this.#bundledResources],
      resourceSlots: [...this.#resourceSlots],
      execution: this.#execution,
      implementations: [...this.#implementations],
      splitPolicy: this.#splitPolicy,
    };
    return {
      definition,
      ...(this.#graph === undefined ? {} : { graph: this.#graph }),
      definitionPath: `materials/${this.#options.id}.material.json`,
      ...(this.#graphPath === undefined ? {} : { graphPath: this.#graphPath }),
    };
  }
}

export function materialDefinition(options: MaterialDefinitionBuilderOptions): MaterialDefinitionBuilder {
  return new MaterialDefinitionBuilder(options);
}

// Allows callers to keep fully custom parameter defaults strongly JSON typed.
export type MaterialParameterDefault = JsonValue;
