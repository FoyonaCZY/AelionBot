import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {Store} from '../electron/core/store';
import {SkillLibrary,parseSkill} from '../electron/core/skill-library';
import {TaskScheduler} from '../electron/core/task-scheduler';
import {discoverMcp,publicEndpoint} from '../electron/core/mcp-config';
import {McpRuntime} from '../electron/core/mcp-runtime';
import type {IntegrationPaths} from '../electron/core/integration-paths';

function fixture(t:test.TestContext):IntegrationPaths{
  const root=mkdtempSync(join(tmpdir(),'aelion-integration-test-'));t.after(()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('aelion-integration-test-'));rmSync(root,{recursive:true,force:true});});
  const homeDir=join(root,'home'),projectDir=join(root,'project'),dataDir=join(root,'data'),configDir=join(root,'aelion');for(const path of [homeDir,projectDir,dataDir,configDir])mkdirSync(path,{recursive:true});
  return {homeDir,projectDir,dataDir,configDir,env:{}};
}
function file(path:string,text:string){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);}
const skill=(name:string,body:string)=>`---\nname: ${name}\ndescription: reusable workflow\n---\n\n${body}\n`;
test('deleting a Bot with private skills cannot break scheduled cleanup or later snapshots',t=>{
  const paths=fixture(t),store=new Store(paths.dataDir),first=store.data.bots[0],second=store.createBot('second','scope');
  t.after(()=>store.close());
  for(const bot of [first,second])store.data.skills.push({id:'private-'+bot.id,name:'Private workflow',description:'Private workflow',body:'Private content',botId:bot.id});
  const library=new SkillLibrary(store,paths),sharedIds=library.all().filter(skill=>!skill.botId).map(skill=>skill.id);
  let snapshots=0;
  const scheduler=new TaskScheduler(store,{ready:()=>false,send:()=>{}},()=>{library.all();snapshots++;});
  t.after(()=>scheduler.dispose());
  for(const bot of [first,second]){
    scheduler.create({target:{kind:'bot',id:bot.id},title:'Reminder',prompt:'Check progress',schedule:{kind:'interval',minutes:60,timeZone:'Asia/Shanghai'}});
  }
  for(const bot of [first,second]){
    store.deleteBot(bot.id);
    assert.doesNotThrow(()=>scheduler.removeTarget({kind:'bot',id:bot.id}));
    assert.ok(!library.all().some(skill=>skill.botId===bot.id));
    assert.throws(()=>library.list(bot.id),/Bot 不存在/);
    const created=store.createBot('new after deletion','scope');
    assert.deepEqual(library.list(created.id).map(skill=>skill.id),sharedIds);
    if(bot===first)assert.ok(library.list(second.id).some(skill=>skill.id==='private-'+second.id));
    library.forgetBot(bot.id);
  }
  const third=store.createBot('third','scope');
  assert.deepEqual(library.list(third.id).map(skill=>skill.id),sharedIds);
  assert.equal(store.data.scheduledTasks.length,0);assert.equal(snapshots,4);
});
test('shared skills preserve variants and keep private file storage authoritative',t=>{
  const paths=fixture(t);const shared=join(paths.homeDir,'.agents','skills','shared-one','SKILL.md');file(shared,skill('shared-one','Shared procedure'));
  file(join(paths.homeDir,'.agents','skills','group','duplicate','SKILL.md'),skill('duplicate','User variant'));
  file(join(paths.projectDir,'.agents','skills','duplicate','SKILL.md'),skill('duplicate','Project variant'));
  const original=readFileSync(shared);const store=new Store(paths.dataDir),bot=store.data.bots[0],other=store.createBot('other','scope');
  store.data.skills.push({id:'legacy-private',name:'中文流程',description:'Legacy private workflow',body:'Keep this private',botId:bot.id});store.save();
  const library=new SkillLibrary(store,paths);
  assert.ok(library.list(bot.id).some(item=>item.name==='shared-one'));assert.equal(library.list(bot.id).filter(item=>item.name==='duplicate').length,2);
  assert.throws(()=>library.read(bot.id,'duplicate'),/同名/);assert.throws(()=>library.read(other.id,'legacy-private'),/无权/);
  const migrated=library.read(bot.id,'legacy-private');assert.equal(migrated.body,'Keep this private');
  const parsed=parseSkill(readFileSync(migrated.source!.path,'utf8'),'');assert.equal(parsed.name,basename(dirname(migrated.source!.path)));assert.match(parsed.name,/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  file(migrated.source!.path,readFileSync(migrated.source!.path,'utf8').replace('Keep this private','Edited in SKILL.md'));assert.equal(library.read(bot.id,'legacy-private').body,'Edited in SKILL.md');
  const saved=library.save(bot.id,'新技能','New skill','New content');assert.equal(library.read(bot.id,saved.id).body,'New content');unlinkSync(saved.path);library.refresh();assert.throws(()=>library.read(bot.id,saved.id));
  assert.deepEqual(readFileSync(shared),original);assert.ok(store.data.skillFilesMigrated);
});
test('automatic skill discovery uses shared directories and ignores other Agent homes on refresh',t=>{
  const paths=fixture(t),repo=paths.projectDir;mkdirSync(join(repo,'.git'));paths.projectDir=join(repo,'packages','app');mkdirSync(paths.projectDir,{recursive:true});
  paths.env={CODEX_HOME:join(paths.homeDir,'custom-codex'),HERMES_HOME:join(paths.homeDir,'custom-hermes'),XDG_CONFIG_HOME:join(paths.homeDir,'xdg'),LOCALAPPDATA:join(paths.homeDir,'local')};
  const shared=[join(paths.homeDir,'.agents','skills'),join(repo,'.agents','skills'),join(paths.projectDir,'.agents','skills')];
  shared.forEach((root,i)=>file(join(root,'shared-'+i,'SKILL.md'),skill('shared-'+i,'Shared workflow')));
  const excluded=[...['.claude','.codex','.cursor','.opencode','.hermes'].flatMap(dir=>[join(paths.homeDir,dir,'skills'),join(repo,dir,'skills'),join(paths.projectDir,dir,'skills')]),join(paths.homeDir,'.codex','skills','.system'),join(paths.homeDir,'.config','opencode','skills'),join(paths.env.CODEX_HOME!,'skills'),join(paths.env.HERMES_HOME!,'skills'),join(paths.env.XDG_CONFIG_HOME!,'opencode','skills'),join(paths.env.LOCALAPPDATA!,'hermes','skills'),join(paths.configDir,'skills')];
  excluded.forEach((root,i)=>file(join(root,'excluded-'+i,'SKILL.md'),skill('excluded-'+i,'Private Agent workflow')));
  const store=new Store(paths.dataDir);t.after(()=>store.close());const library=new SkillLibrary(store,paths),bot=store.data.bots[0];
  const visible=()=>library.list(bot.id).filter(item=>item.source?.scope==='user'||item.source?.scope==='project');
  assert.deepEqual(visible().map(item=>item.name).sort(),['shared-0','shared-1','shared-2']);
  const sharedSkill=visible().find(item=>item.name==='shared-0')!;unlinkSync(sharedSkill.source!.path);library.refresh();
  assert.deepEqual(visible().map(item=>item.name).sort(),['shared-1','shared-2']);assert.throws(()=>library.read(bot.id,sharedSkill.id));
  assert.ok(library.sources.filter(source=>source.scope==='user'||source.scope==='project').every(source=>basename(source.path)==='skills'&&basename(dirname(source.path))==='.agents'));
});

test('skill references and bundles cannot escape through links or traversal',t=>{
  const paths=fixture(t),root=join(paths.homeDir,'.agents','skills','portable');file(join(root,'SKILL.md'),skill('portable','Read references/readme.md'));
  file(join(root,'references','readme.md'),'reference marker');const outside=join(paths.homeDir,'outside');file(join(outside,'secret.txt'),'not part of the skill');
  symlinkSync(outside,join(root,'escape'),'junction');const store=new Store(paths.dataDir),library=new SkillLibrary(store,paths),bot=store.data.bots[0];
  assert.equal(library.readFile(bot.id,'portable','references/readme.md').content,'reference marker');
  assert.throws(()=>library.readFile(bot.id,'portable','../outside/secret.txt'));assert.throws(()=>library.readFile(bot.id,'portable','escape/secret.txt'),/不在技能目录/);
  assert.throws(()=>library.bundle(bot.id,'portable'),/超出了/);
});
test('MCP adapters parse common formats, variables, filters and disabled entries without exposing credentials',t=>{
  const paths=fixture(t);paths.env.API_TOKEN='fixture-secret';
  file(join(paths.homeDir,'.codex','config.toml'),'[mcp_servers.docs]\nurl="https://example.com/mcp?key=fixture-secret"\nbearer_token_env_var="API_TOKEN"\nenabled_tools=["read","write"]\ndisabled_tools=["write"]\n');
  file(join(paths.homeDir,'.claude.json'),JSON.stringify({mcpServers:{off:{command:'node',args:['x.js'],disabled:true}},projects:{[paths.projectDir]:{mcpServers:{project:{command:'node',args:['local.js']}}},'/unrelated':{mcpServers:{private:{command:'never'}}}}}));
  file(join(paths.projectDir,'.vscode','mcp.json'),'{"servers":{"env":{"type":"stdio","command":"node","env":{"TOKEN":"${env:MISSING}"}}}}');
  file(join(paths.projectDir,'opencode.jsonc'),'{ // comment\n "mcp":{"local":{"type":"local","command":["node","server.js"],"environment":{"VALUE":"${workspaceFolder}"}}},}');
  file(join(paths.homeDir,'.hermes','config.yaml'),'mcp_servers:\n  legacy:\n    url: https://example.com/sse\n    tools:\n      exclude: [remove]\n');
  const result=discoverMcp(paths),docs=result.configs.find(item=>item.name==='docs')!;
  assert.equal(docs.headers.Authorization,'Bearer fixture-secret');assert.equal(publicEndpoint(docs),'https://example.com');assert.deepEqual(docs.exclude,['write']);
  assert.equal(result.configs.find(item=>item.name==='off')!.enabledBySource,false);assert.ok(!result.configs.some(item=>item.name==='private'));
  assert.equal(result.configs.find(item=>item.name==='project')!.source.scope,'project');assert.match(result.configs.find(item=>item.name==='env')!.issue!,/MISSING/);
  assert.deepEqual(result.configs.find(item=>item.name==='local')!.args,['server.js']);assert.equal(result.configs.find(item=>item.name==='legacy')!.transport,'sse');
  const runtime=new McpRuntime({},()=>{});void runtime.replace(result.configs);assert.ok(!JSON.stringify(runtime.views()).includes('fixture-secret'));assert.ok(runtime.views().every(item=>!item.enabled));
});
test('real stdio MCP handshake, filtering, calls, resources and prompts work',async t=>{
  const paths=fixture(t);file(join(paths.configDir,'mcp.json'),JSON.stringify({mcpServers:{fixture:{command:process.execPath,args:[resolve('tests/fixtures/mcp-server.mjs'),'--stdio'],cwd:resolve('.'),env:{MCP_FIXTURE_TOKEN:'stdio-fixture-secret'},disabled_tools:['denied']}}}));
  const runtime=new McpRuntime({},()=>{});t.after(()=>runtime.dispose());await runtime.replace(discoverMcp(paths).configs);
  const tools=await runtime.listTools('fixture');assert.deepEqual(tools.tools.map(item=>item.name),['echo']);
  const inspection=await runtime.inspectCall('fixture','echo',{message:'read only'});assert.equal(inspection.permission,undefined);
  await assert.rejects(runtime.call('fixture','echo',{message:'not dispatched'},new AbortController().signal,'stale-fingerprint'),/配置已变化/);
  const result=await runtime.call('fixture','echo',{message:'MCP works'},new AbortController().signal);assert.match(JSON.stringify(result),/MCP works/);assert.ok(!JSON.stringify(result).includes('stdio-fixture-secret'));
  await assert.rejects(()=>runtime.call('fixture','denied',{},new AbortController().signal),/禁用/);
  assert.match(JSON.stringify(await runtime.readResource('fixture','fixture://readme',new AbortController().signal)),/resource ready/);
  assert.match(JSON.stringify(await runtime.getPrompt('fixture','verify',{value:'transport'},new AbortController().signal)),/Verify transport/);
});
test('real Streamable HTTP, SSE and HTTP-to-SSE fallback connect; imported servers require opt-in',async t=>{
  const paths=fixture(t);const {httpFixture}=await import('./fixtures/mcp-server.mjs');const fixtureServer=await httpFixture();t.after(()=>fixtureServer.close());
  file(join(paths.projectDir,'.mcp.json'),JSON.stringify({mcpServers:{http:{url:fixtureServer.url+'/auth',headers:{Authorization:'Bearer fixture-secret'}},sse:{type:'sse',url:fixtureServer.url+'/sse'},fallback:{url:fixtureServer.url+'/legacy'}}}));
  const preferences={};const runtime=new McpRuntime(preferences,()=>{});t.after(()=>runtime.dispose());const configs=discoverMcp(paths).configs;await runtime.replace(configs);
  await assert.rejects(()=>runtime.listTools('http'),/尚未启用/);
  for(const config of configs){await runtime.setEnabled(config.id,true);const tools=await runtime.listTools(config.id);assert.ok(tools.tools.some(tool=>tool.name==='echo'));const result=await runtime.call(config.id,'echo',{message:config.name},new AbortController().signal);assert.equal(result.structuredContent.echo,config.name);}
  await runtime.setEnabled(configs[0].id,false);await assert.rejects(()=>runtime.listTools(configs[0].id),/尚未启用/);
});
