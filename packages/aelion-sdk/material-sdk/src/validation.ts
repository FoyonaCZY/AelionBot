import type { Diagnostic, JsonValue } from '@aelionsdk/core';
import { compileMaterialGraph, type CompileMaterialOptions } from '@aelionsdk/material-compiler';

import type { AuthoredMaterial, MaterialDefinition, MaterialParameter, MaterialValidationResult } from './types.js';

function issue(diagnostics: Diagnostic[], code: string, message: string, path: readonly (string | number)[]): void {
  diagnostics.push({ code, severity: 'error', message, path, recoverable: false });
}

function duplicates(values: readonly { readonly id: string }[]): string[] {
  const seen = new Set<string>();
  const result = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) result.add(value.id);
    seen.add(value.id);
  }
  return [...result];
}

function validDefault(parameter: MaterialParameter): boolean {
  const value: JsonValue = parameter.default;
  switch (parameter.type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
    case 'duration':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'float':
    case 'angle':
      return typeof value === 'number' && Number.isFinite(value);
    case 'enum':
      return typeof value === 'string' && (parameter.values?.includes(value) ?? false);
    case 'string':
      return typeof value === 'string';
    default:
      return value !== null;
  }
}

function requireHostPort(
  definition: MaterialDefinition,
  diagnostics: Diagnostic[],
  id: string,
  direction: 'input' | 'output',
  role: 'source' | 'from' | 'to' | 'result',
): void {
  const port = definition.ports.find((value) => value.id === id);
  if (
    port?.direction !== direction ||
    port.type !== 'visual-frame' ||
    port.role !== role ||
    port.binding !== 'host' ||
    !port.required
  ) {
    issue(
      diagnostics,
      'MATERIAL_DEFINITION_INVALID',
      `${definition.kind} requires host port ${id}:${direction}/${role}`,
      ['definition', 'ports'],
    );
  }
}

function compilerParameterType(parameter: MaterialParameter): 'float' | 'enum' | undefined {
  if (['float', 'integer', 'angle', 'duration'].includes(parameter.type)) return 'float';
  return parameter.type === 'enum' ? 'enum' : undefined;
}

export function validateAuthoredMaterial(
  authored: AuthoredMaterial,
  options: { readonly budget?: CompileMaterialOptions['budget'] } = {},
): MaterialValidationResult {
  const diagnostics: Diagnostic[] = [];
  const { definition, graph } = authored;
  for (const [collection, values] of [
    ['ports', definition.ports],
    ['parameters', definition.parameters],
    ['bundledResources', definition.bundledResources],
    ['resourceSlots', definition.resourceSlots],
  ] as const) {
    for (const id of duplicates(values)) {
      issue(diagnostics, 'MATERIAL_DEFINITION_INVALID', `Duplicate ${collection} id ${id}`, ['definition', collection]);
    }
  }

  if (definition.kind === 'visual-filter' || definition.kind === 'visual-effect') {
    requireHostPort(definition, diagnostics, 'source', 'input', 'source');
    requireHostPort(definition, diagnostics, 'result', 'output', 'result');
  } else if (definition.kind === 'visual-transition') {
    requireHostPort(definition, diagnostics, 'from', 'input', 'from');
    requireHostPort(definition, diagnostics, 'to', 'input', 'to');
    requireHostPort(definition, diagnostics, 'result', 'output', 'result');
    if (!definition.scopes.includes('transition')) {
      issue(diagnostics, 'MATERIAL_DEFINITION_INVALID', 'visual-transition requires transition scope', [
        'definition',
        'scopes',
      ]);
    }
  } else {
    requireHostPort(definition, diagnostics, 'result', 'output', 'result');
  }

  for (const [index, parameter] of definition.parameters.entries()) {
    if (!validDefault(parameter)) {
      issue(diagnostics, 'MATERIAL_DEFINITION_INVALID', `Parameter ${parameter.id} has an invalid default`, [
        'definition',
        'parameters',
        index,
        'default',
      ]);
    }
    if (parameter.animatable && parameter.affects !== 'uniform') {
      issue(diagnostics, 'MATERIAL_DEFINITION_INVALID', `Animatable parameter ${parameter.id} must affect uniform`, [
        'definition',
        'parameters',
        index,
        'affects',
      ]);
    }
    if (
      typeof parameter.default === 'number' &&
      ((parameter.range?.min !== undefined && parameter.default < parameter.range.min) ||
        (parameter.range?.max !== undefined && parameter.default > parameter.range.max))
    ) {
      issue(diagnostics, 'MATERIAL_DEFINITION_INVALID', `Parameter ${parameter.id} default is outside its range`, [
        'definition',
        'parameters',
        index,
        'default',
      ]);
    }
  }

  const graphImplementations = definition.implementations.filter((value) => value.type === 'graph');
  if (graphImplementations.length > 0 && graph === undefined) {
    issue(diagnostics, 'MATERIAL_GRAPH_INVALID', 'A graph implementation requires a Graph payload', ['graph']);
  }
  if (graph !== undefined) {
    const parameters = Object.fromEntries(
      definition.parameters.flatMap((parameter) => {
        const type = compilerParameterType(parameter);
        return type === undefined ? [] : [[parameter.id, type]];
      }),
    );
    const inputPorts = Object.fromEntries(
      definition.ports
        .filter((port) => port.direction === 'input' && port.type === 'visual-frame')
        .map((port) => [port.id, 'visual-frame' as const]),
    );
    const specializationValues = Object.fromEntries(
      definition.parameters
        .filter((parameter) => parameter.affects === 'specialization')
        .map((parameter) => [parameter.id, parameter.default]),
    );
    const compiled = compileMaterialGraph(graph, {
      parameters,
      inputPorts,
      systems: { transitionProgress: 'float' },
      specializationValues,
      ...(options.budget === undefined ? {} : { budget: options.budget }),
    });
    diagnostics.push(...compiled.diagnostics);
    if (graph.nodeSet !== definition.implementations.find((value) => value.type === 'graph')?.nodeSet) {
      issue(diagnostics, 'MATERIAL_PROTOCOL_UNSUPPORTED', 'Definition and Graph node sets differ', [
        'graph',
        'nodeSet',
      ]);
    }
  }

  return { valid: diagnostics.length === 0, diagnostics };
}
