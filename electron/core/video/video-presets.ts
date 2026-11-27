// Shared built-in Video Studio transitions, visual effects, and AMP material registration.
// Keep browser-safe (no Node built-ins) so both the hidden video engine and the preview player iframe can import it.
import type { JsonObject } from '@aelionsdk/core';
import {
  compileMaterialGraphToWebGl2,
  type MaterialGraph,
  type WebGl2MaterialProgram,
} from '@aelionsdk/material-compiler';
import type { IrMaterialDefinition } from '@aelionsdk/render-ir';
import { installMigrationMaterials, migrationMaterialPackage, type MigrationMaterialRegistry } from '@aelionsdk/sdk';
import type { VideoEffectPreset, VideoTransitionPreset } from '../../../shared/types/video-studio-types';

const STUDIO_INTEGRITY = `sha256:${'ab'.repeat(32)}` as const;

const STUDIO_MATERIAL_PACKAGE = Object.freeze({
  packageId: 'aelion.studio.builtin',
  packageVersion: '1.0.0',
  packageIntegrity: STUDIO_INTEGRITY,
});

export interface VideoTransitionPresetMeta {
  readonly preset: VideoTransitionPreset;
  readonly materialId: string;
  readonly defaultDurationUs: number;
  readonly definition: IrMaterialDefinition;
}

export const VIDEO_TRANSITION_PRESETS: Readonly<Record<VideoTransitionPreset, VideoTransitionPresetMeta>> = {
  'cross-dissolve': {
    preset: 'cross-dissolve',
    materialId: 'diffusion-dissolve',
    defaultDurationUs: 500_000,
    definition: { ...migrationMaterialPackage, materialId: 'diffusion-dissolve' },
  },
  'fade-black': {
    preset: 'fade-black',
    materialId: 'diffusion-fade-to-black',
    defaultDurationUs: 600_000,
    definition: { ...migrationMaterialPackage, materialId: 'diffusion-fade-to-black' },
  },
  'fade-white': {
    preset: 'fade-white',
    materialId: 'diffusion-fade-to-white',
    defaultDurationUs: 600_000,
    definition: { ...migrationMaterialPackage, materialId: 'diffusion-fade-to-white' },
  },
  'slide-left': {
    preset: 'slide-left',
    materialId: 'diffusion-slide-from-left',
    defaultDurationUs: 500_000,
    definition: { ...migrationMaterialPackage, materialId: 'diffusion-slide-from-left' },
  },
  'slide-right': {
    preset: 'slide-right',
    materialId: 'diffusion-slide-from-right',
    defaultDurationUs: 500_000,
    definition: { ...migrationMaterialPackage, materialId: 'diffusion-slide-from-right' },
  },
};

const GRAPH_SCHEMA = 'https://aelion.dev/schemas/material-graph-1.0.0.json';
const VISUAL_NODE_SET = 'aelion.visual/1.0.0';

const WARM_FILM_GRAPH: MaterialGraph = {
  $schema: GRAPH_SCHEMA,
  graphVersion: '1.0.0',
  nodeSet: VISUAL_NODE_SET,
  nodes: [
    {
      id: 'temp',
      type: 'color.temperature',
      typeVersion: '1.0.0',
      inputs: {
        source: { inputPort: 'source' },
        amount: { parameter: 'warmth' },
      },
    },
    {
      id: 'lift',
      type: 'color.lift-black',
      typeVersion: '1.0.0',
      inputs: {
        source: { node: 'temp', output: 'frame' },
        amount: { parameter: 'lift' },
      },
    },
    {
      id: 'contrast',
      type: 'color.contrast',
      typeVersion: '1.0.0',
      inputs: {
        source: { node: 'lift', output: 'frame' },
        amount: { parameter: 'contrast' },
      },
    },
  ],
  outputs: {
    result: { node: 'contrast', output: 'frame' },
  },
};

