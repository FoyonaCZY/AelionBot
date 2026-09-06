import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {parse} from 'yaml';

const workflow=parse(readFileSync('.github/workflows/publish-verified-release.yml','utf8'));
const source=workflow.jobs.source.steps.find((s:any)=>s.id==='source').run.split('\n').slice(1,-2).join('\n');
function fixture(){
 const common=['Audit source','Typecheck','Test'];
 return {run:{status:'completed',conclusion:'success',path:'.github/workflows/release.yml',event:'workflow_dispatch',head_repository:{full_name:'example/AelionBot'},head_sha:'a'.repeat(40)},
  jobs:{jobs:['windows-x64','macos-arm64','macos-x64'].map(name=>({name,conclusion:'success',steps:[...common,...(name==='windows-x64'?['Build and verify Windows installer']:['Build and verify Mac installers','Verify packaged Mac app','Verify Mac Linux desktop and persistence'])].map(name=>({name,conclusion:'success'}))}))},
  artifacts:{artifacts:['AelionBot-windows-x64','AelionBot-macos-arm64','AelionBot-macos-x64'].map(name=>({name,expired:false,size_in_bytes:100}))}};
}
function validate(data:ReturnType<typeof fixture>,id='1234'){
 let output='';
 runInNewContext(source,{process:{env:{BUILD_RUN_ID:id,GITHUB_REPOSITORY:'example/AelionBot',GITHUB_OUTPUT:'result'}},console:{log:()=>{}},require:(name:string)=>{
  if(name==='node:fs')return {appendFileSync:(_path:string,text:string)=>{output+=text;}};
  if(name==='node:child_process')return {execFileSync:(_command:string,args:string[])=>JSON.stringify(args[1].includes('/jobs?')?data.jobs:args[1].includes('/artifacts?')?data.artifacts:data.run)};
  throw Error('Unexpected import');
 }});
 return output;
}
test('release promotion pins the source from a complete three-platform build',()=>{
 assert.equal(validate(fixture()),'sha='+ 'a'.repeat(40)+'\nrun_id=1234\n');
});
test('release promotion rejects unfinished builds, foreign code and missing VM verification',()=>{
 for(const patch of [{status:'in_progress'},{conclusion:'failure'},{event:'pull_request'},{path:'other.yml'},{head_repository:{full_name:'other/repository'}},{head_sha:'invalid'}]){
  const data=fixture();Object.assign(data.run,patch);assert.throws(()=>validate(data),/successful release build/);
 }
 for(const index of [1,2]){const data=fixture();data.jobs.jobs[index].steps.at(-1)!.conclusion='skipped';assert.throws(()=>validate(data),/Required checks did not pass/);}
 const expired=fixture();expired.artifacts.artifacts[1].expired=true;assert.throws(()=>validate(expired),/artifact missing/);
 const missing=fixture();missing.artifacts.artifacts.pop();assert.throws(()=>validate(missing),/artifact missing/);
 assert.throws(()=>validate(fixture(),'1234; echo injected'),/Invalid build run ID/);
});
