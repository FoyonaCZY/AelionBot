import type { MaterialGraph } from '@aelionsdk/material-compiler';

import {
  MATERIAL_DEFINITION_SCHEMA,
  MATERIAL_GRAPH_SCHEMA,
  MATERIAL_NODE_SET,
  MATERIAL_PACKAGE_SCHEMA,
  MATERIAL_PROTOCOL_VERSION,
  type MaterialDefinition,
  type MaterialPackageManifest,
} from './types.js';
import { validMaterialPackagePath } from './package-limits.js';
import {
  assertMaterialDefinitionSchema,
  assertMaterialGraphSchema,
  assertMaterialManifestSchema,
} from './schema-validation.js';

const MAX_MATERIALS = 256;
// The transport limit includes manifest.json itself.
const MAX_MANIFEST_FILES = 255;
const MAX_SCOPES = 5;
const MAX_PORTS = 16;
const MAX_PARAMETERS = 64;
const MAX_BUNDLED_RESOURCES = 32;
const MAX_RESOURCE_SLOTS = 16;
const MAX_IMPLEMENTATIONS = 8;
const MAX_ENUM_VALUES = 256;
const MAX_GRAPH_NODES = 128;
const MAX_GRAPH_INPUTS = 32;
const MAX_GRAPH_OUTPUTS = 8;
const MAX_OBJECT_KEYS = 4096;
const MAX_JSON_ARRAY_VALUES = 1024;
const MAX_JSON_OBJECT_KEYS = 128;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 262_144;
const MAX_STRING_BYTES = 16 * 1024;
const encoder = new TextEncoder();

function invalid(path: string, message: string): never {
  throw new TypeError(`MATERIAL_PACKAGE_INVALID: ${path} ${message}`);
}

/**
 * Performs bounded admission before Ajv sees an untrusted object. Ajv must not
 * be the first code to discover a huge or sparse array: even a tiny sparse
 * in-memory value can otherwise force it to walk and retain millions of
 * errors without consuming any package byte budget.
 */
function admissionRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(path, 'must be an object');
  }
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
  } catch {
    invalid(path, 'has an inaccessible prototype');
  }
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(path, 'must be a plain JSON object');
  }
  return value as Record<string, unknown>;
}

function dataProperty(record_: Record<string, unknown>, key: string, path: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(record_, key);
  } catch {
    invalid(path, 'is inaccessible');
  }
  if (descriptor === undefined || !('value' in descriptor)) {
    invalid(path, 'must be an own data property');
  }
  return descriptor.value;
}

function optionalDataProperty(record_: Record<string, unknown>, key: string, path: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(record_, key);
  } catch {
    invalid(path, 'is inaccessible');
  }
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) invalid(path, 'must be an own data property');
  return descriptor.value;
}

function admittedArray(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value)) invalid(path, 'must be an array');
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
    invalid(path, `has more than ${maximum} entries`);
  }
  // At most `maximum` descriptor reads: this rejects sparse/accessor arrays
  // without invoking caller-controlled indexed getters.
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, index.toString());
    } catch {
      invalid(`${path}[${index}]`, 'is inaccessible');
    }
    if (descriptor === undefined || !('value' in descriptor)) {
      invalid(`${path}[${index}]`, 'must be a dense data entry');
    }
  }
  return value;
}

function admittedObjectKeys(value: unknown, path: string, maximum: number): readonly string[] {
  const object = admissionRecord(value, path);
  let keys: string[];
  try {
    keys = Object.keys(object);
  } catch {
    invalid(path, 'has inaccessible properties');
  }
  if (keys.length > maximum) invalid(path, `has more than ${maximum} properties`);
  return keys;
}

interface JsonAdmissionBudget {
  remaining: number;
}

function admitJsonValue(value: unknown, path: string, budget: JsonAdmissionBudget, depth = 0): void {
  budget.remaining -= 1;
  if (budget.remaining < 0) invalid(path, `exceeds ${MAX_JSON_NODES} JSON values`);
  if (depth > MAX_JSON_DEPTH) invalid(path, 'exceeds JSON nesting limit');
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
    return;
  }
  if (typeof value === 'string') {
    // UTF-8 bytes can never be fewer than this many UTF-16 code units.
    if (value.length > MAX_STRING_BYTES) invalid(path, 'string is too long');
    return;
  }
  if (Array.isArray(value)) {
    const values = admittedArray(value, path, MAX_JSON_ARRAY_VALUES);
    for (let index = 0; index < values.length; index += 1) {
      admitJsonValue(values[index], `${path}[${index}]`, budget, depth + 1);
    }
    return;
  }
  const object = admissionRecord(value, path);
  const keys = admittedObjectKeys(object, path, MAX_JSON_OBJECT_KEYS);
  for (const key of keys) {
    admitJsonValue(dataProperty(object, key, `${path}.${key}`), `${path}.${key}`, budget, depth + 1);
  }
}

