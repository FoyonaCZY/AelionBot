import {createHash} from 'node:crypto';
import {existsSync,readdirSync,readFileSync,mkdirSync,writeFileSync,lstatSync,copyFileSync} from 'node:fs';
import {resolve,join,relative,sep} from 'node:path';
import {execFileSync} from 'node:child_process';
const source=resolve(process.argv[2]||'.local/research/open-design');
const target=resolve('assets/design-systems');
const commit=execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const expected='d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4';
if(commit!==expected)throw Error('Review upstream revision and licenses before changing the bundled catalog');
const sourceRoot=join(source,'design-systems');
mkdirSync(target,{recursive:true});
const systems=[];
for(const id of readdirSync(sourceRoot).sort()){
 const dir=join(sourceRoot,id);if(!/^[a-z0-9][a-z0-9-]*$/.test(id)||!existsSync(join(dir,'DESIGN.md')))continue;
 const files=[];let bytes=0;
 const visit=(folder)=>{for(const entry of readdirSync(folder,{withFileTypes:true})){const full=join(folder,entry.name),info=lstatSync(full);if(info.isSymbolicLink())throw Error('Symlinks are not accepted: '+full);if(info.isDirectory()){visit(full);continue;}if(!info.isFile())throw Error('Unsupported asset '+full);
  const path=relative(dir,full).split(sep).join('/');const buffer=readFileSync(full),destination=join(target,id,...path.split('/'));mkdirSync(resolve(destination,'..'),{recursive:true});copyFileSync(full,destination);bytes+=buffer.length;files.push({path,bytes:buffer.length,sha256:createHash('sha256').update(buffer).digest('hex')});
 }};visit(dir);
 const design=readFileSync(join(dir,'DESIGN.md'),'utf8');let manifest={};try{manifest=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8'));}catch{}
 const name=manifest.name||design.match(/^#\s+(.+)/m)?.[1]?.replace(/^Design System (?:Inspired by|for) /i,'')||id;
 const colors=[...new Set((design.match(/#[0-9a-f]{6}\b/gi)||[]).map(v=>v.toLowerCase()))].slice(0,5);
 systems.push({id,name,category:manifest.category||design.match(/>\s*Category:\s*(.+)/)?.[1]||'Design',description:manifest.description||design.split('\n').find(l=>l.startsWith('> ')&&!l.includes('Category:'))?.slice(2)||'',version:commit,bytes,colors,source:`https://github.com/nexu-io/open-design/tree/${commit}/design-systems/${id}`,license:'Apache-2.0',files});
}
if(systems.length!==152)throw Error('Unexpected catalog count: '+systems.length);
copyFileSync(join(source,'LICENSE'),join(target,'LICENSE'));
writeFileSync(join(target,'NOTICE'),`OpenDesign design-system resources\nSource: https://github.com/nexu-io/open-design\nRevision: ${commit}\nCopyright remains with the respective contributors.\nThese design-systems/ files are distributed under the repository Apache-2.0 license, preserving authored notices. The separate plugin manifests are not used to relicense these files.\nBrand-inspired systems are curated references, not official brand endorsements. Font family names and external asset URLs do not convey third-party redistribution rights. No remote fonts, logos, or images were downloaded by this vendoring step.\nAelionBot adds the catalog index and uses selected packages as design reference data; upstream files are copied without modification.\n`);
writeFileSync(join(target,'catalog.json'),JSON.stringify({version:1,sourceCommit:commit,sourceUrl:'https://github.com/nexu-io/open-design',systems},null,2)+'\n');
console.log(JSON.stringify({systems:systems.length,bytes:systems.reduce((n,s)=>n+s.bytes,0),commit}));
