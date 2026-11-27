import { buildMaterialExecutionPlan, compileMaterialGraph } from './compiler.js';
import { graphHash, identifier, literal } from './codegen-common.js';
import { compileMaterialGraphToWebGpu } from './webgpu.js';
import type {
  CompileMaterialOptions,
  GraphBinding,
  MaterialGraph,
  MaterialUniformBinding,
  WebGl2MaterialProgram,
  WebGl2MaterialPass,
} from './types.js';

function uniformFor(binding: GraphBinding, uniforms: Map<string, MaterialUniformBinding>): string | undefined {
  if ('parameter' in binding) {
    const name = `u_parameter_${identifier(binding.parameter)}`;
    uniforms.set(name, {
      name,
      type: 'float',
      source: { kind: 'parameter', id: binding.parameter },
    });
    return name;
  }
  if ('system' in binding) {
    const name = `u_system_${identifier(binding.system)}`;
    uniforms.set(name, { name, type: 'float', source: { kind: 'system', id: binding.system } });
    return name;
  }
  return undefined;
}

function bindingExpression(
  binding: GraphBinding,
  nodeExpressions: ReadonlyMap<string, string>,
  inputPorts: Set<string>,
  uniforms: Map<string, MaterialUniformBinding>,
): string {
  if ('value' in binding) return literal(binding.value, 'WebGL2');
  const uniform = uniformFor(binding, uniforms);
  if (uniform !== undefined) return uniform;
  if ('inputPort' in binding) {
    inputPorts.add(binding.inputPort);
    return `texture(u_input_${identifier(binding.inputPort)}, v_uv)`;
  }
  if ('node' in binding) {
    const expression = nodeExpressions.get(binding.node);
    if (expression === undefined) throw new TypeError(`Node ${binding.node} has no expression`);
    return expression;
  }
  throw new TypeError('Resource bindings are not executable in the Phase 0 WebGL2 backend');
}

function nodeExpression(
  type: string,
  input: (name: string) => string,
  binding: (name: string) => GraphBinding,
  options: CompileMaterialOptions,
): string {
  switch (type) {
    case 'time.transition-curve': {
      const curveBinding = binding('curve');
      const curve =
        'value' in curveBinding
          ? curveBinding.value
          : 'parameter' in curveBinding
            ? options.specializationValues?.[curveBinding.parameter]
            : undefined;
      if (curve === 'linear') return `clamp(${input('progress')}, 0.0, 1.0)`;
      if (curve === 'smooth') {
        return `smoothstep(0.0, 1.0, clamp(${input('progress')}, 0.0, 1.0))`;
      }
      throw new TypeError('time.transition-curve requires a linear or smooth specialization value');
    }
    case 'composite.mix':
      return `mix(${input('a')}, ${input('b')}, clamp(${input('amount')}, 0.0, 1.0))`;
    case 'color.temperature':
      return `aelion_temperature(${input('source')}, ${input('amount')})`;
    case 'color.lift-black':
      return `aelion_lift_black(${input('source')}, ${input('amount')})`;
    case 'color.scale-rgb':
      return `aelion_scale_rgb(${input('source')}, ${input('scale')})`;
    case 'composite.screen':
      return `aelion_screen(${input('base')}, ${input('overlay')})`;
    case 'math.add':
      return `(${input('a')} + ${input('b')})`;
    case 'math.subtract':
      return `(${input('a')} - ${input('b')})`;
    case 'math.multiply':
      return `(${input('a')} * ${input('b')})`;
    case 'math.divide':
      return `(${input('a')} / ${input('b')})`;
    case 'math.clamp':
      return `clamp(${input('value')}, ${input('min')}, ${input('max')})`;
    case 'math.smoothstep':
      return `smoothstep(${input('edge0')}, ${input('edge1')}, ${input('x')})`;
    case 'color.exposure':
      return `aelion_scale_rgb(${input('source')}, exp2(${input('stops')}))`;
    case 'color.contrast':
      return `aelion_contrast(${input('source')}, ${input('amount')})`;
    case 'color.saturation':
      return `aelion_saturation(${input('source')}, ${input('amount')})`;
    case 'color.invert':
      return `aelion_invert(${input('source')})`;
    case 'composite.multiply':
      return `aelion_multiply(${input('base')}, ${input('overlay')})`;
    case 'composite.add':
      return `aelion_add(${input('base')}, ${input('overlay')})`;
    default:
      throw new TypeError(`Node ${type} is not supported by the Phase 0 WebGL2 backend`);
  }
}

