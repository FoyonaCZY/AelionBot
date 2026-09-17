import {readFileSync,writeFileSync,existsSync,createReadStream,readdirSync} from 'node:fs';
import {resolve,join,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {parse,stringify} from 'yaml';
const root=resolve(import.meta.dirname,'..'),pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8')),directory=resolve(process.argv[2]||'release/downloaded'),tag=process.env.RELEASE_TAG||`v${pkg.version}`;
const required=[`AelionBot-Setup-${pkg.version}-x64.exe`,`AelionBot-Setup-${pkg.version}-x64.exe.blockmap`,'latest.yml'];
for(const arch of ['arm64','x64'])required.push(`AelionBot-${pkg.version}-mac-${arch}.dmg`,`AelionBot-${pkg.version}-mac-${arch}.zip`,`latest-mac-${arch}.yml`,`mac-${arch}-verification.json`);
for(const file of required)if(!existsSync(join(directory,file)))throw Error('Release asset missing: '+file);
const mac=[];
for(const manifest of ['latest.yml','latest-mac-arm64.yml','latest-mac-x64.yml']){
 const info=parse(readFileSync(join(directory,manifest),'utf8'));if(info.version!==pkg.version||!info.files?.length)throw Error('Release manifest version mismatch');
 for(const file of info.files){const name=decodeURIComponent(file.url);if(name!==basename(name)||!required.includes(name))throw Error('Unexpected update file');let size=0;const hash=createHash('sha512');for await(const chunk of createReadStream(join(directory,name))){size+=chunk.length;hash.update(chunk);}if(size!==file.size||hash.digest('base64')!==file.sha512)throw Error('Release asset integrity check failed: '+name);}
 if(manifest!=='latest.yml')mac.push(info);
}
writeFileSync(join(directory,'latest-mac.yml'),stringify({...mac[1],files:mac.flatMap(m=>m.files)}));
const assets=[...new Set([...required.filter(f=>!f.endsWith('-verification.json')&&!/^latest-mac-(arm64|x64)\.yml$/.test(f)),'latest-mac.yml',...readdirSync(directory).filter(f=>f.endsWith('.blockmap')&&required.includes(f.slice(0,-9)))])];
const checksums=[];for(const name of assets){const hash=createHash('sha256');for await(const bytes of createReadStream(join(directory,name)))hash.update(bytes);checksums.push(`${hash.digest('hex')}  ${name}`);}writeFileSync(join(directory,'SHA256SUMS.txt'),checksums.join('\n')+'\n');assets.push('SHA256SUMS.txt');
const gh=(args)=>execFileSync('gh',args,{cwd:root,encoding:'utf8',stdio:'inherit'});
for(const name of assets){
 console.log('upload',name);
 gh(['release','upload',tag,join(directory,name),'--clobber']);
}
gh(['release','edit',tag,'--draft=false','--latest']);
console.log('Attached assets to',tag);
