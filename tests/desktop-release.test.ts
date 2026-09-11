import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse} from 'yaml';

const release=parse(readFileSync('.github/workflows/release.yml','utf8'));
const publish=parse(readFileSync('.github/workflows/publish-verified-release.yml','utf8'));
const steps=release.jobs.build.steps as {name?:string;if?:string;run?:string;uses?:string;id?:string}[];
const step= (name:string)=>steps.find(item=>item.name===name||item.uses===name||item.run===name);

test('Mac desktop release matches the Windows packaging path by default',()=>{
 assert.equal(release.on.workflow_dispatch.inputs.vm_smoke.default,false);
 assert.equal(String(release.jobs.build['timeout-minutes']),'${{ inputs.vm_smoke && 75 || 30 }}');
 assert.equal(release.jobs.build.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD,'1');
 assert.equal(step('Verify Mac Linux desktop and persistence')?.if,"runner.os == 'macOS' && inputs.vm_smoke");
 assert.doesNotMatch(step('Verify Mac Linux desktop and persistence')?.if||'',/github\.event_name/);
 assert.equal(step('Install Mac build runtime')?.if,"${{ runner.os == 'macOS' && steps.runtime.outputs.cache-hit != 'true' }}");
 assert.equal(step('Prepare bundled runtime')?.if,"${{ steps.runtime.outputs.cache-hit != 'true' }}");
 assert.equal(step('Verify bundled runtime')?.run,'node scripts/verify-bundled-runtime.mjs');
 assert.equal((step('Install dependencies') as Record<string,unknown>)['timeout-minutes'],8);
 assert.match(step('Install dependencies')?.run||'',/--foreground-scripts/);
 const cache=steps.find(item=>item.id==='runtime');
 assert.match(String(cache?.uses||''),/actions\/cache/);
 assert.ok((cache as {with:{key:string}}).with.key.includes('runner.os'));
});

test('verified publish no longer boots a TCG guest and does not require the optional Mac smoke',()=>{
 assert.equal(publish.jobs.packaged_vm,undefined);
 assert.deepEqual(publish.jobs.publish.needs,'source');
 assert.match(publish.jobs.source.steps[0].run,/Verify packaged Mac app/);
 assert.doesNotMatch(publish.jobs.source.steps[0].run,/Verify Mac Linux desktop and persistence/);
});
