import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,symlinkSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {unzipSync} from 'fflate';
import {Store} from '../electron/core/store';
import {DesignStore} from '../electron/core/design-store';
import {DesignerFiles} from '../electron/core/designer-files';
import {designerDeck} from '../electron/core/designer-deck';
import {ArtifactService} from '../electron/core/artifacts';
import {Attachments} from '../electron/core/attachments';
import {HostComputer} from '../electron/core/host';
import {Harness} from '../electron/core/harness';
import {DesignerLoop} from '../electron/core/designer-loop';
import {randomUUID} from 'node:crypto';
import {AgentPreviews} from '../electron/core/agent-previews';
function setup(t:any){const root=mkdtempSync(join(tmpdir(),'aelion-local-design-'));t.after(()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(root.includes('aelion-local-design-'));rmSync(root,{recursive:true,force:true});});const store=new Store(join(root,'data')),bot=store.createBot('Designer','',undefined,undefined,{type:'designer'}),base=join(root,'default');const designs=new DesignStore(store,{} as any,()=>{},()=>base),task=designs.create({botId:bot.id,kind:'prototype',brief:'A local page'}),files=new DesignerFiles(store,designs);let vmCalls=0;const vm=new Proxy({},{get(){vmCalls++;throw Error('Designer must not access VM');}});const artifacts=new ArtifactService(store,vm as any);artifacts.designerFiles=files;return {root,store,bot,designs,task,files,artifacts,vm,vmCalls:()=>vmCalls};}
test('local design files stay below default/designers and reject cross-task paths and directory links',async t=>{const f=setup(t),b=f.designs.create({botId:f.bot.id,kind:'prototype',brief:'B'}),workspace=f.task.workspaceDir!;assert.ok(statSync(workspace).isDirectory());assert.ok(workspace.replace(/\\/g,'/').endsWith('/default/designers/'+f.bot.id+'/'+f.task.id));f.files.write(f.task,'index.html',Buffer.from('<main>Draft</main>'));assert.throws(()=>f.files.absolute(f.task,'../outside.txt'));assert.throws(()=>f.files.absolute(f.task,join(b.workspaceDir!,'index.html')));await assert.rejects(f.artifacts.read(f.bot.id,'designers/another/secret.html'));const outside=join(f.root,'outside');mkdirSync(outside);symlinkSync(outside,join(f.task.workspaceDir!,'linked'),'junction');assert.throws(()=>f.files.write(f.task,'linked/escape.txt',Buffer.from('x')));assert.equal(existsSync(join(outside,'escape.txt')),false);assert.equal(f.vmCalls(),0);});
test('local previews, nested assets, attachment delivery and source save use the same bytes without VM',async t=>{const f=setup(t),path=f.task.workspacePath+'/index.html';f.files.write(f.task,'index.html',Buffer.from('<html><body>Draft</body></html>'));f.files.write(f.task,'assets/style.css',Buffer.from('body{color:red}'));assert.equal((await f.artifacts.preview(f.bot.id,path)).kind,'html');assert.equal((await f.artifacts.read(f.bot.id,f.task.workspacePath+'/assets/style.css')).toString(),'body{color:red}');const before=await f.artifacts.readEditable(f.bot.id,path);await f.artifacts.saveEditable(f.bot.id,path,{revision:before.revision,content:'<html><body>Changed</body></html>'});await assert.rejects(f.artifacts.saveEditable(f.bot.id,path,{revision:before.revision,content:'stale'}),/修改/);const attachments=new Attachments(f.store,f.vm as any,f.artifacts),sent=await attachments.prepare(f.bot.id,[{path}],new AbortController().signal);assert.match(attachments.bytes(sent[0].id).toString(),/Changed/);f.store.data.runs.push({id:'local-run',botId:f.bot.id,engine:'designer',designSessionId:f.task.id,workspaceDir:f.task.workspaceDir,status:'running',startedAt:new Date().toISOString(),modelCalls:0,toolCalls:0});const previews=new AgentPreviews(f.store,f.artifacts,attachments,()=>{});await previews.open(f.bot.id,'local-run',{path,location:'host'},new AbortController().signal);assert.deepEqual(previews.snapshot()[0].target,{kind:'workspace',path});await f.artifacts.collect(f.bot.id,'local-run');assert.equal(f.store.data.artifacts.length,2);assert.equal((await f.artifacts.directory(f.bot.id)).entries[0].path,f.task.workspacePath);assert.equal(f.vmCalls(),0);});
test('local deck has editable OOXML text, multiple layouts, escaped content and an HTML companion',async t=>{const f=setup(t),deck=designerDeck('A < B',[{title:'标题 & 原文',body:'一条明确的信息',layout:'split'},{title:'第二页',body:'仍可编辑',layout:'statement'},{title:'目录',layout:'agenda',items:['背景','方案']},{title:'下一步',body:'开始评审',layout:'cta'}]);f.files.write(f.task,'deck.pptx',deck.pptx);f.files.write(f.task,'deck.html',deck.html);const zip=unzipSync(deck.pptx);assert.match(Buffer.from(zip['ppt/slides/slide1.xml']).toString(),/标题 &amp; 原文/);assert.match(Buffer.from(zip['ppt/slides/slide3.xml']).toString(),/1\. 背景/);assert.match(deck.html.toString(),/data-slide-id="slide-4"/);assert.match(deck.html.toString(),/class="agenda"/);assert.equal((await f.artifacts.preview(f.bot.id,f.task.workspacePath+'/deck.pptx')).kind,'web');assert.equal(f.vmCalls(),0);const python=process.env.AELION_TEST_PYTHON;if(python){const result=spawnSync(python,['-c',"from pptx import Presentation\nimport sys\np=Presentation(sys.argv[1]);assert len(p.slides)==4\nassert any('标题 & 原文' in s.text for s in p.slides[0].shapes if s.has_text_frame)\np.slides[0].shapes[1].text='Edited locally'\np.save(sys.argv[1]);assert Presentation(sys.argv[1]).slides[0].shapes[1].text=='Edited locally'",join(f.task.workspaceDir!,'deck.pptx')],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);}else t.diagnostic('PowerPoint reopen check requires AELION_TEST_PYTHON; OOXML and local preview assertions ran.');});
test('designer PowerPoint attachments preview the HTML companion without a VM',async t=>{
 const f=setup(t),deck=designerDeck('Local slides',[{title:'封面',layout:'title'}]);
 f.files.write(f.task,'deck.pptx',deck.pptx);f.files.write(f.task,'deck.html',deck.html);
 const attachments=new Attachments(f.store,f.vm as any,f.artifacts);
 const [pptx]=await attachments.prepare(f.bot.id,[{path:f.task.workspacePath+'/deck.pptx'}],new AbortController().signal);
 const preview=await attachments.previewRich(pptx.id);
 assert.equal(preview.kind,'web');
 assert.equal(preview.web?.kind,'document');
 const html=preview.web?.kind==='document'?preview.web.content||'':'';
 assert.match(html,/封面/);
 assert.equal(f.vmCalls(),0);
 const orphan=attachments.importForBot(f.bot.id,'alone.pptx',Buffer.from('not-a-deck'));
 assert.equal((await attachments.previewRich(orphan.id)).kind,'unsupported');
 assert.equal(f.vmCalls(),0);
});
test('publish blocks remote fonts',async t=>{
 const f=setup(t),session=f.designs.get(f.task.id);
 f.files.write(session,'index.html',Buffer.from('<html><body><link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet"><p>Hello</p></body></html>'));
 const attachments=new Attachments(f.store,f.vm as any,f.artifacts);
 let publishStep=0;const model={complete:async()=>({content:'Trying to publish',calls:publishStep++===0?[{id:randomUUID(),type:'function',function:{name:'design_publish',arguments:JSON.stringify({paths:['index.html']})}}]:[],finishReason:'stop'})};
 const shared=new Harness(f.store,f.vm as any,model as any,()=>{},undefined,undefined,undefined,undefined,undefined,undefined,attachments);t.after(()=>shared.disposeTools());
 const context={observe:()=>{},prepare:async(input:any)=>({messages:[input.system,...input.history],maxOutputTokens:8192,stats:{calibration:1},calibrationEstimate:2000,recordUsage:()=>{}})};
 const loop=new DesignerLoop(f.store,f.designs,{} as any,f.files,model as any,context as any,shared,f.artifacts,attachments,{pendingQuestions:()=>[]} as any,()=>{});
 await loop.run(f.bot.id,'Deliver',{designSessionId:session.id});
 assert.match(f.store.data.runs.at(-1)?.error||'',/远程字体/);
});
test('preview-saved HTML cannot be fully overwritten',async t=>{
 const f=setup(t),session=f.designs.get(f.task.id);
 f.files.write(session,'index.html',Buffer.from('<html><body>Saved by user</body></html>'));
 session.userEdits=[{id:'edit-1',path:'index.html',revision:'abc',time:new Date().toISOString(),summary:'user save'}];f.designs.touch(session);f.designs.save();
 const attachments=new Attachments(f.store,f.vm as any,f.artifacts);
 let permissions=0;const interactions={permission:async()=>{permissions++;},pendingQuestions:()=>[],cancelQuestions:()=>{}};
 const host=new HostComputer({dataDir:f.store.dir,projectDir:f.root,homeDir:f.root},interactions as any);
 let step=0;const overwrite={complete:async()=>({content:'Overwrite',calls:step++===0?[{id:randomUUID(),type:'function',function:{name:'host_file_write',arguments:JSON.stringify({path:'index.html',content:'<html><body>All new</body></html>',reason:'replace'})}}]:[],finishReason:'stop'})};
 const shared=new Harness(f.store,f.vm as any,overwrite as any,()=>{},undefined,undefined,undefined,host,interactions as any,undefined,attachments);t.after(()=>{shared.disposeTools();host.dispose();});
 const context={observe:()=>{},prepare:async(input:any)=>({messages:[input.system,...input.history],maxOutputTokens:8192,stats:{calibration:1},calibrationEstimate:2000,recordUsage:()=>{}})};
 const loop=new DesignerLoop(f.store,f.designs,{} as any,f.files,overwrite as any,context as any,shared,f.artifacts,attachments,interactions as any,()=>{});
 await loop.run(f.bot.id,'Rewrite page',{designSessionId:session.id});
 assert.match(readFileSync(join(session.workspaceDir!,'index.html'),'utf8'),/Saved by user/);
 const run=f.store.data.runs.at(-1)!;assert.match([run.error||'',...f.store.data.messages.filter(m=>m.runId===run.id).map(m=>m.content)].join('\n'),/局部|整文件/);
 assert.equal(permissions,0);
});
test('legacy VM design tasks are kept intact and cannot silently execute on the host',t=>{const f=setup(t),legacy={...f.task,location:undefined,workspaceDir:undefined,workspacePath:'design-projects/'+f.task.id};assert.throws(()=>f.files.absolute(legacy,'index.html'),/旧版 VM/);assert.equal(f.task.location,'host');assert.equal(f.vmCalls(),0);});

