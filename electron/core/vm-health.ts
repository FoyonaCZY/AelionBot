import ssh2 from 'ssh2';
import type {ConnectConfig,Client,ClientChannel} from 'ssh2';
import type {CommandResult} from '../../src/shared';
// One SSH session for health checks. Task commands retain their own cancellation boundary.
export const VM_HEALTH_SCRIPT=String.raw`import pathlib,subprocess,json,time,fcntl
state=pathlib.Path('/var/lib/aelion')
def read(name):
 try: return (state/name).read_text()[:16000]
 except OSError: return ''
while True:
 try:
  tokens=[]
  if (state/'work-ready').is_file(): tokens.append('READY')
  if subprocess.run(['systemctl','is-active','--quiet','lightdm']).returncode==0 and subprocess.run(['pgrep','-u','aelion','-x','xfce4-session'],stdout=subprocess.DEVNULL).returncode==0: tokens.append('DESKTOP')
  if (state/'desktop-error').exists(): tokens.append('TOOL_ERROR')
  if (state/'desktop-needs-reboot').exists(): tokens.append('NEEDS_REBOOT')
  if all(pathlib.Path(p).is_file() for p in ['/usr/local/bin/aelion-browser','/usr/bin/thunar','/usr/local/bin/aelion-session']): tokens.append('VERSION:'+read('workstation-version').strip())
  with (state/'desktop.lock').open('a') as lock:
   try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
   except BlockingIOError: tokens.append('MAINTENANCE')
  output=' '.join(tokens)+'\nSTAGE:'+read('desktop-stage')+'\nINSTALL_PROGRESS:'+read('desktop-progress.json')+'\n'
  print(json.dumps({'stdout':output}),flush=True)
 except Exception as error: print(json.dumps({'error':str(error)}),flush=True)
 time.sleep(6)
`;
export class VmHealthChannel {
  private client?:Client;private channel?:ClientChannel;private identity='';private buffer='';
  private last?:{time:number;result:CommandResult};
  private waiters=new Set<{ok:(result:CommandResult)=>void;fail:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  constructor(private createClient:()=>Client=()=>new ssh2.Client()){}
  read(identity:string,options:ConnectConfig,command:string):Promise<CommandResult>{
    if(this.client&&this.identity!==identity)this.close();
    if(this.client&&this.last&&Date.now()-this.last.time<15000)return Promise.resolve({...this.last.result});
    const pending=new Promise<CommandResult>((ok,fail)=>{const waiter={ok,fail,timer:setTimeout(()=>this.close(Error('VM 状态通道超时')),12000)};this.waiters.add(waiter);});
    if(!this.client){
      const client=this.createClient();this.client=client;this.identity=identity;
      client.on('error',error=>{if(this.client===client)this.close(error);});
      client.on('close',()=>{if(this.client===client)this.close(Error('VM 状态连接已断开'));});
      client.on('ready',()=>{if(this.client!==client)return;client.exec(command,(error,channel)=>{
        if(error){if(this.client===client)this.close(error);return;}
        if(this.client!==client){channel.close();return;}this.channel=channel;
        channel.on('data',(data:Buffer)=>{if(this.client!==client)return;this.buffer+=data.toString('utf8');if(this.buffer.length>65536){this.close(Error('VM 状态响应过大'));return;}
          let newline;while((newline=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,newline);this.buffer=this.buffer.slice(newline+1);try{
            const value=JSON.parse(line);if(value.error||typeof value.stdout!=='string')throw Error(String(value.error||'VM 状态响应无效'));
            const result={stdout:value.stdout,stderr:'',exitCode:0,durationMs:0};this.last={time:Date.now(),result};for(const waiter of this.waiters){clearTimeout(waiter.timer);waiter.ok({...result});}this.waiters.clear();
          }catch(error){this.close(error as Error);return;}}
        });
        channel.on('error',(error:Error)=>{if(this.client===client)this.close(error);});
        channel.on('close',()=>{if(this.client===client)this.close(Error('VM 状态通道已结束'));});
        channel.stderr.on('data',()=>{});
      });});
      try{client.connect({...options,keepaliveInterval:10000,keepaliveCountMax:3});}catch(error){this.close(error as Error);}
    }
    return pending;
  }
  close(error=Error('VM 状态通道已关闭')){
    const client=this.client,channel=this.channel;this.client=undefined;this.channel=undefined;this.last=undefined;this.buffer='';this.identity='';
    for(const waiter of this.waiters){clearTimeout(waiter.timer);waiter.fail(error);}this.waiters.clear();channel?.destroy();client?.end();
  }
}