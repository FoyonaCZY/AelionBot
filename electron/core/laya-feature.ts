import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {chmodSync,existsSync,mkdirSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {homedir} from 'node:os';
import {DECISION_MODELS,type LayaFeatureState,type LayaVariant} from '../../src/laya-types';
import {LayaShadow} from './laya-shadow';
import {verifiedDownload} from './download';

const UV_VERSION='0.12.18';
const UV_ASSETS={
  'darwin-arm64':{name:'uv-aarch64-apple-darwin.tar.gz',sha256:'cf40e0c6a202190ccd9e0406dcfdd5b2d6668a9a5c779b17948963df32aafe5b'},
  'linux-x64':{name:'uv-x86_64-unknown-linux-gnu.tar.gz',sha256:'89eadd7c76fc063887959510d5ba0ab1264dfd5f1143b925ddb73021a40acf16'},
  'linux-arm64':{name:'uv-aarch64-unknown-linux-gnu.tar.gz',sha256:'afb6291f3f0a6b4521fc67b947822506c41dde5b60d2189dd8f3695b2ac8c9e7'},
  'win32-x64':{name:'uv-x86_64-pc-windows-msvc.zip',sha256:'cae6a3bc25239f83dffb467a4b180508d9da23986c04639ebfa44e43e6a84bff'},
} as const;

export function preferredLayaVariant(platform:string,arch:string):LayaVariant|undefined{
  if(platform==='darwin'&&arch==='arm64')return 'mlx';
  if(platform==='win32'&&arch==='x64'||platform==='linux'&&['x64','arm64'].includes(arch))return 'standard';
  return undefined;
}

type Saved={installed:Partial<Record<LayaVariant,string>>;enabled:boolean;active?:LayaVariant};

export class LayaFeature {
  private file:string;
  private saved?:Saved;
  private phase:LayaFeatureState['phase']='not-installed';
  private error?:string;
  private downloading?:LayaVariant;
  private child?:ChildProcessWithoutNullStreams;
  private downloadAbort?:AbortController;
  private installing=false;
  private generation=0;
  private disposed=false;

  constructor(private dir:string,private shadow:LayaShadow,private changed:()=>void,private supported=Boolean(preferredLayaVariant(process.platform,process.arch))){
    this.file=join(dir,'laya-runtime','feature.json');
    try{
      const value=JSON.parse(readFileSync(this.file,'utf8')) as Partial<Saved>&{installed?:Saved['installed']|true;variant?:LayaVariant;python?:string};
      const installed=value.installed===true&&value.variant&&value.python?{[value.variant]:value.python}:value.installed;
      if(installed&&typeof installed==='object'){
        const paths:Saved['installed']={};
        for(const variant of ['mlx','standard'] as const)if(typeof installed[variant]==='string'&&existsSync(installed[variant]))paths[variant]=installed[variant];
        if(Object.keys(paths).length)this.saved={installed:paths,active:value.active&&paths[value.active]?value.active:value.variant&&paths[value.variant]?value.variant:undefined,enabled:Boolean(value.enabled)};
      }
    }catch{/* No user opt-in yet. */}
    if(this.saved?.enabled&&this.saved.active)this.start();else if(this.saved)this.phase='disabled';
  }

  snapshot():LayaFeatureState{const stopped=this.phase==='ready'&&!this.shadow.isReady;return {phase:stopped?'error':this.phase,installed:(['standard','mlx'] as const).filter(variant=>Boolean(this.saved?.installed[variant])),enabled:Boolean(this.saved?.enabled),active:this.saved?.active,recommended:preferredLayaVariant(process.platform,process.arch),downloading:this.downloading,error:stopped?'决策模型已停止运行':this.error,supported:this.supported};}

  private save(value:Saved){
    mkdirSync(dirname(this.file),{recursive:true});
    const next=this.file+'.new';writeFileSync(next,JSON.stringify(value),{mode:0o600});renameSync(next,this.file);
    this.saved=value;this.changed();
  }

  private start(){
    if(!this.saved?.enabled||!this.saved.active)return;
    const generation=++this.generation;
    this.phase='loading';this.error=undefined;this.changed();
    this.shadow.configure(this.saved.active,this.saved.installed[this.saved.active],120_000);
    void this.shadow.waitReady().then(()=>{if(generation===this.generation&&this.saved?.enabled){this.phase='ready';this.changed();}},error=>{if(generation===this.generation&&this.saved?.enabled){this.phase='error';this.error=(error as Error).message;this.changed();}});
  }

  setEnabled(enabled:boolean){
    if(!this.saved?.active)throw Error('请先下载决策模型');
    if(this.installing)throw Error('Laya 正在安装');
    this.save({...this.saved,enabled});
    if(enabled)this.start();else{this.generation++;this.shadow.configure();this.phase='disabled';this.error=undefined;this.changed();}
  }

  select(variant:LayaVariant){
    if(!['mlx','standard'].includes(variant)||!this.saved?.installed[variant])throw Error('请先下载这个决策模型');
    if(this.installing)throw Error('决策模型正在下载');
    this.save({...this.saved,active:variant,enabled:true});this.start();
  }

  installRecommended(){
    const variant=preferredLayaVariant(process.platform,process.arch);
    if(!variant||!this.supported)throw Error('当前系统暂不支持一键安装 Laya');
    return this.install(variant);
  }

  async install(variant:LayaVariant){
    if(!['mlx','standard'].includes(variant))throw Error('不支持的 Laya 版本');
    if(!this.supported)throw Error('当前系统暂不支持一键安装 Laya');
    if(this.installing)throw Error('Laya 正在下载');
    if(this.saved?.installed[variant]){this.select(variant);return;}
    this.installing=true;const generation=++this.generation;
    this.downloading=variant;this.phase='preparing';this.error=undefined;this.changed();
    try{
      const venv=join(this.dir,'laya-runtime',variant,'venv');
      const managedPython=join(venv,process.platform==='win32'?'Scripts':'bin',process.platform==='win32'?'python.exe':'python');
      const explicit=process.env.AELION_LAYA_RUNTIME===variant&&process.env.AELION_LAYA_PYTHON&&existsSync(process.env.AELION_LAYA_PYTHON)?process.env.AELION_LAYA_PYTHON:undefined;
      const devPython=join(process.cwd(),'.local','laya-venv','bin','python');
      const existing=explicit||(variant==='mlx'&&process.env.AELION_DEV_URL&&existsSync(devPython)?devPython:undefined);
      const python=existing||managedPython;
      if(!existing){
        const uv=await this.uv();
        mkdirSync(venv,{recursive:true});
        await this.run(uv,['venv','--python','3.12',venv]);
        this.phase='installing';this.changed();
        await this.run(uv,['pip','install','--python',managedPython,DECISION_MODELS.find(model=>model.id===variant)!.packageName]);
      }
      if(generation!==this.generation)throw Error('下载已取消');
      this.phase='loading';this.changed();
      this.shadow.configure(variant,python,15*60_000);
      await this.shadow.waitReady();
      if(generation!==this.generation)throw Error('下载已取消');
      this.save({installed:{...this.saved?.installed,[variant]:python},enabled:true,active:variant});
      this.phase='ready';this.changed();
    }catch(error){
      if(generation!==this.generation)return;
      if(this.saved?.enabled&&this.saved.active)this.start();else{this.shadow.configure();this.phase='error';}
      this.error=(error as Error).message;this.changed();
      throw error;
    }finally{
      this.installing=false;this.child=undefined;this.downloading=undefined;
      if(generation!==this.generation&&!this.disposed){
        if(this.saved?.enabled&&this.saved.active)this.start();
        else this.phase=this.saved?'disabled':'not-installed';
      }
      this.changed();
    }
  }

  cancel(){
    if(!this.installing||this.phase==='cancelling')return;
    this.generation++;this.downloadAbort?.abort();this.child?.kill();this.shadow.configure();this.phase='cancelling';this.error=undefined;this.changed();
  }

  dispose(){this.disposed=true;this.generation++;this.downloadAbort?.abort();this.child?.kill();this.shadow.configure();this.installing=false;}

  private async uv(){
    const candidates=[process.env.AELION_UV_PATH,...(process.platform==='darwin'?[join(homedir(),'.local','bin','uv'),'/opt/homebrew/bin/uv','/usr/local/bin/uv']:[])].filter((value):value is string=>Boolean(value));
    const found=candidates.find(existsSync);if(found)return found;
    const asset=UV_ASSETS[`${process.platform}-${process.arch}` as keyof typeof UV_ASSETS];
    if(!asset)throw Error('当前系统没有可用的下载组件');
    const toolsDir=join(this.dir,'laya-runtime','tools'),binary=join(toolsDir,process.platform==='win32'?'uv.exe':'uv');if(existsSync(binary))return binary;
    const archive=join(toolsDir,`${UV_VERSION}-${asset.name}`),extracted=join(toolsDir,'extract');
    mkdirSync(toolsDir,{recursive:true});
    const controller=new AbortController();this.downloadAbort=controller;
    try{
      await verifiedDownload(`https://releases.astral.sh/github/uv/releases/download/${UV_VERSION}/${asset.name}`,archive,asset.sha256,()=>{},'sha256',{signal:controller.signal});
      controller.signal.throwIfAborted();rmSync(extracted,{recursive:true,force:true});mkdirSync(extracted,{recursive:true});
      if(process.platform==='win32')await this.run('tar.exe',['-xf',archive,'-C',extracted,'uv.exe']);
      else await this.run('/usr/bin/tar',['-xzf',archive,'-C',extracted,'--strip-components=1',asset.name.slice(0,-7)+'/uv']);
      controller.signal.throwIfAborted();const staged=join(extracted,process.platform==='win32'?'uv.exe':'uv');if(!existsSync(staged))throw Error('下载器文件不完整');
      chmodSync(staged,0o755);renameSync(staged,binary);return binary;
    }finally{this.downloadAbort=undefined;rmSync(extracted,{recursive:true,force:true});}
  }

  private run(command:string,args:string[]):Promise<void>{
    return new Promise((resolve,reject)=>{
      const child=spawn(command,args,{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,UV_NO_PROGRESS:'1'}});
      child.stdin.end();
      this.child=child;let detail='';
      for(const stream of [child.stdout,child.stderr])stream.on('data',(part:Buffer)=>{detail=(detail+part.toString()).slice(-1000);});
      const timer=setTimeout(()=>child.kill(),20*60_000);
      child.on('error',error=>{clearTimeout(timer);reject(new Error(`无法启动下载工具：${error.message}`));});
      child.on('close',code=>{clearTimeout(timer);if(code===0)resolve();else reject(new Error(detail.trim().slice(-300)||`下载失败（${code}）`));});
    });
  }
}
