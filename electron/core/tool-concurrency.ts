export const SERIAL_TOOLS=new Set([
  'computer','request_user_control','request_user_input','user_input_wait',
  'host_execute','host_file_write','host_file_patch','file_write','file_patch','apply_patch','computer_execute',
  'python_session','terminal_start','terminal_input','terminal_stop','process_start','process_stop',
  'message_attach','memory','chat_pin','group_pin','bot_send_message','bot_delegate_task',
  'group_send_message','group_create','group_invite','group_wake','start_main_task','delegation_receipt',
  'checkpoint_restore','skill_materialize'
]);
export const isSerialTool=(name:string)=>SERIAL_TOOLS.has(name)||/^groups?_(send|create|invite|wake|pin)/.test(name);

export async function runConcurrentTools<T>(items:T[],serial:(item:T)=>boolean,limit:number,signal:AbortSignal,worker:(item:T,signal:AbortSignal)=>Promise<void>){
  const cap=Number.isFinite(limit)?Math.max(1,Math.min(8,Math.floor(limit))):1;
  const inflight=new Map<number,Promise<void>>();
  const batch=new AbortController();
  const abort=()=>batch.abort(signal.reason||Error('已取消'));
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  let index=0;
  try{
    while(index<items.length||inflight.size){
      if(batch.signal.aborted){await Promise.allSettled([...inflight.values()]);break;}
      while(index<items.length&&inflight.size<cap){
        if(serial(items[index])&&inflight.size)break;
        const current=index,item=items[current];index++;
        if(serial(item)){await worker(item,batch.signal);continue;}
        const work=Promise.resolve().then(()=>worker(item,batch.signal)).finally(()=>inflight.delete(current));
        inflight.set(current,work);
      }
      if(inflight.size)await Promise.race(inflight.values());
    }
  }finally{
    signal.removeEventListener('abort',abort);
    await Promise.allSettled([...inflight.values()]);
  }
}
