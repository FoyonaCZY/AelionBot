import {extractFile} from '@electron/asar';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const archive=resolve(process.argv[2]||'.local/designer-package-local/win-unpacked/resources/app.asar');
const read=path=>extractFile(archive,join(...path.split('/')));
const catalog=JSON.parse(read('assets/design-systems/catalog.json'));
if(catalog.systems.length!==152)throw Error('Incomplete packaged design catalog');
let files=0,bytes=0;
for(const system of catalog.systems)for(const entry of system.files){const data=read(`assets/design-systems/${system.id}/${entry.path}`);if(data.length!==entry.bytes||createHash('sha256').update(data).digest('hex')!==entry.sha256)throw Error('Packaged design resource mismatch');files++;bytes+=data.length;}
for(const name of ['LICENSE','NOTICE'])if(!read('assets/design-systems/'+name).length)throw Error('Missing '+name);
if(!read('dist-electron/main.cjs').toString().includes('designer-v1'))throw Error('Designer engine missing from bundle');
console.log(JSON.stringify({archive,systems:catalog.systems.length,verifiedFiles:files,bytes,licensesIncluded:true}));
