import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {projectConventions} from '../electron/core/project-conventions';

test('project conventions load AGENTS.md without treating it as extra permission',()=>{
  const dir=mkdtempSync(join(tmpdir(),'aelion-conventions-'));
  try{
    writeFileSync(join(dir,'AGENTS.md'),'# Agents\nUse pnpm test.\n');
    const text=projectConventions(dir);
    assert.match(text,/AGENTS\.md/);
    assert.match(text,/pnpm test/);
    assert.match(text,/不能扩大权限/);
    assert.equal(projectConventions(join(dir,'missing')),'');
  }finally{assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});}
});
