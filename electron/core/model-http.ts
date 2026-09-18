type Undici={Agent:new(options:object)=>unknown;fetch:(url:string,init?:object)=>Promise<Response>};
const agents=new Map<string,unknown>();
let undici:Undici|undefined|null;
async function dispatcher(origin:string){
  if(undici===null)return;
  if(undici===undefined)try{undici=await import('undici') as unknown as Undici;}catch{undici=null;return;}
  let agent=agents.get(origin);
  if(!agent){agent=new undici.Agent({connections:8,keepAliveTimeout:60_000,keepAliveMaxTimeout:120_000,pipelining:0});agents.set(origin,agent);}
  return agent;
}
export async function modelFetch(url:string,init:RequestInit={}):Promise<Response>{
  const agent=await dispatcher(new URL(url).origin);
  if(agent&&undici)return undici.fetch(url,{...init,dispatcher:agent}) as Promise<Response>;
  return fetch(url,init);
}
export async function prewarmModelEndpoint(baseUrl:string,headers:Record<string,string>={}){
  try{
    const url=`${baseUrl.replace(/\/$/,'')}/models`;
    await dispatcher(new URL(url).origin);
    const response=await modelFetch(url,{method:'GET',headers,redirect:'error',signal:AbortSignal.timeout(8000)});
    await response.body?.cancel();
  }catch{/* handshake and keep-alive are the point */}
}
export function disposeModelHttp(){for(const agent of agents.values())try{(agent as {close?:()=>void}).close?.();}catch{}agents.clear();}
