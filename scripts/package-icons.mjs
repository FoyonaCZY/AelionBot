import {readFileSync,copyFileSync,mkdirSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';

const require=createRequire(import.meta.url),asar=require('@electron/asar');
const {NtExecutable,NtExecutableResource,Resource,Data}=require('resedit');
const defaultAssets=resolve(dirname(fileURLToPath(import.meta.url)),'../assets');
export const iconFiles=['icon.svg','icon.png','icon.ico'];
const hash=bytes=>createHash('sha256').update(Buffer.from(bytes)).digest('hex');
const signature=items=>items.map(item=>({width:item.width||256,height:item.height||256,hash:hash(item.isRaw()?item.bin:item.generate())})).sort((a,b)=>a.width-b.width||a.height-b.height);

export function syncIconAssets(appDir,assetsDir=defaultAssets){
  const destination=join(appDir,'assets');mkdirSync(destination,{recursive:true});
  for(const file of iconFiles)copyFileSync(join(assetsDir,file),join(destination,file));
}

export function embedWindowsIcon(bytes,icoBytes=readFileSync(join(defaultAssets,'icon.ico'))){
  const executable=NtExecutable.from(bytes),resources=NtExecutableResource.from(executable),icons=Data.IconFile.from(icoBytes).icons.map(item=>item.data);
  assert.ok(icons.length,'Application icon contains no images.');
  const group=Resource.IconGroupEntry.fromEntries(resources.entries)[0];
  Resource.IconGroupEntry.replaceIconsForResource(resources.entries,group?.id??1,group?.lang??1033,icons);
  resources.outputResource(executable);return Buffer.from(executable.generate());
}

export function verifyWindowsIcons(appDir,assetsDir=defaultAssets){
  const expected=signature(Data.IconFile.from(readFileSync(join(assetsDir,'icon.ico'))).icons.map(item=>item.data));
  const resources=NtExecutableResource.from(NtExecutable.from(readFileSync(join(appDir,'AelionBot.exe')))),groups=Resource.IconGroupEntry.fromEntries(resources.entries);
  assert.ok(groups.some(group=>JSON.stringify(signature(group.getIconItemsFromEntries(resources.entries)))===JSON.stringify(expected)),'EXE icon does not match assets/icon.ico; do not publish this package.');
  const archive=join(appDir,'resources/app.asar');
  for(const file of iconFiles)assert.equal(hash(asar.extractFile(archive,join('assets',file))),hash(readFileSync(join(assetsDir,file))),`Packaged assets/${file} is missing or outdated.`);
  return {status:'passed',appDir:resolve(appDir),iconSizes:expected.map(item=>item.width),packagedAssets:iconFiles};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(verifyWindowsIcons(resolve(process.argv[2]||'release/win-unpacked')),null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
