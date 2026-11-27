import { throwIfAborted, type Disposable } from '@aelionsdk/core';

export interface FontAssetRegistration {
  readonly id: string;
  readonly family: string;
  readonly source: ArrayBuffer;
  readonly descriptors?: FontFaceDescriptors;
}

export interface FontManagerSnapshot {
  readonly loadedFonts: number;
  readonly loadedBytes: number;
  readonly maxFonts: number;
  readonly maxBytes: number;
}

/** Bounded explicit font loader. Export can fail closed instead of using an unknown system fallback. */
export class BrowserFontManager implements Disposable {
  readonly #faces = new Map<string, { face: FontFace; bytes: number }>();
  readonly #fontSet: FontFaceSet;
  readonly #maxFonts: number;
  readonly #maxBytes: number;
  #loadedBytes = 0;
  #disposed = false;

  public get disposed(): boolean {
    return this.#disposed;
  }

  public constructor(
    options: {
      readonly fontSet?: FontFaceSet;
      readonly maxFonts?: number;
      readonly maxBytes?: number;
    } = {},
  ) {
    const defaultFontSet = typeof document === 'undefined' ? undefined : document.fonts;
    const fontSet = options.fontSet ?? defaultFontSet;
    if (fontSet === undefined) {
      throw new DOMException('FontFaceSet is unavailable in this execution context', 'NotSupportedError');
    }
    this.#fontSet = fontSet;
    this.#maxFonts = options.maxFonts ?? 32;
    this.#maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#maxFonts) || this.#maxFonts <= 0) {
      throw new RangeError('FONT_LIMIT_INVALID');
    }
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes <= 0) {
      throw new RangeError('FONT_BYTE_LIMIT_INVALID');
    }
  }

  public snapshot(): FontManagerSnapshot {
    return {
      loadedFonts: this.#faces.size,
      loadedBytes: this.#loadedBytes,
      maxFonts: this.#maxFonts,
      maxBytes: this.#maxBytes,
    };
  }

  public async load(registration: FontAssetRegistration, signal?: AbortSignal): Promise<void> {
    if (this.#disposed) throw new ReferenceError('Font manager is disposed');
    if (this.#faces.has(registration.id)) throw new TypeError('FONT_ID_EXISTS');
    if (this.#faces.size >= this.#maxFonts || this.#loadedBytes + registration.source.byteLength > this.#maxBytes) {
      throw new RangeError('FONT_RESOURCE_LIMIT');
    }
    throwIfAborted(signal, 'Font load');
    const face = new FontFace(registration.family, registration.source.slice(0), registration.descriptors);
    await face.load();
    throwIfAborted(signal, 'Font load');
    this.#fontSet.add(face);
    this.#faces.set(registration.id, { face, bytes: registration.source.byteLength });
    this.#loadedBytes += registration.source.byteLength;
  }

  public resolveFallback(families: readonly string[], sample = 'Aa中🙂', fontSizePx = 16): string {
    for (const family of families) {
      const escaped = family.replaceAll('"', '\\"');
      if (this.#fontSet.check(`${fontSizePx.toString()}px "${escaped}"`, sample)) return family;
    }
    return 'sans-serif';
  }

  public requireAvailable(families: readonly string[], sample?: string): string {
    const resolved = this.resolveFallback(families, sample);
    if (resolved === 'sans-serif' && !families.includes('sans-serif')) {
      throw new ReferenceError(`FONT_MISSING: ${families.join(', ')}`);
    }
    return resolved;
  }

  public unload(id: string): boolean {
    const entry = this.#faces.get(id);
    if (entry === undefined) return false;
    this.#fontSet.delete(entry.face);
    this.#faces.delete(id);
    this.#loadedBytes -= entry.bytes;
    return true;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const entry of this.#faces.values()) this.#fontSet.delete(entry.face);
    this.#faces.clear();
    this.#loadedBytes = 0;
  }
}
