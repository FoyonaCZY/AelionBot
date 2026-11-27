import type { Diagnostic, JsonObject, JsonValue } from '@aelionsdk/core';

export type MaterialValueType = 'float' | 'enum' | 'visual-frame';

export type GraphBinding =
  | { readonly value: JsonValue }
  | { readonly parameter: string }
  | { readonly inputPort: string }
  | { readonly node: string; readonly output: string }
  | { readonly system: string }
  | { readonly resource: string };

export interface MaterialGraphNode extends JsonObject {
  id: string;
  type: string;
  typeVersion: string;
  inputs: Record<string, GraphBinding>;
}

export interface MaterialGraph extends JsonObject {
  $schema: string;
  graphVersion: string;
  nodeSet: string;
  nodes: MaterialGraphNode[];
  outputs: Record<string, { readonly node: string; readonly output: string }>;
}

export interface MaterialNodeDefinition {
  readonly type: string;
  readonly version: string;
  readonly inputs: Readonly<Record<string, MaterialValueType>>;
  readonly outputs: Readonly<Record<string, MaterialValueType>>;
  readonly estimatedTextureSamples: number;
  readonly estimatedPasses: number;
}

export interface ExecutableMaterialNode {
  readonly id: string;
  readonly type: string;
  readonly typeVersion: string;
  readonly inputs: Readonly<Record<string, GraphBinding>>;
}

export interface MaterialUniformBinding {
  readonly name: string;
  readonly type: 'float';
  readonly source:
    { readonly kind: 'parameter'; readonly id: string } | { readonly kind: 'system'; readonly id: string };
}

export interface WebGl2MaterialProgram {
  readonly backend: 'webgl2';
  readonly nodeSet: string;
  readonly graphHash: string;
  readonly inputPorts: readonly string[];
  readonly uniforms: readonly MaterialUniformBinding[];
  readonly fragmentShader: string;
  readonly webgpu?: WebGpuMaterialProgram;
  readonly executionPlan: MaterialExecutionPlan;
  readonly passes?: readonly WebGl2MaterialPass[];
}

export interface WebGl2MaterialPassInput {
  readonly sampler: string;
  readonly source:
    { readonly kind: 'external'; readonly port: string } | { readonly kind: 'pass'; readonly passId: string };
}

export interface WebGl2MaterialPass {
  readonly id: string;
  readonly inputs: readonly WebGl2MaterialPassInput[];
  readonly uniforms: readonly MaterialUniformBinding[];
  readonly fragmentShader: string;
}

export interface WebGpuMaterialProgram {
  readonly backend: 'webgpu';
  readonly nodeSet: string;
  readonly graphHash: string;
  readonly inputPorts: readonly string[];
  readonly uniforms: readonly MaterialUniformBinding[];
  readonly shader: string;
  readonly executionPlan: MaterialExecutionPlan;
}

export interface MaterialExecutionPass {
  readonly id: string;
  readonly kind: 'draw' | 'blur-horizontal' | 'blur-vertical';
  readonly nodes: readonly string[];
  readonly estimatedTextureSamples: number;
}

export interface MaterialExecutionPlan {
  readonly passes: readonly MaterialExecutionPass[];
  readonly intermediateTextureCount: number;
}

export interface MaterialGraphBudget {
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly maxPasses: number;
  readonly maxTextureSamples: number;
}

export interface CompiledMaterialGraph {
  readonly nodeSet: string;
  readonly order: readonly string[];
  readonly depth: number;
  readonly estimatedPasses: number;
  readonly estimatedTextureSamples: number;
  readonly executableNodes: readonly ExecutableMaterialNode[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface CompileMaterialOptions {
  readonly parameters: Readonly<Record<string, MaterialValueType>>;
  /** Values for parameters whose Definition declares `affects: specialization`. */
  readonly specializationValues?: Readonly<Record<string, JsonValue>>;
  readonly inputPorts: Readonly<Record<string, MaterialValueType>>;
  readonly systems?: Readonly<Record<string, MaterialValueType>>;
  readonly budget?: Partial<MaterialGraphBudget>;
}

export interface MaterialParameterDefinition {
  readonly id: string;
  readonly type: 'boolean' | 'integer' | 'float' | 'enum' | 'string';
  readonly default: JsonValue;
  readonly range?: { readonly min?: number; readonly max?: number };
  readonly values?: readonly string[];
  readonly animatable: boolean;
}

export interface MaterialPortDefinition {
  readonly id: string;
  readonly direction: 'input' | 'output';
  readonly type: 'visual-frame' | 'mask' | 'depth' | 'motion-vectors';
  readonly binding: 'host' | 'instance';
  readonly required: boolean;
}

export interface MaterialResourceSlotDefinition {
  readonly id: string;
  readonly required: boolean;
  readonly fallbackResourceId?: string;
}

export type MaterialImplementationDescriptor =
  | { readonly type: 'graph' }
  | { readonly type: 'shader'; readonly backend: 'webgpu' | 'webgl2' }
  | { readonly type: 'wasm' };

export interface RuntimeMaterialDefinition {
  readonly parameters: readonly MaterialParameterDefinition[];
  readonly ports: readonly MaterialPortDefinition[];
  readonly resourceSlots: readonly MaterialResourceSlotDefinition[];
  readonly implementations: readonly MaterialImplementationDescriptor[];
}

export interface MaterialInstanceValue {
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly resourceBindings?: Readonly<Record<string, JsonValue>>;
  readonly inputBindings?: Readonly<Record<string, JsonValue>>;
}

export interface MaterialRuntimeSelectionOptions {
  readonly backend: 'webgpu' | 'webgl2' | 'cpu';
  readonly trust: 'declarative' | 'trusted-code';
  readonly trustedCodeAuthorized?: boolean;
}
