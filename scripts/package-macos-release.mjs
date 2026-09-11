import {createRequire} from 'node:module';
import {spawn,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,mkdirSync,renameSync,createReadStream} from 'node:fs';
import {resolve,join,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {parse} from 'yaml';
const require=createRequire(import.meta.url),root=resolve(import.meta.dirname,'..'),pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8')),arch=process.arch;
for(const key of ['CSC_LINK','CSC_NAME','CSC_KEY_PASSWORD','APPLE_ID','APPLE_APP_SPECIFIC_PASSWORD','APPLE_TEAM_ID','APPLE_API_KEY','APPLE_API_KEY_ID','APPLE_API_ISSUER'])if(process.env[key]==='')delete process.env[key];
if(process.platform!=='darwin'||!['arm64','x64'].includes(arch))throw Error('Build on the target macOS architecture');
if(process.env.GITHUB_REF_TYPE==='tag'&&process.env.GITHUB_REF_NAME!==`v${pkg.version}`)throw Error('Tag/version mismatch');
const output=join(root,'release','github');mkdirSync(output,{recursive:true});
const signed=Boolean(process.env.CSC_LINK||process.env.CSC_NAME),notarized=signed&&Boolean(process.env.APPLE_ID&&process.env.APPLE_APP_SPECIFIC_PASSWORD&&process.env.APPLE_TEAM_ID||process.env.APPLE_API_KEY&&process.env.APPLE_API_KEY_ID&&process.env.APPLE_API_ISSUER);
writeFileSync(join(root,'runtime','mac-release.json'),JSON.stringify({arch,version:pkg.version,minimumSystemVersion:'15.0',signatureType:signed?'developer-id':'adhoc',notarized,automaticUpdates:notarized},null,2));
async function run(script){await new Promise((yes,no)=>{const child=spawn(process.execPath,[join(root,script)],{cwd:root,stdio:'inherit'});child.on('error',no);child.on('exit',code=>code===0?yes():no(Error(`${script} failed (${code})`)));});}
await run('scripts/prepare-native-tools.mjs');await run('scripts/generate-icons.mjs');await run('scripts/build.mjs');
const {build,Platform,Arch}=require('electron-builder');
await build({targets:Platform.MAC.createTarget(['dmg','zip'],arch==='arm64'?Arch.arm64:Arch.x64),publish:'never',config:{directories:{output},extraResources:[{from:'runtime/qemu',to:'qemu',filter:['**/*']},{from:'runtime/mac-release.json',to:'mac-release.json'}],mac:{category:'public.app-category.productivity',icon:'assets/icon.png',artifactName:'AelionBot-${version}-mac-${arch}.${ext}',minimumSystemVersion:'15.0',identity:signed?undefined:'-',hardenedRuntime:true,entitlements:'build/entitlements.mac.plist',entitlementsInherit:'build/entitlements.mac.plist',gatekeeperAssess:false,notarize:notarized,forceCodeSigning:signed}}});
const app=join(output,arch==='arm64'?'mac-arm64':'mac','AelionBot.app');if(!existsSync(app))throw Error('Packaged app missing');
execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',app],{stdio:'inherit'});
execFileSync('/usr/bin/lipo',[join(app,'Contents','MacOS','AelionBot'),'-verify_arch',arch==='arm64'?'arm64':'x86_64'],{stdio:'inherit'});
const emulator=join(app,'Contents','Resources','qemu','bin',`qemu-system-${arch==='arm64'?'aarch64':'x86_64'}`);execFileSync(emulator,['--version'],{stdio:'inherit'});
const manifest=join(output,'latest-mac.yml');if(!existsSync(manifest))throw Error('Mac update manifest missing');const info=parse(readFileSync(manifest,'utf8'));if(info.version!==pkg.version)throw Error('Mac update version mismatch');
for(const file of info.files||[]){const name=decodeURIComponent(file.url);if(basename(name)!==name||!name.startsWith(`AelionBot-${pkg.version}-mac-${arch}.`))throw Error('Unexpected Mac update asset');const hash=createHash('sha512');for await(const chunk of createReadStream(join(output,name)))hash.update(chunk);if(hash.digest('base64')!==file.sha512)throw Error('Mac update checksum mismatch');}
for(const extension of ['dmg','zip'])if(!existsSync(join(output,`AelionBot-${pkg.version}-mac-${arch}.${extension}`)))throw Error('Mac installer asset missing');
renameSync(manifest,join(output,`latest-mac-${arch}.yml`));
writeFileSync(join(output,`mac-${arch}-verification.json`),JSON.stringify({version:pkg.version,arch,verified:true,signed,notarized,automaticUpdates:notarized},null,2));
console.log(JSON.stringify({version:pkg.version,arch,verified:true,signed,notarized}));
