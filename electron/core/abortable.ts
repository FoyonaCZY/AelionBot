export async function abortable<T>(signal:AbortSignal,operation:()=>Promise<T>):Promise<T>{
  signal.throwIfAborted();let cancel:()=>void=()=>{};
  const stopped=new Promise<never>((_,reject)=>{cancel=()=>reject(signal.reason||new Error('请求已取消'));signal.addEventListener('abort',cancel,{once:true});});
  try{return await Promise.race([operation(),stopped]);}finally{signal.removeEventListener('abort',cancel);}
}
