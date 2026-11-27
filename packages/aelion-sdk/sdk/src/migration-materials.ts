import type { JsonValue } from '@aelionsdk/core';
import type { MaterialUniformBinding, WebGl2MaterialProgram } from '@aelionsdk/material-compiler';
import type { IrMaterialDefinition } from '@aelionsdk/render-ir';

import { migrationMaterialPackage } from './migration.js';

export interface MigrationMaterialRegistry {
  register(
    definition: IrMaterialDefinition,
    program: WebGl2MaterialProgram | ((parameters: Readonly<Record<string, JsonValue>>) => WebGl2MaterialProgram),
  ): () => void;
}

const vertexPrelude = `#version 300 es
precision highp float;
`;

function plan(id: string, textureSamples: number): WebGl2MaterialProgram['executionPlan'] {
  return {
    passes: [
      {
        id,
        kind: 'draw',
        nodes: [id],
        estimatedTextureSamples: textureSamples,
      },
    ],
    intermediateTextureCount: 0,
  };
}

function parameter(id: string): MaterialUniformBinding {
  return {
    name: `u_parameter_${id}`,
    type: 'float',
    source: { kind: 'parameter', id },
  };
}

const progressUniform: MaterialUniformBinding = {
  name: 'u_system_transitionProgress',
  type: 'float',
  source: { kind: 'system', id: 'transitionProgress' },
};

function transitionProgram(id: string, body: string, textureSamples = 2): WebGl2MaterialProgram {
  return {
    backend: 'webgl2',
    nodeSet: 'aelion.migration/1.0.0',
    graphHash: `aelion-migration-${id}-v1`,
    inputPorts: ['from', 'to'],
    uniforms: [progressUniform],
    executionPlan: plan(id, textureSamples),
    fragmentShader: `${vertexPrelude}
uniform sampler2D u_input_from;
uniform sampler2D u_input_to;
uniform float u_system_transitionProgress;
in vec2 v_uv;
out vec4 out_color;
void main() {
  float progress = clamp(u_system_transitionProgress, 0.0, 1.0);
  ${body}
}`,
  };
}

const transitionPrograms: Readonly<Record<string, WebGl2MaterialProgram>> = {
  'diffusion-dissolve': transitionProgram(
    'diffusion-dissolve',
    'out_color = mix(texture(u_input_from, v_uv), texture(u_input_to, v_uv), progress);',
  ),
  'diffusion-slide-from-right': transitionProgram(
    'diffusion-slide-from-right',
    `float offset = (1.0 - progress) * (1.0 - progress);
  vec4 from_color = texture(u_input_from, v_uv);
  vec2 to_uv = vec2(v_uv.x - offset, v_uv.y);
  vec4 to_color = texture(u_input_to, clamp(to_uv, 0.0, 1.0));
  out_color = v_uv.x >= offset ? to_color : from_color;`,
  ),
  'diffusion-slide-from-left': transitionProgram(
    'diffusion-slide-from-left',
    `float offset = (1.0 - progress) * (1.0 - progress);
  vec4 from_color = texture(u_input_from, v_uv);
  vec2 to_uv = vec2(v_uv.x + offset, v_uv.y);
  vec4 to_color = texture(u_input_to, clamp(to_uv, 0.0, 1.0));
  out_color = v_uv.x <= 1.0 - offset ? to_color : from_color;`,
  ),
  'diffusion-fade-to-black': transitionProgram(
    'diffusion-fade-to-black',
    `vec4 base = progress < 0.5 ? texture(u_input_from, v_uv) : texture(u_input_to, v_uv);
  float amount = progress < 0.5 ? progress * 2.0 : (1.0 - progress) * 2.0;
  out_color = mix(base, vec4(0.0, 0.0, 0.0, 1.0), amount);`,
  ),
  'diffusion-fade-to-white': transitionProgram(
    'diffusion-fade-to-white',
    `vec4 base = progress < 0.5 ? texture(u_input_from, v_uv) : texture(u_input_to, v_uv);
  float amount = progress < 0.5 ? progress * 2.0 : (1.0 - progress) * 2.0;
  out_color = mix(base, vec4(1.0), amount);`,
  ),
};

function effectProgram(
  id: string,
  body: string,
  parameters: readonly string[] = ['value'],
  textureSamples = 1,
): WebGl2MaterialProgram {
  const declarations = parameters.map((value) => `uniform float u_parameter_${value};`).join('\n');
  return {
    backend: 'webgl2',
    nodeSet: 'aelion.migration/1.0.0',
    graphHash: `aelion-migration-${id}-v1`,
    inputPorts: ['source'],
    uniforms: parameters.map(parameter),
    executionPlan: plan(id, textureSamples),
    fragmentShader: `${vertexPrelude}
uniform sampler2D u_input_source;
${declarations}
in vec2 v_uv;
out vec4 out_color;
void main() {
  vec4 source_color = texture(u_input_source, v_uv);
  float amount = u_parameter_value / 100.0;
  ${body}
}`,
  };
}

