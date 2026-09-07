import {existsSync,realpathSync} from 'node:fs';
import {posix,win32} from 'node:path';
import type {HostPermissionDetails} from '../../src/shared';

export interface HostRiskContext {workspaceDir?:string;dataDir:string;homeDir:string;platform:NodeJS.Platform;}
const sensitiveSegment=/^(?:\.ssh|\.aws|\.azure|\.kube|\.gnupg|\.codex|\.aelion|\.git|credentials?|secrets?|keychains?|gcloud)$/i;
const sensitiveFile=/^(?:\.env(?:\..*)?|\.netrc|_netrc|\.npmrc|\.pypirc|\.git-credentials|\.boto|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*(?:credentials?|secrets?|passwords?|tokens?|private[-_]keys?).*|(?:login|web) data(?:-.*)?|cookies(?:-.*)?|.*\.(?:pem|p12|pfx|key|keystore))$/i;
const protectedWriteSegment=/^(?:\.vscode|\.idea|\.husky|\.claude|\.gemini|\.agents)$/i;
const protectedWriteFile=/^(?:\.gitconfig|\.gitmodules|\.bashrc|\.bash_profile|\.zshrc|\.zprofile|\.profile|\.ripgreprc|\.mcp\.json|\.claude\.json)$/i;
const posixSystemWriteRoots=['/etc','/private/etc','/bin','/sbin','/usr/bin','/usr/sbin','/usr/lib','/System/Library','/Library/LaunchAgents','/Library/LaunchDaemons','/Library/Keychains','/Applications'];
const pathApi=(context:HostRiskContext)=>context.platform==='win32'?win32:posix;
function canonical(value:string,context:HostRiskContext){
  let path=pathApi(context).normalize(value);
  if(context.platform===process.platform)try{
    let ancestor=path;const suffix:string[]=[];
    while(!existsSync(ancestor)){const parent=pathApi(context).dirname(ancestor);if(parent===ancestor)break;suffix.unshift(pathApi(context).basename(ancestor));ancestor=parent;}
    if(existsSync(ancestor))path=pathApi(context).join(realpathSync.native(ancestor),...suffix);
  }catch{return;}
  return context.platform==='win32'?path.toLowerCase():path;
}
function inside(value:string,root:string,context:HostRiskContext){const path=canonical(value,context),base=canonical(root,context);if(!path||!base)return false;const relative=pathApi(context).relative(base,path);return relative===''||relative!=='..'&&!relative.startsWith('..'+pathApi(context).sep)&&!pathApi(context).isAbsolute(relative);}
export function ordinaryProjectPath(value:string,context:HostRiskContext,cwd=context.workspaceDir){
  if(!cwd||!context.workspaceDir||!pathApi(context).isAbsolute(cwd)||/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069*?]/.test(value)||/^\\\\|^\/\/|^~|^[a-z]+:\/\//i.test(value))return false;
  if(context.platform==='win32'&&(/^[a-z]:[^\\/]/i.test(value)||value.replace(/^[a-z]:/i,'').includes(':')))return false;
  const path=pathApi(context).resolve(cwd,value),resolved=canonical(path,context);if(!resolved||/^\\\\|^\/\//.test(resolved)||!inside(path,context.workspaceDir,context)||inside(path,context.dataDir,context))return false;
  const parts=resolved.split(/[\\/]/).filter(Boolean),name=parts.at(-1)||'';
  // Auth libraries commonly contain tokens.ts or secrets/password.py. These are
  // ordinary source files; credential stores and explicit .env/key files remain protected.
  const sourceFile=/\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|cs|c|cpp|h|hpp|swift|php|vue|svelte|css|scss)$/i.test(name)&&!/^\.env(?:\.|$)|^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/i.test(name);
  return !parts.some(part=>sensitiveSegment.test(part)&&!(sourceFile&&/^(?:credentials?|secrets?)$/i.test(part)))&&(!sensitiveFile.test(name)||sourceFile)&&!/\/(?:library\/(?:keychains|cookies)|appdata\/(?:local|roaming)\/(?:google|microsoft|mozilla|aelion-bot))/i.test(resolved.replaceAll('\\','/'));
}
function ordinaryProjectWrite(value:string,context:HostRiskContext,cwd=context.workspaceDir){
  if(!ordinaryProjectPath(value,context,cwd))return false;
  const path=canonical(pathApi(context).resolve(cwd!,value),context);if(!path)return false;
  const normalized=path.replaceAll('\\','/');
  // Compare resolved directory roots too: on macOS /etc resolves to /private/etc,
  // and other system directories may also be aliases on the current platform.
  if(context.platform==='win32'?/^[a-z]:\/(?:windows|program files(?: \(x86\))?|programdata)(?:\/|$)/i.test(normalized):posixSystemWriteRoots.some(root=>inside(path,root,context)))return false;
  const parts=path.split(/[\\/]/).filter(Boolean);if(parts.some(part=>protectedWriteSegment.test(part))||protectedWriteFile.test(parts.at(-1)||''))return false;
  // A protected directory may itself be a junction/alias to another path in the project.
  for(const name of ['.git','.vscode','.idea','.husky','.claude','.gemini','.agents'])if(inside(path,pathApi(context).join(context.workspaceDir!,name),context))return false;
  return true;
}

