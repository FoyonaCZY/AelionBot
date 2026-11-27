import type { JsonObject, JsonValue } from '@aelionsdk/core';
import type { AelionProject } from '@aelionsdk/project-schema';

import {
  ProjectBuilder,
  type AddAssetOptions,
  type AddCaptionClipOptions,
  type AddImageClipOptions,
  type AddMaterialInstanceOptions,
  type AddMediaClipOptions,
  type AddShapeClipOptions,
  type AddTextClipOptions,
  type AddTrackOptions,
  type ClipAnimatableProperty,
  type CreateProjectOptions,
  type Keyframe,
  type SetMaskOptions,
  type SetVisualOptions,
} from './project-builder.js';

export interface LayerOptions {
  readonly id?: string;
  readonly name?: string;
  readonly enabled?: boolean;
  readonly locked?: boolean;
}

export interface MaterialOptions extends Omit<AddMaterialInstanceOptions, 'id' | 'parameters' | 'name'> {
  readonly name?: string;
  readonly parameters?: JsonObject;
}

export interface ApplyMaterialOptions {
  readonly id?: string;
  readonly name?: string;
  readonly parameters?: JsonObject;
}

export interface CompositionTransitionOptions extends Omit<ApplyMaterialOptions, 'id'> {
  readonly transitionId?: string;
  readonly materialInstanceId?: string;
  readonly atUs: number;
  readonly durationUs: number;
}

function mergeParameters(defaults: JsonObject | undefined, overrides: JsonObject | undefined): JsonObject {
  return { ...(defaults ?? {}), ...(overrides ?? {}) };
}

/** Reusable Material definition. Each use creates a separately owned Project instance. */
export class Material {
  public constructor(
    private readonly builder: ProjectBuilder,
    private readonly options: MaterialOptions,
  ) {}

  public instantiate(options: ApplyMaterialOptions = {}): string {
    return this.builder.addMaterialInstance({
      ...this.options,
      ...(options.id === undefined ? {} : { id: options.id }),
      ...((options.name ?? this.options.name) === undefined ? {} : { name: options.name ?? this.options.name }),
      parameters: mergeParameters(this.options.parameters, options.parameters),
    });
  }
}

/** Fluent handle for a Project Item. */
export class Clip {
  public constructor(
    public readonly id: string,
    public readonly layer: Layer,
    private readonly builder: ProjectBuilder,
  ) {}

  public effect(material: Material, options: ApplyMaterialOptions = {}): this {
    this.builder.attachEffect(this.id, material.instantiate(options));
    return this;
  }

  public mask(source: Clip, options: Omit<SetMaskOptions, 'sourceItemId'> = {}): this {
    this.builder.setMask(this.id, { ...options, sourceItemId: source.id });
    return this;
  }

  public keyframes<T extends JsonValue>(property: ClipAnimatableProperty, values: readonly Keyframe<T>[]): this {
    this.builder.setKeyframes(this.id, property, values);
    return this;
  }

  public visual(options: SetVisualOptions): this {
    this.builder.setVisual(this.id, options);
    return this;
  }
}

/** Ordered Composition layer backed by a schema-valid Aelion Track. */
export class Layer {
  public readonly id: string;

  public constructor(
    public readonly kind: AddTrackOptions['kind'],
    private readonly builder: ProjectBuilder,
    options: LayerOptions = {},
  ) {
    this.id = builder.addTrack({ kind, ...options });
  }

  public video(options: Omit<AddMediaClipOptions, 'kind' | 'trackId'>): Clip {
    this.#expect('visual', 'video');
    return this.#clip(this.builder.addMediaClip({ ...options, kind: 'video', trackId: this.id }));
  }

  public audio(options: Omit<AddMediaClipOptions, 'kind' | 'trackId'>): Clip {
    this.#expect('audio', 'audio');
    return this.#clip(this.builder.addMediaClip({ ...options, kind: 'audio', trackId: this.id }));
  }

  public image(options: Omit<AddImageClipOptions, 'trackId'>): Clip {
    this.#expect('visual', 'image');
    return this.#clip(this.builder.addImageClip({ ...options, trackId: this.id }));
  }

  public text(options: Omit<AddTextClipOptions, 'trackId'>): Clip {
    this.#expect('visual', 'text');
    return this.#clip(this.builder.addTextClip({ ...options, trackId: this.id }));
  }

  public caption(options: Omit<AddCaptionClipOptions, 'trackId'>): Clip {
    this.#expect('caption', 'caption');
    return this.#clip(this.builder.addCaptionClip({ ...options, trackId: this.id }));
  }

  public shape(options: Omit<AddShapeClipOptions, 'trackId'>): Clip {
    this.#expect('visual', 'shape');
    return this.#clip(this.builder.addShapeClip({ ...options, trackId: this.id }));
  }

  #clip(id: string): Clip {
    return new Clip(id, this, this.builder);
  }

  #expect(expected: AddTrackOptions['kind'], content: string): void {
    if (this.kind !== expected) {
      throw new TypeError(`${content} Clips require a ${expected} Layer`);
    }
  }
}

/**
 * Product-level authoring API. It keeps Composition/Layer/Clip ergonomics while
 * producing the same portable, validator-backed Project document as ProjectBuilder.
 */
export class Composition {
  readonly #builder: ProjectBuilder;

  public constructor(options: CreateProjectOptions = {}) {
    this.#builder = new ProjectBuilder(options);
  }

  public get projectId(): string {
    return this.#builder.projectId;
  }

  public get sequenceId(): string {
    return this.#builder.sequenceId;
  }

  public asset(options: AddAssetOptions): this {
    this.#builder.addAsset(options);
    return this;
  }

  public layer(kind: AddTrackOptions['kind'], options: LayerOptions = {}): Layer {
    return new Layer(kind, this.#builder, options);
  }

  public material(options: MaterialOptions): Material {
    return new Material(this.#builder, options);
  }

  public transition(from: Clip, to: Clip, material: Material, options: CompositionTransitionOptions): string {
    if (from.layer !== to.layer) throw new TypeError('Transition Clips must share a Layer');
    const materialInstanceId = material.instantiate({
      ...(options.materialInstanceId === undefined ? {} : { id: options.materialInstanceId }),
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.parameters === undefined ? {} : { parameters: options.parameters }),
    });
    return this.#builder.addTransition({
      ...(options.transitionId === undefined ? {} : { id: options.transitionId }),
      fromItemId: from.id,
      toItemId: to.id,
      materialInstanceId,
      atUs: options.atUs,
      durationUs: options.durationUs,
    });
  }

  public build(): Readonly<AelionProject> {
    return this.#builder.build();
  }

  /** Escape hatch for advanced, schema-level operations without changing document semantics. */
  public advanced(): ProjectBuilder {
    return this.#builder;
  }
}

export function createComposition(options: CreateProjectOptions = {}): Composition {
  return new Composition(options);
}
