import {createHash,randomUUID} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {win32,posix} from 'node:path';
import {hostPathKey} from './host-platform';
import type {CommandPattern,CommandPermissionRule,HostPermissionDetails} from '../../src/shared';
import {atomicJson} from './store';

type Token={value:string;bare:boolean};
type StoredRule=CommandPermissionRule&{platform?:NodeJS.Platform;prefix?:string[];commandHash?:string};
const singles=new Set(['get-childitem','get-content','get-item','get-itemproperty','get-location','get-command','get-process','get-service','test-path','resolve-path','select-string','write-output','pwd','whoami','hostname','rg']);
const posixSingles=new Set(['pwd','whoami','hostname','ls','cat','head','tail','wc','which','file','stat','grep','rg']);
const literal=/^[A-Za-z0-9_.:/\\-]+$/;
const hash=(command:string)=>createHash('sha256').update(command.trim()).digest('hex');
const cwdKey=hostPathKey;

// This deliberately accepts only a small, literal subset of PowerShell.
// Shell expressions require exact rules; punctuation inside literal arguments
// (for example a quoted rg regex) is data rather than shell syntax.
function tokens(command:string,platform=process.platform):Token[]|undefined{
  if(/[\r\n\u0085\u2028\u2029\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(command))return;
  const result:Token[]=[];let value='',quote='',bare=true,started=false;
  const flush=()=>{if(started)result.push({value,bare});value='';bare=true;started=false;};
  for(let index=0;index<command.length;index++){
    const char=command[index];
    if(quote){
      if(char===quote){
        if(platform==='win32'&&command[index+1]===quote){if(quote==='"')return;value+=quote;index++;}else quote='';
      }else{
        if(quote==='"'&&(/[$`]/.test(char)||platform!=='win32'&&/[\\!]/.test(char)))return;
        // Windows native argument passing may reinterpret embedded quotes.
        if(platform==='win32'&&char==='"')return;
        value+=char;
      }
    }else if(char==='"'||char==="'"){quote=char;bare=false;started=true;}
    else if(char===' '||char==='\t')flush();
    else {if(/\s|[;$`|&<>(){}\[\]@,#]/.test(char)||platform!=='win32'&&/[\\!~]/.test(char))return;value+=char;started=true;}
  }
  if(quote)return;flush();
  if(result.some(token=>token.value==='--%'||/^--pre(?:=|$)/i.test(token.value)))return;
  return result.length?result:undefined;
}
function prefixFor(command:string,platform=process.platform):string[]|undefined{
  const parsed=tokens(command,platform);if(!parsed)return;
  const program=platform==='win32'?win32.basename(parsed[0].value).toLowerCase().replace(/\.exe$/,''):posix.basename(parsed[0].value);
  let count=0;
  if((platform==='win32'?singles:posixSingles).has(program))count=1;
  else if(program==='git')count=2;
  else if(program==='gh'&&['pr','issue','repo','run','workflow','release'].includes(parsed[1]?.value))count=3;
  else if(['npm','pnpm','yarn'].includes(program)){
    if(['run','run-script'].includes(parsed[1]?.value))count=3;
    else if(['test','build','lint','dev','typecheck','install','ci'].includes(parsed[1]?.value))count=2;
  }
  if(!count||parsed.length<count)return;
  const prefix=parsed.slice(0,count);
  if(prefix.some(token=>!token.bare||!literal.test(token.value))||prefix.slice(1).some(token=>token.value.startsWith('-')))return;
  return prefix.map(token=>token.value);
}
function samePrefix(a:string[],b:string[],platform=process.platform){return a.length===b.length&&a.every((value,index)=>index===0&&platform==='win32'?value.toLowerCase()===b[index].toLowerCase():value===b[index]);}
function commandDetails(details:HostPermissionDetails,platform=process.platform):details is HostPermissionDetails&{command:string;cwd:string}{
  return details.operation==='command'&&typeof details.command==='string'&&Boolean(details.command.trim())&&details.command.length<=6000&&typeof details.cwd==='string'&&(platform==='win32'?win32:posix).isAbsolute(details.cwd);
}
function validRule(value:unknown,platform=process.platform):value is StoredRule{
  if(!value||typeof value!=='object')return false;
  const rule=value as StoredRule;
  if((rule.platform||'win32')!==platform||typeof rule.id!=='string'||!/^[a-f0-9-]{36}$/.test(rule.id)||typeof rule.pattern!=='string'||!rule.pattern||rule.pattern.length>8000||typeof rule.cwd!=='string'||!(platform==='win32'?win32:posix).isAbsolute(rule.cwd)||typeof rule.enabled!=='boolean'||typeof rule.createdAt!=='string'||!Number.isFinite(Date.parse(rule.createdAt)))return false;
  if(rule.kind==='exact')return typeof rule.commandHash==='string'&&/^[a-f0-9]{64}$/.test(rule.commandHash)&&rule.prefix===undefined;
  if(rule.kind!=='prefix'||!Array.isArray(rule.prefix)||!rule.prefix.length||rule.prefix.some(token=>typeof token!=='string'||!literal.test(token))||rule.commandHash!==undefined)return false;
  const derived=prefixFor(rule.prefix.join(' '),platform);
  return Boolean(derived&&samePrefix(derived,rule.prefix,platform)&&rule.pattern===`${rule.prefix.join(' ')} *`);
}
function view(rule:StoredRule):CommandPermissionRule{
  const {id,kind,pattern,cwd,enabled,createdAt}=rule;return {id,kind,pattern,cwd,enabled,createdAt};
}

export class CommandPermissions {
  private rules:StoredRule[]=[];
  constructor(readonly file:string,private redact:(value:string)=>string=value=>value,private platform:NodeJS.Platform=process.platform){
    if(!existsSync(file))return;
    try{
      const saved=JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
      if(saved.version===1&&Array.isArray(saved.rules)&&saved.rules.every((rule:unknown)=>validRule(rule,this.platform)))this.rules=saved.rules;
    }catch{/* An unreadable rule file grants no permissions. */}
  }
  list(){return this.rules.map(view);}
  private candidate(details:HostPermissionDetails){
    if(!commandDetails(details,this.platform))return;
    const prefix=prefixFor(details.command,this.platform),pattern=prefix?`${prefix.join(' ')} *`:details.command.trim(),cwd=(this.platform==='win32'?win32:posix).normalize(details.cwd),platform=this.platform;
    if(prefix&&this.redact(pattern)===pattern)return {kind:'prefix' as const,platform,pattern,prefix,cwd};
    return {kind:'exact' as const,platform,pattern:this.redact(details.command.trim()),commandHash:hash(details.command),cwd};
  }
  suggest(details:HostPermissionDetails):CommandPattern|undefined{
    const rule=this.candidate(details);return rule?{kind:rule.kind,pattern:rule.pattern}:undefined;
  }
  match(details:HostPermissionDetails):CommandPermissionRule|undefined{
    if(!commandDetails(details,this.platform))return;
    const parsed=tokens(details.command,this.platform),digest=hash(details.command),cwd=cwdKey(details.cwd,this.platform);
    const rule=this.rules.find(rule=>rule.enabled&&cwdKey(rule.cwd,this.platform)===cwd&&(rule.kind==='exact'?rule.commandHash===digest:Boolean(parsed&&parsed.length>=rule.prefix!.length&&parsed.slice(0,rule.prefix!.length).every(token=>token.bare)&&samePrefix(rule.prefix!,parsed.slice(0,rule.prefix!.length).map(token=>token.value),this.platform))));
    return rule?view(rule):undefined;
  }
  allow(details:HostPermissionDetails):CommandPermissionRule{
    const candidate=this.candidate(details);if(!candidate)throw new Error('此操作不支持保存命令模式');
    const existing=this.rules.find(rule=>cwdKey(rule.cwd,this.platform)===cwdKey(candidate.cwd,this.platform)&&rule.kind===candidate.kind&&(rule.kind==='prefix'?samePrefix(rule.prefix!,candidate.prefix!,this.platform):rule.commandHash===candidate.commandHash));
    if(existing){this.commit(this.rules.map(rule=>rule.id===existing.id?{...rule,enabled:true}:rule));return view(this.rules.find(rule=>rule.id===existing.id)!);}
    const rule:StoredRule={...candidate,id:randomUUID(),enabled:true,createdAt:new Date().toISOString()};
    this.commit([...this.rules,rule]);return view(rule);
  }
  setEnabled(id:string,enabled:boolean){
    if(typeof enabled!=='boolean')throw new Error('无效的命令权限状态');this.require(id);
    this.commit(this.rules.map(rule=>rule.id===id?{...rule,enabled}:rule));
  }
  remove(id:string){this.require(id);this.commit(this.rules.filter(rule=>rule.id!==id));}
  private require(id:string){if(typeof id!=='string'||!this.rules.some(rule=>rule.id===id))throw new Error('命令模式不存在或已删除');}
  private commit(rules:StoredRule[]){atomicJson(this.file,{version:1,rules});this.rules=rules;}
}
