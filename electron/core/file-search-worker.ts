import {parentPort,workerData} from 'node:worker_threads';
import {closeSync,lstatSync,openSync,readSync,readdirSync,realpathSync,fstatSync} from 'node:fs';
import {basename,join,posix,relative,isAbsolute} from 'node:path';
import ignore,{type Ignore} from 'ignore';
import {ordinaryProjectPath} from './permission-risk';
import {characterWindow,decodeText,FileToolError,TEXT_FILE_LIMIT,toolFailure} from './file-text';
import {redactHost} from './host-redaction';
import type {FileMatch,FileSearchRequest,FileSearchResult} from './file-search-types';

const ignoredDirectories=new Set(['node_modules','__pycache__','.venv','venv','.cache','.next','.nuxt','.turbo']);
interface Rules {base:string;ignore:Ignore;}
interface Entry {name:string;isFile:()=>boolean;isDirectory:()=>boolean;isSymbolicLink:()=>boolean;}
function readBounded(fd:number,size:number){const buffer=Buffer.alloc(size);let read=0;while(read<size){const bytes=readSync(fd,buffer,read,size-read,read);if(!bytes)break;read+=bytes;}return buffer.subarray(0,read);}
export function searchWorkspace(request:FileSearchRequest):FileSearchResult{
  const root=realpathSync.native(request.root);if(root!==request.root||!lstatSync(root).isDirectory())throw new FileToolError('PATH_CHANGED','检索目录已变化，请重新确认');
  const risk={workspaceDir:root,dataDir:request.dataDir,homeDir:request.homeDir,platform:process.platform};
  const skipped={ignored:0,sensitive:0,links:0,binary:0,large:0,unreadable:0};
  const files:string[]=[],matches:FileMatch[]=[],counts:Array<{path:string;count:number}>=[];let total=0,visited=0,scannedFiles=0,scannedBytes=0,scanLimited=false,limitReason:string|undefined;
  const deadline=Date.now()+4500,limit=(reason:string)=>{scanLimited=true;limitReason=reason;};
  let expression:RegExp|undefined;if(request.kind==='search'&&(request.regex||!request.caseSensitive))try{expression=new RegExp(request.regex?request.query!:request.query!.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'u'+(request.caseSensitive?'':'i'));}catch{throw new FileToolError('INVALID_REGEX','正则表达式无效，请修正语法或使用 regex=false 的文本检索');}
  const needle=request.query;
  const selected=(index:number)=>index>=request.offset&&index<request.offset+request.limit;
  const ignored=(path:string,directory:boolean,rules:Rules[])=>{let excluded=false;for(const rule of rules){const rel=relative(rule.base,path).replaceAll('\\','/')+(directory?'/':'');if(!rel||rel.startsWith('../'))continue;const result=rule.ignore.test(rel);if(result.ignored)excluded=true;else if(result.unignored)excluded=false;}return excluded;};
  const ruleFor=(directory:string):Rules|undefined=>{
    const path=join(directory,'.gitignore');let fd:number|undefined;try{const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536||realpathSync.native(path)!==path)return;fd=openSync(path,'r');const info=fstatSync(fd);if(info.ino!==stat.ino||info.dev!==stat.dev||info.size>65536)return;return {base:directory,ignore:ignore({ignorecase:process.platform==='win32'}).add(readBounded(fd,info.size).toString('utf8'))};}catch{return;}finally{if(fd!==undefined)closeSync(fd);}
  };
  const within=(path:string)=>{const rel=relative(root,path);return rel===''||rel!=='..'&&!rel.startsWith('../')&&!rel.startsWith('..\\')&&!isAbsolute(rel);};
  const visit=(directory:string,inherited:Rules[],depth:number)=>{
    if(scanLimited)return;if(Date.now()>deadline){limit('达到检索时间上限，请缩小 path 或 glob');return;}if(depth>40){limit('目录层级超过 40 层，请缩小 path');return;}
    let entries:Entry[];try{entries=request.file?[{name:basename(request.file),isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>false}]:readdirSync(directory,{withFileTypes:true});}catch{skipped.unreadable++;return;}
    const local=request.respectIgnore&&!request.file?ruleFor(directory):undefined,rules=local?[...inherited,local]:inherited;
    for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
      if(scanLimited)break;if(++visited>20000){limit('目录项超过 20000，请缩小 path 或 glob');break;}if(Date.now()>deadline){limit('达到检索时间上限，请缩小 path 或 glob');break;}
      const path=join(directory,entry.name);
      if(entry.isSymbolicLink()){skipped.links++;continue;}
      if(entry.isDirectory()){
        if(ignoredDirectories.has(entry.name)||request.respectIgnore&&ignored(path,true,rules)){skipped.ignored++;continue;}
        if(!ordinaryProjectPath(join(path,'__aelion_search__.ts'),risk)){skipped.sensitive++;continue;}
        try{if(realpathSync.native(path)!==path){skipped.links++;continue;}}catch{skipped.unreadable++;continue;}
        visit(path,rules,depth+1);continue;
      }
      if(!entry.isFile())continue;
      if(request.respectIgnore&&ignored(path,false,rules)){skipped.ignored++;continue;}
      if(!ordinaryProjectPath(path,risk)){skipped.sensitive++;continue;}
      const rel=relative(root,path).replaceAll('\\','/'),candidate=process.platform==='win32'?rel.toLowerCase():rel,pattern=process.platform==='win32'?request.glob.toLowerCase():request.glob;
      if(!request.file&&!posix.matchesGlob(candidate,pattern))continue;
      let original:ReturnType<typeof lstatSync>;try{original=lstatSync(path);if(!original.isFile()||original.isSymbolicLink()||realpathSync.native(path)!==path||!within(path)){skipped.links++;continue;}}catch{skipped.unreadable++;continue;}
      if(request.kind==='find'){if(selected(total))files.push(path);total++;continue;}
      if(scannedFiles>=2000||scannedBytes>=32*1024*1024){limit('达到文件或读取量上限，请缩小 path 或 glob');break;}
      let fd:number|undefined,text:string;
      try{
        const actual=realpathSync.native(path);if(actual!==path||!within(actual)){skipped.links++;continue;}
        if(original.size>TEXT_FILE_LIMIT){skipped.large++;continue;}if(scannedBytes+original.size>32*1024*1024){limit('达到读取量上限，请缩小 path 或 glob');break;}
        fd=openSync(path,'r');const stat=fstatSync(fd);if(!stat.isFile()||stat.ino!==original.ino||stat.dev!==original.dev){skipped.links++;continue;}if(stat.size>TEXT_FILE_LIMIT){skipped.large++;continue;}if(scannedBytes+stat.size>32*1024*1024){limit('达到读取量上限，请缩小 path 或 glob');break;}
        const bytes=readBounded(fd,stat.size);scannedFiles++;scannedBytes+=bytes.length;text=redactHost(decodeText(bytes).text,request.secrets,true);
      }catch(error){if(error instanceof FileToolError&&error.code==='UNSUPPORTED_ENCODING')skipped.binary++;else if(error instanceof FileToolError&&error.code==='FILE_TOO_LARGE')skipped.large++;else skipped.unreadable++;continue;}
      finally{if(fd!==undefined)closeSync(fd);}
      if(!text.length)continue;const lines=text.split(/\r?\n/);if(text.endsWith('\n'))lines.pop();let count=0,lineOffset=0;
      for(let index=0;index<lines.length;index++){
        if((index&1023)===0&&Date.now()>deadline){limit('达到检索时间上限，请缩小 path 或 glob');break;}
        const line=lines[index],newline=text.indexOf('\n',lineOffset),nextLineOffset=newline<0?text.length:newline+1,match=expression?.exec(line),column=expression?(match?.index??-1):line.indexOf(needle!);if(column<0){lineOffset=nextLineOffset;continue;}count++;
        if(request.outputMode==='content'){
          if(selected(total)){const snippet=characterWindow(line,Math.max(0,column-200),2000);matches.push({path,line:index+1,column:column+1,offset:lineOffset+column,text:snippet.text,textStartColumn:snippet.start+1,truncated:snippet.start>0||snippet.end<line.length,...(request.contextLines?{before:lines.slice(Math.max(0,index-request.contextLines),index).map(line=>characterWindow(line,0,1000).text),after:lines.slice(index+1,index+1+request.contextLines).map(line=>characterWindow(line,0,1000).text)}:{})});}
          if(++total>=10000){limit('匹配超过 10000 条，请缩小检索范围');break;}
        }else if(request.outputMode==='files')break;
        lineOffset=nextLineOffset;
      }
      if(count&&request.outputMode!=='content'){if(selected(total)){if(request.outputMode==='files')files.push(path);else counts.push({path,count});}total++;}
    }
  };
  if(ordinaryProjectPath(join(root,'__aelion_search__.ts'),risk))visit(root,[],0);else skipped.sensitive++;
  const nextOffset=Math.min(total,request.offset+request.limit);
  return {path:request.file||root,...(request.kind==='find'||request.outputMode==='files'?{files}:request.outputMode==='count'?{counts}:{matches}),offset:request.offset,nextOffset,total,eof:nextOffset>=total,truncated:scanLimited||nextOffset<total,scanLimited,limitReason,visitedEntries:visited,scannedFiles,scannedBytes,skipped};
}
if(parentPort){try{parentPort.postMessage({ok:true,result:searchWorkspace(workerData as FileSearchRequest)});}catch(error){parentPort.postMessage({ok:false,...toolFailure(error)});}}