function admitManifest(value: unknown): void {
  const manifest = admissionRecord(value, 'manifest');
  admittedArray(dataProperty(manifest, 'materials', 'manifest.materials'), 'manifest.materials', MAX_MATERIALS);
  admittedArray(dataProperty(manifest, 'files', 'manifest.files'), 'manifest.files', MAX_MANIFEST_FILES);
}

function admitDefinition(value: unknown): void {
  const definition = admissionRecord(value, 'definition');
  admittedArray(dataProperty(definition, 'scopes', 'definition.scopes'), 'definition.scopes', MAX_SCOPES);
  admittedArray(dataProperty(definition, 'ports', 'definition.ports'), 'definition.ports', MAX_PORTS);
  const parameters = admittedArray(
    dataProperty(definition, 'parameters', 'definition.parameters'),
    'definition.parameters',
    MAX_PARAMETERS,
  );
  admittedArray(
    dataProperty(definition, 'bundledResources', 'definition.bundledResources'),
    'definition.bundledResources',
    MAX_BUNDLED_RESOURCES,
  );
  admittedArray(
    dataProperty(definition, 'resourceSlots', 'definition.resourceSlots'),
    'definition.resourceSlots',
    MAX_RESOURCE_SLOTS,
  );
  admittedArray(
    dataProperty(definition, 'implementations', 'definition.implementations'),
    'definition.implementations',
    MAX_IMPLEMENTATIONS,
  );
  const display = admissionRecord(dataProperty(definition, 'display', 'definition.display'), 'definition.display');
  const tags = optionalDataProperty(display, 'tags', 'definition.display.tags');
  if (tags !== undefined) admittedArray(tags, 'definition.display.tags', 32);

  const budget: JsonAdmissionBudget = { remaining: MAX_JSON_NODES };
  for (let index = 0; index < parameters.length; index += 1) {
    const parameter = admissionRecord(parameters[index], `definition.parameters[${index}]`);
    admitJsonValue(
      dataProperty(parameter, 'default', `definition.parameters[${index}].default`),
      `definition.parameters[${index}].default`,
      budget,
    );
    const values = optionalDataProperty(parameter, 'values', `definition.parameters[${index}].values`);
    if (values !== undefined) {
      admittedArray(values, `definition.parameters[${index}].values`, MAX_ENUM_VALUES);
    }
  }
}

function admitGraph(value: unknown): void {
  const graph = admissionRecord(value, 'graph');
  const nodes = admittedArray(dataProperty(graph, 'nodes', 'graph.nodes'), 'graph.nodes', MAX_GRAPH_NODES);
  admittedObjectKeys(dataProperty(graph, 'outputs', 'graph.outputs'), 'graph.outputs', MAX_GRAPH_OUTPUTS);
  const budget: JsonAdmissionBudget = { remaining: MAX_JSON_NODES };
  for (let index = 0; index < nodes.length; index += 1) {
    const node = admissionRecord(nodes[index], `graph.nodes[${index}]`);
    const inputs = admissionRecord(
      dataProperty(node, 'inputs', `graph.nodes[${index}].inputs`),
      `graph.nodes[${index}].inputs`,
    );
    const inputNames = admittedObjectKeys(inputs, `graph.nodes[${index}].inputs`, MAX_GRAPH_INPUTS);
    for (const name of inputNames) {
      const binding = admissionRecord(
        dataProperty(inputs, name, `graph.nodes[${index}].inputs.${name}`),
        `graph.nodes[${index}].inputs.${name}`,
      );
      const literalValue = optionalDataProperty(binding, 'value', `graph.nodes[${index}].inputs.${name}.value`);
      if (literalValue !== undefined) {
        admitJsonValue(literalValue, `graph.nodes[${index}].inputs.${name}.value`, budget);
      }
    }
    const config = optionalDataProperty(node, 'config', `graph.nodes[${index}].config`);
    if (config !== undefined) {
      const configRecord = admissionRecord(config, `graph.nodes[${index}].config`);
      const configKeys = admittedObjectKeys(configRecord, `graph.nodes[${index}].config`, MAX_GRAPH_INPUTS);
      for (const key of configKeys) {
        admitJsonValue(
          dataProperty(configRecord, key, `graph.nodes[${index}].config.${key}`),
          `graph.nodes[${index}].config.${key}`,
          budget,
        );
      }
    }
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(path, 'must be an object');
  }
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
  } catch {
    invalid(path, 'has an inaccessible prototype');
  }
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(path, 'must be a plain JSON object');
  }
  const output = value as Record<string, unknown>;
  let keys: string[];
  try {
    keys = Object.keys(output);
  } catch {
    invalid(path, 'has inaccessible properties');
  }
  if (keys.length > MAX_OBJECT_KEYS) invalid(path, 'has too many properties');
  return output;
}

