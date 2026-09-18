export const EXCLUSIVE_TOOLS=new Set([
  'computer','request_user_control','request_user_input','user_input_wait',
  'host_execute','computer_execute',
  'python_session','terminal_start','terminal_input','terminal_stop','process_start','process_stop',
  'message_attach','memory','chat_pin','group_pin','bot_send_message','bot_delegate_task',
  'group_send_message','group_create','group_invite','start_main_task','delegation_receipt',
  'checkpoint_restore','skill_materialize'
]);
export const PATH_LOCKED_TOOLS=new Set(['host_file_write','host_file_patch','file_write','file_patch','apply_patch']);
export const SERIAL_TOOLS=new Set([...EXCLUSIVE_TOOLS,...PATH_LOCKED_TOOLS]);
export const isExclusiveTool=(name:string)=>EXCLUSIVE_TOOLS.has(name)||/^groups?_(send|create|invite|pin)/.test(name);
export const isSerialTool=(name:string)=>isExclusiveTool(name)||PATH_LOCKED_TOOLS.has(name);
const normalizeLockPath=(path:string)=>path.replaceAll('\\','/').replace(/^\.\//,'').replace(/\/{2,}/g,'/');
export function writeLockPaths(name:string,args:Record<string,unknown>){
  if(!PATH_LOCKED_TOOLS.has(name))return [];
  const scope=name.startsWith('host_')||name==='apply_patch'?'host':'vm';
  const paths=new Set<string>();
  const add=(value:unknown)=>{if(typeof value==='string'&&value.trim())paths.add(`${scope}:${normalizeLockPath(value.trim())}`);};
  if(name==='apply_patch'&&typeof args.patch==='string'){
    for(const line of args.patch.split(/\r?\n/)){
      const file=/^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line),move=/^\*\*\* Move to: (.+)$/.exec(line);
      if(file)add(file[1]);if(move)add(move[1]);
    }
  }else{
    add(args.path);add(args.moveTo);
  }
  return [...paths].sort();
}
function pathLocks(){
  const chain=new Map<string,Promise<void>>();
  return async(keys:string[],work:()=>Promise<void>)=>{
    if(!keys.length)return work();
    const ordered=[...new Set(keys)].sort();
    const releases:Array<()=>void>=[];
    for(const key of ordered){
      const previous=chain.get(key)||Promise.resolve();
      let release!:()=>void;const next=new Promise<void>(resolve=>{release=resolve;});
      chain.set(key,previous.then(()=>next));
      await previous;releases.push(release);
    }
    try{await work();}finally{for(const release of releases.reverse())release();}
  };
}
export async function runConcurrentTools<T>(items:T[],serial:(item:T)=>boolean,limit:number,signal:AbortSignal,worker:(item:T,signal:AbortSignal)=>Promise<void>,lockKeys:(item:T)=>string[]=()=>[]){
  const cap=Number.isFinite(limit)?Math.max(1,Math.min(32,Math.floor(limit))):1;
  const inflight=new Map<number,Promise<void>>();
  const batch=new AbortController();
  const abort=()=>batch.abort(signal.reason||Error('已取消'));
  const withLocks=pathLocks();
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  let index=0;
  try{
    while(index<items.length||inflight.size){
      if(batch.signal.aborted){await Promise.allSettled([...inflight.values()]);break;}
      while(index<items.length&&inflight.size<cap){
        if(serial(items[index])&&inflight.size)break;
        const current=index,item=items[current];index++;
        if(serial(item)){await withLocks(lockKeys(item),()=>worker(item,batch.signal));continue;}
        const work=Promise.resolve().then(()=>withLocks(lockKeys(item),()=>worker(item,batch.signal))).finally(()=>inflight.delete(current));
        inflight.set(current,work);
      }
      if(inflight.size)await Promise.race(inflight.values());
    }
  }finally{
    signal.removeEventListener('abort',abort);
    await Promise.allSettled([...inflight.values()]);
  }
}