// Only a single literal command is eligible. Expressions, pipelines, redirection,
// scripts and unknown flags go to the model; prefix matching alone is not a risk check.
function literals(command:string,platform:NodeJS.Platform){
  if(command.length>6000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(command)||platform!=='win32'&&/[\\!~]/.test(command))return;
  const result:string[]=[];let word='',quote='',started=false,quoted=false,closedQuote=false;
  const push=()=>{if(quoted&&(!result.length||word.startsWith('-')))return false;result.push(word);word='';started=false;quoted=false;closedQuote=false;return true;};
  for(const char of command){
    if(quote){if(quote==='"'&&/[$`]/.test(char))return;if(char===quote){quote='';closedQuote=true;}else word+=char;}
    else if(char===' '||char==='\t'){if(started&&!push())return;}
    else if(closedQuote)return;
    else if(char==='"'||char==="'"){if(started)return;quote=char;quoted=true;started=true;}
    else{if(/[\s;$`|&<>(){}\[\]@#]/.test(char))return;word+=char;started=true;}
  }
  if(quote||started&&!push())return;return result.length?result:undefined;
}
function powershellRead(words:string[],details:HostPermissionDetails,context:HostRiskContext){
  const name=words[0].toLowerCase(),args=words.slice(1),cwd=details.cwd;
  if(name==='get-location')return args.length===0;
  const read=name==='get-content',list=name==='get-childitem',metadata=['get-item','test-path','resolve-path'].includes(name);
  if(!read&&!list&&!metadata||!cwd||!ordinaryProjectPath('.',context,cwd))return false;
  const paths:string[]=[];let literal=false;
  const flags=read?new Set(['-raw']):list?new Set(['-force','-name','-file','-directory','-recurse']):new Set(['-force']);
  for(let i=0;i<args.length;i++){
    const value=args[i],flag=value.toLowerCase();
    if(flag==='-literalpath'||flag==='-path'){if(!args[i+1]||paths.length)return false;literal=flag==='-literalpath';paths.push(args[++i]);}
    else if(flags.has(flag))continue;
    else if(read&&['-totalcount','-first','-tail'].includes(flag)||list&&flag==='-depth'){if(!/^\d{1,5}$/.test(args[++i]||'')||Number(args[i])>10000)return false;}
    else if(read&&flag==='-encoding'){if(!['utf8','utf8bom','utf8nobom','ascii','unicode','bigendianunicode','default','oem'].includes((args[++i]||'').toLowerCase()))return false;}
    else if(!value.startsWith('-')&&!paths.length)paths.push(value);else return false;
  }
  if(!paths.length){if(!list)return false;paths.push('.');}
  return paths.length===1&&(literal||!/[\[\]*?]/.test(paths[0]))&&ordinaryProjectPath(paths[0],context,cwd);
}
function powershellEdit(words:string[],details:HostPermissionDetails,context:HostRiskContext){
  const name=words[0].toLowerCase(),args=words.slice(1),cwd=details.cwd;
  if(!cwd||!['set-content','add-content','new-item'].includes(name))return false;
  let path:string|undefined,value=false,itemType:string|undefined;
  for(let i=0;i<args.length;i++){
    const flag=args[i].toLowerCase();
    if(flag==='-literalpath'||flag==='-path'){if(path||!args[i+1])return false;path=args[++i];}
    else if(flag==='-value'&&name!=='new-item'){if(value||args[i+1]===undefined)return false;value=true;i++;}
    else if(flag==='-encoding'&&name!=='new-item'){if(!['utf8','utf8bom','utf8nobom','ascii','unicode'].includes((args[++i]||'').toLowerCase()))return false;}
    else if(flag==='-nonewline'&&name!=='new-item')continue;
    else if(flag==='-itemtype'&&name==='new-item'){itemType=args[++i]?.toLowerCase();if(!['directory','file'].includes(itemType||''))return false;}
    else if(!args[i].startsWith('-')&&!path)path=args[i];else return false;
  }
  return Boolean(path&&(name==='new-item'?itemType:value)&&ordinaryProjectWrite(path,context,cwd));
}
export function classifyHostOperation(details:HostPermissionDetails,context:HostRiskContext):{lowRisk:boolean;reason:string}{
  if(details.operation==='read_file'&&details.path&&pathApi(context).isAbsolute(details.path)&&ordinaryProjectPath(details.path,context))return {lowRisk:true,reason:'读取或查看当前工作目录中的普通文件'};
  if(details.operation==='write_file'&&details.path&&pathApi(context).isAbsolute(details.path)&&ordinaryProjectWrite(details.path,context))return {lowRisk:true,reason:'在工作目录内创建或编辑普通项目文件'};
  if(details.operation==='command'&&details.command){
    const words=literals(details.command,context.platform);
    if(words&&context.platform==='win32'&&powershellRead(words,details,context))return {lowRisk:true,reason:'单条本机只读查询，范围在当前工作目录内'};
    if(words&&context.platform==='win32'&&powershellEdit(words,details,context))return {lowRisk:true,reason:'单条项目文件编辑或目录创建'};
    // Absolute system paths avoid aliases and project-local executables on POSIX.
    if(words&&context.platform!=='win32'&&['/bin/pwd','/usr/bin/whoami','/bin/hostname'].includes(words[0])&&words.length===1)return {lowRisk:true,reason:'查询当前路径或本机身份'};
  }
  return {lowRisk:false,reason:details.operation==='write_file'?'写入位置超出普通项目编辑范围':details.operation==='mcp'?'MCP 工具需要结合任务审核':'操作超出可直接放行的项目操作范围'};
}