function array(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value)) invalid(path, 'must be an array');
  let length: number;
  try {
    length = value.length;
  } catch {
    invalid(path, 'has an inaccessible length');
  }
  if (!Number.isSafeInteger(length) || length > maximum) {
    invalid(path, `has more than ${maximum} entries`);
  }
  return value;
}

function string(value: unknown, path: string, maximumBytes = MAX_STRING_BYTES): string {
  if (typeof value !== 'string' || value.length === 0) invalid(path, 'must be a non-empty string');
  if (encoder.encode(value).byteLength > maximumBytes) {
    invalid(path, `exceeds ${maximumBytes} UTF-8 bytes`);
  }
  return value;
}

function optionalString(value: unknown, path: string): void {
  if (value !== undefined) string(value, path);
}

function member(value: unknown, allowed: readonly string[], path: string): void {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    invalid(path, `must be one of ${allowed.join(', ')}`);
  }
}

function boolean(value: unknown, path: string): void {
  if (typeof value !== 'boolean') invalid(path, 'must be boolean');
}

function finiteNumber(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(path, 'must be finite');
}

function safeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    invalid(path, 'must be a non-negative safe integer');
  }
  return Number(value);
}

function literal(value: unknown, expected: unknown, path: string): void {
  if (value !== expected) invalid(path, `must equal ${String(expected)}`);
}

function stringArray(value: unknown, path: string, maximum: number): void {
  for (const [index, item] of array(value, path, maximum).entries()) {
    string(item, `${path}[${index}]`);
  }
}

function idCollection(value: unknown, path: string, maximum: number): readonly Record<string, unknown>[] {
  const result = array(value, path, maximum).map((item, index) => {
    const entry = record(item, `${path}[${index}]`);
    string(entry.id, `${path}[${index}].id`);
    return entry;
  });
  const ids = result.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) invalid(path, 'contains duplicate ids');
  return result;
}

function validateJsonValue(
  value: unknown,
  path: string,
  depth = 0,
  budget: JsonAdmissionBudget = { remaining: MAX_JSON_NODES },
): void {
  budget.remaining -= 1;
  if (budget.remaining < 0) invalid(path, `exceeds ${MAX_JSON_NODES} JSON values`);
  if (depth > MAX_JSON_DEPTH) invalid(path, 'exceeds JSON nesting limit');
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
    return;
  }
  if (typeof value === 'string') {
    if (encoder.encode(value).byteLength > MAX_STRING_BYTES) {
      invalid(path, `string exceeds ${MAX_STRING_BYTES} UTF-8 bytes`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY_VALUES) invalid(path, 'array has too many values');
    value.forEach((item, index) => validateJsonValue(item, `${path}[${index}]`, depth + 1, budget));
    return;
  }
  const object = record(value, path);
  if (Object.keys(object).length > MAX_JSON_OBJECT_KEYS) invalid(path, 'has too many properties');
  for (const [key, item] of Object.entries(object)) {
    string(key, `${path} key`);
    validateJsonValue(item, `${path}.${key}`, depth + 1, budget);
  }
}

