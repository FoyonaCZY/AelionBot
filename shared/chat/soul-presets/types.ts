export type SoulPresetId = 'default' | 'backend' | 'data' | 'writing' | 'research' | 'designer';
export type SoulPresetTable = Record<SoulPresetId, { name: string; soul: string }>;
