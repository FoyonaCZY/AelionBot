import type { Diagnostic, JsonValue } from '@aelionsdk/core';

import { VISUAL_NODE_SET_1 } from './node-registry.js';
import type {
  CompileMaterialOptions,
  CompiledMaterialGraph,
  GraphBinding,
  MaterialGraph,
  MaterialGraphBudget,
  MaterialImplementationDescriptor,
  MaterialValueType,
  MaterialExecutionPlan,
  MaterialInstanceValue,
  MaterialRuntimeSelectionOptions,
  RuntimeMaterialDefinition,
} from './types.js';

const DEFAULT_BUDGET: MaterialGraphBudget = {
  maxNodes: 128,
  maxDepth: 32,
  maxPasses: 8,
  maxTextureSamples: 256,
};

function issue(diagnostics: Diagnostic[], code: string, message: string, path: readonly (string | number)[]): void {
  diagnostics.push({
    code,
    severity: 'error',
    message,
    path,
    recoverable: false,
  });
}

function literalType(value: unknown): MaterialValueType | undefined {
  return typeof value === 'number' ? 'float' : typeof value === 'string' ? 'enum' : undefined;
}

function bindingType(
  binding: GraphBinding,
  options: CompileMaterialOptions,
  outputTypes: ReadonlyMap<string, Readonly<Record<string, MaterialValueType>>>,
  diagnostics: Diagnostic[],
  path: readonly (string | number)[],
): MaterialValueType | undefined {
  if ('value' in binding) {
    const type = literalType(binding.value);
    if (type === undefined) {
      issue(diagnostics, 'MATERIAL_GRAPH_LITERAL_TYPE_INVALID', 'Unsupported literal type', path);
    }
    return type;
  }
  if ('parameter' in binding) {
    const type = options.parameters[binding.parameter];
    if (type === undefined) {
      issue(diagnostics, 'MATERIAL_GRAPH_PARAMETER_MISSING', `Unknown parameter ${binding.parameter}`, path);
    }
    return type;
  }
  if ('inputPort' in binding) {
    const type = options.inputPorts[binding.inputPort];
    if (type === undefined) {
      issue(diagnostics, 'MATERIAL_GRAPH_PORT_MISSING', `Unknown input port ${binding.inputPort}`, path);
    }
    return type;
  }
  if ('system' in binding) {
    const type = (options.systems ?? { transitionProgress: 'float' })[binding.system];
    if (type === undefined) {
      issue(diagnostics, 'MATERIAL_GRAPH_SYSTEM_MISSING', `Unknown system value ${binding.system}`, path);
    }
    return type;
  }
  if ('node' in binding) {
    const type = outputTypes.get(binding.node)?.[binding.output];
    if (type === undefined) {
      issue(
        diagnostics,
        'MATERIAL_GRAPH_OUTPUT_MISSING',
        `Unknown node output ${binding.node}.${binding.output}`,
        path,
      );
    }
    return type;
  }
  issue(diagnostics, 'MATERIAL_GRAPH_RESOURCE_UNTYPED', 'Resource bindings require an explicit typed node', path);
  return undefined;
}

