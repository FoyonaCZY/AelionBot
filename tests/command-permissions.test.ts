import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {CommandPermissions} from '../electron/core/command-permissions';
import {Interactions,InteractionDenied,respondToInteraction} from '../electron/core/interactions';
import {HostComputer,redactHost} from '../electron/core/host';
import type {ComputerController} from '../electron/core/computer';
import type {HostPermissionDetails} from '../src/shared';

const details=(command:string,cwd='C:\\projects\\sample'):HostPermissionDetails=>({operation:'command',command,cwd,reason:'测试命令权限'});
function fixture(t:test.TestContext,redact=(value:string)=>value){
  const root=mkdtempSync(join(tmpdir(),'aelion-command-rules-test-')),file=join(root,'command-permissions.json');
  const rules=new CommandPermissions(file,redact),decisions:Array<{decision:string;ruleId?:string}>=[];
  const interactions=new Interactions(()=>{},(_request,decision,ruleId)=>decisions.push({decision,ruleId}),rules);
  const host=new HostComputer({dataDir:root,projectDir:root,homeDir:root,env:{...process.env}},interactions);
  t.after(()=>{interactions.dispose();host.dispose();assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('aelion-command-rules-test-'));rmSync(root,{recursive:true,force:true});});
  return{root,file,rules,interactions,host,decisions};
}

test('suggested patterns retain the relevant executable and subcommand',t=>{
  const {rules}=fixture(t);
  const examples=[['git status --short','git status *'],['git diff --stat','git diff *'],['npm run build -- --mode production','npm run build *'],['pnpm run typecheck','pnpm run typecheck *'],['gh pr list --state open','gh pr list *'],["Get-Content -LiteralPath 'C:\\report.txt'",'Get-Content *']];
  for(const [command,pattern] of examples)assert.deepEqual(rules.suggest(details(command)),{kind:'prefix',pattern});
  for(const command of ['git','git -C C:\\repo status','gh api repos/example/repo','python -c "print(1)"','custom-tool --check','Get-Content file.txt | Select-Object -First 3'])assert.equal(rules.suggest(details(command))?.kind,'exact');
});

test('prefix matching uses token boundaries and the approved working directory',t=>{
  const {rules}=fixture(t);rules.allow(details('git status --short'));
  for(const command of ['git status','git   status --porcelain','GIT\tstatus --short'])assert.ok(rules.match(details(command,'c:/projects/sample/')));
  for(const command of ['git status-other','git log','git STATUS','git.exe status','othergit status'])assert.equal(rules.match(details(command)),undefined);
  assert.equal(rules.match(details('git status','C:\\projects\\different')),undefined);
  const rule=rules.list()[0];rule.enabled=false;assert.ok(rules.match(details('git status')));
});

test('shell operators, substitutions and additional statements cannot inherit a prefix grant',t=>{
  const {rules}=fixture(t);rules.allow(details('git status'));rules.allow(details('rg needle .'));
  const rejected=[
    'git status; Write-Output extra','git status\nWrite-Output extra','git status\r\nWrite-Output extra',
    'git status | Write-Output extra','git status && whoami','git status & whoami','git status > result.txt',
    'git status $(whoami)','git status "$env:USERNAME"','git status `; whoami','git status # comment',
    'git status --% --short','git status\u2028whoami','git status\u0085whoami','git status { whoami }',
    "git 'status' --short",'rg needle . --pre=helper.exe'
  ];
  for(const command of rejected)assert.equal(rules.match(details(command)),undefined,command);
});

test('scripts and interpreter commands require the same full command',t=>{
  const {rules}=fixture(t),command="Write-Output 'first'; Write-Output 'second'";
  const rule=rules.allow(details(command));assert.equal(rule.kind,'exact');
  assert.ok(rules.match(details(command)));assert.ok(rules.match(details(`  ${command}  `)));
  assert.equal(rules.match(details(`${command}; Write-Output 'third'`)),undefined);
  assert.equal(rules.match(details(command.replace('second','different'))),undefined);
});

