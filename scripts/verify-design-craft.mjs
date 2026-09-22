import {readFileSync,realpathSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
/** Craft references are prompt content shipped as data. A build must not silently drop or truncate one. */
export function verifyDesignCraft(root=resolve('assets/design-craft')){
 const catalog=JSON.parse(readFileSync(join(root,'catalog.json'),'utf8'));
 if(catalog.version!==1||!Array.isArray(catalog.sections)||catalog.sections.length<7)throw Error('Incomplete design-craft catalog');
 if(new Set(catalog.sections.map(s=>s.id)).size!==catalog.sections.length)throw Error('Duplicate design-craft section id');
 let bytes=0;
 for(const section of catalog.sections){
  if(!/^[a-z][a-z0-9-]{0,40}$/.test(section.id||''))throw Error('Invalid design-craft section id: '+section.id);
  if(!/^[a-z0-9-]+\.md$/.test(section.file||''))throw Error('Invalid design-craft file name: '+section.file);
  for(const field of ['title','summary','requiredFor'])if(!String(section[field]||'').trim())throw Error(`design-craft section ${section.id} is missing ${field}`);
  const path=realpathSync(join(root,section.file)),r=relative(realpathSync(root),path);
  if(isAbsolute(r)||r==='..'||r.startsWith('..\\')||r.startsWith('../'))throw Error('Craft reference path escaped its directory');
  const text=readFileSync(path,'utf8');
  // A stub would pass type checks and silently weaken every design run.
  if(text.length<600)throw Error('Craft reference is too short to be usable: '+section.file);
  if(!/^#\s+\S/m.test(text))throw Error('Craft reference is missing a title heading: '+section.file);
  bytes+=text.length;
 }
 const pkg=JSON.parse(readFileSync(resolve('package.json'),'utf8'));
 if(!pkg.build.files.includes('assets/design-craft/**'))throw Error('Craft references are absent from desktop packaging');
 if(!pkg.build.asarUnpack.includes('assets/design-craft/**'))throw Error('Craft references must be unpacked from the asar archive');
 return {sections:catalog.sections.length,bytes};
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename))console.log(JSON.stringify(verifyDesignCraft(process.argv[2]?resolve(process.argv[2]):undefined)));
