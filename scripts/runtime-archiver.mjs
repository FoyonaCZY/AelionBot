import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join,basename} from 'node:path';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url),exec=promisify(execFile);
const toolVersion='26.03',toolHash='0859c524b8a63551848f0c246abddcb1d0b7b656b0fbfe879f8d85e61a9e6edd';
export async function runtimeArchiver(downloads,useSystem=true){
  const candidates=[process.env.AELION_ARCHIVER,join(process.env.ProgramFiles||'C:/Program Files','7-Zip/7z.exe'),join(process.env.ProgramFiles||'C:/Program Files','Bandizip/bz.exe')].filter(Boolean);
  if(useSystem){const path=candidates.find(path=>existsSync(path));if(path)return {path,bandizip:basename(path).toLowerCase()==='bz.exe'};}
  // 7za only supports a subset of formats. Extract the full 7-Zip CLI for NSIS archives.
  mkdirSync(downloads,{recursive:true});const installer=join(downloads,`7zip-${toolVersion}-x64.exe`),dir=join(downloads,`7zip-${toolVersion}`),digest=bytes=>createHash('sha256').update(bytes).digest('hex');
  if(!existsSync(installer)||digest(readFileSync(installer))!==toolHash){
    const response=await fetch(`https://github.com/ip7z/7zip/releases/download/${toolVersion}/7z2603-x64.exe`,{signal:AbortSignal.timeout(60000)});if(!response.ok)throw Error(`7-Zip download failed: HTTP ${response.status}`);const bytes=Buffer.from(await response.arrayBuffer());if(digest(bytes)!==toolHash)throw Error('7-Zip checksum mismatch');writeFileSync(installer+'.part',bytes);renameSync(installer+'.part',installer);
  }
  mkdirSync(dir,{recursive:true});await exec(require('7zip-bin').path7za,['x',installer,`-o${dir}`,'-y'],{windowsHide:true,maxBuffer:4*1024*1024});
  const path=join(dir,'7z.exe');if(!existsSync(path)||!existsSync(join(dir,'7z.dll')))throw Error('Full 7-Zip CLI was not extracted');return {path,bandizip:false};
}
