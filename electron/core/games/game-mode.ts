/**
 * The rules side of a match (docs/ai-party-games-design.md §1). The runtime owns scheduling, model calls,
 * retries, pauses, persistence and the run record; a game mode owns everything a specific game decides:
 * how a match starts, which actions are legal, how they advance it, and what each seat may see.
 */
import type {
  GameAction,
  GameLog,
  GameModeId,
  GamePhase,
  GamePlayer,
  GameRequest,
  GameRole,
  GameStatus,
  GameTrace,
  GameView,
} from '../../../shared/types/game-types';
import type { MatchFacts } from '../persona/match-facts';
import type { PersonaDecision, PersonaSeed, SeatPersona } from './persona-play';

/** Fields every match has, whatever the game. Game-specific state lives in the mode's own fields. */
export interface MatchState {
  /** Missing on matches saved before game modes existed; those are all Werewolf. */
  mode?: GameModeId;
  /** Winning team. Missing while running and when the match was stopped without a result. */
  winner?: string;
  id: string;
  groupId: string;
  day: number;
  phase: GamePhase;
  status: GameStatus;
  seats: (GamePlayer & { alive: boolean; role: GameRole })[];
  logs: GameLog[];
  requests: GameRequest[];
  accepted: string[];
  error?: string;
  trace?: GameTrace[];
  revision?: number;
  /** Seed behind every random draw of the match; keeps replays reproducible. Never sent to clients. */
  seed?: number;
  /** Each seat's last few decision notes, kept across phases so the next decision can read its own plan. */
  notes?: Record<string, string[]>;
  /** Durable acknowledgement of all post-match effects; missing receipts are replayed after restart. */
  settlementComplete?: boolean;
  /** Latest pre-receipt checkpoint only: may already have an unkeyed legacy report. */
  settlementLegacy?: boolean;
  /** New decisions record model interpretations separately from long-term trait growth. */
  personaPolicy?: 'model_semantic_v1';
  /** Bot seats' persona for this match. Private to each seat until the reveal. */
  persona?: Record<string, SeatPersona>;
  personaDraws?: number;
  /** Key decisions made under personality, used for growth at settlement. */
  decisions?: PersonaDecision[];
}

interface GameSkill {
  id: string;
  title: string;
  version: string;
  content: string;
}

export interface GameMode<S extends MatchState = MatchState> {
  id: GameModeId;
  /** Throws when this game cannot be played with this many seats. Checked before anything else. */
  checkSeats(count: number): void;
  /** Start a match. Throws when the players or options do not fit this game. */
  create(input: { groupId: string; players: GamePlayer[]; board?: GameView['board']; blank?: boolean }): S;
  /** Rule description recorded in the run record when the match is created. */
  describe(s: S, aiTimeoutMs: number): string;
  validate(s: S, request: GameRequest, action: GameAction): void;
  accept(s: S, requestId: string, action: GameAction, timeout?: boolean): void;
  /** What a human seat submits when its deadline passes. */
  timeoutAction(request: GameRequest): GameAction;
  view(s: S, viewerId?: string, omniscient?: boolean): GameView;
  /** System prompt and input sent to the model; they may only use what `view` gave this seat. */
  instructions(context: GameView, request: GameRequest): string;
  prompt(context: GameView, request: GameRequest): string;
  skills(context: GameView, request: GameRequest): GameSkill[];
  /** The finished match in the persona module's terms (docs/ai-party-games-design.md §2.2). */
  facts(s: S): MatchFacts;
  /** Personality hooks: an opening plan per Bot seat, and a choice among reasonable candidates. */
  persona?: {
    assign(s: S, seeds: Record<string, PersonaSeed>): void;
    pick(
      s: S,
      request: GameRequest,
      action: GameAction,
      valid: (a: GameAction) => boolean,
      actorInput?: string,
    ): { action: GameAction; decision?: PersonaDecision };
  };
}

export function log(s: MatchState, text: string, seatId?: string, audience?: string[]) {
  s.logs.push({ id: s.logs.length + 1, day: s.day, phase: s.phase, text, seatId, audience, time: Date.now() });
}
/** Persona of Bot seats in a view: the viewer's own while running, every seat's after the reveal. */
export function personaView(s: MatchState, viewerId: string | undefined, reveal: boolean) {
  if (!s.persona) return {};
  const persona: NonNullable<GameView['persona']> = {};
  for (const [seatId, p] of Object.entries(s.persona))
    if (reveal || seatId === viewerId)
      persona[seatId] = {
        botId: p.botId,
        traits: p.traits,
        mbti: p.mbti,
        ...(p.plan ? { plan: { id: p.plan.id, name: p.plan.name, detail: p.plan.detail } } : {}),
        ...(reveal ? { overrides: (s.decisions || []).filter((d) => d.seatId === seatId && d.overridden).length } : {}),
      };
  return Object.keys(persona).length ? { persona } : {};
}
/**
 * The log as one seat may read it: shared lines, and private lines addressed to it. After the reveal everyone reads
 * everything, and other seats' private system lines are labelled with whose they were.
 */
export function viewLogs(s: MatchState, viewerId: string | undefined, reveal: boolean): GameView['logs'] {
  return s.logs
    .filter((e) => !e.audience || reveal || (!!viewerId && e.audience.includes(viewerId)))
    .map(({ audience, ...e }) => {
      const otherPrivate = reveal && audience && !e.seatId && !(viewerId && audience.includes(viewerId));
      const owners = audience?.map((id) => s.seats.find((p) => p.id === id)?.name || '玩家').join('、');
      return {
        ...e,
        text: otherPrivate ? `【${owners} · 私有记录】${e.text.replace(/^你/, owners || '该玩家')}` : e.text,
        scope: audience ? ('personal' as const) : ('shared' as const),
      };
    });
}
