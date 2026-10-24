import type { ModelSelection } from './core';
import type { GameBehaviorPolicy, GameMbti } from '../games/game-personality';
/** Games the runtime can host; each has a game mode in electron/core/games/modes.ts. */
export type GameModeId = 'werewolf' | 'undercover' | 'doudizhu' | 'mahjong';
export type GameRole =
  | 'wolf'
  | 'seer'
  | 'witch'
  | 'villager'
  | 'hunter'
  | 'idiot'
  | 'guard'
  // Who's the Spy (谁是卧底)
  | 'civilian'
  | 'undercover'
  | 'blank'
  // Dou Di Zhu (斗地主): one landlord against two farmers.
  | 'landlord'
  | 'farmer'
  // Mahjong (麻将): the dealer and the other three.
  | 'dealer'
  | 'player';
export type GamePhase = 'night' | 'speech' | 'vote' | 'election' | 'resolution' | 'bid' | 'play' | 'finished';
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
  /** A personality preset for this match only; a member Bot's own profile is left as it is. */
  preset?: string;
}
/** Structured facts the rules engine records for post-match settlement; logs stay human-readable text. */
export type GameEvent =
  | { type: 'exile'; day: number; seatId: string; voters: string[] }
  | { type: 'save'; day: number; witchId: string; seatId: string }
  | { type: 'inspect'; day: number; seerId: string; seatId: string; wolf: boolean }
  | { type: 'elect'; day: number; seatId?: string; applicants: string[]; withdrawn?: string[] }
  | { type: 'blank_guess'; day: number; seatId: string; correct: boolean };
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
    | 'pk_speak'
    // Who's the Spy: describe your word without saying it; a voted-out blank guesses the civilians' word.
    | 'describe'
    | 'blank_guess'
    // Dou Di Zhu: bid for landlord, then play a combination (or pass).
    | 'bid'
    | 'play'
    // Mahjong: on your own turn discard (or win, or declare a kong); on another's discard claim it (or pass).
    | 'discard'
    | 'claim';
  /** For card and tile games every legal move is listed here, and `targets` holds their ids. */
  targets: string[];
  /** What each target means, as the table and the model read it; card games list every legal move. */
  options?: GameOption[];
  /** The seat may pass ({ skip: true }) instead of choosing a target. */
  canPass?: boolean;
  /** Card and tile games with table talk on: the move may carry one short line of talk (`text`). */
  talk?: boolean;
  witch?: { victim?: string; canSave: boolean; canPoison: boolean };
  deadlineAt?: number;
  remainingMs?: number;
}
/** One legal move of a card or tile game. */
export interface GameOption {
  id: string;
  /** How the move reads, such as 「三带一 777+3」 or 「打 5万」. */
  label: string;
  /** Dou Di Zhu: the ranks played. Mahjong: the tile discarded or claimed. */
  cards?: string[];
  /** Mahjong discards: what the hand needs afterwards, worked out for the player (same helper for people and AI). */
  hint?: string;
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
  /** Missing on views from before game modes existed; those are all Werewolf. */
  mode?: GameModeId;
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
  /** Werewolf: wolves or village. Who's the Spy: civilian, undercover or blank. Dou Di Zhu: landlord or farmer.
   *  Mahjong: hu when a seat won, draw when the wall ran out. */
  winner?: 'wolves' | 'village' | 'civilian' | 'undercover' | 'blank' | 'landlord' | 'farmer' | 'hu' | 'draw';
  /** Dou Di Zhu table as this viewer may see it. */
  cards?: DoudizhuTable;
  /** Mahjong table as this viewer may see it. */
  tiles?: MahjongTable;
  /** Who's the Spy: the viewer's own word, and both words once they may be known. */
  words?: { own?: string; civilian?: string; undercover?: string };
  /** When a finished match ended (ms); its report card sits at that point of the group timeline. */
  endedAt?: number;
  error?: string;
  humanId?: string;
  /** totalMs: the whole time allowed for the move being timed, where the game says. */
  clock?: { deadlineAt?: number; remainingMs?: number; seatId?: string; totalMs?: number };
  /** The viewer's own recent decision notes in this match (newest last); never other seats'. */
  notes?: string[];
  /** Persona of Bot seats: the viewer's own while running, every seat's after the reveal. */
  persona?: Record<string, GameSeatPersona>;
}
interface DoudizhuTable {
  /** The viewer's own cards (ids such as ♠10, 小王), sorted low to high. */
  hand?: string[];
  /** Every hand, once they may all be seen (after the match, or watched with full view). */
  hands?: Record<string, string[]>;
  counts: Record<string, number>;
  /** Each seat's bid: 0 is a pass; missing has not bid yet. */
  bids: Record<string, number>;
  landlordId?: string;
  /** The three hole cards, shown once a landlord takes them. */
  kitty?: string[];
  /** The highest bid so far; the base of the score. */
  bid: number;
  /** Doubled by each bomb, rocket and a spring. */
  multiplier: number;
  /** The play to beat in this trick. */
  lead?: { seatId: string; cards: string[]; label: string };
  /** Each seat's last move in the current trick, for the table. */
  last: Record<string, { cards?: string[]; label: string; pass?: boolean }>;
  /** Every card played so far, for the card counter (the same one the AI players get). */
  played: string[];
  /** Points each seat won (+) or lost (−), once the match is over. */
  scores?: Record<string, number>;
  spring?: boolean;
}
export interface MahjongMeld {
  kind: 'peng' | 'gang' | 'angang';
  tile: string;
  from?: string;
}
interface MahjongTable {
  /** The viewer's tiles (codes such as 5m, E), sorted; the tile just drawn is last and also named in `drawn`. */
  hand?: string[];
  drawn?: string;
  hands?: Record<string, string[]>;
  counts: Record<string, number>;
  melds: Record<string, MahjongMeld[]>;
  discards: Record<string, string[]>;
  /** Tiles left in the wall. */
  wall: number;
  dealerId: string;
  turnId?: string;
  lastDiscard?: { seatId: string; tile: string };
  win?: { seatId: string; fromId?: string; tile: string; selfDrawn: boolean; fans: { name: string; fan: number }[] };
  scores?: Record<string, number>;
}
interface GameSeatPersona {
  botId: string;
  traits: import('../persona/persona-model').Traits;
  mbti: string;
  plan?: { id: string; name: string; detail: string };
  /** How it talks: a preset's habits and catchphrases. */
  voice?: string;
  /** Key decisions where personality chose a reasonable alternative to the model's first pick. */
  overrides?: number;
}
export interface GameCreate {
  /** Defaults to Werewolf. */
  mode?: GameModeId;
  groupId: string;
  board?: 'standard12' | 'guard12';
  /** Who's the Spy: add a blank (a player with no word); only with seven or more players. */
  blank?: boolean;
  /** Dou Di Zhu and Mahjong: AI players may add a line of table talk to a move. Off unless asked for, since talk
   *  can give a hand away. */
  tableTalk?: boolean;
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