test('exact rules retain hashes rather than unmasked credentials',t=>{
  const secret='fixture-private-token-123456';
  const {rules,file}=fixture(t,value=>redactHost(value,[secret]));
  const command=`custom-tool --token '${secret}'`;
  const rule=rules.allow(details(command));assert.equal(rule.kind,'exact');assert.ok(!rule.pattern.includes(secret));
  assert.ok(!readFileSync(file,'utf8').includes(secret));
  assert.ok(new CommandPermissions(file).match(details(command)));
  assert.equal(rules.match(details(command.replace(secret,'different-token'))),undefined);
});

test('rules persist across restarts and can be disabled, re-enabled and removed',t=>{
  const {rules,file}=fixture(t);const first=rules.allow(details('npm run build'));
  rules.allow(details('npm run build -- --verbose'));assert.equal(rules.list().length,1);
  const restored=new CommandPermissions(file);assert.equal(restored.match(details('npm run build'))?.id,first.id);
  restored.setEnabled(first.id,false);assert.equal(restored.match(details('npm run build')),undefined);
  assert.equal(new CommandPermissions(file).list()[0].enabled,false);
  restored.setEnabled(first.id,true);assert.ok(restored.match(details('npm run build')));
  restored.remove(first.id);assert.equal(new CommandPermissions(file).list().length,0);
  assert.throws(()=>restored.setEnabled(first.id,true),/不存在/);
});

test('unreadable or invalid saved patterns grant no permissions',t=>{
  const {rules,file}=fixture(t);rules.allow(details('git status'));
  const saved=JSON.parse(readFileSync(file,'utf8'));saved.rules[0].prefix=['git'];saved.rules[0].pattern='git *';writeFileSync(file,JSON.stringify(saved));
  assert.equal(new CommandPermissions(file).list().length,0);
  writeFileSync(file,'not json');assert.equal(new CommandPermissions(file).match(details('git status')),undefined);
});

test('one-time approval and denial never create saved rules',async t=>{
  const {rules,interactions}=fixture(t),signal=new AbortController().signal;
  const first=interactions.permission('a','run',details('git status'),signal);interactions.approve(interactions.snapshot()[0].id,true);await first;assert.equal(rules.list().length,0);
  const second=interactions.permission('a','run',details('git status'),signal),rejected=assert.rejects(second,InteractionDenied);
  interactions.approve(interactions.snapshot()[0].id,false);await rejected;assert.equal(rules.list().length,0);
});

test('always allow derives the saved rule only from the immutable pending request',async t=>{
  const {rules,interactions,decisions}=fixture(t),source=details('git status --short');
  source.commandPattern={kind:'prefix',pattern:'*'};
  const pending=interactions.permission('a','run',source,new AbortController().signal),request=interactions.snapshot()[0];
  assert.equal(request.kind,'host_permission');if(request.kind!=='host_permission')throw new Error('Unexpected request');
  assert.equal(request.details.commandPattern?.pattern,'git status *');
  source.command='powershell -Command anything';request.details.command='Write-Output fake';request.details.commandPattern!.pattern='*';
  respondToInteraction(interactions,{} as ComputerController,{id:request.id,action:'allow-always',pattern:'*'} as any);await pending;
  assert.equal(rules.list()[0].pattern,'git status *');assert.equal(decisions[0].decision,'always-allowed');assert.equal(decisions[0].ruleId,rules.list()[0].id);
  await interactions.permission('another-bot','next',details('git status --porcelain'),new AbortController().signal);
  assert.equal(interactions.snapshot().length,0);assert.equal(decisions[1].decision,'rule-allowed');
});