const SOFT_GLOW_GRAPH: MaterialGraph = {
  $schema: GRAPH_SCHEMA,
  graphVersion: '1.0.0',
  nodeSet: VISUAL_NODE_SET,
  nodes: [
    {
      id: 'highlights',
      type: 'color.extract-highlights',
      typeVersion: '1.0.0',
      inputs: {
        source: { inputPort: 'source' },
        threshold: { parameter: 'threshold' },
      },
    },
    {
      id: 'blur',
      type: 'blur.gaussian',
      typeVersion: '1.0.0',
      inputs: {
        source: { node: 'highlights', output: 'frame' },
        radiusPx: { parameter: 'radiusPx' },
      },
    },
    {
      id: 'scale',
      type: 'color.scale-rgb',
      typeVersion: '1.0.0',
      inputs: {
        source: { node: 'blur', output: 'frame' },
        scale: { parameter: 'intensity' },
      },
    },
    {
      id: 'screen',
      type: 'composite.screen',
      typeVersion: '1.0.0',
      inputs: {
        base: { inputPort: 'source' },
        overlay: { node: 'scale', output: 'frame' },
      },
    },
  ],
  outputs: {
    result: { node: 'screen', output: 'frame' },
  },
};

const CINEMATIC_GRAPH: MaterialGraph = {
  $schema: GRAPH_SCHEMA,
  graphVersion: '1.0.0',
  nodeSet: VISUAL_NODE_SET,
  nodes: [
    {
      id: 'temp',
      type: 'color.temperature',
      typeVersion: '1.0.0',
      inputs: {
        source: { inputPort: 'source' },
        amount: { parameter: 'temperature' },
      },
    },
    {
      id: 'contrast',
      type: 'color.contrast',
      typeVersion: '1.0.0',
      inputs: {
        source: { node: 'temp', output: 'frame' },
        amount: { parameter: 'contrast' },
      },
    },
    {
      id: 'sat',
      type: 'color.saturation',
      typeVersion: '1.0.0',
      inputs: {
        source: { node: 'contrast', output: 'frame' },
        amount: { parameter: 'saturation' },
      },
    },
    {
      id: 'lift',
      type: 'color.lift-black',
      typeVersion: '1.0.0',
      inputs: {
        source: { node: 'sat', output: 'frame' },
        amount: { parameter: 'lift' },
      },
    },
  ],
  outputs: {
    result: { node: 'lift', output: 'frame' },
  },
};

let compiledStudioProgramsCache: Readonly<
  Record<'warm-film' | 'soft-glow' | 'cinematic', WebGl2MaterialProgram>
> | null = null;

export function compiledStudioPrograms(): Readonly<
  Record<'warm-film' | 'soft-glow' | 'cinematic', WebGl2MaterialProgram>
> {
  if (compiledStudioProgramsCache !== null) return compiledStudioProgramsCache;
  compiledStudioProgramsCache = Object.freeze({
    'warm-film': compileMaterialGraphToWebGl2(WARM_FILM_GRAPH, {
      inputPorts: { source: 'visual-frame' },
      parameters: { warmth: 'float', lift: 'float', contrast: 'float' },
    }),
    'soft-glow': compileMaterialGraphToWebGl2(SOFT_GLOW_GRAPH, {
      inputPorts: { source: 'visual-frame' },
      parameters: { threshold: 'float', radiusPx: 'float', intensity: 'float' },
    }),
    cinematic: compileMaterialGraphToWebGl2(CINEMATIC_GRAPH, {
      inputPorts: { source: 'visual-frame' },
      parameters: { temperature: 'float', contrast: 'float', saturation: 'float', lift: 'float' },
    }),
  });
  return compiledStudioProgramsCache;
}

export interface VideoEffectPresetMeta {
  readonly preset: VideoEffectPreset;
  readonly definition: IrMaterialDefinition;
  readonly defaultIntensity: number;
  readonly defaultParams: Readonly<Record<string, number>>;
}

