import test from 'node:test';
import assert from 'node:assert/strict';
import {BoundedOutput,bytePage} from '../electron/core/bounded-output';
import {redactHost,HostComputer} from '../electron/core/host';
import {Interactions} from '../electron/core/interactions';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';

test('bounded output retains beginning and final errors with accurate omission counts',()=>{
 const output=new BoundedOutput(100);output.push(Buffer.from('START\n'+'x'.repeat(1000)+'\nFINAL ERROR'));const result=output.result();assert.ok(result.text.startsWith('START\n'));assert.ok(result.text.endsWith('FINAL ERROR'));assert.equal(result.truncated,true);assert.equal(result.omittedBytes,result.totalBytes-100);
});
test('UTF-8 boundaries and known secret fragments stay safe after truncation',()=>{
 const output=new BoundedOutput(12);for(const byte of Buffer.from('😀中文end'))output.push(Buffer.from([byte]));const result=output.result();assert.ok(!result.text.includes('\ufffd'));assert.ok(result.text.endsWith('文end'));
 const secret='fixture-private-token-99887766',begin=new BoundedOutput(24);begin.push(Buffer.from(secret+' '.repeat(100)));const first=begin.result(text=>redactHost(text,[secret]),[secret]);assert.ok(!first.text.includes('fixture-priv'));
 const end=new BoundedOutput(24);end.push(Buffer.from(' '.repeat(100)+secret));const last=end.result(text=>redactHost(text,[secret]),[secret]);assert.ok(!last.text.includes('token-99887766'));assert.match(last.text,/redacted/);
});
test('byte log cursors do not split characters and defer incomplete streaming bytes',()=>{
 const bytes=Buffer.from('😀中文\nend');let offset=0,text='';while(offset<bytes.length){const page=bytePage(bytes,offset,5,true);assert.ok(page.nextOffset>offset);text+=page.output;offset=page.nextOffset;}assert.equal(text,bytes.toString('utf8'));
 const partial=bytePage(Buffer.from('😀').subarray(0,3),0,12000,false);assert.equal(partial.output,'');assert.equal(partial.nextOffset,0);assert.equal(partial.pendingBytes,3);assert.equal(bytePage(Buffer.from('😀'),0,12000,false).output,'😀');
});
test('large host stdout cannot hide late stderr or the real exit code',{skip:process.platform!=='win32'},async t=>{
 const parent=realpathSync.native(tmpdir()),root=mkdtempSync(join(parent,'aelion-output-')),interactions=new Interactions(()=>{}),host=new HostComputer({dataDir:root,homeDir:root,projectDir:root},interactions);t.after(()=>{host.dispose();interactions.dispose();assert.equal(dirname(resolve(root)),parent);rmSync(root,{recursive:true,force:true});});
 const pending=host.execute('bot','run',{command:"[Console]::Write('x' * 1500000); [Console]::Error.WriteLine('FINAL FAILURE'); exit 7",cwd:root,reason:'verify output'},new AbortController().signal);interactions.approve(interactions.snapshot()[0].id,true);const result=await pending;assert.equal(result.exitCode,7);assert.match(result.stderr,/FINAL FAILURE/);assert.equal(result.stdoutBytes,1500000);assert.equal(result.truncated,true);assert.ok(result.omittedBytes>0);assert.ok(result.stdout.length<530000);assert.ok(result.durationMs<10000,'Redaction must not stall on a long identifier-like output');
});
