import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,lstatSync,writeFileSync} from 'node:fs';
import {join,resolve,extname} from 'node:path';
import {pathToFileURL} from 'node:url';

const extensions=new Set(['.html','.css','.js','.json','.xml','.txt','.svg','.png','.jpg','.jpeg','.gif','.webp','.avif','.ico','.woff','.woff2','.ttf','.mp4','.webm']);
export function allowedPath(path){return Boolean(path&&!path.includes('\\')&&!path.includes(':')&&!/[\x00-\x1f\x7f]/.test(path)&&path.split('/').every(part=>part&&!part.startsWith('.'))&&!path.startsWith('blog/_preview/')&&extensions.has(extname(path).toLowerCase()));}

export function prepareDeployment(directory,identity){
  if(identity.repository!=='FoyonaCZY/AelionBot'||! /^[a-f0-9]{40}$/.test(identity.revision)||!['runId','runNumber','runAttempt'].every(key=>Number.isSafeInteger(identity[key])&&identity[key]>0))throw Error('Invalid deployment identity');
  const root=resolve(directory),files={};let bytes=0;
  function walk(at,prefix=''){
    for(const entry of readdirSync(at,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      const path=prefix+entry.name,full=join(at,entry.name);
      if(lstatSync(full).isSymbolicLink())throw Error('Deployment must not contain links: '+path);
      if(entry.isDirectory()){if(entry.name.startsWith('.')||path==='blog/_preview')throw Error('Private directory in deployment: '+path);walk(full,path+'/');}
      else if(entry.isFile()&&path==='deployment.json')continue;
      else if(!entry.isFile()||!allowedPath(path))throw Error('Unexpected deployment file: '+path);
      else{const data=readFileSync(full);bytes+=data.length;if(bytes>250*1024*1024||Object.keys(files).length>=10000)throw Error('Website exceeds deployment limits');files[path]=createHash('sha256').update(data).digest('hex');}
    }
  }
  walk(root);
  for(const required of ['index.html','blog/index.html','404.html','robots.txt','sitemap.xml'])if(!files[required])throw Error('Missing public page: '+required);
  if(!Object.keys(files).some(path=>path.startsWith('assets/')&&path.endsWith('.js')))throw Error('Website JavaScript is missing');
  const manifest={schemaVersion:1,...identity,files};
  const output=JSON.stringify(manifest,null,2)+'\n';if(Buffer.byteLength(output)>1024*1024)throw Error('Deployment manifest is too large');
  writeFileSync(join(root,'deployment.json'),output,{mode:0o644});
  return manifest;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const env=process.env,manifest=prepareDeployment('website/dist',{repository:env.GITHUB_REPOSITORY,revision:env.GITHUB_SHA,runId:Number(env.GITHUB_RUN_ID),runNumber:Number(env.GITHUB_RUN_NUMBER),runAttempt:Number(env.GITHUB_RUN_ATTEMPT)});
  console.log(`Prepared ${Object.keys(manifest.files).length} files for ${manifest.revision}.`);
}
