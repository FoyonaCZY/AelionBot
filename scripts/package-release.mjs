import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {readFileSync,existsSync,mkdirSync,realpathSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {verifyRelease} from './verify-release.mjs';

if(process.platform==='darwin'){await import('./package-macos-release.mjs');process.exit(0);}
const {verifyWindowsIcons}=await import('./package-icons.mjs');
const require=createRequire(import.meta.url),root=resolve(import.meta.dirname,'..'),pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
if(process.platform!=='win32')throw Error('Windows releases must be built on Windows.');
if(process.env.GITHUB_REF_TYPE==='tag'&&process.env.GITHUB_REF_NAME!==`v${pkg.version}`)throw Error('The Git tag must match package.json version.');
if(!/^\d+\.\d+\.\d+$/.test(pkg.version))throw Error('This workflow publishes stable versions only.');
const output=resolve(root,'release/github');mkdirSync(output,{recursive:true});const rel=relative(realpathSync(root),realpathSync(output));if(rel.startsWith('..')||isAbsolute(rel))throw Error('Release directory resolves outside this project.');
if(!existsSync(join(root,'runtime/qemu/qemu-system-x86_64.exe')))throw Error('Run pnpm run vm:prepare-runtime first.');
async function run(script){await new Promise((done,fail)=>{const child=spawn(process.execPath,[join(root,script)],{cwd:root,windowsHide:true,stdio:'inherit'});child.on('error',fail);child.on('exit',code=>code===0?done():fail(Error(`${script} failed (${code})`)));});}
await run('scripts/generate-icons.mjs');await run('scripts/build.mjs');
const {build,Platform,Arch}=require('electron-builder');
const transient=/HTTPError|Response code 5\d\d|status code 5\d\d|ECONNRESET|ETIMEDOUT/;
for(let attempt=0;;attempt++){
  try{await build({targets:Platform.WINDOWS.createTarget(['nsis'],Arch.x64),publish:'never',config:{directories:{output}}});break;}
  catch(error){
    const text=String(error?.message||error);
    if(attempt>=3||!transient.test(text))throw error;
    const wait=20_000*(attempt+1);
    console.warn(`electron-builder download failed (${text.split('\n')[0]}); retrying in ${wait/1000}s`);
    await new Promise(done=>setTimeout(done,wait));
  }
}
verifyWindowsIcons(join(output,'win-unpacked'));
console.log(JSON.stringify(await verifyRelease(output,pkg.version),null,2));
