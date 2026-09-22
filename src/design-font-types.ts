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
  license: {name: string; path?: string; url?: string; note?: string};
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
}
export interface DesignFontAcquire {
  fontId: string;
  weights?: number[];
  styles?: DesignFontStyle[];
  subsets?: string[];
}
export interface DesignFontCheck {
  fonts: Array<{id: string; family: string; valid: boolean; missingFiles: string[]; missingCharacters: string[]; checkedCharacters: number}>;
  cssPath: string;
  cssValid: boolean;
}