for(const kind of ['prototype','ppt','clone','mobile','document'] as const)test('real tool pipeline publishes '+kind+' and opens its preview',async t=>{
 const f=setup(t),session=f.designs.get(f.task.id);session.kind=kind;
 const paths=kind==='ppt'?['deck.pptx','deck.html']:['index.html'];
 if(kind==='ppt'){const deck=designerDeck('Local slides',[{title:'Editable content'}]);f.files.write(session,'deck.pptx',deck.pptx);f.files.write(session,'deck.html',deck.html);}
 else f.files.write(session,'index.html',Buffer.from('<html><body>Ready</body></html>'));
 if(kind==='clone')f.files.write(session,'NOTES.md',Buffer.from('# Clone notes\n- 原站 URL: https://example.test/site\n- 不克隆登录与支付\n'));
 const attachments=new Attachments(f.store,f.vm as any,f.artifacts),previews=new AgentPreviews(f.store,f.artifacts,attachments,()=>{});let turn=0;
 const model={complete:async()=>({content:'Ready for review',calls:turn++===0?[{id:randomUUID(),type:'function',function:{name:'design_publish',arguments:JSON.stringify({paths})}}]:[],finishReason:'stop'})};
 const shared=new Harness(f.store,f.vm as any,model as any,()=>{},undefined,undefined,undefined,undefined,undefined,undefined,attachments);shared.setPreviewGateway(previews);t.after(()=>shared.disposeTools());
 const context={observe:()=>{},prepare:async(input:any)=>({messages:[input.system,...input.history],maxOutputTokens:8192,stats:{calibration:1},calibrationEstimate:2000,recordUsage:()=>{}})};
 const loop=new DesignerLoop(f.store,f.designs,{} as any,f.files,model as any,context as any,shared,f.artifacts,attachments,{pendingQuestions:()=>[]} as any,()=>{});
 await loop.run(f.bot.id,'Deliver the design',{designSessionId:session.id});
 const run=f.store.data.runs.at(-1)!;assert.equal(run.status,'completed',run.error||'Design run failed');assert.equal(f.designs.get(session.id).status,'review');assert.equal(run.attachments?.length,kind==='clone'?2:paths.length);assert.equal(previews.snapshot().length,1);assert.deepEqual(previews.snapshot()[0].target,{kind:'workspace',path:session.workspacePath+'/'+(kind==='ppt'?'deck.html':'index.html')});assert.ok(run.executions?.some(e=>e.tool==='open_preview'&&e.status==='succeeded'));assert.equal(f.vmCalls(),0);
});

