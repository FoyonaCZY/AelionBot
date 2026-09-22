// Preserve the shared decision snapshot while limiting transport pressure.
export async function settleLimited<T>(items:T[],limit:number,signal:AbortSignal,run:(item:T)=>Promise<void>){
 const results:PromiseSettledResult<void>[]=new Array(items.length);let next=0;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
  while(next<items.length){signal.throwIfAborted();const index=next++;try{await run(items[index]);results[index]={status:'fulfilled',value:undefined};}catch(reason){results[index]={status:'rejected',reason};}}
 }));return results;
}
