export type DesignFontStyle = 'normal' | 'italic';
export type DesignFontFormat = 'woff2' | 'woff' | 'ttf' | 'otf';
export interface DesignFontFile {
  /** Path relative to the design workspace. */
  path: string;
  weight: number;
  /** Variable font weight range, when present. */
  weightRange?: [number, number];
  style: DesignFontStyle;
  format: DesignFontFormat;
  sha256: string;
  bytes: number;
  subset?: string;
  unicodeRange?: string;
}
export interface DesignFont {
  /** Computed by list(); false when tracked font bytes or generated CSS are missing/modified. */
  available?: boolean;
  issues?: string[];
  id: string;
  family: string;
  source: 'fontsource' | 'import';
  version?: string;
  weights: number[];
  styles: DesignFontStyle[];
  subsets: string[];
  files: DesignFontFile[];
  cssPath: string;
  license: { name: string; path?: string; url?: string; note?: string };
  addedAt: string;
}
export interface DesignFontCatalogEntry {
  id: string;
  family: string;
  category: string;
  weights: number[];
  styles: DesignFontStyle[];
  subsets: string[];
  cached?: boolean;
  /** Already in the user's font library. */
  inLibrary?: boolean;
}
/** A family in the user's font library (Settings → Design → Fonts), stored outside any task. */
export interface DesignLibraryFont extends DesignFont {
  /** Fontsource id of a downloaded family. */
  fontsourceId?: string;
  category?: string;
  /** The specimen should show Chinese text. */
  cjk?: boolean;
  /** Total bytes of the font files. */
  bytes: number;
}
/** Font slices for a Settings specimen; the renderer turns each into a FontFace. */
export interface DesignFontPreview {
  family: string;
  faces: Array<{ data: Uint8Array; weight: string; style: DesignFontStyle; unicodeRange?: string }>;
}
export interface DesignFontAcquire {
  fontId: string;
  weights?: number[];
  styles?: DesignFontStyle[];
  subsets?: string[];
}
export interface DesignFontCheck {
  fonts: Array<{
    id: string;
    family: string;
    valid: boolean;
    missingFiles: string[];
    missingCharacters: string[];
    checkedCharacters: number;
  }>;
  cssPath: string;
  cssValid: boolean;
}
