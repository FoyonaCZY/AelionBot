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
/**
 * One question per message: should this Bot respond? Short, decisive fields come first because an
 * over-long input is truncated at the end.
 */
export interface GroupDecisionInput {
  bot: { name: string; role: string };
  /** What the Bot is doing now, such as "在做：导出页面（计划 3/5）". */
  work: string;
  message: DecisionMessage;
  repliedTo?: DecisionMessage;
  /** The addressed Bot's first answer, when this Bot waited for it. */
  answer?: DecisionMessage;
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
  /** Only in records written before Laya became a single relevance question. */
  adjustment?: string;
  criteria?: Record<string, string>;
  features?: { repliedTo: boolean; answered: boolean; working: boolean };
  input?: GroupDecisionInput;
}