test('clone publish requires a source URL in NOTES.md',async t=>{
 const f=setup(t),session=f.designs.get(f.task.id);session.kind='clone';
 f.files.write(session,'index.html',Buffer.from('<html><body>Replica</body></html>'));
 f.files.write(session,'NOTES.md',Buffer.from('# Clone\nNo source URL yet.\n'));
 const attachments=new Attachments(f.store,f.vm as any,f.artifacts);let turn=0;
 const model={complete:async()=>({content:'Trying to publish',calls:turn++===0?[{id:randomUUID(),type:'function',function:{name:'design_publish',arguments:JSON.stringify({paths:['index.html']})}}]:[],finishReason:'stop'})};
 const shared=new Harness(f.store,f.vm as any,model as any,()=>{},undefined,undefined,undefined,undefined,undefined,undefined,attachments);t.after(()=>shared.disposeTools());
 const context={observe:()=>{},prepare:async(input:any)=>({messages:[input.system,...input.history],maxOutputTokens:8192,stats:{calibration:1},calibrationEstimate:2000,recordUsage:()=>{}})};
 const loop=new DesignerLoop(f.store,f.designs,{} as any,f.files,model as any,context as any,shared,f.artifacts,attachments,{pendingQuestions:()=>[]} as any,()=>{});
 await loop.run(f.bot.id,'Deliver',{designSessionId:session.id});
 assert.match([f.store.data.runs.at(-1)?.error||'',...f.store.data.messages.filter(m=>m.runId===f.store.data.runs.at(-1)?.id).map(m=>m.content)].join('\n'),/来源网址/);
});
test('designer creates a substantial new file through the real host service without hash or shell fallback',async t=>{
 const f=setup(t),content='<html><body><main>'+('Design content. '.repeat(700))+'</main></body></html>',attachments=new Attachments(f.store,f.vm as any,f.artifacts);
 let permissions=0;const interactions={permission:async()=>{permissions++;},pendingQuestions:()=>[],cancelQuestions:()=>{}};
 const host=new HostComputer({dataDir:f.store.dir,projectDir:f.root,homeDir:f.root},interactions as any);let turn=0;
 const model={complete:async()=>({content:'File delivered',calls:turn++===0?[{id:randomUUID(),type:'function',function:{name:'design_file_create',arguments:JSON.stringify({path:'index.html',content,reason:'Create requested prototype'})}}]:turn===2?[{id:randomUUID(),type:'function',function:{name:'design_publish',arguments:JSON.stringify({paths:['index.html']})}}]:[],finishReason:'stop'})};
 const shared=new Harness(f.store,f.vm as any,model as any,()=>{},undefined,undefined,undefined,host,interactions as any,undefined,attachments);const previews=new AgentPreviews(f.store,f.artifacts,attachments,()=>{},host);shared.setPreviewGateway(previews);t.after(()=>{shared.disposeTools();host.dispose();});
 const context={observe:()=>{},prepare:async(input:any)=>({messages:[input.system,...input.history],maxOutputTokens:8192,stats:{calibration:1},calibrationEstimate:2000,recordUsage:()=>{}})};
 const loop=new DesignerLoop(f.store,f.designs,{} as any,f.files,model as any,context as any,shared,f.artifacts,attachments,interactions as any,()=>{});
 await loop.run(f.bot.id,'Create page',{designSessionId:f.task.id});const run=f.store.data.runs.at(-1)!;assert.equal(run.status,'completed',run.error||'Run failed');assert.equal(readFileSync(join(f.task.workspaceDir!,'index.html'),'utf8'),content);assert.equal(previews.snapshot().length,1);assert.equal(permissions,1);assert.ok(!run.executions?.some(e=>e.tool==='host_execute'));assert.equal(f.vmCalls(),0);
 await assert.rejects(host.writeFile(f.bot.id,run.id,{path:'index.html',content:'overwrite',reason:'test'},new AbortController().signal,f.task.workspaceDir),/文件已存在/);assert.equal(readFileSync(join(f.task.workspaceDir!,'index.html'),'utf8'),content);
 await assert.rejects(host.writeFile(f.bot.id,run.id,{path:'new.html',content:'new',reason:'test',expectedSha256:'0'.repeat(64)},new AbortController().signal,f.task.workspaceDir),/新建文件请省略/);assert.equal(existsSync(join(f.task.workspaceDir!,'new.html')),false);
});

