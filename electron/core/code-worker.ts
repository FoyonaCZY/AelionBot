import {parentPort,workerData} from 'node:worker_threads';
import {getQuickJS} from 'quickjs-emscripten';
const port=parentPort!;
async function execute(){
 const quickjs=await getQuickJS(),runtime=quickjs.newRuntime();runtime.setMemoryLimit(32*1024*1024);runtime.setMaxStackSize(512*1024);
 let deadline=Date.now()+2000,finished=false,nextId=0,emitted=0;runtime.setInterruptHandler(()=>Date.now()>deadline);
 const fail=(message:string):never=>{throw Error(message);};
 const context=runtime.newContext(),pending=new Map<number,ReturnType<typeof context.newPromise>>(),logs:unknown[]=[];
 const pump=()=>{deadline=Date.now()+2000;const result=runtime.executePendingJobs();if(result.error){const error=context.dump(result.error);result.error.dispose();throw Error(error.message||String(error));}};
 const invoke=context.newFunction('__invoke',(name,input)=>{
  if(++nextId>100)return fail('单次代码编排最多调用 100 次工具');
  const tool=context.getString(name),json=context.getString(input);if(json.length>1024*1024)return fail('工具参数超过 1 MB');
  if(!workerData.names.includes(tool))return fail('当前工具不可用：'+tool);
  const promise=context.newPromise();pending.set(nextId,promise);port.postMessage({type:'call',id:nextId,name:tool,args:JSON.parse(json)});return promise.handle;
 });context.setProp(context.global,'__invoke',invoke);invoke.dispose();
 const emit=context.newFunction('emit',value=>{const json=context.getString(value);emitted+=json.length;if(emitted>64000)return fail('输出超过 64000 字符，请在代码中筛选或汇总结果');logs.push(JSON.parse(json));return context.undefined;});context.setProp(context.global,'__emit',emit);emit.dispose();
 const receive=(message:any)=>{if(finished||message.type!=='result')return;const promise=pending.get(message.id);if(!promise)return;const value=context.newString(JSON.stringify(message.result));promise.resolve(value);value.dispose();try{pump();}catch(error){port.postMessage({type:'error',error:(error as Error).message});} };
 port.on('message',receive);
 try{
  const bootstrap=`const tools=new Proxy(Object.create(null),{get:(_,name)=>async(args={})=>{const result=JSON.parse(await __invoke(String(name),JSON.stringify(args)));if(!result.ok)throw new Error(result.error);return result.value;}});const emit=value=>__emit(JSON.stringify(value??null));`;
  const setup=context.evalCode(bootstrap);if(setup.error){const error=context.dump(setup.error);setup.error.dispose();throw Error(error.message);}setup.value.dispose();
  deadline=Date.now()+2000;const evaluated=context.evalCode(`(async()=>{\n${workerData.code}\n})()`,'tool-program.js');if(evaluated.error){const error=context.dump(evaluated.error);evaluated.error.dispose();throw Error(error.message);}
  const resultPromise=context.resolvePromise(evaluated.value);pump();const resolved=await resultPromise;evaluated.value.dispose();
  if(resolved.error){const error=context.dump(resolved.error);resolved.error.dispose();throw Error(error.message||String(error));}
  const value=context.dump(resolved.value);resolved.value.dispose();if(JSON.stringify(value??null).length+emitted>64000)throw Error('代码返回值过大，请先筛选结果');port.postMessage({type:'done',value,logs,calls:nextId});
 }finally{finished=true;port.off('message',receive);for(const promise of pending.values())promise.dispose();context.dispose();runtime.dispose();}
}
execute().then(()=>port.close(),error=>{port.postMessage({type:'error',error:error instanceof Error?error.message:String(error)});port.close();});
