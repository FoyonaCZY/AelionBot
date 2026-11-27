import type { JsonValue } from '@aelionsdk/core';
import type { WebGl2MaterialProgram } from '@aelionsdk/material-compiler';
import type { IrMaterialDefinition } from '@aelionsdk/render-ir';

import type { AelionRuntimeMaterialRegistry } from './types.js';

function key(definition: IrMaterialDefinition): string {
  return [definition.packageId, definition.packageVersion, definition.packageIntegrity, definition.materialId].join(
    '\u0000',
  );
}

export class RuntimeMaterialRegistry implements AelionRuntimeMaterialRegistry {
  readonly #programs = new Map<
    string,
    WebGl2MaterialProgram | ((parameters: Readonly<Record<string, JsonValue>>) => WebGl2MaterialProgram)
  >();

  public register(
    definition: IrMaterialDefinition,
    program: WebGl2MaterialProgram | ((parameters: Readonly<Record<string, JsonValue>>) => WebGl2MaterialProgram),
  ): () => void {
    const id = key(definition);
    if (this.#programs.has(id)) {
      throw new Error(`Material ${definition.packageId}/${definition.materialId} is registered`);
    }
    this.#programs.set(id, program);
    return () => this.#programs.delete(id);
  }

  public resolveProgram(
    definition: IrMaterialDefinition,
    parameters: Readonly<Record<string, JsonValue>>,
  ): WebGl2MaterialProgram | undefined {
    const value = this.#programs.get(key(definition));
    return typeof value === 'function' ? value(parameters) : value;
  }
}