test('design_image writes into assets after permission and fails without image bytes',async t=>{
 const f=setup(t),session=f.designs.get(f.task.id),attachments=new Attachments(f.store,f.vm as any,f.artifacts);
 f.files.write(session,'index.html',Buffer.from('<html><body><h1 data-design-id="hero">Hero</h1></body></html>'));
 let permissions=0;const interactions={permission:async()=>{permissions++;},pendingQuestions:()=>[],cancelQuestions:()=>{}};
 const host=new HostComputer({dataDir:f.store.dir,projectDir:f.root,homeDir:f.root},interactions as any);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
 let turn=0;
 const model={complete:async(_messages:any,tools:any)=>!tools?.length?{content:'',calls:[],finishReason:'stop',native:{protocol:'responses',key:'k',data:[{type:'image_generation_call',result:png.toString('base64')}]}}:{content:turn?'Ready':'Saving',calls:turn++===0?[{id:randomUUID(),type:'function',function:{name:'design_image',arguments:JSON.stringify({prompt:'A red mark',reason:'Hero art',filename:'hero.png'})}}]:turn===2?[{id:randomUUID(),type:'function',function:{name:'design_publish',arguments:JSON.stringify({paths:['index.html']})}}]:[],finishReason:'stop'}};
 const shared=new Harness(f.store,f.vm as any,model as any,()=>{},undefined,undefined,undefined,host,interactions as any,undefined,attachments);t.after(()=>{shared.disposeTools();host.dispose();});
 const context={observe:()=>{},prepare:async(input:any)=>({messages:[input.system,...input.history],maxOutputTokens:8192,stats:{calibration:1},calibrationEstimate:2000,recordUsage:()=>{}})};
 const loop=new DesignerLoop(f.store,f.designs,{} as any,f.files,model as any,context as any,shared,f.artifacts,attachments,interactions as any,()=>{});
 await loop.run(f.bot.id,'Need a hero image',{designSessionId:session.id});
 const run=f.store.data.runs.at(-1)!;assert.equal(run.status,'completed',run.error||'image run failed');
 assert.equal(permissions,1);assert.ok(existsSync(join(session.workspaceDir!,'assets','hero.png')));
 assert.equal(readFileSync(join(session.workspaceDir!,'assets','hero.png')).equals(png),true);
 let failTurn=0;const failing={complete:async(_m:any,tools:any)=>!tools?.length?{content:'no image',calls:[],finishReason:'stop'}:{content:'Trying',calls:failTurn++===0?[{id:randomUUID(),type:'function',function:{name:'design_image',arguments:JSON.stringify({prompt:'x',reason:'art'})}}]:[],finishReason:'stop'}};
 const failLoop=new DesignerLoop(f.store,f.designs,{} as any,f.files,failing as any,context as any,shared,f.artifacts,attachments,interactions as any,()=>{});
 await failLoop.run(f.bot.id,'Need another image',{designSessionId:session.id});
 assert.match([f.store.data.runs.at(-1)?.error||'',...f.store.data.messages.filter(m=>m.runId===f.store.data.runs.at(-1)?.id).map(m=>m.content)].join('\n'),/生图未返回|假装/);
});

