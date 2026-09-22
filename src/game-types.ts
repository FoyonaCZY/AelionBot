import type {ModelSelection} from './shared';
import type {GameBehaviorPolicy,GameMbti} from './game-personality';
export type GameRole='wolf'|'seer'|'witch'|'villager'|'hunter'|'idiot'|'guard';
export type GamePhase='night'|'speech'|'vote'|'election'|'resolution'|'finished';
export type GameStatus='running'|'paused'|'finished';
export interface GamePlayer {id:string;name:string;color:string;human:boolean;mbti?:GameMbti;behaviorPolicy?:GameBehaviorPolicy;personality?:string;model?:ModelSelection;}
export interface GameSeat extends GamePlayer {alive:boolean;role?:GameRole;revealed?:boolean;canVote?:boolean;}
export interface GameAction {formatNote?:string;target?:string;text?:string;endTurn?:boolean;note?:string;personalityNote?:string;potion?:'save'|'poison'|'skip';choice?:boolean;skip?:boolean;direction?:'clockwise'|'counterclockwise';}
export interface GameRequest {discussionRound?:'proposal'|'response'|'confirm';id:string;seatId:string;kind:'wolf_plan'|'kill'|'inspect'|'witch'|'speak'|'vote'|'guard'|'sheriff_join'|'campaign'|'withdraw'|'sheriff_vote'|'sheriff_order'|'badge'|'shoot'|'last_words'|'pk_speak';targets:string[];witch?:{victim?:string;canSave:boolean;canPoison:boolean};deadlineAt?:number;remainingMs?:number;}
export interface GameLog {scope?:'shared'|'personal';id:number;day:number;phase:GamePhase;seatId?:string;text:string;audience?:string[];time?:number;}
export interface GameView {revision?:number;id:string;groupId:string;board?:'standard12'|'guard12';sheriffId?:string;stage?:string;candidates?:string[];election?:{applicants:string[];withdrawn:string[];round:number;joining:boolean};day:number;phase:GamePhase;status:GameStatus;seats:GameSeat[];logs:GameLog[];pending:GameRequest[];winner?:'wolves'|'village';error?:string;humanId?:string;clock?:{deadlineAt?:number;remainingMs?:number;seatId?:string};}
export interface GameCreate {groupId:string;board?:'standard12'|'guard12';players:GamePlayer[];}
export interface GameAPI {
 inspect(input:{id:string}):Promise<GameTrace[]>;
 create(input:GameCreate):Promise<GameView>;
 read(input:{groupId:string;omniscient?:boolean}):Promise<GameView|null>;
 act(input:{id:string;requestId:string;action:GameAction}):Promise<GameView>;
 control(input:{id:string;action:'pause'|'resume'|'stop'}):Promise<GameView>;
}

export interface GameTrace {metrics?:ResponseMetrics;seq:number;time:number;type:'created'|'request_created'|'model_response'|'model_queued'|'model_started'|'model_returned'|'model_failed'|'model_cancelled'|'reply_discarded'|'action_accepted'|'action_rejected'|'timeout'|'transition'|'pause'|'resume'|'stop'|'recovered'|'failure_pause';day:number;phase:GamePhase;seatId?:string;requestId?:string;kind?:GameRequest['kind'];attempt?:number;elapsedMs?:number;model?:string;detail?:string;input?:string;instruction?:string;skills?:{id:string;title:string;version:string}[];action?:GameAction;}

export interface ResponseMetrics {httpStatus:number;headersMs:number;totalMs:number;finishReason?:string;inputTokens?:number;outputTokens?:number;reasoningTokens?:number;}