export function assertMaterialPackageManifestShape(value: unknown): asserts value is MaterialPackageManifest {
  admitManifest(value);
  assertMaterialManifestSchema(value);
  const manifest = record(value, 'manifest');
  literal(manifest.$schema, MATERIAL_PACKAGE_SCHEMA, 'manifest.$schema');
  literal(manifest.protocolVersion, MATERIAL_PROTOCOL_VERSION, 'manifest.protocolVersion');
  const metadata = record(manifest.package, 'manifest.package');
  string(metadata.id, 'manifest.package.id');
  string(metadata.version, 'manifest.package.version');
  string(metadata.displayName, 'manifest.package.displayName');
  string(metadata.license, 'manifest.package.license');
  const publisher = record(metadata.publisher, 'manifest.package.publisher');
  string(publisher.id, 'manifest.package.publisher.id');
  string(publisher.name, 'manifest.package.publisher.name');
  const engines = record(metadata.engines, 'manifest.package.engines');
  string(engines.aelion, 'manifest.package.engines.aelion');
  string(engines.nodeSet, 'manifest.package.engines.nodeSet');
  if (metadata.trust !== 'declarative' && metadata.trust !== 'trusted-code') {
    invalid('manifest.package.trust', 'must be declarative or trusted-code');
  }
  for (const [index, item] of array(manifest.materials, 'manifest.materials', MAX_MATERIALS).entries()) {
    const material = record(item, `manifest.materials[${index}]`);
    string(material.id, `manifest.materials[${index}].id`);
    member(
      material.kind,
      ['visual-filter', 'visual-effect', 'visual-transition', 'visual-generator'],
      `manifest.materials[${index}].kind`,
    );
    string(material.definition, `manifest.materials[${index}].definition`, 512);
    if (typeof material.definition !== 'string' || !validMaterialPackagePath(material.definition)) {
      invalid(`manifest.materials[${index}].definition`, 'must be a safe relative package path');
    }
  }
  const materialIds = (manifest.materials as readonly { readonly id: string }[]).map((material) => material.id);
  if (new Set(materialIds).size !== materialIds.length) {
    invalid('manifest.materials', 'contains duplicate ids');
  }
  const materialDefinitions = (manifest.materials as readonly { readonly definition: string }[]).map(
    (material) => material.definition,
  );
  if (new Set(materialDefinitions).size !== materialDefinitions.length) {
    invalid('manifest.materials', 'contains duplicate definition paths');
  }
  for (const [index, item] of array(manifest.files, 'manifest.files', MAX_MANIFEST_FILES).entries()) {
    const file = record(item, `manifest.files[${index}]`);
    string(file.path, `manifest.files[${index}].path`, 512);
    if (typeof file.path !== 'string' || !validMaterialPackagePath(file.path)) {
      invalid(`manifest.files[${index}].path`, 'must be a safe relative package path');
    }
    string(file.mediaType, `manifest.files[${index}].mediaType`);
    safeInteger(file.bytes, `manifest.files[${index}].bytes`);
    if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(file.sha256)) {
      invalid(`manifest.files[${index}].sha256`, 'must be a lowercase SHA-256 hex digest');
    }
  }
  const filePaths = (manifest.files as readonly { readonly path: string }[]).map((file) => file.path);
  if (new Set(filePaths).size !== filePaths.length) {
    invalid('manifest.files', 'contains duplicate paths');
  }
  validateJsonValue(manifest, 'manifest');
}