test('matching requests already waiting also use the newly saved rule',async t=>{
  const {interactions}=fixture(t),controller=new AbortController();
  const first=interactions.permission('a','one',details('git status'),controller.signal);
  const second=interactions.permission('b','two',details('git status --short'),controller.signal);
  const other=interactions.permission('c','three',details('git log'),controller.signal),rejected=assert.rejects(other,/取消/);
  interactions.approveAlways(interactions.snapshot()[0].id);await Promise.all([first,second]);
  assert.equal(interactions.snapshot().length,1);controller.abort();await rejected;
});

test('stale or cancelled requests cannot install rules, and cancellation still wins with a saved grant',async t=>{
  const {rules,interactions,decisions}=fixture(t),controller=new AbortController();
  const pending=interactions.permission('a','one',details('git status'),controller.signal),rejected=assert.rejects(pending,/取消/),id=interactions.snapshot()[0].id;
  controller.abort();await rejected;assert.throws(()=>interactions.approveAlways(id),/已结束/);assert.equal(rules.list().length,0);
  rules.allow(details('git status'));const before=decisions.length;
  await assert.rejects(interactions.permission('a','two',details('git status'),controller.signal),/取消/);assert.equal(decisions.length,before);
});

test('file and MCP operations cannot inherit or install command rules',async t=>{
  const {rules,interactions}=fixture(t);rules.allow(details('Get-Content file.txt'));
  for(const operation of ['read_file','write_file','mcp'] as const){
    const pending=interactions.permission('a','run',{...details('Get-Content file.txt'),operation,path:'C:\\file.txt'},new AbortController().signal),rejected=assert.rejects(pending,InteractionDenied),request=interactions.snapshot()[0];
    assert.equal(request.kind,'host_permission');if(request.kind==='host_permission')assert.equal(request.details.commandPattern,undefined);
    assert.throws(()=>interactions.approveAlways(request.id),/不支持/);
    interactions.approve(request.id,false);await rejected;
  }
  assert.equal(rules.list().length,1);
});

test('an unsaved rule never authorizes the pending operation',async t=>{
  const {root}=fixture(t),file=join(root,'is-a-directory');mkdirSync(file);
  const rules=new CommandPermissions(file),interactions=new Interactions(()=>{},undefined,rules),controller=new AbortController();
  const pending=interactions.permission('a','run',details('git status'),controller.signal),rejected=assert.rejects(pending,/取消/);
  assert.throws(()=>interactions.approveAlways(interactions.snapshot()[0].id));assert.equal(rules.list().length,0);assert.equal(interactions.snapshot().length,1);
  controller.abort();await rejected;interactions.dispose();
});

test('a real PowerShell command reuses a saved grant after restart and prompts again after revocation',{skip:process.platform!=='win32'},async t=>{
  const {root,file,host,interactions}=fixture(t),signal=new AbortController().signal;
  const first=host.execute('a','run-a',{command:"Write-Output 'first result'",cwd:root,reason:'验证保存规则'},signal);
  interactions.approveAlways(interactions.snapshot()[0].id);assert.match((await first).stdout,/first result/);
  const restored=new CommandPermissions(file),nextInteractions=new Interactions(()=>{},undefined,restored),nextHost=new HostComputer({dataDir:root,homeDir:root,projectDir:root,env:{...process.env}},nextInteractions);
  const second=nextHost.execute('b','run-b',{command:"Write-Output 'second result'",cwd:root,reason:'验证自动允许'},signal);
  assert.equal(nextInteractions.snapshot().length,0);assert.match((await second).stdout,/second result/);
  restored.remove(restored.list()[0].id);
  const third=nextHost.execute('b','run-c',{command:"Write-Output 'must wait'",cwd:root,reason:'验证撤销'},signal),rejected=assert.rejects(third,InteractionDenied);
  assert.equal(nextInteractions.snapshot().length,1);nextInteractions.approve(nextInteractions.snapshot()[0].id,false);await rejected;
  nextHost.dispose();nextInteractions.dispose();
});
