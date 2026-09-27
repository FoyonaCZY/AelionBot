import {createHash} from 'node:crypto';
import {isUtf8} from 'node:buffer';

export const TEXT_FILE_LIMIT=2*1024*1024;
export const READ_PAGE_FIELDS={offset:{type:'integer',minimum:0,description:'字符偏移。按行读取时省略或传 0；非零 offset 不能与行号参数同时使用。'},startLine:{type:'integer',minimum:1,description:'按行读取的起始行，从 1 开始。'},lineCount:{type:'integer',minimum:1,maximum:2000},maxChars:{type:'integer',minimum:1,maximum:32000},withLineNumbers:{type:'boolean'}};
export class FileToolError extends Error {constructor(readonly code:string,message:string,readonly details?:Record<string,unknown>){super(message);this.name='FileToolError';}}
export function toolFailure(error:unknown){const code=(error as {code?:unknown})?.code;const structured=typeof (error as {toolResult?:unknown})?.toolResult==='function'?(error as {toolResult:()=>Record<string,unknown>}).toolResult():undefined;return {error:error instanceof Error?error.message:String(error),...(typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(code)?{errorCode:code}:{}),...(error instanceof FileToolError&&error.details?{details:error.details}:{}),...structured};}
export function boundedInteger(value:unknown,fallback:number,min:number,max:number,name:string){if(value===undefined)return fallback;if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)throw new FileToolError('INVALID_ARGUMENT',`${name} 必须是 ${min}–${max} 范围内的整数`);return value;}
export function decodeText(bytes:Buffer){
  if(bytes.length>TEXT_FILE_LIMIT)throw new FileToolError('FILE_TOO_LARGE','文本文件超过 2 MB，请缩小读取目标或使用命令按需处理');
  if(bytes.includes(0)||!isUtf8(bytes))throw new FileToolError('UNSUPPORTED_ENCODING','文件不是 UTF-8 文本；二进制或其他编码请使用对应工具处理');
  const value=bytes.toString('utf8'),bom=value.startsWith('\uFEFF');return {text:bom?value.slice(1):value,bom,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};
}
const high=(code:number)=>code>=0xd800&&code<=0xdbff,low=(code:number)=>code>=0xdc00&&code<=0xdfff;
export function characterWindow(text:string,offset:number,limit:number){
  let start=Math.min(text.length,Math.max(0,offset));if(start>0&&low(text.charCodeAt(start))&&high(text.charCodeAt(start-1)))start--;
  let end=Math.min(text.length,start+limit);if(end<text.length&&high(text.charCodeAt(end-1))&&low(text.charCodeAt(end)))end--;
  if(end===start&&start<text.length)end=Math.min(text.length,start+2);
  return {start,end,text:text.slice(start,end)};
}
export function textPage(text:string,args:Record<string,unknown>={}){
  const offset=boundedInteger(args.offset,0,0,Number.MAX_SAFE_INTEGER,'offset'),startLine=boundedInteger(args.startLine,1,1,Number.MAX_SAFE_INTEGER,'startLine'),lineCount=boundedInteger(args.lineCount,200,1,2000,'lineCount'),maxChars=boundedInteger(args.maxChars,12000,1,32000,'maxChars');
  if(args.withLineNumbers!==undefined&&typeof args.withLineNumbers!=='boolean')throw new FileToolError('INVALID_ARGUMENT','withLineNumbers 必须是布尔值');
  const numbered=args.withLineNumbers===true,lineMode=args.startLine!==undefined||args.lineCount!==undefined||numbered;
  if(lineMode&&offset!==0)throw new FileToolError('INVALID_ARGUMENT','非零 offset 与按行读取参数不能同时使用；按行读取时省略 offset 或传 0');
  if(numbered&&maxChars<64)throw new FileToolError('INVALID_ARGUMENT','带行号读取时 maxChars 至少为 64');
  const starts:number[]=[];if(text.length)starts.push(0);for(let index=0;index<text.length;index++)if(text[index]==='\n'&&index+1<text.length)starts.push(index+1);
  const lineAt=(index:number)=>{let left=0,right=starts.length;while(left<right){const mid=(left+right)>>>1;if(starts[mid]<=index)left=mid+1;else right=mid;}return left;};
  const requestedStart=lineMode?(starts[startLine-1]??text.length):offset,requestedEnd=lineMode?(starts[Math.min(starts.length,startLine-1+lineCount)]??text.length):text.length;
  const window=characterWindow(text,requestedStart,Math.min(maxChars,Math.max(0,requestedEnd-requestedStart)));let end=Math.min(requestedEnd,window.end),content=text.slice(window.start,end);
  if(numbered){
    content='';end=window.start;
    for(let line=startLine;line<=starts.length&&line<startLine+lineCount;line++){
      const from=starts[line-1],to=Math.min(starts[line]??text.length,requestedEnd),prefix=`${line} | `,room=maxChars-content.length-prefix.length;
      if(room<2)break;const part=characterWindow(text,from,Math.min(room,to-from));content+=prefix+text.slice(part.start,Math.min(part.end,to));end=Math.min(part.end,to);if(end<to)break;
    }
  }
  const start=Math.min(window.start,text.length),eof=end>=text.length,partialLine=!eof&&end>start&&text[end-1]!=='\n';
  return {content,offset:start,nextOffset:end,total:text.length,totalLines:starts.length,startLine:start<text.length?lineAt(start):0,endLine:end>start?lineAt(end-1):0,...(!eof&&!partialLine?{nextLine:lineAt(end)}:{}),withLineNumbers:numbered,partialLine,truncated:!eof,rangeTruncated:end<requestedEnd,eof};
}
export function expectedHash(value:unknown,required=false){
  if(value===undefined&&!required)return undefined;
  if(typeof value!=='string'||! /^[a-f0-9]{64}$/i.test(value))throw new FileToolError('EXPECTED_HASH_REQUIRED','请先读取文件，并传入读取结果的 sha256 作为 expectedSha256');return value.toLowerCase();
}
// Progressive line matching, after Codex apply_patch seek_sequence: models often
// drift on trailing spaces, indentation or typographic punctuation. Each pass is
// tried only when the stricter one found nothing; a match must stay unique.
export function normalizeLine(line:string){return line.trim().replace(/[\u2010-\u2015\u2212]/g,'-').replace(/[\u2018\u2019\u201A\u201B]/g,"'").replace(/[\u201C\u201D\u201E\u201F]/g,'"').replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g,' ');}
export type MatchStrategy='exact'|'trim-end'|'trim'|'unicode';
const LINE_PASSES:Array<[MatchStrategy,(line:string)=>string]>=[['exact',line=>line],['trim-end',line=>line.trimEnd()],['trim',line=>line.trim()],['unicode',normalizeLine]];
export function seekLines(lines:string[],pattern:string[],from=0,eof=false){
  for(const [strategy,key] of LINE_PASSES){
    const wanted=pattern.map(key),matches:number[]=[];
    for(let index=from;index<=lines.length-pattern.length;index++){
      if(eof&&index+pattern.length!==lines.length)continue;
      let equal=true;for(let offset=0;offset<pattern.length&&equal;offset++)equal=key(lines[index+offset])===wanted[offset];
      if(equal)matches.push(index);
    }
    if(matches.length)return {strategy,matches};
  }
  return undefined;
}
export const indentOf=(line:string)=>/^[ \t]*/.exec(line)![0];
// Where the old text was indented differently, carry the file's indentation onto the replacement.
export function reindent(lines:string[],from:string,to:string){return from===to?lines:lines.map(line=>line.trim()&&line.startsWith(from)?to+line.slice(from.length):line);}
export function similarLines(lines:string[],pattern:string[]){
  const first=pattern.map(normalizeLine).find(Boolean);if(!first)return [];
  return lines.flatMap((line,index)=>normalizeLine(line).includes(first)?[{line:index+1,text:line.slice(0,200)}]:[]).slice(0,3);
}
function lineEdit(text:string,oldText:string,newText:string,replaceAll:boolean){
  const starts=[0];for(let index=0;index<text.length;index++)if(text[index]==='\n')starts.push(index+1);
  const lines=starts.map((start,index)=>text.slice(start,index+1<starts.length?starts[index+1]-1:text.length).replace(/\r$/,''));
  const pattern=oldText.replace(/\r\n/g,'\n').split('\n'),endsWithNewline=pattern.length>1&&pattern.at(-1)==='';if(endsWithNewline)pattern.pop();
  if(!pattern.some(line=>line.trim()))return {candidates:[]};
  const seek=seekLines(lines,pattern);if(!seek)return {candidates:similarLines(lines,pattern)};
  const matches:number[]=[];for(const index of seek.matches)if(!matches.length||index>=matches.at(-1)!+pattern.length)matches.push(index);
  if(matches.length>1&&!replaceAll)return {ambiguous:matches.length};
  const first=pattern.findIndex(line=>line.trim()),newline=text.includes('\r\n')?'\r\n':'\n',replacement=(endsWithNewline?newText.replace(/\r?\n$/,''):newText).split(/\r?\n/);
  let content='',cursor=0;
  for(const index of matches){
    const last=index+pattern.length-1,end=starts[last]+lines[last].length,value=seek.strategy==='trim'||seek.strategy==='unicode'?reindent(replacement,indentOf(pattern[first]),indentOf(lines[index+first])):replacement;
    content+=text.slice(cursor,starts[index])+value.join(newline);cursor=end;
  }
  return {content:content+text.slice(cursor),replacements:matches.length,strategy:seek.strategy};
}
export function editText(bytes:Buffer,args:{oldText:unknown;newText:unknown;expectedSha256:unknown;replaceAll?:unknown}){
  const expected=expectedHash(args.expectedSha256,true)!,source=decodeText(bytes);
  if(source.sha256!==expected)throw new FileToolError('FILE_CHANGED','文件自上次读取后已变化，请重新读取后再修改');
  if(typeof args.oldText!=='string'||!args.oldText.length||args.oldText.length>256000||typeof args.newText!=='string'||args.newText.length>256000)throw new FileToolError('INVALID_ARGUMENT','oldText 不能为空，oldText 和 newText 最长为 256000 字符');
  if(args.replaceAll!==undefined&&typeof args.replaceAll!=='boolean')throw new FileToolError('INVALID_ARGUMENT','replaceAll 必须是布尔值');
  const crlf=source.text.includes('\r\n')&&!source.text.replaceAll('\r\n','').includes('\n'),lf=!source.text.includes('\r\n');
  const normalize=(value:string)=>crlf?value.replace(/\r?\n/g,'\r\n'):lf?value.replaceAll('\r\n','\n'):value;
  const oldText=normalize(args.oldText),newText=normalize(args.newText);let count=0,at=0;
  while((at=source.text.indexOf(oldText,at))>=0){count++;at+=oldText.length;}
  let text:string,strategy:MatchStrategy='exact';
  if(count){
    if(count!==1&&args.replaceAll!==true)throw new FileToolError('EDIT_AMBIGUOUS',`oldText 匹配到 ${count} 处，请补充上下文；确需全部替换时设置 replaceAll=true`);
    if(oldText===newText)throw new FileToolError('EDIT_NO_CHANGE','oldText 与 newText 相同，没有需要保存的修改');
    if(source.text.length+count*(newText.length-oldText.length)>TEXT_FILE_LIMIT)throw new FileToolError('FILE_TOO_LARGE','替换后的文件超过 2 MB，请拆分处理');
    text=source.text.split(oldText).join(newText);
  }else{
    const line=lineEdit(source.text,oldText,newText,args.replaceAll===true);
    if('ambiguous' in line)throw new FileToolError('EDIT_AMBIGUOUS',`oldText 在忽略空白差异后匹配到 ${line.ambiguous} 处，请补充上下文；确需全部替换时设置 replaceAll=true`);
    if(line.content===undefined)throw new FileToolError('EDIT_NOT_FOUND','未找到 oldText 的匹配（已尝试忽略行尾空白、缩进和常见 Unicode 标点差异）。请重新读取目标行后再修改；不要带行号前缀',line.candidates.length?{similarLines:line.candidates}:undefined);
    if(line.content===source.text)throw new FileToolError('EDIT_NO_CHANGE','oldText 与 newText 相同，没有需要保存的修改');
    text=line.content;count=line.replacements;strategy=line.strategy;
  }
  const content=(source.bom?'\uFEFF':'')+text,next=Buffer.from(content,'utf8');if(next.length>TEXT_FILE_LIMIT)throw new FileToolError('FILE_TOO_LARGE','替换后的文件超过 2 MB，请拆分处理');
  return {content,replacements:count,sha256:createHash('sha256').update(next).digest('hex'),bytes:next.length,...(strategy!=='exact'?{matchStrategy:strategy}:{})};
}
export function filesystemError(error:unknown,path:string){
  const code=(error as NodeJS.ErrnoException)?.code;
  if(code==='ENOENT')return new FileToolError('FILE_NOT_FOUND',`文件或目录不存在：${path}。请先列出目录或查找文件，再使用返回的路径`);
  if(code==='EISDIR')return new FileToolError('IS_DIRECTORY',`这是目录：${path}，请使用列目录工具`);
  if(code==='ENOTDIR')return new FileToolError('NOT_DIRECTORY',`路径不是目录：${path}`);
  if(code==='EACCES'||code==='EPERM')return new FileToolError('ACCESS_DENIED',`操作系统拒绝访问：${path}`);
  return error;
}