test('design_export_pdf writes a real PDF beside the HTML preview',async t=>{
 const f=setup(t),session=f.designs.get(f.task.id);
 f.files.write(session,'index.html',Buffer.from('<html><body><h1>Print me</h1></body></html>'));
 const attachments=new Attachments(f.store,f.vm as any,f.artifacts);
 let permissions=0;const interactions={permission:async()=>{permissions++;},pendingQuestions:()=>[],cancelQuestions:()=>{}};
 const host=new HostComputer({dataDir:f.store.dir,projectDir:f.root,homeDir:f.root},interactions as any);
 let turn=0;
 const model={complete:async()=>({content:turn?'Ready':'Exporting',calls:turn++===0?[{id:randomUUID(),type:'function',function:{name:'design_export_pdf',arguments:JSON.stringify({path:'index.html',reason:'Share a PDF'})}}]:turn===2?[{id:randomUUID(),type:'function',function:{name:'design_publish',arguments:JSON.stringify({paths:['index.html','index.pdf']})}}]:[],finishReason:'stop'})};
 const shared=new Harness(f.store,f.vm as any,model as any,()=>{},undefined,undefined,undefined,host,interactions as any,undefined,attachments);t.after(()=>{shared.disposeTools();host.dispose();});
 const context={observe:()=>{},prepare:async(input:any)=>({messages:[input.system,...input.history],maxOutputTokens:8192,stats:{calibration:1},calibrationEstimate:2000,recordUsage:()=>{}})};
 const pdf=Buffer.from('%PDF-1.4\n%fixture\n');
 const loop=new DesignerLoop(f.store,f.designs,{} as any,f.files,model as any,context as any,shared,f.artifacts,attachments,interactions as any,()=>{},{pdf:{render:async()=>pdf}});
 await loop.run(f.bot.id,'Export pdf',{designSessionId:session.id});
 const run=f.store.data.runs.at(-1)!;assert.equal(run.status,'completed',run.error||'pdf run failed');
 assert.equal(permissions,1);assert.equal(readFileSync(join(session.workspaceDir!,'index.pdf')).subarray(0,5).toString(),'%PDF-');
 assert.ok(f.designs.get(session.id).artifacts.some(a=>a.kind==='pdf'));
});

