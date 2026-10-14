/**
 * What a finished match tells the persona module, whatever the game (docs/ai-party-games-design.md §2.2).
 * Each game mode translates its own rules into these facts; the persona module never reads game rules.
 */
import type { Experience } from '../../../shared/persona/persona-model';
import type { PersonaDecision, SeatPersona } from '../games/persona-play';

/** Seat ids are per match; botId is the member Bot. */
interface FactSeat {
  id: string;
  name: string;
  human: boolean;
  botId?: string;
  /** Team the seat played for. Games without teams give every seat its own; cooperative games give one to all. */
  team: string;
  /** Role as people read it, such as 狼人. */
  role: string;
  /** Where "the plan this Bot used last time in this role" is remembered, for f_explore. */
  planKey?: string;
}
/**
 * Something one player did to another that the rules can confirm. `name` is the stable label used for the
 * affinity source and the highlight type. Texts name seats as {to} and {from}; names are filled in only after
 * forgotten members are removed, so a deleted Bot is never written back into anyone's memories.
 */
export type SocialFact =
  | {
      /** `from` voted their own teammate `to` out. Could be tactics or a mistake: remembered, never a grudge. */
      type: 'ally_vote';
      name: string;
      to: string;
      from: string[];
      key: string;
      highlight: string;
    }
  | {
      /** `from` directly helped `to`. */
      type: 'aid';
      name: string;
      from: string;
      to: string;
      key: string;
      highlight: string;
    };
export interface MatchExperience extends Experience {
  botId: string;
  kind: string;
  summary: string;
  growthDisposition?: 'record_only';
  /** Seats the episode is about. It is dropped when any of them belongs to a forgotten member. */
  seats: string[];
}
export interface MatchFacts {
  id: string;
  groupId: string;
  /** Name of the game in reports, such as 狼人杀. */
  game: string;
  seats: FactSeat[];
  /** Winning teams. Missing when the match was stopped without a result; such a match is never settled. */
  winners?: string[];
  /** One line on how the match ended, such as 好人阵营获胜. */
  result: string;
  social: SocialFact[];
  experiences: MatchExperience[];
  /** New matches retain same-team votes as a fact without inferring betrayal or a grudge. */
  personaPolicy?: 'model_semantic_v1';
  decisions?: PersonaDecision[];
  persona?: Record<string, SeatPersona>;
}
