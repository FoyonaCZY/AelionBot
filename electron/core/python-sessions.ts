import {randomUUID} from 'node:crypto';
import type {Store} from './store';
import {VmController,shQuote} from './vm';
import {BackgroundProcesses} from './background-processes';
import {vmPython} from './vm-python';
export interface PythonSession {id:string;botId:string;processId:string;createdAt:string;pending:Array<{id:string;runId:string}>;closed?:boolean;}
export const PYTHON_KERNEL=String.raw`
import ast,contextlib,json,pathlib,sys,time,traceback
root=pathlib.Path(sys.argv[1]); requests=root/'requests'; requests.mkdir(exist_ok=True); namespace={'__name__':'__aelion_session__'}
class Output:
    def __init__(self): self.text=''; self.truncated=False
    def write(self,value):
        value=str(value); room=max(0,256000-len(self.text)); self.text+=value[:room]; self.truncated=self.truncated or len(value)>room; return len(value)
    def flush(self): pass
def save(path,value):
    temp=path.with_suffix('.tmp'); temp.write_text(json.dumps(value,ensure_ascii=False),encoding='utf-8'); temp.replace(path)
while not (root/'stop').exists():
    for path in sorted(requests.glob('*.json')):
        target=root/(path.stem+'.result.json')
        if target.exists(): continue
        request=json.loads(path.read_text(encoding='utf-8')); out=Output(); status={'status':'completed','isError':False}; value=None
        save(root/'active.json',{'id':path.stem})
        try:
            tree=ast.parse(request['code'],filename='<bot-python>'); expression=tree.body.pop() if tree.body and isinstance(tree.body[-1],ast.Expr) else None
            with contextlib.redirect_stdout(out),contextlib.redirect_stderr(out):
                exec(compile(tree,'<bot-python>','exec'),namespace)
                if expression: value=eval(compile(ast.Expression(expression.value),'<bot-python>','eval'),namespace)
            if value is not None: out.write(repr(value)[:10000]+'\n')
        except BaseException:
            status['isError']=True; out.write(traceback.format_exc(limit=8))
        status.update(output=out.text,truncated=out.truncated,variables=[{'name':k,'type':type(v).__name__} for k,v in namespace.items() if not k.startswith('_')][:100]); save(target,status)
        save(root/'active.json',{})
    time.sleep(.1)
`;
export class PythonSessions {
 constructor(private store:Store,private vm:VmController,private processes:BackgroundProcesses){store.data.pythonSessions||=[];}
 private get(botId:string,id:string){const session=this.store.data.pythonSessions!.find(s=>s.botId===botId&&s.id===id&&!s.closed);if(!session||!/^[a-f0-9-]{36}$/.test(id))throw Error('Python 会话不存在或不属于当前 Bot');return session;}
 private async run(botId:string,code:string,signal:AbortSignal,input?:unknown){const result=input===undefined?await this.vm.execute('python3 -c '+shQuote(code),botId,signal):await vmPython(this.vm,botId,input,code,signal);if(result.exitCode!==0)throw Error(result.stderr||'Python 会话管理失败');return JSON.parse(result.stdout);}
 async start(botId:string,runId:string,signal:AbortSignal){
  this.store.bot(botId);const existing=this.store.data.pythonSessions!.find(s=>s.botId===botId&&!s.closed);if(existing)return {id:existing.id,processId:existing.processId,existing:true,note:'已有会话，请继续使用或显式 reset。'};
  const id=randomUUID();
  await this.run(botId,`import pathlib,json; d=pathlib.Path.cwd()/'.aelion-python'/a['id']; d.mkdir(parents=True,exist_ok=False); (d/'requests').mkdir(); (d/'kernel.py').write_text(a['code'],encoding='utf-8'); print(json.dumps({'ready':True}))`,signal,{id,code:PYTHON_KERNEL});
  const dir=`/work/${botId}/.aelion-python/${id}`,process=await this.processes.start(botId,runId,{location:'vm',purpose:'service',command:`python3 -u ${shQuote(dir+'/kernel.py')} ${shQuote(dir)}`},signal);
  const session:PythonSession={id,botId,processId:process.id,createdAt:new Date().toISOString(),pending:[]};this.store.data.pythonSessions!.push(session);this.store.save();return {id,processId:process.id,started:true};
 }
 async execute(botId:string,runId:string,args:Record<string,unknown>,signal:AbortSignal){
  const session=this.get(botId,String(args.id));if(session.pending.length)throw Error('Python 会话仍有未取回的执行结果，请先 poll；不要重发可能已运行的代码');
  if(typeof args.code!=='string'||!args.code.trim()||args.code.length>50000)throw Error('Python 代码为空或过长');
  const state=await this.processes.status(botId,session.processId,signal);if(!['running','starting'].includes(state.status))throw Error('Python 会话已停止或状态未知，请检查进程后 reset');
  const id=randomUUID();
  session.pending.push({id,runId});this.store.save();
  await this.run(botId,`import pathlib,json; d=pathlib.Path.cwd()/'.aelion-python'/'${session.id}'/'requests'; p=d/(a['id']+'.json'); temp=p.with_suffix('.tmp'); temp.write_text(json.dumps(a),encoding='utf-8'); temp.replace(p); print(json.dumps({'queued':True}))`,signal,{id,code:args.code});
  return this.poll(botId,session.id,id,signal,Number(args.waitMs)||10000);
 }
 async poll(botId:string,id:string,requestId:string,signal:AbortSignal,waitMs=10000){
  const session=this.get(botId,id);if(!/^[a-f0-9-]{36}$/.test(requestId))throw Error('执行 ID 无效');const duration=Math.min(30000,Math.max(0,waitMs));
  const result=await this.run(botId,`import pathlib,json,time; p=pathlib.Path.cwd()/'.aelion-python'/'${id}'/'${requestId}.result.json'; end=time.monotonic()+${duration/1000}\nwhile not p.exists() and time.monotonic()<end: time.sleep(.1)\nprint(p.read_text(encoding='utf-8') if p.exists() else json.dumps({'status':'running'}))`,signal);
  if(result.status==='completed'){session.pending=session.pending.filter(p=>p.id!==requestId);this.store.save();}return {id,requestId,...result};
 }
 pending(botId:string,runId:string){return this.store.data.pythonSessions!.filter(s=>s.botId===botId&&!s.closed).flatMap(s=>s.pending.filter(p=>p.runId===runId).map(p=>({sessionId:s.id,requestId:p.id})));}
 async cancelRun(botId:string,runId:string){for(const session of this.store.data.pythonSessions!.filter(s=>s.botId===botId&&!s.closed&&s.pending.some(p=>p.runId===runId))){const result=await this.processes.stop(botId,session.processId,AbortSignal.timeout(6000));if(['stopped','failed','completed'].includes(result.status))session.closed=true;}this.store.save();}
 async reset(botId:string,id:string,runId:string,signal:AbortSignal){const session=this.get(botId,id),result=await this.processes.stop(botId,session.processId,signal);if(!['stopped','failed','completed'].includes(result.status))throw Error('旧会话尚未确认停止，不能建立新会话');session.closed=true;this.store.save();return this.start(botId,runId,signal);}
}
