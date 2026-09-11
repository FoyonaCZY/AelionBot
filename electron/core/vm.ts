import { EventEmitter } from 'node:events';
import { createServer, type Server as HttpServer } from 'node:http';
import { createConnection, createServer as createTcpServer } from 'node:net';
import { copyFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve,extname } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawn, execFile,execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import ssh2 from 'ssh2';
import { WebSocketServer } from 'ws';
import {vmPlatform,vmMachineArgs,qemuBinary,qemuFirmware,qemuDataDir,type GuestArch} from './vm-platform';
import type { CommandResult, VmState } from '../../src/shared';
import type {TerminalDriver} from './terminal-sessions';
import { atomicJson } from './store';
import { DESKTOP_SCRIPT, WORKSTATION_VERSION, SESSION_LAUNCHER, GUEST_IMAGE_SEAL_SCRIPT } from './desktop-profile';
import { BOT_DESKTOP_SCRIPT,BOT_DESKTOP_VERSION } from './bot-desktop-profile';
import { WALLPAPER_INSTALL_SCRIPT } from './desktop-wallpaper';
import { DESKTOP_APPEARANCE_VERSION } from './desktop-appearance';
import { verifiedDownload, fileHash,type ResourceFetch } from './download';
import {workstationProgress,workstationFailure,installationProgress} from './workstation-progress';
import {PACKAGE_INSTALLER_BOOTSTRAP} from './package-installer';
import {shutdownOwnedVm} from './vm-shutdown';
import {stopOwnedQemuWindows,inspectOwnedQemuWindows} from './owned-qemu';

const runFile = promisify(execFile);
const { Client, utils } = ssh2;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const shQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function processAlive(pid?: number) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
async function freePort(): Promise<number> {
  return new Promise((ok, fail) => { const server=createTcpServer(); server.once('error',fail); server.listen(0,'127.0.0.1',()=>{const address=server.address(); const port=typeof address==='object'&&address?address.port:0;server.close(()=>ok(port));}); });
}
interface VmRecord {arch?:GuestArch;id: string; pid?: number; initialized?:boolean; workstationVersion?:string; sshPort: number; qmpPort: number; vncPort: number; seedPort: number; seedToken: string; hostKeyHash: string; preparedAt: string; }
export interface VmOptions { dataDir: string; runtimeDir: string; cacheDir: string; wallpaperPath?:string; memoryMiB?: number;cpuCount?:number;platform?:NodeJS.Platform;arch?:GuestArch;accelerator?:'tcg'|'hvf'|'whpx';startupTimeoutMs?:number;skipDesktop?:boolean;downloadFetch?:ResourceFetch; }

const INIT_SCRIPT = `#!/bin/sh
set -eu
mkdir -p /var/lib/aelion /work
udevadm settle
disk=/dev/disk/by-id/virtio-AELIONDATA
test -b "$disk"
kind=$(blkid -s TYPE -o value "$disk" || true)
if [ -z "$kind" ]; then mkfs.ext4 -F -L AELIONDATA "$disk"; fi
test "$(blkid -s TYPE -o value "$disk")" = ext4
uuid=$(blkid -s UUID -o value "$disk")
grep -q "$uuid" /etc/fstab || echo "UUID=$uuid /work ext4 defaults,nofail 0 2" >> /etc/fstab
mountpoint -q /work || mount /work
chown aelion:aelion /work
chmod 700 /work
touch /var/lib/aelion/work-ready
systemctl disable --now apt-daily.timer apt-daily-upgrade.timer || true
`;

