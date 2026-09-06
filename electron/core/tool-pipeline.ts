export const READ_TOOLS=new Set(['file_read','skill_read','skill_file_read','skills_list','history_read','history_search','read_result','mcp_list_servers','mcp_list_tools','mcp_list_resources','mcp_read_resource','mcp_list_prompts','mcp_get_prompt']);
interface Step {id:string;tool:string;args:Record<string,unknown>;dependsOn?:string[];}
export async function readPipeline(value:unknown,parallel:number,signal:AbortSignal,invoke:(name:string,args:Record<string,unknown>)=>Promise<unknown>){
 if(!Array.isArray(value)||!value.length||value.length>20)throw Error('批处理需要 1–20 个读取步骤');const steps=value as Step[],results=new Map<string,{ok:boolean;result?:unknown;error?:string}>(),ids=new Set<string>();
 for(const step of steps){if(!step||typeof step.id!=='string'||!/^[\w-]{1,40}$/.test(step.id)||ids.has(step.id)||!READ_TOOLS.has(step.tool)||!step.args||typeof step.args!=='object'||Array.isArray(step.args)||step.dependsOn?.some(id=>!ids.has(id)))throw Error('批处理仅可调用已注册的读取工具，依赖必须指向之前的唯一步骤 ID');ids.add(step.id);}
 const resolve=(value:any,deps:string[],depth=0):any=>{
  if(depth>30)throw Error('参数嵌套过深');if(!value||typeof value!=='object')return value;
  if(Object.hasOwn(value,'$from')){if(!deps.includes(value.$from))throw Error('结果引用必须声明 dependsOn');const result=results.get(value.$from);if(!result?.ok)throw Error('依赖步骤未成功');let current:any=result.result;for(const key of String(value.path||'').split('.').filter(Boolean)){if(['__proto__','prototype','constructor'].includes(key)||current==null||!Object.hasOwn(current,key))throw Error('结果引用路径不存在');current=current[key];}return structuredClone(current);}
  return Array.isArray(value)?value.map(v=>resolve(v,deps,depth+1)):Object.fromEntries(Object.entries(value).map(([k,v])=>[k,resolve(v,deps,depth+1)]));
 };
 const pending=[...steps];while(pending.length){signal.throwIfAborted();const ready=pending.filter(s=>(s.dependsOn||[]).every(id=>results.has(id))).slice(0,Math.max(1,Math.min(8,parallel)));if(!ready.length)throw Error('批处理依赖无法完成');
  await Promise.all(ready.map(async step=>{try{signal.throwIfAborted();const result=await invoke(step.tool,resolve(step.args,step.dependsOn||[]));results.set(step.id,{ok:!(result as any)?.isError&&(!Number.isInteger((result as any)?.exitCode)||(result as any).exitCode===0),result});}catch(error){results.set(step.id,{ok:false,error:(error as Error).message});}finally{pending.splice(pending.indexOf(step),1);}}));
 }
 return {results:Object.fromEntries(steps.map(s=>[s.id,results.get(s.id)])),isError:[...results.values()].some(r=>!r.ok)};
}
