import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';

const root=resolve(import.meta.dirname,'..'),runtime=join(root,'runtime','qemu');
const name=process.platform==='win32'?'qemu-system-x86_64.exe':join('bin',`qemu-system-${process.arch==='arm64'?'aarch64':'x86_64'}`);
const binary=join(runtime,name);
if(!existsSync(binary))throw Error('Bundled QEMU missing: '+binary);
const env={...process.env};
if(process.platform==='darwin'){
 env.QEMU_MODULE_DIR=join(runtime,'lib','qemu');
 delete env.DYLD_LIBRARY_PATH;delete env.DYLD_FALLBACK_LIBRARY_PATH;delete env.DYLD_INSERT_LIBRARIES;
}
execFileSync(binary,['--version'],{stdio:'inherit',env});
console.log('Bundled QEMU runtime ready');