const HELPERS = `
vec4 aelion_temperature(vec4 color, float amount) {
  vec3 scale = vec3(1.0 + amount, 1.0 + amount * 0.15, 1.0 - amount * 0.55);
  return vec4(max(color.rgb * scale, vec3(0.0)), color.a);
}
vec4 aelion_lift_black(vec4 color, float amount) {
  return vec4(mix(color.rgb, vec3(1.0), clamp(amount, 0.0, 1.0)), color.a);
}
vec4 aelion_scale_rgb(vec4 color, float scale) {
  return vec4(max(color.rgb * scale, vec3(0.0)), color.a);
}
vec4 aelion_screen(vec4 base, vec4 overlay) {
  return vec4(1.0 - (1.0 - base.rgb) * (1.0 - overlay.rgb), base.a + overlay.a - base.a * overlay.a);
}
vec4 aelion_contrast(vec4 color, float amount) {
  return vec4((color.rgb - vec3(0.5)) * amount + vec3(0.5), color.a);
}
vec4 aelion_saturation(vec4 color, float amount) {
  float luma = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
  return vec4(mix(vec3(luma), color.rgb, amount), color.a);
}
vec4 aelion_invert(vec4 color) { return vec4(color.a - color.rgb, color.a); }
vec4 aelion_multiply(vec4 base, vec4 overlay) { return vec4(base.rgb * overlay.rgb, base.a * overlay.a); }
vec4 aelion_add(vec4 base, vec4 overlay) { return min(base + overlay, vec4(1.0)); }
`;

function parameterUniform(id: string): MaterialUniformBinding {
  return {
    name: `u_parameter_${identifier(id)}`,
    type: 'float',
    source: { kind: 'parameter', id },
  };
}

function numericParameter(binding: GraphBinding, context: string): string {
  if (!('parameter' in binding)) {
    throw new TypeError(`${context} must bind a numeric Material parameter`);
  }
  return binding.parameter;
}

function inputPort(binding: GraphBinding, context: string): string {
  if (!('inputPort' in binding)) throw new TypeError(`${context} must bind a host input port`);
  return binding.inputPort;
}

function nodeReference(binding: GraphBinding, expected: string, context: string): void {
  if (!('node' in binding) || binding.node !== expected) {
    throw new TypeError(`${context} must consume node ${expected}`);
  }
}