export const VIDEO_EFFECT_PRESETS: Readonly<Record<VideoEffectPreset, VideoEffectPresetMeta>> = {
  'warm-film': {
    preset: 'warm-film',
    definition: { ...STUDIO_MATERIAL_PACKAGE, materialId: 'studio-warm-film' },
    defaultIntensity: 1,
    defaultParams: { warmth: 0.16, lift: 0.04, contrast: 1.08 },
  },
  'soft-glow': {
    preset: 'soft-glow',
    definition: { ...STUDIO_MATERIAL_PACKAGE, materialId: 'studio-soft-glow' },
    defaultIntensity: 0.65,
    defaultParams: { threshold: 0.65, radiusPx: 14, intensity: 0.45 },
  },
  cinematic: {
    preset: 'cinematic',
    definition: { ...STUDIO_MATERIAL_PACKAGE, materialId: 'studio-cinematic' },
    defaultIntensity: 1,
    defaultParams: { temperature: -0.08, contrast: 1.18, saturation: 0.88, lift: 0.03 },
  },
  grayscale: {
    preset: 'grayscale',
    definition: { ...migrationMaterialPackage, materialId: 'diffusion-grayscale' },
    defaultIntensity: 1,
    defaultParams: { value: 100 },
  },
  sepia: {
    preset: 'sepia',
    definition: { ...migrationMaterialPackage, materialId: 'diffusion-sepia' },
    defaultIntensity: 1,
    defaultParams: { value: 100 },
  },
  blur: {
    preset: 'blur',
    definition: { ...migrationMaterialPackage, materialId: 'diffusion-blur' },
    defaultIntensity: 0.5,
    defaultParams: { value: 8 },
  },
  brightness: {
    preset: 'brightness',
    definition: { ...migrationMaterialPackage, materialId: 'diffusion-brightness' },
    defaultIntensity: 1.15,
    defaultParams: { value: 115 },
  },
  contrast: {
    preset: 'contrast',
    definition: { ...migrationMaterialPackage, materialId: 'diffusion-contrast' },
    defaultIntensity: 1.2,
    defaultParams: { value: 120 },
  },
  saturate: {
    preset: 'saturate',
    definition: { ...migrationMaterialPackage, materialId: 'diffusion-saturate' },
    defaultIntensity: 1.3,
    defaultParams: { value: 130 },
  },
  'hue-rotate': {
    preset: 'hue-rotate',
    definition: { ...migrationMaterialPackage, materialId: 'diffusion-hue-rotate' },
    defaultIntensity: 0.5,
    defaultParams: { value: 30 },
  },
};

export function registerBuiltinVideoMaterials(registry: MigrationMaterialRegistry): () => void {
  const disposers: Array<() => void> = [];
  disposers.push(installMigrationMaterials(registry));
  const programs = compiledStudioPrograms();
  disposers.push(registry.register(VIDEO_EFFECT_PRESETS['warm-film'].definition, programs['warm-film']));
  disposers.push(registry.register(VIDEO_EFFECT_PRESETS['soft-glow'].definition, programs['soft-glow']));
  disposers.push(registry.register(VIDEO_EFFECT_PRESETS.cinematic.definition, programs.cinematic));
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}

export function transitionDefinitionForPreset(preset: VideoTransitionPreset): IrMaterialDefinition {
  return { ...VIDEO_TRANSITION_PRESETS[preset].definition };
}

export function presetForTransitionDefinition(
  definition: Partial<IrMaterialDefinition> | undefined,
): VideoTransitionPreset | undefined {
  if (!definition?.materialId) return undefined;
  for (const meta of Object.values(VIDEO_TRANSITION_PRESETS)) {
    if (
      meta.definition.materialId === definition.materialId &&
      (!definition.packageId || definition.packageId === meta.definition.packageId)
    ) {
      return meta.preset;
    }
  }
  return undefined;
}

