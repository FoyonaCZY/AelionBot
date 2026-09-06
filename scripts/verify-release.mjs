import {createHash} from 'node:crypto';
import {createReadStream,readFileSync,statSync,existsSync} from 'node:fs';
import {join,basename,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from 'yaml';
import assert from 'node:assert/strict';

export async function verifyRelease(directory,version){
  const info=parse(readFileSync(join(directory,'latest.yml'),'utf8'));assert.equal(info.version,version,'Update manifest version does not match the application');assert.ok(Array.isArray(info.files)&&info.files.length,'Missing update files');
  const files=[];
  for(const entry of info.files){
    assert.equal(typeof entry.url,'string');const name=decodeURIComponent(entry.url);assert.equal(basename(name),name,'Update file must be in the release directory');assert.equal(name,`AelionBot-Setup-${version}-x64.exe`,'Unexpected installer name');const path=join(directory,name),hash=createHash('sha512');for await(const chunk of createReadStream(path))hash.update(chunk);assert.equal(hash.digest('base64'),entry.sha512,'Installer checksum mismatch');assert.equal(statSync(path).size,entry.size,'Installer size mismatch');assert.ok(existsSync(path+'.blockmap'),'Missing differential update blockmap');files.push(name,name+'.blockmap');
  }
  assert.equal(info.path,info.files[0].url);assert.equal(info.sha512,info.files[0].sha512);return {version,verified:true,files:[...new Set([...files,'latest.yml'])]};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));console.log(JSON.stringify(await verifyRelease(resolve(process.argv[2]||'release/github'),pkg.version),null,2));}