export function compileMaterialGraph(graph: MaterialGraph, options: CompileMaterialOptions): CompiledMaterialGraph {
  const diagnostics: Diagnostic[] = [];
  const budget = { ...DEFAULT_BUDGET, ...options.budget };
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  if (nodeById.size !== graph.nodes.length) {
    issue(diagnostics, 'MATERIAL_GRAPH_DUPLICATE_NODE', 'Node IDs must be unique', ['nodes']);
  }
  if (graph.nodes.length > budget.maxNodes) {
    issue(
      diagnostics,
      'MATERIAL_BUDGET_EXCEEDED',
      `Graph has ${graph.nodes.length} nodes; limit is ${budget.maxNodes}`,
      ['nodes'],
    );
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const order: string[] = [];
  const depths = new Map<string, number>();

  const visit = (id: string): number => {
    if (visiting.has(id)) {
      issue(diagnostics, 'MATERIAL_DEPENDENCY_CYCLE', `Graph cycle includes ${id}`, ['nodes']);
      return 0;
    }
    if (visited.has(id)) return depths.get(id) ?? 0;
    const node = nodeById.get(id);
    if (node === undefined) return 0;
    visiting.add(id);
    let depth = 1;
    for (const binding of Object.values(node.inputs)) {
      if ('node' in binding) {
        if (!nodeById.has(binding.node)) {
          issue(diagnostics, 'MATERIAL_GRAPH_NODE_MISSING', `Node ${id} references missing node ${binding.node}`, [
            'nodes',
            id,
            'inputs',
          ]);
        } else {
          depth = Math.max(depth, visit(binding.node) + 1);
        }
      }
    }
    visiting.delete(id);
    visited.add(id);
    depths.set(id, depth);
    order.push(id);
    return depth;
  };

  graph.nodes.forEach((node) => visit(node.id));
  const depth = Math.max(0, ...depths.values());
  if (depth > budget.maxDepth) {
    issue(diagnostics, 'MATERIAL_BUDGET_EXCEEDED', `Graph depth ${depth} exceeds limit ${budget.maxDepth}`, ['nodes']);
  }

  const outputTypes = new Map<string, Readonly<Record<string, MaterialValueType>>>();
  let estimatedPasses = 0;
  let estimatedTextureSamples = 0;
  for (const id of order) {
    const node = nodeById.get(id);
    if (node === undefined) continue;
    const definition = VISUAL_NODE_SET_1.get(`${node.type}@${node.typeVersion}`);
    if (definition === undefined) {
      issue(diagnostics, 'MATERIAL_NODE_UNSUPPORTED', `Unsupported node ${node.type}@${node.typeVersion}`, [
        'nodes',
        id,
        'type',
      ]);
      continue;
    }
    for (const [inputName, expectedType] of Object.entries(definition.inputs)) {
      const binding = node.inputs[inputName];
      if (binding === undefined) {
        issue(diagnostics, 'MATERIAL_GRAPH_INPUT_MISSING', `Node ${id} is missing input ${inputName}`, [
          'nodes',
          id,
          'inputs',
          inputName,
        ]);
        continue;
      }
      const actualType = bindingType(binding, options, outputTypes, diagnostics, ['nodes', id, 'inputs', inputName]);
      if (actualType !== undefined && actualType !== expectedType) {
        issue(
          diagnostics,
          'MATERIAL_GRAPH_TYPE_MISMATCH',
          `Node ${id} input ${inputName} expects ${expectedType}, received ${actualType}`,
          ['nodes', id, 'inputs', inputName],
        );
      }
    }
    for (const inputName of Object.keys(node.inputs)) {
      if (!(inputName in definition.inputs)) {
        issue(diagnostics, 'MATERIAL_GRAPH_INPUT_UNKNOWN', `Node ${id} has unknown input ${inputName}`, [
          'nodes',
          id,
          'inputs',
          inputName,
        ]);
      }
    }
    outputTypes.set(id, definition.outputs);
    estimatedPasses += definition.estimatedPasses;
    estimatedTextureSamples += definition.estimatedTextureSamples;
  }

  for (const [name, output] of Object.entries(graph.outputs)) {
    const type = outputTypes.get(output.node)?.[output.output];
    if (type !== 'visual-frame') {
      issue(diagnostics, 'MATERIAL_GRAPH_OUTPUT_INVALID', `Graph output ${name} must resolve to visual-frame`, [
        'outputs',
        name,
      ]);
    }
  }
  if (estimatedPasses > budget.maxPasses || estimatedTextureSamples > budget.maxTextureSamples) {
    issue(diagnostics, 'MATERIAL_BUDGET_EXCEEDED', 'Graph static execution budget exceeds host limits', ['nodes']);
  }

  return {
    nodeSet: graph.nodeSet,
    order,
    depth,
    estimatedPasses,
    estimatedTextureSamples,
    executableNodes: order.flatMap((id) => {
      const node = nodeById.get(id);
      return node === undefined
        ? []
        : [
            {
              id: node.id,
              type: node.type,
              typeVersion: node.typeVersion,
              inputs: node.inputs,
            },
          ];
    }),
    diagnostics,
  };
}

export function buildMaterialExecutionPlan(
  graph: MaterialGraph,
  compiled: CompiledMaterialGraph,
): MaterialExecutionPlan {
  const passes: MaterialExecutionPlan['passes'][number][] = [];
  let pendingFusedNodes: string[] = [];
  const flushFused = (ownerId: string, samples: number): void => {
    if (pendingFusedNodes.length === 0) return;
    passes.push({
      id: `${ownerId}:draw`,
      kind: 'draw',
      nodes: pendingFusedNodes,
      estimatedTextureSamples: Math.max(1, samples),
    });
    pendingFusedNodes = [];
  };
  for (const id of compiled.order) {
    const node = graph.nodes.find((value) => value.id === id);
    const definition = node === undefined ? undefined : VISUAL_NODE_SET_1.get(`${node.type}@${node.typeVersion}`);
    if (node?.type === 'blur.gaussian') {
      flushFused(id, 1);
      passes.push(
        {
          id: `${id}:horizontal`,
          kind: 'blur-horizontal',
          nodes: [id],
          estimatedTextureSamples: 8,
        },
        {
          id: `${id}:vertical`,
          kind: 'blur-vertical',
          nodes: [id],
          estimatedTextureSamples: 8,
        },
      );
      continue;
    }
    pendingFusedNodes.push(id);
    if ((definition?.estimatedPasses ?? 0) > 0) {
      flushFused(id, definition?.estimatedTextureSamples ?? 1);
    }
  }
  flushFused('output', 1);
  return { passes, intermediateTextureCount: Math.max(0, passes.length - 1) };
}

function runtimeIssue(
  diagnostics: Diagnostic[],
  code: string,
  message: string,
  path: readonly (string | number)[],
): void {
  issue(diagnostics, code, message, path);
}

function staticValue(value: JsonValue): JsonValue {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const animation = Reflect.get(value, 'animation');
    if (animation !== null && typeof animation === 'object') {
      const keyframes: unknown = Reflect.get(animation, 'keyframes');
      if (Array.isArray(keyframes)) {
        const first: unknown = keyframes[0];
        return first !== null && typeof first === 'object'
          ? ((Reflect.get(first, 'value') as JsonValue | undefined) ?? null)
          : null;
      }
    }
  }
  return value;
}

