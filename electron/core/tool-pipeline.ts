export const READ_TOOLS=new Set(['file_read','host_file_read','host_list_directory','host_find_files','host_search_files','skill_read','skill_file_read','skills_list','history_read','history_search','read_result','attachment_read','execution_list','task_read','goal_read','process_list','process_status','mcp_list_servers','mcp_list_tools','mcp_list_resources','mcp_read_resource','mcp_list_prompts','mcp_get_prompt']);
interface Step {id:string;tool:string;args:Record<string,unknown>;dependsOn:string[];}
interface Outcome {ok:boolean;status:'succeeded'|'failed'|'skipped'|'cancelled';result?:unknown;error?:string;failedDependencies?:string[];}
interface Options {allowedTools?:ReadonlySet<string>;stopOnError?:(error:unknown)=>boolean;}
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const blockedKey=(key:string)=>['__proto__','prototype','constructor'].includes(key);
function references(value:unknown,step:Step,depth=0){
  if(depth>30)throw Error(`步骤 ${step.id} 的参数嵌套超过 30 层`);
  if(!value||typeof value!=='object')return;
  if(Object.hasOwn(value,'$from')){
    const ref=value as Record<string,unknown>;
    if(typeof ref.$from!=='string'||!step.dependsOn.includes(ref.$from))throw Error(`步骤 ${step.id} 的结果引用 ${String(ref.$from)} 必须声明在 dependsOn 中`);
    if(ref.path!==undefined&&(typeof ref.path!=='string'||ref.path.split('.').some(blockedKey)))throw Error(`步骤 ${step.id} 的结果引用路径无效`);
    if(Object.keys(ref).some(key=>key!=='$from'&&key!=='path'))throw Error(`步骤 ${step.id} 的结果引用只支持 $from 和 path`);
    return;
  }
  for(const item of Object.values(value))references(item,step,depth+1);
}
function validatedSteps(value:unknown,allowed?:ReadonlySet<string>):Step[]{
  if(!Array.isArray(value)||!value.length||value.length>20)throw Error('批处理需要 1–20 个读取步骤');
  let input:unknown[];try{input=structuredClone(value);}catch{throw Error('批处理参数必须可序列化');}
  const ids=new Set<string>();
  return input.map((entry,index)=>{
    if(!object(entry))throw Error(`第 ${index+1} 个批处理步骤必须是对象`);
    if(typeof entry.id!=='string'||!/^[\w-]{1,40}$/.test(entry.id))throw Error(`第 ${index+1} 个步骤的 ID 需要 1–40 个字母、数字、下划线或连字符`);
    const id=entry.id;if(ids.has(id))throw Error(`批处理步骤 ID 重复：${id}`);
    if(typeof entry.tool!=='string'||!READ_TOOLS.has(entry.tool))throw Error(`步骤 ${id} 的 ${String(entry.tool)} 不在批处理读取工具列表中`);
    if(allowed&&!allowed.has(entry.tool))throw Error(`步骤 ${id} 的工具 ${entry.tool} 在当前任务模式下不可用`);
    if(!object(entry.args))throw Error(`步骤 ${id} 的 args 必须是参数对象`);
    const deps=entry.dependsOn??[];
    if(!Array.isArray(deps)||deps.some(dep=>typeof dep!=='string'))throw Error(`步骤 ${id} 的 dependsOn 必须是步骤 ID 数组`);
    if(new Set(deps).size!==deps.length)throw Error(`步骤 ${id} 包含重复依赖`);
    for(const dep of deps)if(!ids.has(dep))throw Error(`步骤 ${id} 依赖的 ${dep} 必须是之前已定义的步骤，不能引用自身或后续步骤`);
    const step:Step={id,tool:entry.tool,args:entry.args,dependsOn:deps};references(step.args,step);ids.add(id);return step;
  });
}
export async function readPipeline(value:unknown,parallel:number,signal:AbortSignal,invoke:(name:string,args:Record<string,unknown>,signal:AbortSignal)=>Promise<unknown>,options:Options={}){
  const steps=validatedSteps(value,options.allowedTools),results=new Map<string,Outcome>(),pending=new Map(steps.map(step=>[step.id,step])),active=new Map<string,Promise<void>>();
  const limit=Number.isFinite(parallel)?Math.max(1,Math.min(8,Math.floor(parallel))):1,controller=new AbortController();
  let interruption:unknown;
  const stop=(error:unknown)=>{interruption??=error;controller.abort(error);};
  const abort=()=>stop(signal.reason||Error('批处理已取消'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  const resolve=(value:any,deps:string[]):any=>{
    if(!value||typeof value!=='object')return value;
    if(Object.hasOwn(value,'$from')){
      const result=results.get(value.$from);if(!deps.includes(value.$from)||!result?.ok)throw Error(`依赖步骤 ${value.$from} 未成功`);
      let current:any=result.result;for(const key of String(value.path||'').split('.').filter(Boolean)){if(blockedKey(key)||current==null||!Object.hasOwn(current,key))throw Error(`依赖 ${value.$from} 的结果路径 ${value.path} 不存在`);current=current[key];}return structuredClone(current);
    }
    return Array.isArray(value)?value.map(item=>resolve(item,deps)):Object.fromEntries(Object.entries(value).map(([key,item])=>[key,resolve(item,deps)]));
  };
  try{
    while(pending.size||active.size){
      controller.signal.throwIfAborted();let progressed=false;
      for(const step of pending.values()){
        if(!step.dependsOn.every(id=>results.has(id)))continue;
        const failed=step.dependsOn.filter(id=>!results.get(id)!.ok);
        if(failed.length){results.set(step.id,{ok:false,status:'skipped',failedDependencies:failed,error:`依赖步骤 ${failed.join('、')} 未成功，已跳过`});pending.delete(step.id);progressed=true;continue;}
        if(active.size>=limit)continue;
        pending.delete(step.id);progressed=true;
        const work=Promise.resolve().then(async()=>{
          try{
            controller.signal.throwIfAborted();const result=await invoke(step.tool,resolve(step.args,step.dependsOn),controller.signal);controller.signal.throwIfAborted();
            const ok=!(result as any)?.isError&&(!Number.isInteger((result as any)?.exitCode)||(result as any).exitCode===0);results.set(step.id,{ok,status:ok?'succeeded':'failed',result});
          }catch(error){if(options.stopOnError?.(error))stop(error);results.set(step.id,{ok:false,status:controller.signal.aborted?'cancelled':'failed',error:error instanceof Error?error.message:String(error)});}
          finally{active.delete(step.id);}
        });active.set(step.id,work);
      }
      if(interruption!==undefined)throw interruption;
      if(active.size)await Promise.race(active.values());else if(pending.size&&!progressed)throw Error('批处理依赖无法完成');
    }
    controller.signal.throwIfAborted();return {results:Object.fromEntries(steps.map(step=>[step.id,results.get(step.id)])),isError:[...results.values()].some(result=>!result.ok)};
  }catch(error){controller.abort(error);await Promise.allSettled(active.values());throw error;}
  finally{signal.removeEventListener('abort',abort);}
}
