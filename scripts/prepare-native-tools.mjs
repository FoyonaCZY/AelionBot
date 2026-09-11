import {createRequire} from 'node:module';
import {chmodSync,existsSync,realpathSync,statSync} from 'node:fs';
import {dirname,join,relative,isAbsolute} from 'node:path';

if(process.platform==='darwin'){
 const require=createRequire(import.meta.url),root=realpathSync(dirname(require.resolve('node-pty/package.json')));
 let helpers=0;
 for(const directory of ['build/Release','build/Debug',`prebuilds/darwin-${process.arch}`]){
  const candidate=join(root,directory,'spawn-helper');if(!existsSync(candidate))continue;
  const file=realpathSync(candidate),rel=relative(root,file);if(isAbsolute(rel)||rel==='..'||rel.startsWith('../'))throw Error('PTY helper resolves outside node-pty');
  if(!statSync(file).isFile())throw Error('PTY helper is not a file');chmodSync(file,0o755);helpers++;console.log(`Prepared executable PTY helper: ${rel}`);
 }
 if(!helpers)throw Error('Mac PTY spawn-helper missing');
}