export function validateMaterialInstance(
  definition: RuntimeMaterialDefinition,
  instance: MaterialInstanceValue,
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const parameters = new Map(definition.parameters.map((value) => [value.id, value]));
  for (const [id, source] of Object.entries(instance.parameters)) {
    const parameter = parameters.get(id);
    if (parameter === undefined) {
      runtimeIssue(diagnostics, 'MATERIAL_INSTANCE_INVALID', `Unknown parameter ${id}`, ['parameters', id]);
      continue;
    }
    const value = staticValue(source);
    const numeric = parameter.type === 'float' || parameter.type === 'integer';
    if (numeric && (typeof value !== 'number' || !Number.isFinite(value))) {
      runtimeIssue(diagnostics, 'MATERIAL_INSTANCE_INVALID', `Parameter ${id} must be finite`, ['parameters', id]);
      continue;
    }
    if (parameter.type === 'integer' && !Number.isSafeInteger(value)) {
      runtimeIssue(diagnostics, 'MATERIAL_INSTANCE_INVALID', `Parameter ${id} must be a safe integer`, [
        'parameters',
        id,
      ]);
    }
    if (parameter.type === 'boolean' && typeof value !== 'boolean') {
      runtimeIssue(diagnostics, 'MATERIAL_INSTANCE_INVALID', `Parameter ${id} must be boolean`, ['parameters', id]);
    }
    if ((parameter.type === 'enum' || parameter.type === 'string') && typeof value !== 'string') {
      runtimeIssue(diagnostics, 'MATERIAL_INSTANCE_INVALID', `Parameter ${id} must be a string`, ['parameters', id]);
    }
    if (parameter.type === 'enum' && (typeof value !== 'string' || !parameter.values?.includes(value))) {
      runtimeIssue(diagnostics, 'MATERIAL_INSTANCE_INVALID', `Parameter ${id} has an invalid enum value`, [
        'parameters',
        id,
      ]);
    }
    if (numeric && typeof value === 'number') {
      if (parameter.range?.min !== undefined && value < parameter.range.min) {
        runtimeIssue(diagnostics, 'MATERIAL_PARAMETER_OUT_OF_RANGE', `${id} is below its minimum`, ['parameters', id]);
      }
      if (parameter.range?.max !== undefined && value > parameter.range.max) {
        runtimeIssue(diagnostics, 'MATERIAL_PARAMETER_OUT_OF_RANGE', `${id} exceeds its maximum`, ['parameters', id]);
      }
    }
  }
  const resources = instance.resourceBindings ?? {};
  for (const slot of definition.resourceSlots) {
    if (slot.required && resources[slot.id] === undefined && slot.fallbackResourceId === undefined) {
      runtimeIssue(diagnostics, 'MATERIAL_INSTANCE_INVALID', `Required resource ${slot.id} is missing`, [
        'resourceBindings',
        slot.id,
      ]);
    }
  }
  const inputBindings = instance.inputBindings ?? {};
  for (const port of definition.ports) {
    if (
      port.direction === 'input' &&
      port.binding === 'instance' &&
      port.required &&
      inputBindings[port.id] === undefined
    ) {
      runtimeIssue(diagnostics, 'MATERIAL_INSTANCE_INVALID', `Required input ${port.id} is missing`, [
        'inputBindings',
        port.id,
      ]);
    }
  }
  return diagnostics;
}

export function selectMaterialImplementation(
  definition: RuntimeMaterialDefinition,
  options: MaterialRuntimeSelectionOptions,
): {
  readonly implementation?: MaterialImplementationDescriptor;
  readonly diagnostics: readonly Diagnostic[];
} {
  const executableCode = definition.implementations.some((value) => value.type !== 'graph');
  if (executableCode && options.trust !== 'trusted-code') {
    return {
      diagnostics: [
        {
          code: 'MATERIAL_TRUST_REQUIRED',
          severity: 'error',
          message: 'Shader/WASM Material implementations require a trusted-code package',
          recoverable: false,
        },
      ],
    };
  }
  if (options.trust === 'trusted-code' && executableCode && options.trustedCodeAuthorized !== true) {
    return {
      diagnostics: [
        {
          code: 'MATERIAL_TRUST_REQUIRED',
          severity: 'error',
          message: 'The host did not authorize this trusted-code Material package',
          recoverable: false,
        },
      ],
    };
  }
  const implementation = definition.implementations.find(
    (value) =>
      (value.type === 'graph' && options.backend !== 'cpu') ||
      (value.type === 'shader' && value.backend === options.backend) ||
      (value.type === 'wasm' && options.backend === 'cpu'),
  );
  return implementation === undefined
    ? {
        diagnostics: [
          {
            code: 'MATERIAL_BACKEND_UNAVAILABLE',
            severity: 'error',
            message: `No Material implementation supports ${options.backend}`,
            recoverable: true,
          },
        ],
      }
    : { implementation, diagnostics: [] };
}
