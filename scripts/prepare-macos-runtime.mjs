import {execFileSync} from 'node:child_process';
import {basename,dirname,join,resolve,relative,isAbsolute,posix} from 'node:path';
import {existsSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,cpSync,realpathSync,chmodSync,rmSync,renameSync,readdirSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
export const linkedLibraries=text=>text.split('\n').slice(1).map(line=>line.trim().replace(/\s+\(compatibility version.*$/,'')).filter(Boolean);
const run=(program,args,options={})=>execFileSync(program,args,{encoding:'utf8',maxBuffer:16*1024*1024,...options}).trim();
const system=path=>path.startsWith('/usr/lib/')||path.startsWith('/System/Library/');
export async function prepareMacRuntime(){
 if(process.platform!=='darwin'||!['x64','arm64'].includes(process.arch))throw Error('Mac runtime must be prepared on its native macOS architecture');
 const root=resolve(import.meta.dirname,'..'),destination=join(root,'runtime','qemu'),staging=join(root,'runtime','qemu-macos-staging');
 const guardedRemove=path=>{const rel=relative(root,resolve(path));if(rel.startsWith('..')||isAbsolute(rel)||!rel.startsWith('runtime/')||existsSync(path)&&lstatSync(path).isSymbolicLink())throw Error('Unsafe runtime directory');if(existsSync(path))rmSync(path,{recursive:true,force:true});};
 guardedRemove(staging);mkdirSync(join(staging,'bin'),{recursive:true});mkdirSync(join(staging,'lib'),{recursive:true});
 const prefix=run('brew',['--prefix']),qemu=run('brew',['--prefix','qemu']),info=JSON.parse(run('brew',['info','--json=v2','qemu'])).formulae[0],target=process.arch==='arm64'?'aarch64':'x86_64';
 const jobs=[],known=new Map(),names=new Map();
 function add(source,output){source=realpathSync(source);if(known.has(source))return known.get(source);mkdirSync(dirname(output),{recursive:true});copyFileSync(source,output);chmodSync(output,0o755);known.set(source,output);jobs.push({source,output});return output;}
 const bins=[`qemu-system-${target}`,'qemu-img'];for(const name of bins)add(join(qemu,'bin',name),join(staging,'bin',name));
 const moduleRoot=join(qemu,'lib','qemu');if(existsSync(moduleRoot))for(const name of readdirSync(moduleRoot))if(/\.(so|dylib)$/.test(name))add(join(moduleRoot,name),join(staging,'lib','qemu',name));
 const rpaths=source=>[...run('/usr/bin/otool',['-l',source]).matchAll(/cmd LC_RPATH[\s\S]*?\n\s*path (.+?) \(offset/g)].map(m=>m[1]);
 const expand=(path,source)=>path.replace(/^@loader_path/,dirname(source)).replace(/^@executable_path/,join(qemu,'bin'));
 for(let i=0;i<jobs.length;i++){
  const job=jobs[i],paths=rpaths(job.source);for(const dependency of linkedLibraries(run('/usr/bin/otool',['-L',job.source]))){
   if(system(dependency))continue;
   let source=dependency.startsWith('@rpath/')?[...paths.map(p=>join(expand(p,job.source),dependency.slice(7))),join(prefix,'lib',dependency.slice(7)),join(dirname(job.source),dependency.slice(7))].find(existsSync):expand(dependency,job.source);
   if(!source||!existsSync(source))throw Error(`Cannot resolve ${dependency} in ${job.source}`);source=realpathSync(source);if(system(source))continue;
   if(source===job.source)continue;
   const name=basename(source);if(names.has(name)&&names.get(name)!==source)throw Error(`Conflicting bundled library ${name}`);names.set(name,source);
   const output=add(source,join(staging,'lib',name)),link='@loader_path/'+relative(dirname(job.output),output).split('\\').join('/');
   run('/usr/bin/install_name_tool',['-change',dependency,link,job.output]);
  }
  if(!job.output.startsWith(join(staging,'bin')+'/'))run('/usr/bin/install_name_tool',['-id','@loader_path/'+basename(job.output),job.output]);
 }
 cpSync(join(qemu,'share','qemu'),join(staging,'share','qemu'),{recursive:true,dereference:true});
 const licenses=join(staging,'licenses');mkdirSync(licenses,{recursive:true});cpSync(join(root,'docs','licenses'),join(licenses,'aelion-notices'),{recursive:true});
 const formulae=new Map();for(const {source} of jobs){const match=/\/Cellar\/([^/]+)\/([^/]+)\//.exec(source);if(match)formulae.set(match[1],{version:match[2],root:source.slice(0,source.indexOf('/Cellar/')+8)+match[1]+'/'+match[2]});}
 for(const [name,formula] of formulae){const folder=join(licenses,name);mkdirSync(folder,{recursive:true});for(const entry of readdirSync(formula.root))if(/^(COPYING|LICENSE|AUTHORS|NOTICE)/i.test(entry)&&lstatSync(join(formula.root,entry)).isFile())copyFileSync(join(formula.root,entry),join(folder,entry));if(existsSync(join(formula.root,'.brew',name+'.rb')))copyFileSync(join(formula.root,'.brew',name+'.rb'),join(folder,name+'.rb'));}
 const entitlements=join(root,'build','entitlements.mac.plist');
 for(const {output} of [...jobs].reverse()){const bin=output.startsWith(join(staging,'bin')+'/');run('/usr/bin/codesign',['--force','--sign','-',...(bin?['--entitlements',entitlements]:[]),output]);run('/usr/bin/lipo',[output,'-verify_arch',process.arch==='arm64'?'arm64':'x86_64']);}
 for(const {output} of jobs)for(const lib of linkedLibraries(run('/usr/bin/otool',['-L',output])))if(!system(lib)&&!lib.startsWith('@loader_path/'))throw Error('Non-relocatable library: '+lib);
 const env={...process.env,QEMU_MODULE_DIR:join(staging,'lib','qemu'),DYLD_PRINT_LIBRARIES:'1'};delete env.DYLD_LIBRARY_PATH;delete env.DYLD_FALLBACK_LIBRARY_PATH;
 const version=run(join(staging,'bin',bins[0]),['--version'],{env}).split('\n')[0];run(join(staging,'bin','qemu-img'),['--version'],{env});
 const hashes=Object.fromEntries(jobs.map(({output})=>[relative(staging,output),createHash('sha256').update(readFileSync(output)).digest('hex')]));
 writeFileSync(join(staging,'aelion-runtime.json'),JSON.stringify({platform:'darwin',arch:process.arch,version,source:'https://formulae.brew.sh/formula/qemu',upstream:info.urls?.stable,formulae:[...formulae].map(([name,f])=>({name,version:f.version,source:`https://formulae.brew.sh/formula/${name}`})),hashStage:'runtime-before-app-signing',files:hashes},null,2));
 guardedRemove(destination);renameSync(staging,destination);console.log(JSON.stringify({runtime:destination,arch:process.arch,version,libraries:jobs.length}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await prepareMacRuntime();
