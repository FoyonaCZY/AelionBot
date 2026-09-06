import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=resolve('.local/reference/harness-20260905');mkdirSync(root,{recursive:true});
const repos={hermes:'NousResearch/hermes-agent',codex:'openai/codex',opencode:'anomalyco/opencode',pi:'earendil-works/pi',openhands:'OpenHands/software-agent-sdk'};
const json=async url=>{const response=await fetch(url,{headers:{'User-Agent':'AelionBot-source-review'},signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error(`${response.status} ${url}`);return response.json();};
for(const [name,repo] of Object.entries(repos)){
  const dir=join(root,name);mkdirSync(dir,{recursive:true});
  const checkout=join(root,`${name}-git`),gitOptions={windowsHide:true,timeout:90000,maxBuffer:32*1024*1024,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}};
  if(!existsSync(join(checkout,'.git')))execFileSync('git',['clone','--filter=blob:none','--no-checkout','--depth','1',`https://github.com/${repo}.git`,checkout],gitOptions);
  let manifest;
  if(existsSync(join(dir,'manifest.json')))manifest=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8'));
  else{const revision=execFileSync('git',['-C',checkout,'rev-parse','HEAD'],{...gitOptions,encoding:'utf8'}).trim();manifest={repo,revision,reviewedAt:new Date().toISOString(),paths:[],files:[]};writeFileSync(join(dir,'manifest.json'),JSON.stringify(manifest,null,2));}
  manifest.paths=execFileSync('git',['-C',checkout,'ls-tree','-r','--name-only',manifest.revision],{...gitOptions,encoding:'utf8'}).trim().split('\n');
  const wanted=process.argv.slice(2).filter(value=>value.startsWith(`${name}:`)).map(value=>value.slice(name.length+1));
  for(const file of wanted){if(!manifest.paths.includes(file)){console.log(JSON.stringify({name,file,status:'missing'}));continue;}const path=join(dir,file);if(manifest.files.some(item=>item.path===file)&&existsSync(path))continue;const bytes=execFileSync('git',['-C',checkout,'show',`${manifest.revision}:${file}`],gitOptions);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes);manifest.files=manifest.files.filter(item=>item.path!==file);manifest.files.push({path:file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});writeFileSync(join(dir,'manifest.json'),JSON.stringify(manifest,null,2));}
  writeFileSync(join(dir,'manifest.json'),JSON.stringify(manifest,null,2));
  console.log(JSON.stringify({name,repo,revision:manifest.revision,downloaded:manifest.files.length,candidates:manifest.paths.filter(path=>/(compact|condens|background.review|memory.*\.py|memories|skill_manager|session_search)/i.test(path)&&!/(test|lock|snap|locale|translation|images)/i.test(path)).slice(0,35)}));
}
