import {execFileSync} from 'node:child_process';
import {join} from 'node:path';

// Load the packaged Electron framework without opening windows or touching user data.
// codesign --verify alone does not catch dyld's runtime library-validation failures.
export function verifyMacosLoader(app){
 const env={...process.env,ELECTRON_RUN_AS_NODE:'1'};
 for(const key of ['DYLD_LIBRARY_PATH','DYLD_FALLBACK_LIBRARY_PATH','DYLD_INSERT_LIBRARIES','NODE_OPTIONS','NODE_PATH'])delete env[key];
 const output=execFileSync(join(app,'Contents','MacOS','AelionBot'),['-e',"if(!process.versions.electron)process.exit(1);console.log('AELION_ELECTRON_LOADER_OK')"],{env,encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']});
 if(output.trim()!=='AELION_ELECTRON_LOADER_OK')throw Error('Packaged Electron loader verification failed');
}
