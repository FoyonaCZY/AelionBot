import type { Diagnostic } from './diagnostic.js';

/** BCP-47 locale tag, e.g. `en` or `zh-CN`. */
export type DiagnosticLocale = string;

/**
 * Localized message templates keyed by diagnostic `code` then locale. Templates
 * interpolate `{key}` placeholders from the diagnostic's `details` object; a
 * placeholder with no matching detail renders as an empty string.
 */
export type DiagnosticCatalog = Readonly<Record<string, Readonly<Record<DiagnosticLocale, string>>>>;
/**
 * Return a copy of `diagnostic` whose `message` is the localized template for
 * `locale`, or the original `diagnostic` unchanged when the catalog has no
 * template for its `code`. The stable `code`, structured fields and
 * `recoverable` flag are never altered, so callers can keep branching on the
 * code while rendering a localized message.
 */
export function localizeDiagnostic<T extends Diagnostic>(
  diagnostic: T,
  catalog: DiagnosticCatalog,
  locale: DiagnosticLocale,
): T {
  const template = catalog[diagnostic.code]?.[locale];
  if (template === undefined) return diagnostic;
  const details = diagnostic.details;
  const message = template.replace(/\{([a-zA-Z0-9_]+)\}/gu, (_, key: string) => {
    const value = details?.[key];
    // Interpolate primitives only; objects would render as '[object Object]'.
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
  });
  return { ...diagnostic, message };
}

/**
 * Localize every diagnostic in a result array. Unknown codes pass through with
 * their original English message.
 */
export function localizeDiagnostics<T extends Diagnostic>(
  diagnostics: readonly T[],
  catalog: DiagnosticCatalog,
  locale: DiagnosticLocale,
): readonly T[] {
  return diagnostics.map((diagnostic) => localizeDiagnostic(diagnostic, catalog, locale));
}

/**
 * English message templates for the most common documented diagnostic codes.
 * Applications extend this with additional locales; unknown codes fall back to
 * the original English `message`.
 */
export const defaultDiagnosticCatalog: DiagnosticCatalog = {
  PROJECT_ENTITY_KEY_MISMATCH: {
    en: '{collection} key {key} does not match entity id {id}',
  },
  PROJECT_REFERENCE_MISSING: { en: 'Reference {id} does not exist in {collection}' },
  PROJECT_DUPLICATE_REFERENCE: { en: 'Duplicate reference {value}' },
  PROJECT_HOST_MISMATCH: { en: '{entity} {id} belongs to another {host}' },
  PROJECT_MATERIAL_ORPHAN: { en: 'Material instance {id} has no owner' },
  PROJECT_IMAGE_SEQUENCE_FRAME_MISSING: {
    en: 'Image sequence {id} references missing frame Asset {frameAssetId}',
  },
  PROJECT_IMAGE_SEQUENCE_FRAME_KIND_INVALID: {
    en: 'Frame Asset {frameAssetId} of image sequence {id} must be an image Asset',
  },
  MEDIA_INPUT_INVALID: { en: 'Input media is unsupported or corrupt: {cause}' },
  OPERATION_ABORTED: { en: '{operation} was aborted' },
};
