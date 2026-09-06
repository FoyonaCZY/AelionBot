import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { verifiedDownload } from '../electron/core/download';
const profile=JSON.parse(readFileSync(resolve('runtime/guest-image.json'),'utf8'));
let last=0;
await verifiedDownload(profile.url, resolve('runtime/downloads',profile.filename),profile.sha512, (_fraction,detail)=>{if(Date.now()-last>5000){console.log(detail);last=Date.now();}});
console.log('Verified guest image ready');
