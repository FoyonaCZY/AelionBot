import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { materialDefinitionSchema, materialGraphSchema, materialPackageSchema } from './bundled-schemas.js';

interface CompiledMaterialValidators {
  readonly manifest: ValidateFunction;
  readonly definition: ValidateFunction;
  readonly graph: ValidateFunction;
}

let compiledValidators: CompiledMaterialValidators | null | undefined;

function canUseDynamicCodeGen(): boolean {
  try {
    const probe = new Function('return true') as () => boolean;
    return probe() === true;
  } catch {
    return false;
  }
}

function getMaterialValidators(): CompiledMaterialValidators | undefined {
  if (compiledValidators !== undefined) return compiledValidators ?? undefined;
  if (!canUseDynamicCodeGen()) {
    compiledValidators = null;
    return undefined;
  }
  try {
    const ajv = new Ajv2020({
      // Shape admission runs before these validators and rejects oversized input.
      // Stop at the first schema failure so invalid packages cannot amplify CPU or
      // retained error state by asking Ajv to enumerate every violation.
      allErrors: false,
      allowUnionTypes: true,
      strict: true,
      validateFormats: true,
    });
    addFormats(ajv);
    compiledValidators = {
      manifest: ajv.compile(materialPackageSchema),
      definition: ajv.compile(materialDefinitionSchema),
      graph: ajv.compile(materialGraphSchema),
    };
    return compiledValidators;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof EvalError || /unsafe-eval|Code generation from strings/iu.test(message)) {
      compiledValidators = null;
      return undefined;
    }
    throw error;
  }
}

function pointer(error: ErrorObject): string {
  return error.instancePath === '' ? '/' : error.instancePath;
}

function assertSchema(value: unknown, name: 'manifest' | 'definition' | 'graph'): void {
  const validators = getMaterialValidators();
  if (validators === undefined) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(`MATERIAL_PACKAGE_INVALID: ${name} / must be an object`);
    }
    return;
  }
  const validator = validators[name];
  if (validator(value)) return;
  const first = validator.errors?.[0];
  const message = first?.message ?? `does not conform to the ${name} schema`;
  const path = first === undefined ? '/' : pointer(first);
  throw new TypeError(`MATERIAL_PACKAGE_INVALID: ${name} ${path} ${message}`);
}

export function assertMaterialManifestSchema(value: unknown): void {
  assertSchema(value, 'manifest');
}

export function assertMaterialDefinitionSchema(value: unknown): void {
  assertSchema(value, 'definition');
}

export function assertMaterialGraphSchema(value: unknown): void {
  assertSchema(value, 'graph');
}
