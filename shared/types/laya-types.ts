export type LayaVariant = 'mlx' | 'standard';
export const DECISION_MODELS: ReadonlyArray<{ id: LayaVariant; name: string; packageName: string; modelId: string }> = [
  { id: 'standard', name: 'Laya 标准版', packageName: 'laya', modelId: 'convaiinnovations/laya-multilingual' },
  { id: 'mlx', name: 'Laya Mac 版', packageName: 'laya-mlx==0.2.0', modelId: 'aac6fef/laya-multilingual-mlx' },
];
export interface LayaFeatureState {
  phase: 'not-installed' | 'preparing' | 'installing' | 'loading' | 'cancelling' | 'ready' | 'disabled' | 'error';
  installed: LayaVariant[];
  enabled: boolean;
  active?: LayaVariant;
  recommended?: LayaVariant;
  downloading?: LayaVariant;
  error?: string;
  supported: boolean;
}

export function isLayaVariant(value: unknown): value is LayaVariant {
  return DECISION_MODELS.some((model) => model.id === value);
}
export type GroupChoice = 'observe' | 'participate';
export interface LayaPrediction {
  choice: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  model: string;
  runtime: LayaVariant;
  elapsedMs: number;
  inferenceMs?: number;
  activeMemoryBytes?: number;
  cacheMemoryBytes?: number;
}
interface DecisionMessage {
  from: { kind: 'user' | 'bot' | 'system'; name: string };
  text: string;
}
export interface GroupDecisionInput {
  bot: { name: string; soul: string };
  events: Array<DecisionMessage & { mentioned: boolean }>;
  recent: DecisionMessage[];
  myTask?: { title: string; status: import('./group-types').GroupTask['status'] };
  rootRequest?: string;
}
interface DecisionRecord extends LayaPrediction {
  sourceId: string;
  actorId: string;
  time?: string;
}
export interface GroupDecisionRecord extends DecisionRecord {
  scope: 'group';
  choice: GroupChoice;
  appliedChoice: GroupChoice;
  adjustment?: string;
  criteria?: Record<string, string>;
  features?: { events: number; recent: number; mentioned: boolean; ownTask: boolean };
  input?: GroupDecisionInput;
}
export type LayaDecisionRecord = GroupDecisionRecord | (DecisionRecord & { scope: 'game' | 'game_speech' });
