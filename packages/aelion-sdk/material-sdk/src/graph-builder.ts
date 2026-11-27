import type { JsonValue } from '@aelionsdk/core';
import type { GraphBinding, MaterialGraph, MaterialGraphNode } from '@aelionsdk/material-compiler';

import { MATERIAL_GRAPH_SCHEMA, MATERIAL_NODE_SET } from './types.js';

export type GraphValueType = 'float' | 'enum' | 'visual-frame';

export interface GraphValue<T extends GraphValueType> {
  readonly type: T;
  readonly binding: GraphBinding;
}

export type FloatValue = GraphValue<'float'>;
export type EnumValue = GraphValue<'enum'>;
export type VisualFrameValue = GraphValue<'visual-frame'>;

function value<T extends GraphValueType>(type: T, binding: GraphBinding): GraphValue<T> {
  return { type, binding };
}

export class MaterialGraphBuilder {
  readonly #nodes: MaterialGraphNode[] = [];
  readonly #ids = new Set<string>();
  readonly #outputs: Record<string, { node: string; output: string }> = {};

  literal(number: number): FloatValue {
    if (!Number.isFinite(number)) throw new TypeError('Graph literals must be finite');
    return value('float', { value: number });
  }

  enum(value_: string): EnumValue {
    return value('enum', { value: value_ });
  }

  parameterFloat(id: string): FloatValue {
    return value('float', { parameter: id });
  }

  parameterEnum(id: string): EnumValue {
    return value('enum', { parameter: id });
  }

  inputFrame(id: string): VisualFrameValue {
    return value('visual-frame', { inputPort: id });
  }

  resource(id: string): GraphValue<'visual-frame'> {
    return value('visual-frame', { resource: id });
  }

  systemFloat(
    id:
      | 'sequenceTimeUs'
      | 'itemTimeUs'
      | 'itemDurationUs'
      | 'normalizedItemTime'
      | 'transitionProgress'
      | 'frameIndex'
      | 'frameDurationUs'
      | 'qualityScale'
      | 'randomSeed',
  ): FloatValue {
    return value('float', { system: id });
  }

  #node<T extends GraphValueType>(
    id: string,
    type: string,
    inputs: Readonly<Record<string, GraphValue<GraphValueType>>>,
    output: string,
    outputType: T,
  ): GraphValue<T> {
    if (this.#ids.has(id)) throw new TypeError(`Duplicate Material Graph node ${id}`);
    this.#ids.add(id);
    this.#nodes.push({
      id,
      type,
      typeVersion: '1.0.0',
      inputs: Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.binding])),
    });
    return value(outputType, { node: id, output });
  }

  transitionCurve(id: string, progress: FloatValue, curve: EnumValue): FloatValue {
    return this.#node(id, 'time.transition-curve', { progress, curve }, 'value', 'float');
  }

  mix(id: string, a: VisualFrameValue, b: VisualFrameValue, amount: FloatValue): VisualFrameValue {
    return this.#node(id, 'composite.mix', { a, b, amount }, 'frame', 'visual-frame');
  }

  temperature(id: string, source: VisualFrameValue, amount: FloatValue): VisualFrameValue {
    return this.#node(id, 'color.temperature', { source, amount }, 'frame', 'visual-frame');
  }

  liftBlack(id: string, source: VisualFrameValue, amount: FloatValue): VisualFrameValue {
    return this.#node(id, 'color.lift-black', { source, amount }, 'frame', 'visual-frame');
  }

  extractHighlights(id: string, source: VisualFrameValue, threshold: FloatValue): VisualFrameValue {
    return this.#node(id, 'color.extract-highlights', { source, threshold }, 'frame', 'visual-frame');
  }

  gaussianBlur(id: string, source: VisualFrameValue, radiusPx: FloatValue): VisualFrameValue {
    return this.#node(id, 'blur.gaussian', { source, radiusPx }, 'frame', 'visual-frame');
  }

  scaleRgb(id: string, source: VisualFrameValue, scale: FloatValue): VisualFrameValue {
    return this.#node(id, 'color.scale-rgb', { source, scale }, 'frame', 'visual-frame');
  }

  screen(id: string, base: VisualFrameValue, overlay: VisualFrameValue): VisualFrameValue {
    return this.#node(id, 'composite.screen', { base, overlay }, 'frame', 'visual-frame');
  }

  multiplyFrames(id: string, base: VisualFrameValue, overlay: VisualFrameValue): VisualFrameValue {
    return this.#node(id, 'composite.multiply', { base, overlay }, 'frame', 'visual-frame');
  }

  addFrames(id: string, base: VisualFrameValue, overlay: VisualFrameValue): VisualFrameValue {
    return this.#node(id, 'composite.add', { base, overlay }, 'frame', 'visual-frame');
  }

  exposure(id: string, source: VisualFrameValue, stops: FloatValue): VisualFrameValue {
    return this.#node(id, 'color.exposure', { source, stops }, 'frame', 'visual-frame');
  }

  contrast(id: string, source: VisualFrameValue, amount: FloatValue): VisualFrameValue {
    return this.#node(id, 'color.contrast', { source, amount }, 'frame', 'visual-frame');
  }

  saturation(id: string, source: VisualFrameValue, amount: FloatValue): VisualFrameValue {
    return this.#node(id, 'color.saturation', { source, amount }, 'frame', 'visual-frame');
  }

  invert(id: string, source: VisualFrameValue): VisualFrameValue {
    return this.#node(id, 'color.invert', { source }, 'frame', 'visual-frame');
  }

  add(id: string, a: FloatValue, b: FloatValue): FloatValue {
    return this.#node(id, 'math.add', { a, b }, 'value', 'float');
  }

  subtract(id: string, a: FloatValue, b: FloatValue): FloatValue {
    return this.#node(id, 'math.subtract', { a, b }, 'value', 'float');
  }

  multiply(id: string, a: FloatValue, b: FloatValue): FloatValue {
    return this.#node(id, 'math.multiply', { a, b }, 'value', 'float');
  }

  divide(id: string, a: FloatValue, b: FloatValue): FloatValue {
    return this.#node(id, 'math.divide', { a, b }, 'value', 'float');
  }

  clamp(id: string, input: FloatValue, min: FloatValue, max: FloatValue): FloatValue {
    return this.#node(id, 'math.clamp', { value: input, min, max }, 'value', 'float');
  }

  smoothstep(id: string, edge0: FloatValue, edge1: FloatValue, x: FloatValue): FloatValue {
    return this.#node(id, 'math.smoothstep', { edge0, edge1, x }, 'value', 'float');
  }

  output(id: string, frame: VisualFrameValue): this {
    if (!('node' in frame.binding)) {
      throw new TypeError('A Material Graph output must reference a node output');
    }
    this.#outputs[id] = { node: frame.binding.node, output: frame.binding.output };
    return this;
  }

  build(): MaterialGraph {
    return {
      $schema: MATERIAL_GRAPH_SCHEMA,
      graphVersion: '1.0.0',
      nodeSet: MATERIAL_NODE_SET,
      nodes: this.#nodes.map((node) => ({ ...node, inputs: { ...node.inputs } })),
      outputs: { ...this.#outputs },
    };
  }
}

export function materialGraph(build: (graph: MaterialGraphBuilder) => void): MaterialGraph {
  const builder = new MaterialGraphBuilder();
  build(builder);
  return builder.build();
}

// Keep JsonValue reachable from generated declarations for author-defined literal helpers.
export type MaterialGraphLiteral = JsonValue;