const effectPrograms: Readonly<Record<string, WebGl2MaterialProgram>> = {
  'diffusion-brightness': effectProgram(
    'diffusion-brightness',
    'out_color = vec4(source_color.rgb * amount, source_color.a);',
  ),
  'diffusion-contrast': effectProgram(
    'diffusion-contrast',
    'out_color = vec4((source_color.rgb - 0.5) * amount + 0.5, source_color.a);',
  ),
  'diffusion-grayscale': effectProgram(
    'diffusion-grayscale',
    `float luma = dot(source_color.rgb, vec3(0.2126, 0.7152, 0.0722));
  out_color = vec4(mix(source_color.rgb, vec3(luma), clamp(amount, 0.0, 1.0)), source_color.a);`,
  ),
  'diffusion-hue-rotate': effectProgram(
    'diffusion-hue-rotate',
    `float angle = radians(u_parameter_value);
  float c = cos(angle);
  float s = sin(angle);
  mat3 hue = mat3(
    0.213 + c * 0.787 - s * 0.213,
    0.715 - c * 0.715 - s * 0.715,
    0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143,
    0.715 + c * 0.285 + s * 0.140,
    0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787,
    0.715 - c * 0.715 + s * 0.715,
    0.072 + c * 0.928 + s * 0.072
  );
  out_color = vec4(clamp(hue * source_color.rgb, 0.0, 1.0), source_color.a);`,
  ),
  'diffusion-invert': effectProgram(
    'diffusion-invert',
    'out_color = vec4(mix(source_color.rgb, 1.0 - source_color.rgb, clamp(amount, 0.0, 1.0)), source_color.a);',
  ),
  'diffusion-opacity': effectProgram('diffusion-opacity', 'out_color = source_color * clamp(amount, 0.0, 1.0);'),
  'diffusion-saturate': effectProgram(
    'diffusion-saturate',
    `float luma = dot(source_color.rgb, vec3(0.2126, 0.7152, 0.0722));
  out_color = vec4(mix(vec3(luma), source_color.rgb, max(0.0, amount)), source_color.a);`,
  ),
  'diffusion-sepia': effectProgram(
    'diffusion-sepia',
    `vec3 sepia = vec3(
    dot(source_color.rgb, vec3(0.393, 0.769, 0.189)),
    dot(source_color.rgb, vec3(0.349, 0.686, 0.168)),
    dot(source_color.rgb, vec3(0.272, 0.534, 0.131))
  );
  out_color = vec4(mix(source_color.rgb, min(sepia, 1.0), clamp(amount, 0.0, 1.0)), source_color.a);`,
  ),
  'diffusion-blur': effectProgram(
    'diffusion-blur',
    `vec2 radius = vec2(
    max(0.0, u_parameter_value) / max(1.0, u_parameter_width),
    max(0.0, u_parameter_value) / max(1.0, u_parameter_height)
  );
  vec4 sum = source_color * 0.227027;
  sum += texture(u_input_source, v_uv + vec2(radius.x, 0.0) * 1.384615) * 0.158108;
  sum += texture(u_input_source, v_uv - vec2(radius.x, 0.0) * 1.384615) * 0.158108;
  sum += texture(u_input_source, v_uv + vec2(0.0, radius.y) * 1.384615) * 0.158108;
  sum += texture(u_input_source, v_uv - vec2(0.0, radius.y) * 1.384615) * 0.158108;
  sum += texture(u_input_source, v_uv + radius * 3.230769) * 0.035885;
  sum += texture(u_input_source, v_uv - radius * 3.230769) * 0.035885;
  sum += texture(u_input_source, v_uv + vec2(radius.x, -radius.y) * 3.230769) * 0.035885;
  sum += texture(u_input_source, v_uv + vec2(-radius.x, radius.y) * 3.230769) * 0.035885;
  out_color = sum;`,
    ['value', 'width', 'height'],
    9,
  ),
};

function definition(materialId: string): IrMaterialDefinition {
  return { ...migrationMaterialPackage, materialId };
}

/** Install renderable programs for every Material emitted by the Diffusion adapter. */
export function installMigrationMaterials(registry: MigrationMaterialRegistry): () => void {
  const disposers = [...Object.entries(transitionPrograms), ...Object.entries(effectPrograms)].map(
    ([materialId, program]) => registry.register(definition(materialId), program),
  );
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}

export function migrationMaterialProgram(materialId: string): WebGl2MaterialProgram | undefined {
  return transitionPrograms[materialId] ?? effectPrograms[materialId];
}
