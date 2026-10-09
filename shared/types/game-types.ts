import type { ModelSelection } from './core';
import type { GameBehaviorPolicy, GameMbti } from '../games/game-personality';
export type GameRole = 'wolf' | 'seer' | 'witch' | 'villager' | 'hunter' | 'idiot' | 'guard';
export type GamePhase = 'night' | 'speech' | 'vote' | 'election' | 'resolution' | 'finished';
export type GameStatus = 'running' | 'paused' | 'finished';
export interface GamePlayer {
  id: string;
  name: string;
  color: string;
  human: boolean;
  mbti?: GameMbti;
  behaviorPolicy?: GameBehaviorPolicy;
  personality?: string;
  model?: ModelSelection;
  /** The group member Bot seated here; seat ids are random per match. Guests and the human have none. */
  botId?: string;
}
/** Structured facts the rules engine records for post-match settlement; logs stay human-readable text. */
export type GameEvent =
  | { type: 'exile'; day: number; seatId: string; voters: string[] }
  | { type: 'save'; day: number; witchId: string; seatId: string }
  | { type: 'inspect'; day: number; seerId: string; seatId: string; wolf: boolean }
  | { type: 'elect'; day: number; seatId?: string; applicants: string[]; withdrawn?: string[] };
interface GameSeat extends GamePlayer {
  alive: boolean;
  role?: GameRole;
  revealed?: boolean;
  canVote?: boolean;
}
export interface GameAction {
  formatNote?: string;
  target?: string;
  text?: string;
  endTurn?: boolean;
  note?: string;
  personalityNote?: string;
  potion?: 'save' | 'poison' | 'skip';
  choice?: boolean;
  skip?: boolean;
  direction?: 'clockwise' | 'counterclockwise';
  /** Model-labelled alternatives for a key decision (personality doc §9.4); the first is the model's own pick. */
  candidates?: import('../persona/persona-model').Candidate[];
}
export interface GameRequest {
  discussionRound?: 'proposal' | 'response' | 'confirm';
  id: string;
  seatId: string;
  kind:
    | 'wolf_plan'
    | 'kill'
    | 'inspect'
    | 'witch'
    | 'speak'
    | 'vote'
    | 'guard'
    | 'sheriff_join'
    | 'campaign'
    | 'withdraw'
    | 'sheriff_vote'
    | 'sheriff_order'
    | 'badge'
    | 'shoot'
    | 'last_words'
    | 'pk_speak';
  targets: string[];
  witch?: { victim?: string; canSave: boolean; canPoison: boolean };
  deadlineAt?: number;
  remainingMs?: number;
}
export interface GameLog {
  scope?: 'shared' | 'personal';
  id: number;
  day: number;
  phase: GamePhase;
  seatId?: string;
  text: string;
  audience?: string[];
  time?: number;
}
export interface GameView {
  revision?: number;
  id: string;
  groupId: string;
  board?: 'standard12' | 'guard12';
  sheriffId?: string;
  stage?: string;
  candidates?: string[];
  election?: { applicants: string[]; withdrawn: string[]; round: number; joining: boolean };
  day: number;
  phase: GamePhase;
  status: GameStatus;
  seats: GameSeat[];
  logs: GameLog[];
  pending: GameRequest[];
  winner?: 'wolves' | 'village';
  error?: string;
  humanId?: string;
  clock?: { deadlineAt?: number; remainingMs?: number; seatId?: string };
  /** The viewer's own recent decision notes in this match (newest last); never other seats'. */
  notes?: string[];
  /** Persona of Bot seats: the viewer's own while running, every seat's after the reveal. */
  persona?: Record<string, GameSeatPersona>;
}
interface GameSeatPersona {
  botId: string;
  traits: import('../persona/persona-model').Traits;
  mbti: string;
  plan?: { id: string; name: string; detail: string };
  /** Key decisions where personality chose a reasonable alternative to the model's first pick. */
  overrides?: number;
}
export interface GameCreate {
  groupId: string;
  board?: 'standard12' | 'guard12';
  players: GamePlayer[];
}
export interface GameAPI {
  inspect(input: { id: string }): Promise<GameTrace[]>;
  create(input: GameCreate): Promise<GameView>;
  read(input: { groupId: string; omniscient?: boolean }): Promise<GameView | null>;
  act(input: { id: string; requestId: string; action: GameAction }): Promise<GameView>;
  control(input: { id: string; action: 'pause' | 'resume' | 'stop' }): Promise<GameView>;
}

export interface GameTrace {
  /** Resolved request configuration only; never includes provider identifiers, URLs or credentials. */
  modelConfig?: GameModelConfig;
  /** True when the provider supplied the exact strings sent with this attempt. */
  requestCaptured?: boolean;
  metrics?: ResponseMetrics;
  seq: number;
  time: number;
  type:
    | 'created'
    | 'request_created'
    | 'model_response'
    | 'model_queued'
    | 'model_started'
    | 'model_returned'
    | 'model_failed'
    | 'model_cancelled'
    | 'reply_discarded'
    | 'action_accepted'
    | 'action_rejected'
    | 'timeout'
    | 'transition'
    | 'pause'
    | 'resume'
    | 'stop'
    | 'recovered'
    | 'failure_pause'
    | 'persona_plan'
    | 'persona_override';
  day: number;
  phase: GamePhase;
  seatId?: string;
  requestId?: string;
  kind?: GameRequest['kind'];
  attempt?: number;
  elapsedMs?: number;
  model?: string;
  detail?: string;
  input?: string;
  /** Raw reply excerpt when it could not be parsed as an action. */
  output?: string;
  instruction?: string;
  skills?: { id: string; title: string; version: string }[];
  action?: GameAction;
}

export interface GameModelConfig {
  model: string;
  protocol?: string;
  reasoningEffort?: string;
  contextTokens?: number;
  maxOutputTokens?: number;
}

export interface ResponseMetrics {
  httpStatus: number;
  headersMs: number;
  totalMs: number;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}