export function assertMaterialDefinitionShape(value: unknown): asserts value is MaterialDefinition {
  admitDefinition(value);
  assertMaterialDefinitionSchema(value);
  const definition = record(value, 'definition');
  literal(definition.$schema, MATERIAL_DEFINITION_SCHEMA, 'definition.$schema');
  literal(definition.protocolVersion, MATERIAL_PROTOCOL_VERSION, 'definition.protocolVersion');
  string(definition.id, 'definition.id');
  member(
    definition.kind,
    ['visual-filter', 'visual-effect', 'visual-transition', 'visual-generator'],
    'definition.kind',
  );
  const display = record(definition.display, 'definition.display');
  string(display.name, 'definition.display.name');
  optionalString(display.description, 'definition.display.description');
  optionalString(display.category, 'definition.display.category');
  if (display.tags !== undefined) stringArray(display.tags, 'definition.display.tags', 32);
  const scopes = array(definition.scopes, 'definition.scopes', MAX_SCOPES);
  scopes.forEach((scope, index) => {
    member(scope, ['source', 'item', 'track', 'sequence', 'transition'], `definition.scopes[${index}]`);
  });
  const ports = idCollection(definition.ports, 'definition.ports', MAX_PORTS);
  ports.forEach((port, index) => {
    member(port.direction, ['input', 'output'], `definition.ports[${index}].direction`);
    member(port.type, ['visual-frame', 'mask', 'depth', 'motion-vectors'], `definition.ports[${index}].type`);
    member(port.role, ['source', 'from', 'to', 'auxiliary', 'result'], `definition.ports[${index}].role`);
    member(port.binding, ['host', 'instance'], `definition.ports[${index}].binding`);
    boolean(port.required, `definition.ports[${index}].required`);
  });
  const parameters = idCollection(definition.parameters, 'definition.parameters', MAX_PARAMETERS);
  parameters.forEach((parameter, index) => {
    member(
      parameter.type,
      [
        'boolean',
        'integer',
        'float',
        'enum',
        'vec2',
        'vec3',
        'vec4',
        'color',
        'angle',
        'duration',
        'gradient',
        'curve',
        'string',
      ],
      `definition.parameters[${index}].type`,
    );
    validateJsonValue(parameter.default, `definition.parameters[${index}].default`);
    boolean(parameter.animatable, `definition.parameters[${index}].animatable`);
    member(parameter.affects, ['uniform', 'specialization', 'graph'], `definition.parameters[${index}].affects`);
    const ui = record(parameter.ui, `definition.parameters[${index}].ui`);
    string(ui.control, `definition.parameters[${index}].ui.control`);
    string(ui.group, `definition.parameters[${index}].ui.group`);
    safeInteger(ui.order, `definition.parameters[${index}].ui.order`);
    string(ui.label, `definition.parameters[${index}].ui.label`);
  });
  const resources = idCollection(definition.bundledResources, 'definition.bundledResources', MAX_BUNDLED_RESOURCES);
  resources.forEach((resource, index) => {
    member(
      resource.kind,
      ['texture2d', 'texture3d', 'lut1d', 'lut3d', 'cube-texture', 'mask', 'binary-table'],
      `definition.bundledResources[${index}].kind`,
    );
    string(resource.path, `definition.bundledResources[${index}].path`, 512);
    if (typeof resource.path !== 'string' || !validMaterialPackagePath(resource.path)) {
      invalid(`definition.bundledResources[${index}].path`, 'must be a safe relative package path');
    }
  });
  const resourceSlots = idCollection(definition.resourceSlots, 'definition.resourceSlots', MAX_RESOURCE_SLOTS);
  resourceSlots.forEach((resource, index) => {
    member(
      resource.kind,
      ['texture2d', 'texture3d', 'lut1d', 'lut3d', 'cube-texture', 'mask', 'binary-table'],
      `definition.resourceSlots[${index}].kind`,
    );
    boolean(resource.required, `definition.resourceSlots[${index}].required`);
    optionalString(resource.fallbackResourceId, `definition.resourceSlots[${index}].fallbackResourceId`);
  });
  const execution = record(definition.execution, 'definition.execution');
  const color = record(execution.color, 'definition.execution.color');
  literal(color.input, 'working-linear', 'definition.execution.color.input');
  literal(color.output, 'working-linear', 'definition.execution.color.output');
  const alpha = record(execution.alpha, 'definition.execution.alpha');
  literal(alpha.input, 'premultiplied', 'definition.execution.alpha.input');
  literal(alpha.output, 'premultiplied', 'definition.execution.alpha.output');
  boolean(alpha.preservesTransparency, 'definition.execution.alpha.preservesTransparency');
  const resolution = record(execution.resolution, 'definition.execution.resolution');
  member(resolution.policy, ['same-as-host', 'scale'], 'definition.execution.resolution.policy');
  if (resolution.scale !== undefined) finiteNumber(resolution.scale, 'definition.execution.resolution.scale');
  const spatialPadding = record(execution.spatialPadding, 'definition.execution.spatialPadding');
  member(spatialPadding.mode, ['none', 'fixed', 'parameter-bound'], 'definition.execution.spatialPadding.mode');
  const temporal = record(execution.temporal, 'definition.execution.temporal');
  safeInteger(temporal.pastUs, 'definition.execution.temporal.pastUs');
  safeInteger(temporal.futureUs, 'definition.execution.temporal.futureUs');
  boolean(temporal.stateful, 'definition.execution.temporal.stateful');
  member(
    temporal.seekPolicy,
    ['stateless', 'reconstruct', 'reset-with-warning'],
    'definition.execution.temporal.seekPolicy',
  );
  member(
    execution.determinism,
    ['strict', 'backend-tolerant', 'non-deterministic'],
    'definition.execution.determinism',
  );
  const supports = record(execution.supports, 'definition.execution.supports');
  for (const property of ['realtime', 'offline', 'alpha', 'hdr', 'tiled'] as const) {
    boolean(supports[property], `definition.execution.supports.${property}`);
  }
  for (const [index, item] of array(
    definition.implementations,
    'definition.implementations',
    MAX_IMPLEMENTATIONS,
  ).entries()) {
    const implementation = record(item, `definition.implementations[${index}]`);
    string(implementation.type, `definition.implementations[${index}].type`);
    if (implementation.type === 'graph') {
      string(implementation.graph, `definition.implementations[${index}].graph`, 512);
      string(implementation.nodeSet, `definition.implementations[${index}].nodeSet`);
      if (!validMaterialPackagePath(String(implementation.graph))) {
        invalid(`definition.implementations[${index}].graph`, 'must be a safe relative path');
      }
    } else if (implementation.type === 'wasm') {
      string(implementation.module, `definition.implementations[${index}].module`, 512);
      if (!validMaterialPackagePath(String(implementation.module))) {
        invalid(`definition.implementations[${index}].module`, 'must be a safe relative path');
      }
    } else if (implementation.type === 'shader') {
      string(implementation.backend, `definition.implementations[${index}].backend`);
      if (implementation.backend === 'webgpu') {
        string(implementation.module, `definition.implementations[${index}].module`, 512);
        if (!validMaterialPackagePath(String(implementation.module))) {
          invalid(`definition.implementations[${index}].module`, 'must be a safe relative path');
        }
      } else if (implementation.backend === 'webgl2') {
        string(implementation.fragmentModule, `definition.implementations[${index}].fragmentModule`, 512);
        optionalString(implementation.vertexModule, `definition.implementations[${index}].vertexModule`);
        if (!validMaterialPackagePath(String(implementation.fragmentModule))) {
          invalid(`definition.implementations[${index}].fragmentModule`, 'must be a safe relative path');
        }
        if (typeof implementation.vertexModule === 'string' && !validMaterialPackagePath(implementation.vertexModule)) {
          invalid(`definition.implementations[${index}].vertexModule`, 'must be a safe relative path');
        }
      } else invalid(`definition.implementations[${index}].backend`, 'is unsupported');
    } else invalid(`definition.implementations[${index}].type`, 'is unsupported');
  }
  member(definition.splitPolicy, ['copy', 'reset', 'reject'], 'definition.splitPolicy');
  validateJsonValue(definition, 'definition');
}

