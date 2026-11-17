export type SoulPresetId =
  | 'default'
  | 'backend'
  | 'frontend'
  | 'data'
  | 'writing'
  | 'research'
  | 'designer'
  | 'translator'
  | 'marketing'
  | 'tutor'
  | 'finance'
  | 'life';
/** `summary` is the one line a template shows in the New Bot form. */
export type SoulPresetTable = Record<SoulPresetId, { name: string; summary: string; soul: string }>;
