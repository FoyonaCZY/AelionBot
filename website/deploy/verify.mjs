import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

const manifest=JSON.parse(readFileSync('website/dist/deployment.json','utf8'));
const origin='https://aelion.chat';
const sha=data=>createHash('sha256').update(data).digest('hex');
async function verify(){
  const response=await fetch(`${origin}/deployment.json`,{cache:'no-store',signal:AbortSignal.timeout(20000)});
  assert.equal(response.status,200,'Deployment manifest');
  const live=await response.json();assert.equal(live.revision,manifest.revision,'Published revision');assert.equal(live.runId,manifest.runId,'Published workflow run');
  for(const [path,hash] of Object.entries(manifest.files)){
    if(path==='404.html')continue;
    const url=`${origin}/${path.split('/').map(encodeURIComponent).join('/')}`;
    const asset=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(20000)});
    assert.equal(asset.status,200,path);assert.equal(sha(Buffer.from(await asset.arrayBuffer())),hash,path+' content');
  }
  for(const url of ['http://aelion.chat/','http://www.aelion.chat/','https://www.aelion.chat/']){
    const redirect=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(15000)});
    assert.equal(redirect.status,301,url);assert.equal(redirect.headers.get('location'),origin+'/',url+' target');
  }
  const missing=await fetch(`${origin}/blog/_preview/not-published/`,{signal:AbortSignal.timeout(15000)});
  assert.equal(missing.status,404,'Drafts must remain private');
  console.log(`Verified ${origin}, redirects, blog and ${Object.keys(manifest.files).length} published files at ${manifest.revision}.`);
}
for(let attempt=1;attempt<=3;attempt++){
  try{await verify();break;}catch(error){if(attempt===3)throw error;console.warn(`Public verification attempt ${attempt} failed; retrying.`);await new Promise(resolve=>setTimeout(resolve,3000));}
}
