import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';

test('publication audit reads staged bytes even when the working copy has already been redacted',t=>{
  const dir=mkdtempSync(join(tmpdir(),'aelion-audit-'));t.after(()=>{assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});});
  execFileSync('git',['init','--quiet',dir],{windowsHide:true});mkdirSync(join(dir,'src'));
  writeFileSync(join(dir,'package.json'),JSON.stringify({repository:{url:'https://github.com/owner/repo.git'},build:{publish:{owner:'owner',repo:'repo'}}}));
  writeFileSync(join(dir,'src/config.ts'),`export const key='${'ghp_'+'A'.repeat(36)}';`);execFileSync('git',['add','.'],{cwd:dir,windowsHide:true});writeFileSync(join(dir,'src/config.ts'),"export const key='';");
  const script=resolve('scripts/audit-publication.mjs'),staged=spawnSync(process.execPath,[script],{cwd:dir,encoding:'utf8',windowsHide:true});assert.equal(staged.status,1);assert.ok(JSON.parse(staged.stdout).findings.some((finding:any)=>finding.kind==='credential-like-value'));
  const worktree=spawnSync(process.execPath,[script,'--worktree'],{cwd:dir,encoding:'utf8',windowsHide:true});assert.equal(worktree.status,0,worktree.stdout+worktree.stderr);
  execFileSync('git',['add','.'],{cwd:dir,windowsHide:true});const clean=spawnSync(process.execPath,[script],{cwd:dir,encoding:'utf8',windowsHide:true});assert.equal(clean.status,0,clean.stdout+clean.stderr);
});