export function presetForEffectDefinition(
  definition: Partial<IrMaterialDefinition> | undefined,
): VideoEffectPreset | undefined {
  if (!definition?.materialId) return undefined;
  for (const meta of Object.values(VIDEO_EFFECT_PRESETS)) {
    if (
      meta.definition.materialId === definition.materialId &&
      (!definition.packageId || definition.packageId === meta.definition.packageId)
    ) {
      return meta.preset;
    }
  }
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function effectMaterialSpec(
  preset: VideoEffectPreset,
  options: {
    intensity?: number;
    params?: Record<string, number>;
    width?: number;
    height?: number;
  } = {},
): { definition: IrMaterialDefinition; parameters: JsonObject } {
  const meta = VIDEO_EFFECT_PRESETS[preset];
  const intensity = options.intensity ?? meta.defaultIntensity;
  const extra = options.params ?? {};
  const width = options.width ?? 1920;
  const height = options.height ?? 1080;

  let parameters: JsonObject;
  switch (preset) {
    case 'warm-film': {
      const k = clamp(intensity, 0, 2);
      parameters = {
        warmth: extra.warmth ?? Number((0.16 * k).toFixed(4)),
        lift: extra.lift ?? Number((0.04 * k).toFixed(4)),
        contrast: extra.contrast ?? Number((1 + 0.08 * k).toFixed(4)),
      };
      break;
    }
    case 'soft-glow': {
      const k = clamp(intensity, 0, 2);
      parameters = {
        threshold: extra.threshold ?? 0.65,
        radiusPx: extra.radiusPx ?? Math.max(1, Number((14 * Math.max(0.25, k)).toFixed(2))),
        intensity: extra.intensity ?? Number((0.65 * k).toFixed(4)),
      };
      break;
    }
    case 'cinematic': {
      const k = clamp(intensity, 0, 2);
      parameters = {
        temperature: extra.temperature ?? Number((-0.08 * k).toFixed(4)),
        contrast: extra.contrast ?? Number((1 + 0.18 * k).toFixed(4)),
        saturation: extra.saturation ?? Number(clamp(1 - 0.12 * k, 0, 2).toFixed(4)),
        lift: extra.lift ?? Number((0.03 * k).toFixed(4)),
      };
      break;
    }
    case 'grayscale':
    case 'sepia': {
      parameters = {
        value: extra.value ?? Number((clamp(intensity, 0, 1) * 100).toFixed(2)),
      };
      break;
    }
    case 'blur': {
      parameters = {
        value: extra.value ?? Number((clamp(intensity, 0, 4) * 16).toFixed(2)),
        width: extra.width ?? width,
        height: extra.height ?? height,
      };
      break;
    }
    case 'brightness':
    case 'contrast':
    case 'saturate': {
      // Allow intensity either as multiplier (0..3, e.g., 1.2 => 120) or explicit percentage via params.value
      const value = extra.value ?? Number((clamp(intensity, 0, 4) * 100).toFixed(2));
      parameters = { value };
      break;
    }
    case 'hue-rotate': {
      parameters = {
        value: extra.value ?? Number((intensity * 60).toFixed(2)),
      };
      break;
    }
  }

  return {
    definition: { ...meta.definition },
    parameters,
  };
}

export function effectIntensityFromParameters(preset: VideoEffectPreset, parameters: JsonObject): number {
  const num = (key: string, fallback: number) => {
    const raw = parameters[key];
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  };
  switch (preset) {
    case 'warm-film':
      return Number((num('warmth', 0.16) / 0.16).toFixed(3));
    case 'soft-glow':
      return Number((num('intensity', 0.45) / 0.65).toFixed(3));
    case 'cinematic':
      return Number(((num('contrast', 1.18) - 1) / 0.18).toFixed(3));
    case 'grayscale':
    case 'sepia':
    case 'brightness':
    case 'contrast':
    case 'saturate':
      return Number((num('value', 100) / 100).toFixed(3));
    case 'blur':
      return Number((num('value', 8) / 16).toFixed(3));
    case 'hue-rotate':
      return Number((num('value', 30) / 60).toFixed(3));
  }
}
