import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {allowedPath,prepareDeployment} from '../deploy/prepare.mjs';

const identity={repository:'FoyonaCZY/AelionBot',revision:'a'.repeat(40),runId:100,runNumber:2,runAttempt:1};
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'aelion-web-package-'));
  t.after(()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('aelion-web-package-'));rmSync(root,{recursive:true,force:true});});
  for(const name of ['index.html','blog/index.html','404.html','robots.txt','sitemap.xml','assets/app.js']){const file=join(root,name);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,'public '+name);}
  return root;
}
test('deployment manifest identifies the exact build and hashes every public file',t=>{
  const root=fixture(t),manifest=prepareDeployment(root,identity);
  assert.equal(manifest.revision,identity.revision);assert.equal(Object.keys(manifest.files).length,6);
  assert.equal(manifest.files['index.html'],createHash('sha256').update(readFileSync(join(root,'index.html'))).digest('hex'));
  assert.deepEqual(prepareDeployment(root,identity),manifest);
});
test('private paths, scripts and traversal cannot enter the deployment package',t=>{
  for(const name of ['.env','assets/../key.txt','/index.html','C:\\key.pem','blog/_preview/draft/index.html','assets/key.pem','source.ts','install.sh'])assert.equal(allowedPath(name),false,name);
  assert.equal(allowedPath('blog-media/产品截图.png'),true);
  const root=fixture(t);writeFileSync(join(root,'secret.pem'),'not a public asset');
  assert.throws(()=>prepareDeployment(root,identity),/Unexpected deployment file/);
});
test('incomplete builds and invalid workflow identities stop packaging',t=>{
  const root=fixture(t);unlinkSync(join(root,'blog/index.html'));
  assert.throws(()=>prepareDeployment(root,identity),/Missing public page/);
  assert.throws(()=>prepareDeployment(root,{...identity,revision:'main'}),/Invalid deployment identity/);
});
