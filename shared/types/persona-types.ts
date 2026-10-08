import type { Features, Scope, Traits } from '../persona/persona-model';
import type { GrowthReviewState } from './persona-growth-types';

/** One Bot's personality (personality doc §13 PersonaProfile). `anchor` is trait0, the value growth is pulled back to. */
export interface PersonaProfile {
  botId: string;
  traits: Traits;
  anchor: Traits;
  /** Experiences with an outcome so far; the learning rate falls as it grows (§8.4). */
  n: number;
  locked: boolean;
  /** Where the anchor came from: a preset MBTI, the model answering the BFI-2 facets, or the user. */
  source: 'mbti' | 'bfi2' | 'user';
  confirmed: boolean;
  lastPlans: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}
/** One experience with a direct outcome and the change it caused (§13 Episode). */
export interface PersonaEpisode {
  id: string;
  botId: string;
  scope: Scope;
  sourceId: string;
  kind: string;
  /** Plain description, e.g. 「投票给 3 号，揭晓是狼人」. */
  summary: string;
  s: Features;
  o: number;
  delta: Traits;
  createdAt: number;
}
export interface PersonaTraitPoint {
  traits: Traits;
  createdAt: number;
  reason: string;
}
export interface PersonaHighlight {
  id: string;
  botId: string;
  scope: 'match' | 'group';
  sourceId: string;
  groupId: string;
  /** Bot ids and 'user'. */
  participants: string[];
  summary: string;
  type: string;
  createdAt: number;
  lastUsedAt?: number;
}
/** Everything the profile page shows (§14). */
export interface PersonaView {
  profile: PersonaProfile;
  mbti: string;
  history: PersonaTraitPoint[];
  episodes: PersonaEpisode[];
  /** Affinity towards other Bots and 'user', strongest first. */
  relations: { id: string; affinity: number }[];
  highlights: PersonaHighlight[];
  growthReview?: GrowthReviewState;
}
/** `mbti` is the Bot's game preset: a Bot without a profile yet starts from it (personality doc §8.1). */
export type PersonaAction =
  | { action: 'set'; traits: Traits }
  | { action: 'confirm' }
  | { action: 'lock'; locked: boolean }
  | { action: 'reset' }
  | { action: 'reviewGrowth' }
  | { action: 'undoGrowthReview'; reviewId: string }
  | { action: 'draft' };
export type PersonaUpdate = { botId: string; mbti?: string } & PersonaAction;