export function assertMaterialGraphShape(value: unknown): asserts value is MaterialGraph {
  admitGraph(value);
  assertMaterialGraphSchema(value);
  const graph = record(value, 'graph');
  literal(graph.$schema, MATERIAL_GRAPH_SCHEMA, 'graph.$schema');
  string(graph.graphVersion, 'graph.graphVersion');
  literal(graph.nodeSet, MATERIAL_NODE_SET, 'graph.nodeSet');
  for (const [index, item] of array(graph.nodes, 'graph.nodes', MAX_GRAPH_NODES).entries()) {
    const node = record(item, `graph.nodes[${index}]`);
    string(node.id, `graph.nodes[${index}].id`);
    string(node.type, `graph.nodes[${index}].type`);
    string(node.typeVersion, `graph.nodes[${index}].typeVersion`);
    const inputs = record(node.inputs, `graph.nodes[${index}].inputs`);
    for (const [name, bindingValue] of Object.entries(inputs)) {
      string(name, `graph.nodes[${index}].inputs key`);
      const binding = record(bindingValue, `graph.nodes[${index}].inputs.${name}`);
      const variants = ['value', 'parameter', 'inputPort', 'system', 'node', 'resource'].filter(
        (key) => binding[key] !== undefined,
      );
      if (variants.length !== 1) {
        invalid(`graph.nodes[${index}].inputs.${name}`, 'must have one binding kind');
      }
      const variant = variants[0];
      if (variant === 'value') {
        validateJsonValue(binding.value, `graph.nodes[${index}].inputs.${name}.value`);
      } else if (variant !== undefined) {
        string(binding[variant], `graph.nodes[${index}].inputs.${name}.${variant}`);
      }
      if (variant === 'node') {
        string(binding.output, `graph.nodes[${index}].inputs.${name}.output`);
      }
    }
  }
  const outputs = record(graph.outputs, 'graph.outputs');
  for (const [name, outputValue] of Object.entries(outputs)) {
    string(name, 'graph.outputs key');
    const output = record(outputValue, `graph.outputs.${name}`);
    string(output.node, `graph.outputs.${name}.node`);
    string(output.output, `graph.outputs.${name}.output`);
  }
  validateJsonValue(graph, 'graph');
}