function softGlowPasses(graph: MaterialGraph): readonly WebGl2MaterialPass[] | undefined {
  const highlight = graph.nodes.find((node) => node.type === 'color.extract-highlights');
  const blur = graph.nodes.find((node) => node.type === 'blur.gaussian');
  const scale = graph.nodes.find((node) => node.type === 'color.scale-rgb');
  const composite = graph.nodes.find((node) => node.type === 'composite.screen');
  const hasMultiPassNode = graph.nodes.some((node) => node.type === 'blur.gaussian');
  if (!hasMultiPassNode) return undefined;
  if (highlight === undefined || blur === undefined || scale === undefined || composite === undefined) {
    throw new TypeError('This multi-pass graph is not supported by the Phase 0 WebGL2 planner');
  }
  const sourceBinding = highlight.inputs.source;
  const thresholdBinding = highlight.inputs.threshold;
  const blurSource = blur.inputs.source;
  const radiusBinding = blur.inputs.radiusPx;
  const scaleSource = scale.inputs.source;
  const intensityBinding = scale.inputs.scale;
  const compositeBase = composite.inputs.base;
  const compositeOverlay = composite.inputs.overlay;
  if (
    sourceBinding === undefined ||
    thresholdBinding === undefined ||
    blurSource === undefined ||
    radiusBinding === undefined ||
    scaleSource === undefined ||
    intensityBinding === undefined ||
    compositeBase === undefined ||
    compositeOverlay === undefined
  ) {
    throw new TypeError('Soft Glow graph is missing a required binding');
  }
  const source = inputPort(sourceBinding, 'Highlight source');
  const base = inputPort(compositeBase, 'Composite base');
  if (source !== base) throw new TypeError('Soft Glow source and composite base must match');
  nodeReference(blurSource, highlight.id, 'Blur source');
  nodeReference(scaleSource, blur.id, 'Glow scale source');
  nodeReference(compositeOverlay, scale.id, 'Composite overlay');
  const threshold = numericParameter(thresholdBinding, 'Highlight threshold');
  const radius = numericParameter(radiusBinding, 'Blur radius');
  const intensity = numericParameter(intensityBinding, 'Glow intensity');
  const thresholdUniform = parameterUniform(threshold);
  const radiusUniform = parameterUniform(radius);
  const intensityUniform = parameterUniform(intensity);
  const preamble = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 out_color;`;
  const blurBody = (axis: 'x' | 'y'): string => `${preamble}
uniform sampler2D u_input_source;
uniform float ${radiusUniform.name};
void main() {
  vec2 texel = 1.0 / vec2(textureSize(u_input_source, 0));
  float radius = clamp(${radiusUniform.name}, 0.0, 64.0);
  vec2 stepUv = texel * vec2(${axis === 'x' ? 'radius / 4.0, 0.0' : '0.0, radius / 4.0'});
  vec4 color = texture(u_input_source, v_uv) * 0.227027;
  color += texture(u_input_source, v_uv + stepUv) * 0.1945946;
  color += texture(u_input_source, v_uv - stepUv) * 0.1945946;
  color += texture(u_input_source, v_uv + stepUv * 2.0) * 0.1216216;
  color += texture(u_input_source, v_uv - stepUv * 2.0) * 0.1216216;
  color += texture(u_input_source, v_uv + stepUv * 3.0) * 0.054054;
  color += texture(u_input_source, v_uv - stepUv * 3.0) * 0.054054;
  color += texture(u_input_source, v_uv + stepUv * 4.0) * 0.016216;
  color += texture(u_input_source, v_uv - stepUv * 4.0) * 0.016216;
  out_color = color;
}`;
  return [
    {
      id: `${highlight.id}:draw`,
      inputs: [{ sampler: 'source', source: { kind: 'external', port: source } }],
      uniforms: [thresholdUniform],
      fragmentShader: `${preamble}
uniform sampler2D u_input_source;
uniform float ${thresholdUniform.name};
void main() {
  vec4 color = texture(u_input_source, v_uv);
  float luma = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
  float threshold = clamp(${thresholdUniform.name}, 0.0, 1.0);
  float gate = smoothstep(max(0.0, threshold - 0.05), min(1.0, threshold + 0.05), luma);
  out_color = vec4(color.rgb * gate, color.a * gate);
}`,
    },
    {
      id: `${blur.id}:horizontal`,
      inputs: [{ sampler: 'source', source: { kind: 'pass', passId: `${highlight.id}:draw` } }],
      uniforms: [radiusUniform],
      fragmentShader: blurBody('x'),
    },
    {
      id: `${blur.id}:vertical`,
      inputs: [{ sampler: 'source', source: { kind: 'pass', passId: `${blur.id}:horizontal` } }],
      uniforms: [radiusUniform],
      fragmentShader: blurBody('y'),
    },
    {
      id: `${composite.id}:draw`,
      inputs: [
        { sampler: 'base', source: { kind: 'external', port: base } },
        { sampler: 'overlay', source: { kind: 'pass', passId: `${blur.id}:vertical` } },
      ],
      uniforms: [intensityUniform],
      fragmentShader: `${preamble}
uniform sampler2D u_input_base;
uniform sampler2D u_input_overlay;
uniform float ${intensityUniform.name};
void main() {
  vec4 baseColor = texture(u_input_base, v_uv);
  vec4 glow = texture(u_input_overlay, v_uv) * max(0.0, ${intensityUniform.name});
  out_color = vec4(
    1.0 - (1.0 - baseColor.rgb) * (1.0 - glow.rgb),
    baseColor.a + glow.a - baseColor.a * glow.a
  );
}`,
    },
  ];
}

export function compileMaterialGraphToWebGl2(
  graph: MaterialGraph,
  options: CompileMaterialOptions,
): WebGl2MaterialProgram {
  const analysis = compileMaterialGraph(graph, options);
  const errors = analysis.diagnostics.filter((value) => value.severity === 'error');
  if (errors.length > 0) {
    throw new TypeError(`Material graph is not executable: ${errors.map((value) => value.code).join(', ')}`);
  }
  const multiPasses = softGlowPasses(graph);
  if (multiPasses !== undefined) {
    const inputPorts = [
      ...new Set(
        multiPasses.flatMap((pass) =>
          pass.inputs.flatMap((input) => (input.source.kind === 'external' ? [input.source.port] : [])),
        ),
      ),
    ];
    const uniforms = [
      ...new Map(multiPasses.flatMap((pass) => pass.uniforms).map((value) => [value.name, value])).values(),
    ];
    const compiledHash = graphHash(graph);
    return {
      backend: 'webgl2',
      nodeSet: graph.nodeSet,
      graphHash: compiledHash,
      inputPorts,
      uniforms,
      fragmentShader: multiPasses.at(-1)?.fragmentShader ?? '',
      executionPlan: buildMaterialExecutionPlan(graph, analysis),
      passes: multiPasses,
    };
  }
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const expressions = new Map<string, string>();
  const inputPorts = new Set<string>();
  const uniforms = new Map<string, MaterialUniformBinding>();
  for (const id of analysis.order) {
    const node = nodes.get(id);
    if (node === undefined) continue;
    const input = (name: string): string => {
      const binding = node.inputs[name];
      if (binding === undefined) throw new TypeError(`Node ${node.id} is missing ${name}`);
      return bindingExpression(binding, expressions, inputPorts, uniforms);
    };
    const binding = (name: string): GraphBinding => {
      const value = node.inputs[name];
      if (value === undefined) throw new TypeError(`Node ${node.id} is missing ${name}`);
      return value;
    };
    expressions.set(id, nodeExpression(node.type, input, binding, options));
  }
  const output = graph.outputs.result ?? Object.values(graph.outputs)[0];
  if (output === undefined) throw new TypeError('Material graph has no output');
  const resultExpression = expressions.get(output.node);
  if (resultExpression === undefined) throw new TypeError('Material graph output is unavailable');
  const samplerDeclarations = [...inputPorts]
    .map((port) => `uniform sampler2D u_input_${identifier(port)};`)
    .join('\n');
  const uniformDeclarations = [...uniforms.values()].map((value) => `uniform float ${value.name};`).join('\n');
  const compiledHash = graphHash({
    ...graph,
    ...(options.specializationValues === undefined ? {} : { specializationValues: options.specializationValues }),
  });
  let webgpu: ReturnType<typeof compileMaterialGraphToWebGpu> | undefined;
  try {
    webgpu = compileMaterialGraphToWebGpu(graph, options);
  } catch {
    webgpu = undefined;
  }
  return {
    backend: 'webgl2',
    nodeSet: graph.nodeSet,
    graphHash: compiledHash,
    inputPorts: [...inputPorts],
    uniforms: [...uniforms.values()],
    executionPlan: buildMaterialExecutionPlan(graph, analysis),
    fragmentShader: `#version 300 es
precision highp float;
${samplerDeclarations}
${uniformDeclarations}
in vec2 v_uv;
out vec4 out_color;
${HELPERS}
void main() { out_color = ${resultExpression}; }
`,
    ...(webgpu === undefined ? {} : { webgpu }),
  };
}
