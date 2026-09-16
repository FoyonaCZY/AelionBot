import {readFileSync,realpathSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
export function verifyDesignSystems(root=resolve('assets/design-systems')){
 const catalog=JSON.parse(readFileSync(join(root,'catalog.json'),'utf8'));
 if(catalog.version!==1||catalog.systems.length!==152||new Set(catalog.systems.map(s=>s.id)).size!==152)throw Error('Incomplete design-system catalog');
 let bytes=0,count=0;
 for(const system of catalog.systems){const base=realpathSync(join(root,system.id));for(const file of system.files){const path=realpathSync(join(base,file.path)),r=relative(base,path);if(isAbsolute(r)||r==='..'||r.startsWith('..\\')||r.startsWith('../'))throw Error('Design resource path escaped its package');const data=readFileSync(path);if(data.length!==file.bytes||createHash('sha256').update(data).digest('hex')!==file.sha256)throw Error('Design resource integrity mismatch: '+system.id+'/'+file.path);bytes+=data.length;count++;}}
 for(const name of ['LICENSE','NOTICE'])if(!readFileSync(join(root,name),'utf8').trim())throw Error('Missing design-system license notice');
 const pkg=JSON.parse(readFileSync(resolve('package.json'),'utf8'));if(!pkg.build.files.includes('assets/design-systems/**'))throw Error('Design systems are absent from desktop packaging');
 return {systems:catalog.systems.length,files:count,bytes,sourceCommit:catalog.sourceCommit};
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename))console.log(JSON.stringify(verifyDesignSystems(process.argv[2]?resolve(process.argv[2]):undefined)));