export class VmController extends EventEmitter {
  readonly platform:ReturnType<typeof vmPlatform>;
  readonly dir: string;
  readonly executable: string;
  private record?: VmRecord;
  private stateValue: VmState;
  private operation = false;
  private activeExecutions = 0;
  private closing=false;
  private shutdownTask?:Promise<void>;
  private child?:import('node:child_process').ChildProcess;
  private seedServer?: HttpServer;
  private vncBridge?: WebSocketServer;
  private vncToken = randomBytes(24).toString('hex');
  private desktopPorts=new Map<string,number>();
  private desktopRuntime?:Promise<void>;
  private wallpaperTask?:Promise<void>;
  private wallpaperRetryAt=0;
  constructor(readonly options: VmOptions) {
    super(); this.dir=join(options.dataDir,'vm');mkdirSync(this.dir,{recursive:true});
    this.platform=vmPlatform(options.platform,options.arch);this.executable=qemuBinary(options.runtimeDir,this.platform.executable);
    if(existsSync(join(this.dir,'machine.json'))) this.record=JSON.parse(readFileSync(join(this.dir,'machine.json'),'utf8'));
    this.stateValue={status:this.record?'stopped':'unprepared',detail:this.record?'工作电脑已准备':'首次使用前需要准备工作电脑',imageVersion:this.platform.image.version,appsReady:this.record?this.record.workstationVersion===WORKSTATION_VERSION:undefined};
  }
  get state() { return {...this.stateValue}; }
  private update(patch: Partial<VmState>) { const changed=Object.entries(patch).some(([key,value])=>this.stateValue[key as keyof VmState]!==value);this.stateValue={...this.stateValue,...patch};if(changed)this.emit('state',this.state); }
  private assertOpen(){if(this.closing)throw Error('客户端正在退出，已取消工作电脑操作');}
  private persist() { atomicJson(join(this.dir,'machine.json'),this.record); }
  private async exclusive<T>(fn:()=>Promise<T>) {
    this.assertOpen();
    if(this.operation) throw new Error('工作电脑正在执行维护操作，请等待完成');
    this.operation=true;
    try{return await fn();}catch(error){this.update({status:'error',lastError:String((error as Error).message),detail:String((error as Error).message)});throw error;}finally{this.operation=false;}
  }
  async prepare() { return this.exclusive(async()=>{
    const imageProfile=this.platform.image;
    if(!existsSync(this.executable)) throw new Error('QEMU 运行时尚未安装。开发版请先运行 npm run vm:prepare-runtime。');
    if(this.record) { this.checkArchitecture();await this.refresh(); return; }
    this.update({status:'preparing',detail:'准备固定 Linux 镜像',progress:0,lastError:undefined});
    const base=join(this.dir,'base.qcow2');
    const cache=join(this.options.cacheDir,imageProfile.filename);
    if(!existsSync(base)&&existsSync(cache)) {
      this.update({detail:'校验本地镜像缓存'});
      if(await fileHash(cache)===imageProfile.sha512)copyFileSync(cache,base);else this.update({detail:'本地镜像缓存校验失败，正在重新下载'});
    }
    await verifiedDownload(imageProfile.url,base,imageProfile.sha512,(progress,detail)=>this.update({progress,detail}),'sha512',{fetch:this.options.downloadFetch,mirrors:imageProfile.mirrors});
    this.assertOpen();
    const img=qemuBinary(this.options.runtimeDir,this.platform.imageTool);
    const rootDisk=join(this.dir,'system.qcow2');const workDisk=join(this.dir,'work.qcow2');
    if(!existsSync(rootDisk)) await runFile(img,['create','-f','qcow2','-F','qcow2','-b',base,rootDisk,'16G'],{windowsHide:true});
    if(!existsSync(workDisk)) await runFile(img,['create','-f','qcow2',workDisk,'24G'],{windowsHide:true});
    if(this.platform.arch==='arm64'&&!existsSync(join(this.dir,'efi-vars.fd')))copyFileSync(qemuFirmware(this.options.runtimeDir,'edk2-arm-vars.fd'),join(this.dir,'efi-vars.fd'));
    for(const name of ['client','host']) if(!existsSync(join(this.dir,`${name}.key`))) {
      const pair=utils.generateKeyPairSync('ed25519');writeFileSync(join(this.dir,`${name}.key`),pair.private,{mode:0o600});writeFileSync(join(this.dir,`${name}.pub`),pair.public,{mode:0o600});
    }
    const hostPublic=readFileSync(join(this.dir,'host.pub'),'utf8').trim().split(/\s+/)[1];
    this.record={arch:this.platform.arch,id:randomUUID(),sshPort:0,qmpPort:0,vncPort:0,seedPort:0,seedToken:randomBytes(24).toString('hex'),hostKeyHash:createHash('sha256').update(Buffer.from(hostPublic,'base64')).digest('hex'),preparedAt:new Date().toISOString()};
    this.persist();this.update({status:'stopped',detail:'工作电脑已准备，可以启动',progress:1});
  }); }
  private checkArchitecture(){if(this.record&&(this.record.arch||'x64')!==this.platform.arch)throw Error('已保存的工作电脑来自不同 CPU 架构，请保留原工作数据并使用对应架构的应用');}
  private cloudConfig() {
    const publicKey=readFileSync(join(this.dir,'client.pub'),'utf8').trim();
    return '#cloud-config\n'+JSON.stringify({
      hostname:'aelion-work',manage_etc_hosts:true,disable_root:false,ssh_pwauth:false,
      users:[{name:'root',ssh_authorized_keys:[publicKey]},{name:'aelion',shell:'/bin/bash',lock_passwd:true,ssh_authorized_keys:[publicKey]}],
      ssh_keys:{ed25519_private:readFileSync(join(this.dir,'host.key'),'utf8'),ed25519_public:readFileSync(join(this.dir,'host.pub'),'utf8')},
      write_files:[{path:'/usr/local/sbin/aelion-init',permissions:'0755',content:INIT_SCRIPT},{path:'/usr/local/sbin/aelion-desktop',permissions:'0755',content:DESKTOP_SCRIPT}],
      runcmd:[['/usr/local/sbin/aelion-init'],...(this.options.skipDesktop?[]:[['sh','-c','nohup /usr/local/sbin/aelion-desktop > /var/log/aelion-desktop.log 2>&1 </dev/null &']])],
      final_message:'Aelion work computer cloud-init complete'
    });
  }
  private async seed() {
    this.assertOpen();
    if(this.seedServer) return;
    const record=this.record!;
    const userData=this.cloudConfig();
    this.seedServer=createServer((request,response)=>{
      const prefix=`/${record.seedToken}/`;
      if(request.method!=='GET'||!request.url?.startsWith(prefix)){response.writeHead(404).end();return;}
      const name=request.url.slice(prefix.length);
      response.setHeader('Content-Type','text/plain');
      if(name==='user-data') response.end(userData);
      else if(name==='meta-data') response.end(`instance-id: ${record.id}\nlocal-hostname: aelion-work\n`);
      else if(name==='vendor-data') response.end('{}');
      else response.writeHead(404).end();
    });
    await new Promise<void>((ok,fail)=>{this.seedServer!.once('error',fail);this.seedServer!.listen(processAlive(record.pid)?record.seedPort:0,'127.0.0.1',()=>ok());});
    const address=this.seedServer.address();record.seedPort=typeof address==='object'&&address?address.port:0;this.persist();
  }
  private async bridge() {
    if(this.vncBridge||!this.record) return;
    this.vncBridge=new WebSocketServer({host:'127.0.0.1',port:0,maxPayload:16*1024*1024});
    this.vncBridge.on('connection',(ws,request)=>{
      const desktop=[...this.desktopPorts].find(([id])=>request.url===`/${this.vncToken}/bot/${id}`);
      if(desktop){
        const client=new Client();let stream:ssh2.ClientChannel|undefined;
        const close=()=>{stream?.destroy();client.end();if(ws.readyState===ws.OPEN)ws.close();};ws.on('close',close);ws.on('error',close);client.on('error',close);
        client.on('ready',()=>client.forwardOut('127.0.0.1',0,'127.0.0.1',desktop[1],(error,channel)=>{
          if(error||ws.readyState!==ws.OPEN){channel?.destroy();close();return;}stream=channel;
          channel.on('data',(data:Buffer)=>{if(ws.readyState===ws.OPEN)ws.send(data);});channel.on('error',close);channel.on('close',close);
          ws.on('message',data=>channel.write(Buffer.isBuffer(data)?data:Buffer.from(data as ArrayBuffer)));
        }));
        client.connect({host:'127.0.0.1',port:this.record!.sshPort,username:'aelion',privateKey:readFileSync(join(this.dir,'client.key')),readyTimeout:10000,hostHash:'sha256',hostVerifier:(hash:string)=>hash===this.record!.hostKeyHash});return;
      }
      if(request.url!==`/${this.vncToken}`){ws.close(1008);return;}
      const tcp=createConnection({host:'127.0.0.1',port:this.record!.vncPort});
      tcp.on('data',data=>{if(ws.readyState===ws.OPEN)ws.send(data);});
      ws.on('message',data=>tcp.write(Buffer.isBuffer(data)?data:Buffer.from(data as ArrayBuffer)));
      const close=()=>{tcp.destroy();ws.close();};tcp.on('error',close);tcp.on('close',()=>ws.close());ws.on('close',()=>tcp.destroy());ws.on('error',()=>tcp.destroy());
    });
    await new Promise<void>((ok,fail)=>{this.vncBridge!.once('listening',ok);this.vncBridge!.once('error',fail);});
    const address=this.vncBridge.address();if(address&&typeof address==='object')this.update({vncUrl:`ws://127.0.0.1:${address.port}/${this.vncToken}`});
  }
  private closeServers() { this.seedServer?.close();this.seedServer=undefined;for(const client of this.vncBridge?.clients||[])client.terminate();this.vncBridge?.close();this.vncBridge=undefined;this.desktopPorts.clear();this.desktopRuntime=undefined;this.wallpaperTask=undefined;this.wallpaperRetryAt=0;this.update({vncUrl:undefined}); }
  async start() { this.assertOpen();if(!this.record) await this.prepare();return this.exclusive(async()=>{
    this.checkArchitecture();
    if(process.platform==='darwin'&&process.arch==='x64'){let translated=false;try{translated=execFileSync('/usr/sbin/sysctl',['-in','sysctl.proc_translated'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()==='1';}catch{}if(translated)throw Error('当前运行的是 Intel 安装包，请为这台 Apple Silicon Mac 下载 ARM64 安装包');}
    await this.refresh();if(this.stateValue.status==='ready')return;
    if(processAlive(this.record?.pid))throw new Error('检测到工作 VM 进程仍存在，暂不启动第二个实例；请检查日志。');
    if(!existsSync(this.executable))throw new Error('QEMU 运行时缺失');
    this.closeServers();await this.seed();
    this.assertOpen();
    const r=this.record!;r.sshPort=await freePort();r.qmpPort=await freePort();r.vncPort=await freePort();
    const qpath=(value:string)=>value.replaceAll(',',',,');
    const args=['-L',qemuDataDir(this.options.runtimeDir),'-name',`aelion-${r.id}`,'-uuid',r.id,...vmMachineArgs(this.platform,this.options.runtimeDir,join(this.dir,'efi-vars.fd'),this.options.accelerator||this.platform.accelerator),'-m',String(this.options.memoryMiB||4096),'-smp',String(this.options.cpuCount||4),'-display','none',
      '-device','qemu-xhci,id=usb0','-device','usb-tablet,bus=usb0.0','-device','usb-kbd,bus=usb0.0',
      '-drive',`file=${qpath(join(this.dir,'system.qcow2'))},if=none,id=systemdisk,format=qcow2,discard=unmap`,'-device','virtio-blk-pci,drive=systemdisk,bootindex=1',
      '-drive',`file=${qpath(join(this.dir,'work.qcow2'))},if=none,id=workdisk,format=qcow2,discard=unmap`,'-device','virtio-blk-pci,drive=workdisk,serial=AELIONDATA',
      '-netdev',`user,id=net0,hostfwd=tcp:127.0.0.1:${r.sshPort}-:22`,'-device','virtio-net-pci,netdev=net0',
      '-device','virtio-rng-pci','-smbios',`type=1,serial=ds=nocloud-net;s=http://10.0.2.2:${r.seedPort}/${r.seedToken}/`,
      '-vnc',`127.0.0.1:${r.vncPort-5900}`,'-qmp',`tcp:127.0.0.1:${r.qmpPort},server=on,wait=off`,
      '-serial',`file:${qpath(join(this.dir,'serial.log'))}`,'-monitor','none'];
    const log=openSync(join(this.dir,'qemu.log'),'a');
    const env={...process.env};if(process.platform==='darwin'){env.QEMU_MODULE_DIR=join(this.options.runtimeDir,'lib','qemu');delete env.DYLD_LIBRARY_PATH;delete env.DYLD_FALLBACK_LIBRARY_PATH;delete env.DYLD_INSERT_LIBRARIES;}
    const child=spawn(this.executable,args,{cwd:this.options.runtimeDir,env,windowsHide:true,detached:true,stdio:['ignore',log,log]});closeSync(log);
    this.child=child;r.pid=child.pid;
    child.once('exit',()=>{if(this.child===child)this.child=undefined;});
    await new Promise<void>((ok,fail)=>{child.once('spawn',ok);child.once('error',fail);});
    child.unref();this.persist();this.assertOpen();
    this.update({status:'starting',detail:'启动工作电脑，等待系统初始化',pid:r.pid,sshPort:r.sshPort,lastError:undefined,desktopReady:false,appsReady:false,needsReboot:false,maintenance:false,progress:undefined});
    await this.bridge();
    const deadline=Date.now()+(this.options.startupTimeoutMs||240_000);
    while(Date.now()<deadline){
      this.assertOpen();
      if(!processAlive(r.pid))throw new Error(`QEMU 已退出：${readFileSync(join(this.dir,'qemu.log'),'utf8').slice(-1800)}`);
      try {
        const result=await this.execRaw('test -f /var/lib/aelion/work-ready && test -d /work && printf AELION_READY','aelion',5000);
        if(result.exitCode===0&&result.stdout.includes('AELION_READY')){r.initialized=true;this.persist();this.update({status:'ready',detail:'工作电脑已就绪',progress:1});await this.refresh();return;}
      }catch{/* SSH readiness is polled; process remains authoritative. */}
      await sleep(1500);
    }
    throw new Error(`工作电脑进程仍在运行，但初始化超过 ${Math.ceil((this.options.startupTimeoutMs||240000)/60000)} 分钟。请查看工作电脑启动日志后重试。`);
  }); }
  async qmp(command: string, args?:Record<string,unknown>):Promise<any> {
    if(!this.record?.qmpPort)throw new Error('工作电脑尚未运行');
    return new Promise((ok,fail)=>{
      const socket=createConnection({host:'127.0.0.1',port:this.record!.qmpPort});let buffer='';let finished=false,identityVerified=false,sent=false;
      const mutating=['system_powerdown','quit','system_reset'].includes(command),expectedId=this.record!.id;
      const sendCommand=()=>{sent=true;socket.write(JSON.stringify({execute:command,arguments:args,id:'cmd'})+'\n');};
      const finish=(error?:Error,value?:unknown)=>{if(finished)return;finished=true;clearTimeout(timeout);socket.destroy();error?fail(error):ok(value);};
      const timeout=setTimeout(()=>finish(new Error('QMP 连接超时')),3000);socket.on('error',error=>finish(error));
      socket.on('data',chunk=>{buffer+=chunk.toString();if(buffer.length>256000){finish(Error('QMP 响应过大'));return;}let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);if(!line)continue;let msg;try{msg=JSON.parse(line);}catch{continue;}
        if(msg.QMP)socket.write(JSON.stringify({execute:'qmp_capabilities',id:'cap'})+'\n');
        else if(msg.id==='cap'){if(msg.error)finish(new Error(JSON.stringify(msg.error)));else if(mutating)socket.write(JSON.stringify({execute:'query-uuid',id:'identity'})+'\n');else sendCommand();}
        else if(msg.id==='identity'){if(msg.error||msg.return?.UUID!==expectedId)finish(new Error('拒绝操作身份不匹配的 QEMU'));else{identityVerified=true;sendCommand();}}
        else if(msg.id==='cmd')msg.error?finish(new Error(JSON.stringify(msg.error))):finish(undefined,msg.return);
      }});
      socket.on('close',()=>{if(!finished)finish(command==='quit'&&identityVerified&&sent?undefined:new Error('QMP 已断开'));});
    });
  }
  async refresh() {
    if(this.closing)return this.state;
    if(!this.record)return this.state;
    this.update({diskBytes:statSync(join(this.dir,'system.qcow2')).size+statSync(join(this.dir,'work.qcow2')).size});
    if(!processAlive(this.record.pid)){if(this.record.pid){this.record.pid=undefined;this.persist();}if(!this.operation)this.update({status:'stopped',detail:'工作电脑已关闭，工作文件已保留',pid:undefined,vncUrl:undefined});return this.state;}
    let identityVerified=false;
    try{
      const identity=await this.qmp('query-uuid');if(identity.UUID!==this.record.id)throw new Error('VM 身份校验失败');identityVerified=true;
      const status=await this.qmp('query-status');
      if(status.running){
        const result=await this.execRaw(`test -f /var/lib/aelion/work-ready && printf READY; systemctl is-active --quiet lightdm && pgrep -u aelion -x xfce4-session >/dev/null && printf DESKTOP; test -f /var/lib/aelion/desktop-error && printf TOOL_ERROR; test -f /var/lib/aelion/desktop-needs-reboot && printf NEEDS_REBOOT; test "$(cat /var/lib/aelion/workstation-version 2>/dev/null)" = '${WORKSTATION_VERSION}' && test -x /usr/local/bin/aelion-browser && test -x /usr/bin/thunar && test -x /usr/local/bin/aelion-session && printf APPS; printf '\\nSTAGE:'; cat /var/lib/aelion/desktop-stage 2>/dev/null; printf '\\nINSTALL_PROGRESS:'; cat /var/lib/aelion/desktop-progress.json 2>/dev/null; printf '\\n'`,'aelion',4000);
        const desktop=result.stdout.includes('DESKTOP');
        const lock=await this.execRaw('flock -n /var/lib/aelion/desktop.lock -c true','root',4000);
        const maintenance=lock.exitCode!==0;this.update({installation:maintenance?installationProgress(result.stdout):undefined});
        if(result.stdout.includes('READY')){
          const appsReady=result.stdout.includes('APPS'),needsReboot=result.stdout.includes('NEEDS_REBOOT');let save=false;
          if(!this.record.initialized){this.record.initialized=true;save=true;}
          if(appsReady&&this.record.workstationVersion!==WORKSTATION_VERSION){this.record.workstationVersion=WORKSTATION_VERSION;save=true;}
          if(save)this.persist();
          this.update({status:'ready',detail:maintenance?workstationProgress(result.stdout):needsReboot?'应用已安装，请重启工作电脑完成初始化':desktop&&appsReady?'工作电脑已就绪':desktop?'桌面在线，应用环境需要准备':'正在准备桌面',pid:this.record.pid,sshPort:this.record.sshPort,desktopReady:desktop,appsReady,maintenance,needsReboot,lastError:result.stdout.includes('TOOL_ERROR')?workstationFailure(result.stdout):undefined});
        }
        else await this.seed();
        if(!this.closing)await this.ensureWallpaper();
        if(!this.closing)await this.bridge();
      }
    }catch(error){
      if(!identityVerified&&!this.closing&&this.record.pid&&process.platform==='win32'){
        const identity=await inspectOwnedQemuWindows({id:this.record.id,pid:this.record.pid,executable:this.executable,systemDisk:join(this.dir,'system.qcow2'),workDisk:join(this.dir,'work.qcow2')});
        if(identity==='missing'||identity==='foreign'){this.record.pid=undefined;this.persist();this.closeServers();this.update({status:'stopped',pid:undefined,detail:'工作电脑已关闭，工作文件已保留',lastError:undefined});return this.state;}
      }
      if(!this.operation){
      if(!this.record.initialized){try{await this.seed();this.update({status:'starting',detail:'正在继续首次初始化',pid:this.record.pid});return this.state;}catch{}}
      this.update({status:'error',detail:'VM 进程存在，连接尚未恢复',lastError:(error as Error).message,pid:this.record.pid});
    }}
    return this.state;
  }
  private async ensureWallpaper(){
    if(!this.options.wallpaperPath||this.closing||this.stateValue.status!=='ready'||!this.stateValue.appsReady||this.stateValue.maintenance||Date.now()<this.wallpaperRetryAt)return;
    if(this.wallpaperTask)return this.wallpaperTask;
    const install=async()=>{
      const image=readFileSync(this.options.wallpaperPath!);
      if(image.length>8*1024*1024||!image.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))throw new Error('工作电脑壁纸无效');
      const hash=createHash('sha256').update(image).digest('hex');
      const probe=await this.execRaw(`test "$(cat /var/lib/aelion/desktop-appearance-version 2>/dev/null)" = ${shQuote(DESKTOP_APPEARANCE_VERSION)} && sha256sum /usr/local/share/aelion/wallpaper.png`,'aelion',5000);
      if(probe.exitCode===0&&probe.stdout.trim().split(/\s+/)[0]===hash)return;
      const result=await this.execRaw(`flock -n /var/lib/aelion/desktop.lock python3 -c ${shQuote(WALLPAPER_INSTALL_SCRIPT)} ${shQuote(hash)}`,'root',60000,undefined,10000,image);
      if(result.exitCode!==0)throw new Error(result.stderr||'工作电脑壁纸更新失败');
    };
    // A cosmetic update must not turn a healthy computer into an error state.
    const pending=install().catch(error=>{
      if(this.wallpaperTask===pending){this.wallpaperTask=undefined;this.wallpaperRetryAt=Date.now()+60000;}
      console.warn('工作电脑壁纸稍后重试：',(error as Error).message);
    });
    this.wallpaperTask=pending;
    await pending;
  }
  private async execRaw(command:string,username:'aelion'|'root',timeoutMs:number,signal?:AbortSignal,outputLimit=2_000_000,inputBytes?:Buffer):Promise<CommandResult>{
    // QEMU's local forwarding can briefly refuse a new socket under concurrent load.
    // Retry only refused connections: no SSH session or guest command has started.
    for(let attempt=0;;attempt++){
      try{return await this.execOnce(command,username,timeoutMs,signal,outputLimit,inputBytes);}
      catch(error){if(attempt>=2||signal?.aborted||(error as NodeJS.ErrnoException).code!=='ECONNREFUSED')throw error;await sleep(100*(attempt+1));}
    }
  }
  private async execOnce(command:string,username:'aelion'|'root',timeoutMs:number,signal?:AbortSignal,outputLimit=2_000_000,inputBytes?:Buffer):Promise<CommandResult>{
    if(!this.record?.sshPort)throw new Error('工作电脑尚未启动');
    const begin=Date.now();
    return new Promise((ok,fail)=>{
      const client=new Client();let stdout='',stderr='';let finished=false;
      const finish=(error?:Error,exitCode=0)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);client.end();error?fail(error):ok({stdout,stderr,exitCode,durationMs:Date.now()-begin});};
      const abort=()=>finish(new Error('操作已取消；请核对已发生的命令结果'));
      const timer=setTimeout(()=>finish(new Error('guest 命令或 SSH 连接超时')),timeoutMs);
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}
      client.on('error',error=>finish(error));
      client.on('ready',()=>client.exec(command,(error,channel)=>{
        if(error){finish(error);return;}
        channel.on('data',(data:Buffer)=>{stdout+=data.toString();if(stdout.length>outputLimit)finish(new Error('执行输出超过上限，请缩小读取范围'));});
        channel.stderr.on('data',(data:Buffer)=>{if(stderr.length<2_000_000)stderr+=data.toString();});
        channel.on('close',(code:number)=>finish(undefined,typeof code==='number'?code:1));if(inputBytes)channel.end(inputBytes);
      }));
      client.connect({host:'127.0.0.1',port:this.record!.sshPort,username,privateKey:readFileSync(join(this.dir,'client.key')),readyTimeout:Math.min(timeoutMs,10000),hostHash:'sha256',hostVerifier:(hash:string)=>hash===this.record!.hostKeyHash});
    });
  }
  async execute(command:string,botId:string,signal?:AbortSignal,outputLimit=2_000_000):Promise<CommandResult>{
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(botId))throw new Error('无效工作区');
    if(this.operation||this.stateValue.status!=='ready')throw new Error('工作电脑尚未就绪或正在维护');
    if(!command.trim()||command.length>32000)throw new Error('命令为空或过长');
    this.activeExecutions++;
    try{return await this.execRaw(`mkdir -p ${shQuote(`/work/${botId}`)} && cd ${shQuote(`/work/${botId}`)} && AELION_BOT_ID=${shQuote(botId)} timeout -s TERM 120 sh -lc ${shQuote(command)}`,'aelion',130000,signal,outputLimit);}finally{this.activeExecutions--;}
  }
  async openTerminal(botId:string,command:string,cwd:string,signal:AbortSignal,pty?:{cols:number;rows:number}):Promise<TerminalDriver>{
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(botId)||!this.record?.sshPort||this.operation||this.stateValue.status!=='ready')throw Error('工作电脑尚未就绪');
    const record=this.record;signal.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const client=new Client(),events=new EventEmitter();let channel:import('ssh2').ClientChannel|undefined,opened=false,closed=false;
      const close=(code=-1)=>{if(closed)return;closed=true;clearTimeout(timer);signal.removeEventListener('abort',abort);if(opened){this.activeExecutions--;events.emit('exit',code);}client.end();};
      const fail=(error:Error)=>{if(!opened)reject(error);close();};
      const abort=()=>{channel?.signal('KILL');channel?.close();fail(Error('终端连接已取消'));};
      const timer=setTimeout(()=>fail(Error('终端 SSH 连接超时')),10000);signal.addEventListener('abort',abort,{once:true});
      client.on('error',fail);client.on('close',()=>close());
      client.on('ready',()=>client.exec(`mkdir -p ${shQuote(`/work/${botId}`)} && cd ${shQuote(cwd)} && exec /bin/bash -lc ${shQuote(command)}`,pty?{pty:{term:'xterm-256color',cols:pty.cols,rows:pty.rows}}:{},(error,stream)=>{
        if(error){fail(error);return;}if(closed){stream.close();return;}channel=stream;opened=true;this.activeExecutions++;clearTimeout(timer);signal.removeEventListener('abort',abort);
        stream.on('data',(bytes:Buffer)=>events.emit('data',bytes.toString('utf8')));stream.stderr.on('data',(bytes:Buffer)=>events.emit('data',bytes.toString('utf8')));stream.on('close',(code:number)=>close(typeof code==='number'?code:-1));
        resolve({write:text=>stream.write(text),resize:(cols,rows)=>stream.setWindow(rows,cols,0,0),onData:fn=>events.on('data',fn),onExit:fn=>events.on('exit',fn),kill:()=>{try{stream.signal('KILL');}finally{stream.close();client.end();}}});
      }));
      client.connect({host:'127.0.0.1',port:record.sshPort,username:'aelion',privateKey:readFileSync(join(this.dir,'client.key')),readyTimeout:10000,hostHash:'sha256',hostVerifier:(hash:string)=>hash===record.hostKeyHash});
    });
  }
  async executePython(code:string,input:Buffer,botId:string,signal?:AbortSignal,outputLimit=2_000_000):Promise<CommandResult>{
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(botId))throw new Error('无效工作区');
    if(this.operation||this.stateValue.status!=='ready')throw new Error('工作电脑尚未就绪或正在维护');
    if(!code.trim()||code.length>32000||input.length>8*1024*1024)throw new Error('Python 脚本或输入超过大小限制');
    this.activeExecutions++;
    try{return await this.execRaw(`mkdir -p ${shQuote(`/work/${botId}`)} && cd ${shQuote(`/work/${botId}`)} && AELION_BOT_ID=${shQuote(botId)} timeout -s TERM 120 python3 -c ${shQuote(code)}`,'aelion',130000,signal,outputLimit,input);}finally{this.activeExecutions--;}
  }
  async importAttachment(botId:string,id:string,name:string,bytes:Buffer,signal:AbortSignal){
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(botId)||!/^[a-f0-9-]{36}$/.test(id)||!name||name.length>512||/[\\/\u0000-\u001f]/.test(name)||name==='.'||name==='..')throw new Error('附件目标路径无效');
    if(Buffer.byteLength(name)>220){const extension=extname(name).slice(0,20),stem=extension?name.slice(0,-extname(name).length):name;let shortened='';for(const character of stem){if(Buffer.byteLength(shortened+character+extension)>220)break;shortened+=character;}name=(shortened||'attachment')+extension;}
    if(this.operation||this.stateValue.status!=='ready')throw new Error('工作电脑尚未就绪或正在维护');
    if(bytes.length>25*1024*1024)throw new Error('附件超过 25 MB');signal.throwIfAborted();
    const data=Buffer.from(JSON.stringify({botId,id,name,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})).toString('base64');
    const script=`import base64,json,pathlib,sys,hashlib,os,tempfile
a=json.loads(base64.b64decode('${data}')); root=pathlib.Path('/work')/a['botId']; root.mkdir(exist_ok=True)
assert root.resolve()==root, 'Workspace is a symbolic link'
folder=root/'attachments'/a['id']; assert folder.resolve().is_relative_to(root), 'Attachment directory is outside workspace'
folder.mkdir(parents=True,exist_ok=True); target=folder/a['name']; assert not target.is_symlink(), 'Attachment target is a symbolic link'
blob=sys.stdin.buffer.read(a['size']+1); assert len(blob)==a['size'] and hashlib.sha256(blob).hexdigest()==a['sha256'], 'Attachment transfer incomplete'
if target.exists():
    assert target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest()==a['sha256'], 'Existing attachment was modified; not overwritten'
else:
    fd,temp=tempfile.mkstemp(prefix='.incoming-',dir=folder)
    try:
        with os.fdopen(fd,'wb') as out: out.write(blob); out.flush(); os.fsync(out.fileno())
        os.link(temp,target)
    finally: os.unlink(temp)
print(json.dumps({'path':str(target),'size':len(blob),'sha256':a['sha256']},ensure_ascii=False))`;
    this.activeExecutions++;
    try{const result=await this.execRaw(`python3 -c ${shQuote(script)}`,'aelion',130000,signal,10000,bytes);if(result.exitCode!==0)throw new Error(result.stderr||'附件复制失败');return JSON.parse(result.stdout) as {path:string;size:number;sha256:string};}finally{this.activeExecutions--;}
  }
  async ensureDesktopRuntime(){
    if(this.desktopRuntime)return this.desktopRuntime;
    const prepare=async()=>{
      if(this.stateValue.status!=='ready'||!this.stateValue.appsReady)throw new Error('请先准备好工作电脑应用');
      const probe=await this.execRaw(`test "$(cat /var/lib/aelion/bot-desktop-version 2>/dev/null)" = ${shQuote(BOT_DESKTOP_VERSION)} && test -x /usr/local/bin/aelion-bot-desktop && test -x /usr/bin/Xtigervnc`,'aelion',5000);
      if(probe.exitCode===0)return;
      await this.exclusive(async()=>{
        this.update({maintenance:true,detail:'正在准备 Bot 独立桌面'});
        const payload=Buffer.from(JSON.stringify({'/usr/local/bin/aelion-bot-desktop':BOT_DESKTOP_SCRIPT,'/usr/local/bin/aelion-session':SESSION_LAUNCHER})).toString('base64');
        const install=`set -eu\nexport DEBIAN_FRONTEND=noninteractive\nexec 9>/var/lib/aelion/desktop.lock\nflock -n 9\n${PACKAGE_INSTALLER_BOOTSTRAP}\n/usr/local/sbin/aelion-packages runtime tigervnc-standalone-server python3-pil xauth x11-utils xdotool xclip\npython3 - <<'PY'\nimport json,base64,pathlib\nfor name,body in json.loads(base64.b64decode('${payload}')).items():\n p=pathlib.Path(name); backup=p.with_suffix('.before-bot-desktops')\n if p.exists() and not backup.exists(): backup.write_bytes(p.read_bytes())\n temp=p.with_suffix('.new');temp.write_text(body);temp.chmod(0o755);temp.replace(p)\nfrom PIL import features\nassert features.check_feature('xcb'), 'Pillow XCB support is required'\npathlib.Path('/var/lib/aelion/bot-desktop-version').write_text('${BOT_DESKTOP_VERSION}')\nPY`;
        try{const result=await this.execRaw(install,'root',900000);if(result.exitCode!==0)throw new Error(`独立桌面准备失败：${result.stderr.slice(-1600)}`);}
        finally{this.update({maintenance:false});}
      });
    };
    const pending=prepare();this.desktopRuntime=pending;
    try{await pending;}catch(error){if(this.desktopRuntime===pending)this.desktopRuntime=undefined;throw error;}
  }
  async ensureBotDesktop(botId:string){
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(botId))throw new Error('无效工作区');
    await this.ensureDesktopRuntime();
    const result=await this.execute(`/usr/local/bin/aelion-bot-desktop ensure ${shQuote(botId)}`,botId);
    if(result.exitCode!==0)throw new Error(result.stderr||'独立桌面启动失败');
    const desktop=JSON.parse(result.stdout) as {botId:string;display:number;port:number;bootId:string};
    if(desktop.botId!==botId||!Number.isInteger(desktop.display)||desktop.display<30||desktop.display>=230||desktop.port!==5900+desktop.display||typeof desktop.bootId!=='string')throw new Error('独立桌面身份无效');
    this.desktopPorts.set(botId,desktop.port);await this.bridge();
    return {...desktop,vncUrl:`${this.stateValue.vncUrl}/bot/${botId}`};
  }
  async executeDesktop(command:string,botId:string,signal?:AbortSignal,outputLimit=2_000_000){
    return this.execute(`/usr/local/bin/aelion-bot-desktop exec ${shQuote(botId)} sh -c ${shQuote(command)}`,botId,signal,outputLimit);
  }
  async desktopScreenshot(botId:string,signal?:AbortSignal){
    const script="import os,io,base64;from PIL import ImageGrab;b=io.BytesIO();ImageGrab.grab(xdisplay=os.environ['DISPLAY']).save(b,format='PNG');print(base64.b64encode(b.getvalue()).decode())";
    const result=await this.executeDesktop(`python3 -c ${shQuote(script)}`,botId,signal,14*1024*1024);
    if(result.exitCode!==0)throw new Error(result.stderr||'独立桌面截图失败');return Buffer.from(result.stdout.trim(),'base64');
  }
  async installSkillPackage(botId:string,id:string,folder:string,files:Array<{path:string;bytes:Buffer}>):Promise<string>{
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(botId)||! /^[a-f0-9-]{1,80}$/.test(id)||!folder||folder==='.'||folder==='..'||/[\\/\0]/.test(folder))throw new Error('无效技能包路径');
    if(this.operation||this.stateValue.status!=='ready')throw new Error('启动工作电脑后才能同步技能资源');
    const payload=JSON.stringify({folder,files:files.map(file=>({path:file.path,data:file.bytes.toString('base64')}))});
    if(payload.length>24*1024*1024)throw new Error('技能包过大');
    const target=`/work/${botId}/.skills/${id}`;
    const program=`import sys,json,pathlib,base64; a=json.load(sys.stdin); base=pathlib.Path(${JSON.stringify(target)}); base.mkdir(parents=True,exist_ok=True); workspace=pathlib.Path('/work/${botId}').resolve(); assert base.resolve().is_relative_to(workspace); root=base/a['folder']; root.mkdir(exist_ok=True); assert root.resolve().is_relative_to(base.resolve());\nfor f in a['files']:\n p=root/f['path']; assert not p.is_symlink() and p.resolve().is_relative_to(root.resolve()); p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(base64.b64decode(f['data']));\n if p.suffix=='.sh': p.chmod(0o755)\nprint(str(root))`;
    this.activeExecutions++;
    try{return await new Promise<string>((ok,fail)=>{
      const client=new Client();let done=false,stdout='',stderr='';
      const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);client.end();error?fail(error):ok(stdout.trim());};
      const timer=setTimeout(()=>finish(new Error('技能同步超时')),60000);
      client.on('error',error=>finish(error));
      client.on('ready',()=>client.exec(`python3 -c ${shQuote(program)}`,(error,channel)=>{
        if(error){finish(error);return;}
        channel.on('data',(data:Buffer)=>{stdout+=data.toString();});channel.stderr.on('data',(data:Buffer)=>{if(stderr.length<2000)stderr+=data.toString();});
        channel.on('close',(code:number)=>finish(code===0?undefined:new Error(stderr||'技能同步失败')));channel.end(payload);
      }));
      client.connect({host:'127.0.0.1',port:this.record!.sshPort,username:'aelion',privateKey:readFileSync(join(this.dir,'client.key')),readyTimeout:10000,hostHash:'sha256',hostVerifier:(hash:string)=>hash===this.record!.hostKeyHash});
    });}finally{this.activeExecutions--;}
  }
  async repairTools(){return this.exclusive(async()=>{
    if(!processAlive(this.record?.pid))throw new Error('请先启动工作电脑');
    this.update({maintenance:true,lastError:undefined,detail:'正在更新工作环境'});
    await this.execRaw(`python3 -c ${shQuote("import os,sys; p='/usr/local/sbin/aelion-desktop.new'; open(p,'wb').write(sys.stdin.buffer.read()); os.chmod(p,0o755); os.replace(p,'/usr/local/sbin/aelion-desktop')")}`,'root',10000,undefined,2048,Buffer.from(DESKTOP_SCRIPT));
    await this.execRaw('nohup /usr/local/sbin/aelion-desktop > /var/log/aelion-desktop.log 2>&1 </dev/null &','root',5000);
    this.update({detail:'已启动工具环境修复，工作文件保留'});
  });}
  async sealProvisionedGuest(){return this.exclusive(async()=>{
    if(this.stateValue.status!=='ready'||!this.stateValue.appsReady)throw new Error('请先准备好工作电脑应用');
    const result=await this.execRaw(GUEST_IMAGE_SEAL_SCRIPT,'root',120000);
    if(result.exitCode!==0)throw new Error(result.stderr||'预装镜像收尾失败');
    return result;
  });}
  async stop(){return this.exclusive(async()=>{
    if(this.activeExecutions)throw new Error('仍有命令正在运行，请先停止任务');
    if(!processAlive(this.record?.pid)){this.closeServers();this.update({status:this.record?'stopped':'unprepared',detail:'工作电脑已关闭'});return;}
    const identity=await this.qmp('query-uuid');if(identity.UUID!==this.record!.id)throw new Error('拒绝关闭身份不匹配的进程');
    const maintenance=await this.execRaw('flock -n /var/lib/aelion/desktop.lock -c true','root',5000);
    if(maintenance.exitCode!==0)throw new Error('桌面工具正在准备，请等待维护任务完成后再关闭或重启。');
    this.update({status:'stopping',detail:'正在安全关闭工作电脑'});await this.qmp('system_powerdown');
    const until=Date.now()+45000;
    while(processAlive(this.record?.pid)&&Date.now()<until)await sleep(500);
    if(processAlive(this.record?.pid))throw new Error('关机尚未完成，实例仍在运行；没有强制终止。');
    this.record!.pid=undefined;this.persist();this.closeServers();this.update({status:'stopped',detail:'工作电脑已关闭，工作文件已保留',pid:undefined,vncUrl:undefined});
  });}
  async restart(){await this.stop();await this.start();}
  beginShutdown(){this.closing=true;}
  shutdownForExit(){this.beginShutdown();return this.shutdownTask??=this.finishShutdown();}
  private async finishShutdown(){
    const target=this.record&&this.record.pid?{id:this.record.id,pid:this.record.pid}:undefined;
    try{if(target)await shutdownOwnedVm(target,{alive:processAlive,qmp:command=>this.qmp(command),force:async()=>{
      if(process.platform==='win32')return stopOwnedQemuWindows({...target,executable:this.executable,systemDisk:join(this.dir,'system.qcow2'),workDisk:join(this.dir,'work.qcow2')});
      const child=this.child;if(child?.pid===target.pid&&child.exitCode===null){child.kill('SIGTERM');return true;}return false;
    }});
      if(this.record){this.record.pid=undefined;this.persist();}this.update({status:this.record?'stopped':'unprepared',pid:undefined,detail:'工作电脑已关闭，工作文件已保留',vncUrl:undefined});
    }finally{this.closeServers();}
  }
  async desktopDiagnostics(){return this.execRaw('systemctl status lightdm --no-pager -l; ls -l /dev/dri /dev/fb0 2>/dev/null; grep -E "CONFIG_DRM|CONFIG_FB_VESA|CONFIG_FB_SIMPLE" /boot/config-$(uname -r) | head -n 15; tail -n 20 /var/log/Xorg.0.log; pgrep -af "Xorg|xfce|lightdm|aelion-desktop|apt-get|dpkg"; ls /boot/vmlinuz*; ls /var/lib/aelion; cat /etc/default/grub.d/90-aelion.cfg 2>/dev/null; tail -n 30 /var/log/aelion-desktop.log','root',10000);}
  async displayDiagnostics(){return this.execRaw('DISPLAY=:0 XAUTHORITY=/home/aelion/.Xauthority xset q; DISPLAY=:0 XAUTHORITY=/home/aelion/.Xauthority xrandr --query; cat /proc/bus/input/devices | grep -E "Name=|Handlers="','aelion',10000);}
  dispose(){this.closeServers();}
}
