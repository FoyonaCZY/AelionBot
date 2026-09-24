import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {appendFileSync, mkdirSync, readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {GameRequest,GameView} from '../../src/game-types';
import {DECISION_MODELS} from '../../src/laya-types';

type Question={type:'choice';instructions:string;criteria:Record<string,string>};
type Prediction={choice:string;confidence?:number;probabilities?:Record<string,number>;model:string;runtime:string;elapsedMs:number;inferenceMs?:number;activeMemoryBytes?:number;cacheMemoryBytes?:number};
type Pending={resolve:(value:Prediction|undefined)=>void;timer:ReturnType<typeof setTimeout>;started:number;signal?:AbortSignal;onAbort?:()=>void};
export type GroupChoice='observe'|'participate';
export type LayaShadowEvent={scope:'group'|'game'|'game_speech';sourceId:string;actorId:string;choice:string;appliedChoice?:GroupChoice;adjustment?:string;confidence?:number;probabilities?:Record<string,number>;criteria?:Record<string,string>;features?:{events:number;recent:number;mentioned:boolean;ownTask:boolean};input?:unknown;runtime:string;model:string;elapsedMs:number;time?:string};

/** Local opt-in Laya process for group participation decisions and game observations. */
export class LayaShadow {
  private child?:ChildProcessWithoutNullStreams;
  private line='';
  private ready=false;
  private startupTimer?:ReturnType<typeof setTimeout>;
  private pending=new Map<string,Pending>();
  private disabled=false;
  private runtime:string|undefined;
  private python:string|undefined;
  private model:string;
  private loadTimeoutMs=120_000;
  private readyWaiters=new Set<{resolve:()=>void;reject:(error:Error)=>void}>();
  private readonly file:string;
  private history:LayaShadowEvent[]=[];
  constructor(dir:string,private script:string,private changed:()=>void=()=>{},options?:{runtime?:string;python?:string}){
    this.runtime=options?options.runtime:process.env.AELION_LAYA_RUNTIME;
    this.python=options?options.python:process.env.AELION_LAYA_PYTHON;
    this.model=(!options&&process.env.AELION_LAYA_MODEL)||DECISION_MODELS.find(model=>model.id===this.runtime)?.modelId||DECISION_MODELS[0].modelId;
    this.file=join(dir,'laya-decisions.jsonl');
    try{this.history=readFileSync(this.file,'utf8').trim().split('\n').slice(-500).map(line=>JSON.parse(line) as LayaShadowEvent).filter(event=>event.scope&&event.sourceId);}catch{}
  }
  get enabled(){return ['standard','mlx'].includes(this.runtime||'')&&!this.disabled;}
  get runtimeName(){return this.runtime;}
  get isReady(){return this.ready&&!this.disabled;}
  warmup(){this.start();}
  configure(runtime?:'standard'|'mlx',python?:string,loadTimeoutMs=120_000){
    this.stop();this.runtime=runtime;this.python=python;this.model=DECISION_MODELS.find(model=>model.id===runtime)?.modelId||DECISION_MODELS[0].modelId;
    this.loadTimeoutMs=loadTimeoutMs;this.disabled=false;this.changed();if(runtime)this.warmup();
  }
  waitReady():Promise<void>{
    if(this.isReady)return Promise.resolve();
    if(!this.enabled)return Promise.reject(new Error('Laya 未启用'));
    return new Promise((resolve,reject)=>this.readyWaiters.add({resolve,reject}));
  }
  groupDecisions(ids:Set<string>){return this.history.filter(event=>event.scope==='group'&&ids.has(event.sourceId));}
  private takePending(id:string){const pending=this.pending.get(id);if(!pending)return;this.pending.delete(id);clearTimeout(pending.timer);if(pending.onAbort)pending.signal?.removeEventListener('abort',pending.onAbort);return pending;}
  private start(){
    if(this.child||!this.enabled)return;
    const python=this.python||'python3';
    const child=spawn(python,['-u',this.script],{stdio:['pipe','pipe','pipe'],env:{...process.env,AELION_LAYA_RUNTIME:this.runtime,AELION_LAYA_MODEL:this.model,TOKENIZERS_PARALLELISM:'false',OMP_NUM_THREADS:'2',OPENBLAS_NUM_THREADS:'2'}});
    this.child=child;
    this.startupTimer=setTimeout(()=>this.fail(),this.loadTimeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',(part:string)=>{
      this.line+=part;
      if(this.line.length>1_000_000){this.fail();return;}
      let end:number;
      while((end=this.line.indexOf('\n'))>=0){const line=this.line.slice(0,end);this.line=this.line.slice(end+1);this.receive(line);}
    });
    child.stderr.on('data',(part:Buffer)=>{console.warn('Laya:',part.toString().slice(0,500));});
    child.on('error',()=>this.fail());child.on('exit',()=>this.fail());
  }
  private receive(line:string){
    try{
      const response=JSON.parse(line) as {ready?:boolean;loadMs?:number;inferenceMs?:number;activeMemoryBytes?:number;cacheMemoryBytes?:number;id?:string;error?:string;result?:{answers?:Record<string,{choice?:string;confidence?:number;probabilities?:Record<string,number>}>}};
      if(response.ready){clearTimeout(this.startupTimer);this.ready=true;console.info('Laya ready:',JSON.stringify({loadMs:response.loadMs,activeMemoryBytes:response.activeMemoryBytes,cacheMemoryBytes:response.cacheMemoryBytes}));for(const waiter of this.readyWaiters)waiter.resolve();this.readyWaiters.clear();this.changed();return;}
      const pending=response.id?this.takePending(response.id):undefined;if(!pending)return;
      const answer=response.result?.answers?.decision;
      if(response.error)console.warn('Laya prediction:',response.error.slice(0,300));
      pending.resolve(answer?.choice?{choice:answer.choice,confidence:answer.confidence,probabilities:answer.probabilities,model:this.model,runtime:this.runtime!,elapsedMs:Date.now()-pending.started,inferenceMs:response.inferenceMs,activeMemoryBytes:response.activeMemoryBytes,cacheMemoryBytes:response.cacheMemoryBytes}:undefined);
    }catch{this.fail();}
  }
  private fail(){
    if(this.disabled)return;this.disabled=true;
    clearTimeout(this.startupTimer);this.ready=false;
    for(const waiter of this.readyWaiters)waiter.reject(new Error('Laya 模型加载失败或超时'));
    this.readyWaiters.clear();
    for(const id of this.pending.keys())this.takePending(id)?.resolve(undefined);
    this.child?.kill();this.child=undefined;
    this.changed();
  }
  private stop(){
    clearTimeout(this.startupTimer);this.ready=false;
    for(const waiter of this.readyWaiters)waiter.reject(new Error('Laya 已停止'));
    this.readyWaiters.clear();
    for(const id of this.pending.keys())this.takePending(id)?.resolve(undefined);
    this.child?.stdout.removeAllListeners();this.child?.stderr.removeAllListeners();this.child?.removeAllListeners();this.child?.kill();this.child=undefined;this.line='';
  }
  private predict(state:unknown,question:Question,signal?:AbortSignal):Promise<Prediction|undefined>{
    if(!this.enabled||signal?.aborted)return Promise.resolve(undefined);
    this.start();if(!this.child||!this.isReady||this.pending.size>=3)return Promise.resolve(undefined);
    const id=randomUUID();return new Promise(resolve=>{
      const timer=setTimeout(()=>{this.takePending(id)?.resolve(undefined);this.fail();},5_000);
      const onAbort=()=>this.takePending(id)?.resolve(undefined);
      this.pending.set(id,{resolve,timer,started:Date.now(),signal,onAbort});
      signal?.addEventListener('abort',onAbort,{once:true});
      if(signal?.aborted){onAbort();return;}
      this.child!.stdin.write(JSON.stringify({id,state,questions:{decision:question}})+'\n',error=>{if(error)this.fail();});
    });
  }
  private record(event:LayaShadowEvent){event.time=new Date().toISOString();this.history.push(event);if(this.history.length>500)this.history.shift();try{mkdirSync(dirname(this.file),{recursive:true});appendFileSync(this.file,JSON.stringify(event)+'\n',{mode:0o600});}catch(error){console.warn('Laya decision log:',error);}this.changed();}
  async group(sourceId:string,actorId:string,state:unknown,forceObserve=false,signal?:AbortSignal):Promise<GroupChoice|undefined>{
    const criteria={observe:'没有新内容需要这个 Bot 回应，也没有需要继续的本人任务',participate:'这个 Bot 可以回应当前问题、补充有用信息，或开展及继续用户授权的工作'};
    const result=await this.predict(state,{type:'choice',instructions:'只判断当前 Bot 是否参与。events 为新消息，recent 为前文，myTask 为本人任务。用户提问、要求参与或有本人任务待推进时选 participate；没有有用补充时选 observe。Bot 建议不构成授权；用户要求暂停或静默时选 observe。具体回复及工具使用由主模型决定。',criteria},signal);
    const input=state as {events?:Array<{mentioned?:boolean}>;recent?:unknown[];myTask?:unknown};
    if(!signal?.aborted&&result&&['observe','participate'].includes(result.choice)){
      const appliedChoice=forceObserve?'observe':result.choice as GroupChoice;
      this.record({scope:'group',sourceId,actorId,...result,criteria,input:state,appliedChoice,adjustment:forceObserve&&result.choice!=='observe'?'用户明确要求本轮静默':undefined,features:{events:input.events?.length||0,recent:input.recent?.length||0,mentioned:input.events?.some(event=>event.mentioned)||false,ownTask:Boolean(input.myTask)}});
      return appliedChoice;
    }
    return undefined;
  }
  async game(sourceId:string,actorId:string,view:GameView,request:GameRequest){
    const options=request.kind==='speak'||request.kind==='campaign'||request.kind==='pk_speak'||request.kind==='last_words'
      ?{claim:'主要是身份声明或查验宣称',accuse:'主要是指控或推动投票',defend:'主要是辩护或回应质疑',probe:'主要是试探、提问或分析',other:'其他发言'}
      :Object.fromEntries(request.targets.slice(0,12).map((id,i)=>['seat_'+i,view.seats.find(p=>p.id===id)?.name||String(i+1)]));
    if(Object.keys(options).length<2)return;
    const result=await this.predict({day:view.day,phase:view.phase,kind:request.kind,seats:view.seats.map(p=>({name:p.name,alive:p.alive,role:p.role})),visibleLogs:view.logs.slice(-6).map(log=>log.text.slice(0,250)),selfRole:view.seats.find(p=>p.id===actorId)?.role},
      {type:'choice',instructions:'根据该玩家可见信息选择最值得考虑的候选。发言时选择话语类型，行动时选择目标。',criteria:options});
    if(result)this.record({scope:'game',sourceId,actorId,...result});
  }
  async speech(sourceId:string,actorId:string,text:string){
    const result=await this.predict(text.slice(0,800),{type:'choice',instructions:'这段狼人杀公开发言主要在做什么？只识别说话行为，不判断身份真假。',criteria:{claim:'声明身份或声称获得查验结果',accuse:'指控他人或推动投票',defend:'为自己或他人辩护',probe:'提问、试探或分析线索',other:'其他发言'}});
    if(result)this.record({scope:'game_speech',sourceId,actorId,...result});
  }
  dispose(){this.stop();this.disabled=true;}
}
