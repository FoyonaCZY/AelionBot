import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {HostComputer} from '../electron/core/host';
import {Interactions,InteractionDenied} from '../electron/core/interactions';
import {CommandPermissions} from '../electron/core/command-permissions';

function fixture(t:test.TestContext){
  const root=mkdtempSync(join(tmpdir(),'aelion-workspace-test-')),home=join(root,'home');mkdirSync(home);
  const options={dataDir:root,homeDir:home,projectDir:root,env:{...process.env}};
  const interactions=new Interactions(()=>{}),host=new HostComputer(options,interactions);
  t.after(()=>{interactions.dispose();host.dispose();assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('aelion-workspace-test-'));rmSync(root,{recursive:true,force:true});});
  return {root,home,options,host,interactions};
}

test('all Bots default to the user Documents/Aelion directory without creating it',t=>{
  const {home,host}=fixture(t),expected=join(home,'Documents','Aelion');
  assert.equal(host.workspace('bot-a'),expected);assert.equal(host.workspace('bot-b'),expected);
  assert.equal(host.context('bot-a').workspace,expected);
  assert.deepEqual(host.workspaceSettings(),{workspaceDir:expected,defaultWorkspaceDir:expected});
  assert.equal(existsSync(expected),false);
});

test('custom folders and tilde paths persist and restoring the default removes the override',t=>{
  const {root,home,host,options,interactions}=fixture(t),custom=join(home,'Documents','Custom work');
  host.setWorkspaceDir('~/Documents/Custom work');assert.equal(host.workspace('a'),custom);assert.equal(existsSync(custom),false);
  const restored=new HostComputer(options,interactions);assert.equal(restored.workspace('b'),custom);
  const saved=JSON.parse(readFileSync(join(root,'host-settings.json'),'utf8'));assert.equal(saved.workspaceDir,custom);
  restored.setWorkspaceDir(restored.workspaceSettings().defaultWorkspaceDir);
  assert.equal(new HostComputer(options,interactions).workspace('a'),join(home,'Documents','Aelion'));
  assert.equal(JSON.parse(readFileSync(join(root,'host-settings.json'),'utf8')).workspaceDir,undefined);
});

test('invalid directories cannot replace an existing preference',t=>{
  const {root,host}=fixture(t),custom=join(root,'valid folder'),file=join(root,'ordinary-file.txt');
  writeFileSync(file,'keep');host.setWorkspaceDir(custom);
  for(const value of ['', 'relative/folder','C:relative','https://example.com/folder',join(root,'bad*folder'),`${root}\nother`,file,join(file,'child')])assert.throws(()=>host.setWorkspaceDir(value),/目录|参数|文件夹/,value);
  assert.equal(host.workspace('bot'),custom);assert.equal(readFileSync(file,'utf8'),'keep');
});

test('changing the default leaves old workspaces and their files in place',t=>{
  const {root,host}=fixture(t),old=join(root,'host-workspaces','bot-a');mkdirSync(old,{recursive:true});writeFileSync(join(old,'report.txt'),'existing report');
  host.setWorkspaceDir(join(root,'new-workspace'));
  assert.equal(readFileSync(join(old,'report.txt'),'utf8'),'existing report');assert.equal(existsSync(join(root,'new-workspace')),false);
});

test('denied commands do not create the configured folder',{skip:process.platform!=='win32'},async t=>{
  const {root,host,interactions}=fixture(t),custom=join(root,'new','work');host.setWorkspaceDir(custom);
  const execution=host.execute('a','run',{command:'Get-Location',reason:'检查目录'},new AbortController().signal),rejected=assert.rejects(execution,InteractionDenied);
  const request=interactions.snapshot()[0];assert.equal(request.kind,'host_permission');if(request.kind==='host_permission')assert.equal(request.details.cwd,custom);
  assert.equal(existsSync(custom),false);interactions.approve(request.id,false);await rejected;assert.equal(existsSync(custom),false);
});

test('approved commands run in the configured folder and explicit cwd still takes precedence',{skip:process.platform!=='win32'},async t=>{
  const {root,host,interactions}=fixture(t),custom=join(root,'work with spaces');host.setWorkspaceDir(custom);
  const first=host.execute('a','one',{command:'(Get-Location).Path',reason:'验证默认目录'},new AbortController().signal);
  interactions.approve(interactions.snapshot()[0].id,true);const defaultResult=await first;
  assert.equal(defaultResult.exitCode,0);assert.equal(defaultResult.cwd,realpathSync.native(custom));assert.equal(defaultResult.stdout.trim(),realpathSync.native(custom));
  const second=host.execute('b','two',{command:'(Get-Location).Path',cwd:root,reason:'验证指定目录'},new AbortController().signal);
  interactions.approve(interactions.snapshot()[0].id,true);const explicitResult=await second;
  assert.equal(explicitResult.exitCode,0);assert.equal(explicitResult.stdout.trim(),realpathSync.native(root));
});

test('a pending approval retains the directory that the user was shown',{skip:process.platform!=='win32'},async t=>{
  const {root,host,interactions}=fixture(t),before=host.workspace('a'),after=join(root,'changed');
  const first=host.execute('a','one',{command:'(Get-Location).Path',reason:'验证已显示的目录'},new AbortController().signal),id=interactions.snapshot()[0].id;
  host.setWorkspaceDir(after);interactions.approve(id,true);const result=await first;
  assert.equal(result.cwd,before);assert.equal(result.stdout.trim(),before);
  const next=host.execute('a','two',{command:'Get-Location',reason:'验证新目录'},new AbortController().signal),rejected=assert.rejects(next,InteractionDenied),request=interactions.snapshot()[0];
  if(request.kind==='host_permission')assert.equal(request.details.cwd,after);
  interactions.approve(request.id,false);await rejected;
});

test('existing command grants do not silently move to a newly selected directory',{skip:process.platform!=='win32'},async t=>{
  const {root,options}=fixture(t),rules=new CommandPermissions(join(root,'command-permissions.json')),interactions=new Interactions(()=>{},undefined,rules),host=new HostComputer(options,interactions);
  const old=host.workspace('a');rules.allow({operation:'command',command:'Get-Location',cwd:old,reason:'先前许可'});
  host.setWorkspaceDir(join(root,'new-default'));
  const execution=host.execute('a','run',{command:'Get-Location',reason:'检查新目录'},new AbortController().signal),rejected=assert.rejects(execution,InteractionDenied);
  assert.equal(interactions.snapshot().length,1);assert.equal(rules.list()[0].cwd,old);
  interactions.approve(interactions.snapshot()[0].id,false);await rejected;interactions.dispose();host.dispose();
});
