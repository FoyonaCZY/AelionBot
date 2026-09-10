import {normalizeUserProfile} from '../src/user-profile';
import {createMacUpdater,macAutomaticUpdates} from './core/mac-updater';
import {hostEnvironment} from './core/host-platform';
import {RunPolicy,runtimeSettings} from './core/runtime-policy';
import { app, BrowserWindow, ipcMain, safeStorage, dialog, shell, Menu, nativeImage, net } from 'electron';
import { randomUUID } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Store } from './core/store';
import {updateBotProfile} from './core/bot-profile';
import { VmController, shQuote } from './core/vm';
import { ModelClient, validateModelEndpoint } from './core/model';
import { ModelProviders } from './core/model-providers';
import { Harness, safeRelativePath } from './core/harness';
import { ComputerController } from './core/computer';
import { installComputerView } from './core/computer-view';
import {Attachments} from './core/attachments';
import {AttachmentDrops} from './core/attachment-drop';
import {readAttachmentClipboard} from './core/attachment-clipboard';
import { ArtifactService } from './core/artifacts';
import { Integrations } from './core/integrations';
import { Interactions,respondToInteraction,changeManualControl } from './core/interactions';
import { HostComputer,redactHost } from './core/host';
import {HostApprovals,defaultPermissionReviewer,defaultApprovalModel} from './core/host-approvals';
import { CommandPermissions } from './core/command-permissions';
import { Cognition } from './core/cognition';
import { PeerChats } from './core/peer-chats';
import {GroupChats} from './core/group-chats';
import {ChatPinQueue} from './core/chat-pins';
import {TaskScheduler} from './core/task-scheduler';
import {groupPending} from '../src/group-types';
import {peerPending} from '../src/peer-types';
import { BotGreetings } from './core/bot-greetings';
import {AppUpdates} from './core/app-updates';
import {Diagnostics} from './core/diagnostics';
import {availableParallelism,release as osRelease,totalmem} from 'node:os';
import {writeFile} from 'node:fs/promises';
import {createWindowsUpdater,UPDATE_REPOSITORY} from './core/windows-updater';
import {assertUpdateDataOutsideApp,loadUpdateLaunchContext,saveUpdateLaunchContext,type UpdateLaunchContext} from './core/update-launch-context';
import {WorkItems} from './core/work-items';
import {assertWorkspaceScope,conversationWorkspace,setConversationWorkspace} from './core/workspaces';
import {resumableRun} from './core/resume-run';
import type { Snapshot } from '../src/shared';
import {externalWebUrl} from '../src/external-links';
import {usageReport} from './core/usage-report';
import {reasoningEffort as cleanReasoning} from '../src/reasoning';
import {Shutdown} from './core/shutdown';

let window:BrowserWindow|undefined;
let vm:VmController;
let store:Store;
let harness:Harness;
let model:ModelClient;
let providers:ModelProviders;
let computer:ComputerController;
let artifacts:ArtifactService;
let attachments:Attachments;
let integrations:Integrations;
let interactions:Interactions;
let host:HostComputer;
let commandPermissions:CommandPermissions;
let hostApprovals:HostApprovals;
let cognition:Cognition;
let peerChats:PeerChats|undefined;
let groupChats:GroupChats|undefined;
let chatPins:ChatPinQueue|undefined;
let scheduler:TaskScheduler|undefined;
let greetings:BotGreetings|undefined;
let appUpdates:AppUpdates|undefined;
let diagnostics:Diagnostics|undefined;
process.on('uncaughtExceptionMonitor',(error,origin)=>diagnostics?.record('process.'+origin,error));
let updatePreparing=false;
let timer:NodeJS.Timeout|undefined;
let polling=false;
let exiting=false;
if(!app.requestSingleInstanceLock()){app.quit();}
else {
  app.on('second-instance',()=>{window?.show();window?.focus();});
  app.whenReady().then(initialize).catch(error=>{diagnostics?.record('app.startup-error',error);console.error(error);dialog.showErrorBox('AelionBot 启动失败',String(error.message));app.exit(1);});
}
function snapshot():Snapshot{return {userProfile:store.data.userProfile,platform:process.platform,workItems:store.data.workItems,conversationWorkspaces:store.data.conversationWorkspaces,updates:appUpdates?.snapshot(),scheduledTasks:store.data.scheduledTasks,bots:store.data.bots,messages:store.data.messages,runs:store.data.runs,model:providers.config(),providers:providers.list(),defaultModel:store.data.defaultModel,botModels:Object.fromEntries(store.data.bots.map(bot=>[bot.id,providers.config(bot.id)])),vm:vm.state,skills:integrations?integrations.skills.all():store.data.skills,artifacts:store.data.artifacts,computer:computer.state,dataDir:store.dir,integrations:integrations?.snapshot(),interactions:interactions?.snapshot()||[],cognition:cognition?.view(),peers:peerChats?.snapshot(),groups:groupChats?.snapshot(),greetingBotIds:greetings?.botIds||[],streamingReplies:[...(harness?.streams.snapshot()||[]),...(greetings?.streams.snapshot()||[])],runtime:store?new RunPolicy(store).settings():undefined,modelUsage:store?.data.modelUsage?.slice(-100),commandPermissions:commandPermissions?.list()||[],hostPermissionModes:hostApprovals?.modes(),hostWorkspace:host?.workspaceSettings()};}
function changed(){if(exiting)return;if(window&&!window.isDestroyed())window.webContents.send('app:event',{type:'state',snapshot:snapshot()});chatPins?.wake();peerChats?.wake();groupChats?.wake();}
function handle(channel:string,callback:(...args:any[])=>unknown){
  ipcMain.handle(channel,async(event,...args)=>{
    if(!window||event.sender.id!==window.webContents.id||event.senderFrame!==window.webContents.mainFrame)throw new Error('不受信任的调用来源');
    if(updatePreparing&&!['app:snapshot','updates:state','updates:open-release','window:dimmed'].includes(channel))throw new Error('正在准备安装更新，请稍候');
    try{return await callback(...args);}catch(error){diagnostics?.record('ipc.'+channel,error);throw error;}
  });
}
function beforeModelChange(botIds:string[]){
  const busy=botIds.find(id=>updatePreparing||harness.isRunning(id));
  if(busy)throw new Error(`请等待 ${store.bot(busy).name} 的当前任务结束后修改模型`);
  cognition.learning.preempt();for(const id of botIds)greetings?.cancel(id);
}
function afterModelChange(){changed();chatPins?.wake();cognition.learning.schedule();void greetings?.greetEmpty();}
async function initialize(){
  app.setAppUserModelId('com.aelion.bot');Menu.setApplicationMenu(process.platform==='darwin'?Menu.buildFromTemplate([{role:'appMenu'},{role:'editMenu'},{role:'viewMenu'},{role:'windowMenu'}]):null);if(process.platform==='darwin')process.env.PATH=hostEnvironment().PATH;
  const profileDir=app.getPath('userData');
  let launchContext:UpdateLaunchContext|undefined;
  try{launchContext=loadUpdateLaunchContext(profileDir,process.execPath);}catch(error){if(!process.env.AELION_DATA_DIR)throw error;}
  const savedLaunch=process.env.AELION_DATA_DIR?undefined:launchContext;
  const dataDir=process.env.AELION_DATA_DIR?resolve(process.env.AELION_DATA_DIR):savedLaunch?.dataDir||(app.isPackaged?profileDir:resolve('.local/app'));
  const projectDir=resolve(process.env.AELION_PROJECT_DIR||savedLaunch?.projectDir||process.cwd());
  mkdirSync(dataDir,{recursive:true});store=new Store(dataDir,{incremental:true});
  providers=new ModelProviders(store,{encrypt:value=>{if(!safeStorage.isEncryptionAvailable())throw new Error('系统加密存储不可用，尚未保存 API Key');return safeStorage.encryptString(value).toString('base64');},decrypt:value=>safeStorage.decryptString(Buffer.from(value,'base64'))},changed);
  commandPermissions=new CommandPermissions(join(dataDir,'command-permissions.json'),value=>host?.redact(value)??redactHost(value));
  interactions=new Interactions(()=>{changed();if(window&&!window.isDestroyed()&&!window.isFocused()&&interactions.snapshot().some(request=>request.kind==='host_permission'?request.approval?.phase!=='reviewing':request.phase==='waiting'))window.flashFrame(true);},(request,decision,ruleId)=>store.journal('interaction.decision',{id:request.id,botId:request.botId,runId:request.runId,kind:request.kind,decision,...(request.kind==='host_permission'&&request.approval?{approval:request.approval}:{}),...(ruleId?{ruleId}:{}),time:new Date().toISOString()}),commandPermissions);
  vm=new VmController({dataDir,wallpaperPath:join(app.getAppPath(),'assets','wallpaper-light.png'),runtimeDir:app.isPackaged?join(process.resourcesPath,'qemu'):resolve('runtime/qemu'),cacheDir:app.isPackaged?join(dataDir,'downloads'):resolve('runtime/downloads'),downloadFetch:(url,options)=>net.fetch(url,options)});
  computer=new ComputerController(vm,dataDir,changed);artifacts=new ArtifactService(store,vm);
  const imagePreview=(bytes:Buffer,id:string)=>{const image=nativeImage.createFromBuffer(bytes);if(image.isEmpty())return;const {width,height}=image.getSize();if(width*height>64*1024*1024)return;const scale=Math.min(1,2048/width,2048/height),preview=scale<1?image.resize({width:Math.max(1,Math.round(width*scale)),height:Math.max(1,Math.round(height*scale)),quality:'best'}):image;writeFileSync(join(computer.imageDir,id+'.png'),preview.toPNG());return {id,...preview.getSize()};};
  attachments=new Attachments(store,vm,artifacts,imagePreview);
  const homeDir=app.getPath('home');
  const configDir=resolve(process.env.AELION_CONFIG_HOME||savedLaunch?.configDir||join(homeDir,'.aelion'));
  diagnostics=new Diagnostics({dataDir,snapshot,paths:()=>[dataDir,profileDir,homeDir,projectDir,configDir,app.getAppPath(),...Object.values(store.data.conversationWorkspaces||{})],secrets:()=>{let keys:string[]=[];try{keys=providers.secrets();}catch{}return [...keys,...Object.entries(process.env).filter(([name])=>/TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL|AUTH/i.test(name)).map(([,value])=>value||'')];},environment:{appVersion:app.getVersion(),platform:process.platform,arch:process.arch,osRelease:osRelease(),electron:process.versions.electron,chrome:process.versions.chrome,node:process.versions.node,packaged:app.isPackaged,cpuCount:availableParallelism(),memoryGiB:Math.round(totalmem()/1024**3)}});
  diagnostics.record('app.started',`AelionBot ${app.getVersion()} (${process.platform} ${process.arch})`);
  host=new HostComputer({imagePreview,dataDir,homeDir,projectDir,runtimeDir:__dirname,env:{...process.env},secrets:()=>providers.secrets()},interactions);
  integrations=new Integrations(store,{homeDir,projectDir,dataDir,configDir,env:{...process.env}},changed,(data,mime)=>{
    if(!['image/png','image/jpeg','image/webp'].includes(mime)||typeof data!=='string'||data.length>12*1024*1024)throw new Error('MCP 图像类型或大小不受支持');
    const img=nativeImage.createFromDataURL(`data:${mime};base64,${data}`);const size=img.getSize();
    if(img.isEmpty()||size.width*size.height>16*1024*1024)throw new Error('MCP 图像不可读或过大');
    const id=randomUUID();writeFileSync(join(computer.imageDir,`${id}.png`),img.toPNG());return {id,width:size.width,height:size.height};
  });
  await integrations.refresh();
  model=new ModelClient(botId=>providers.config(botId),botId=>providers.key(botId),id=>computer.image(id),()=>new RunPolicy(store).settings(),record=>{record.runId||=store.data.runs.find(run=>run.botId===record.botId&&run.status==='running')?.id;(store.data.modelUsage||=[]).push(record);store.journal('model.usage',record);store.save();});
  const approvalModel=defaultApprovalModel(providers,()=>new RunPolicy(store).settings(),record=>{(store.data.modelUsage||=[]).push(record);store.journal('model.usage',record);store.save();});
  hostApprovals=new HostApprovals(store,commandPermissions,defaultPermissionReviewer(approvalModel,()=>providers.config(),text=>host.redact(text)),{homeDir,defaultModel:()=>providers.config()});interactions.setHostPolicy(hostApprovals);
  cognition=new Cognition(store,model,integrations.skills,changed,()=>Boolean(updatePreparing||harness?.busy||groupChats?.busy),()=>providers.secrets());
  harness=new Harness(store,vm,model,changed,computer,(botId,runId)=>artifacts.collect(botId,runId),integrations,host,interactions,cognition,attachments);
  greetings=new BotGreetings(store,model,changed,id=>updatePreparing||harness.isRunning(id));
  peerChats=new PeerChats(store,{isRunning:id=>updatePreparing||harness.isRunning(id)||Boolean(chatPins?.hasPending(id)),run:(id,input,options)=>{groupChats?.preempt(id);greetings?.cancel(id);return harness.run(id,input,options);},cancel:id=>harness.cancel(id)},changed,attachments);
  harness.setPeerGateway(peerChats);peerChats.start();
  groupChats=new GroupChats(store,{isRunning:id=>updatePreparing||harness.isRunning(id)||Boolean(chatPins?.hasPending(id)),run:(id,input,options)=>{greetings?.cancel(id);return harness.run(id,input,options);},cancel:id=>harness.cancel(id),refresh:id=>harness.refreshGroup(id)},changed,attachments);
  chatPins=new ChatPinQueue(store,{isRunning:id=>updatePreparing||harness.isRunning(id),run:(id,input,options)=>{greetings?.cancel(id);return harness.run(id,input,options);},refresh:id=>{greetings?.cancel(id);const active=store.data.runs.find(run=>run.botId===id&&run.status==='running');groupChats?.yieldToUser(id);if(active)peerChats?.cancelRun(active);return harness.refreshInput(id);}},changed,attachments);chatPins.wake();
  harness.setGroupGateway(groupChats);groupChats.start();
  scheduler=new TaskScheduler(store,{
    ready:target=>{
      if(updatePreparing)return false;
      const ids=target.kind==='bot'?[target.id]:store.data.groups.find(room=>room.id===target.id)?.members.filter(member=>!member.leftAt).map(member=>member.id)||[];
      return ids.length>0&&ids.every(id=>store.data.bots.some(bot=>bot.id===id)&&store.modelFor(id).model&&!store.modelFor(id).issue&&!harness.isRunning(id)&&!chatPins?.hasPending(id))&&!(target.kind==='group'&&store.data.groupDeliveries.some(delivery=>delivery.groupId===target.id&&groupPending(delivery.status)));
    },
    send:(target,prompt,trigger)=>{if(target.kind==='bot')chatPins!.schedule(target.id,prompt,trigger);else groupChats!.schedule(target.id,prompt,trigger);}
  },changed);harness.setTaskScheduler(scheduler);
  let pendingLaunch:UpdateLaunchContext|undefined;
  const updateBlocked=()=>{
    if(updatePreparing)return '正在准备安装更新。';
    if(harness.busy||groupChats?.busy||store.data.peerExchanges.some(exchange=>peerPending(exchange.status))||greetings?.botIds.length||store.data.bots.some(bot=>chatPins?.hasPending(bot.id))||store.data.groupDeliveries.some(delivery=>groupPending(delivery.status)))return '请先结束当前 Bot 任务，再重启更新。';
    if(interactions.snapshot().length||Object.values(computer.state.desktops).some(desktop=>desktop.manualControl))return '请先交还工作电脑并结束待处理操作。';
    if(vm.state.maintenance||['preparing','starting','stopping'].includes(vm.state.status))return '工作电脑正在准备或维护，请稍后更新。';
  };
  appUpdates=new AppUpdates(process.platform==='darwin'?createMacUpdater(macAutomaticUpdates(process.resourcesPath)):createWindowsUpdater(process.execPath),app.getVersion(),UPDATE_REPOSITORY,['win32','darwin'].includes(process.platform)&&app.isPackaged,{
    blockedReason:updateBlocked,
    prepareInstall:async version=>{
      const blocked=updateBlocked();if(blocked)throw new Error(blocked);
      assertUpdateDataOutsideApp(dataDir,dirname(process.execPath));assertUpdateDataOutsideApp(profileDir,dirname(process.execPath));
      updatePreparing=true;changed();cognition.learning.preempt();const resumeComputer=Boolean(vm.state.pid);
      try{await vm.stop();pendingLaunch={version:1,executable:process.execPath,dataDir,projectDir,configDir,resumeComputer,targetVersion:version};saveUpdateLaunchContext(profileDir,pendingLaunch);store.save();}
      catch{updatePreparing=false;changed();cognition.learning.schedule();throw new Error('无法安全关闭工作电脑，请先在电脑设置中关闭后再更新。');}
    },
    recoverInstall:async()=>{updatePreparing=false;if(pendingLaunch){const resume=pendingLaunch.resumeComputer;saveUpdateLaunchContext(profileDir,{...pendingLaunch,resumeComputer:false});pendingLaunch=undefined;if(resume)await vm.start().catch(()=>{});}changed();cognition.learning.schedule();}
  },changed);
  cognition.start();
  window=new BrowserWindow({width:1420,height:920,minWidth:980,minHeight:650,title:'AelionBot',icon:join(app.getAppPath(),'assets',process.platform==='win32'?'icon.ico':'icon.png'),backgroundColor:'#ffffff',show:false,titleBarStyle:process.platform==='darwin'?'hiddenInset':'hidden',...(process.platform==='darwin'?{trafficLightPosition:{x:18,y:18}}:{titleBarOverlay:{color:'#f7f7f7',symbolColor:'#555555',height:38}}),webPreferences:{preload:join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  installComputerView(window);
  window.on('unresponsive',()=>diagnostics?.record('renderer.unresponsive','页面未响应'));
  window.webContents.on('render-process-gone',(_event,details)=>diagnostics?.record('renderer.gone',`${details.reason}; exitCode=${details.exitCode}`));
  window.webContents.on('did-fail-load',(_event,code,description)=>diagnostics?.record('renderer.load',`${code}: ${description}`));
  window.webContents.on('console-message',details=>{if(['warning','error'].includes(details.level)&&details.frame===window?.webContents.mainFrame)diagnostics?.record('renderer.'+details.level,`${details.message}\nLine ${details.lineNumber}`);});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{if(url!==window?.webContents.getURL())event.preventDefault();});
  // Keep display zoom available even with the application menu disabled.
  const contents=window.webContents;
  contents.on('before-input-event',(event,input)=>{
    if(input.type!=='keyDown'||!input.control||input.alt||input.meta||input.isComposing)return;
    const zoomIn=input.key==='+'||input.key==='='||input.code==='NumpadAdd';
    const zoomOut=input.key==='-'||input.key==='_'||input.code==='NumpadSubtract';
    const reset=!input.shift&&(input.key==='0'||input.code==='Numpad0');
    if(!zoomIn&&!zoomOut&&!reset)return;
    event.preventDefault();
    const percent=reset?100:Math.round(contents.getZoomFactor()*100)+(zoomIn?10:-10);
    contents.setZoomFactor(Math.max(50,Math.min(200,percent))/100);
  });
  handle('profile:save',value=>{store.data.userProfile=normalizeUserProfile(value);store.save();greetings?.cancelAll();changed();void greetings?.greetEmpty();});
  handle('runtime:save',value=>{store.data.runtime=runtimeSettings(value);store.save();changed();});
  handle('app:snapshot',snapshot);
  handle('usage:query',input=>usageReport(store.data.modelUsage||[],providers.list(),input));
  handle('app:open-external-url',value=>{const url=externalWebUrl(value);if(!url)throw new Error('只能在浏览器中打开有效的 HTTP 或 HTTPS 链接');return shell.openExternal(url);});
  handle('updates:state',()=>appUpdates!.snapshot());
  handle('updates:check',()=>appUpdates!.check());
  handle('updates:download',()=>appUpdates!.download());
  handle('updates:cancel',()=>appUpdates!.cancel());
  handle('updates:install',()=>appUpdates!.install());
  handle('updates:open-release',()=>shell.openExternal(`https://github.com/${UPDATE_REPOSITORY}/releases/latest`));
  handle('diagnostics:prepare',()=>diagnostics!.prepare());
  handle('diagnostics:export',async id=>{
    const report=diagnostics!.archive(id),target=await dialog.showSaveDialog(window!,{title:'导出诊断日志',defaultPath:join(app.getPath('downloads'),report.fileName),filters:[{name:'诊断包',extensions:['zip']}]});
    if(target.canceled||!target.filePath)return null;
    await writeFile(target.filePath,report.bytes,{mode:0o600});return target.filePath;
  });
  handle('diagnostics:issue',id=>shell.openExternal(diagnostics!.issueUrl(id,UPDATE_REPOSITORY)));
  handle('tasks:create',input=>scheduler!.create(input));
  handle('tasks:update',input=>scheduler!.update(input));
  handle('tasks:delete',id=>scheduler!.remove(String(id)));
  handle('tasks:run',id=>scheduler!.runNow(String(id)));
  handle('interaction:respond',async input=>{if(input?.action==='takeover'){const request=interactions.get(String(input.id));if(request.kind==='vm_takeover')await computer.ensure(request.botId);}return respondToInteraction(interactions,computer,input);});
  handle('window:dimmed',(enabled,color)=>{if(typeof enabled!=='boolean'||color!==undefined&&(typeof color!=='string'||!/^#[a-f0-9]{6}$/i.test(color)))throw new Error('无效窗口状态');const background=color||(enabled?'#b9b9b9':'#f7f7f7'),brightness=[1,3,5].reduce((sum,index)=>sum+parseInt(background.slice(index,index+2),16),0)/3;if(process.platform!=='darwin')window?.setTitleBarOverlay({color:background,symbolColor:brightness<128?'#f2f2f2':'#555555',height:38});});
  handle('permissions:mode',input=>{if(hostApprovals.set(input?.scope,input?.mode))interactions.refreshHostPolicy();changed();});
  handle('permissions:command-enabled',input=>{if(typeof input?.id!=='string'||typeof input.enabled!=='boolean')throw new Error('无效命令权限参数');commandPermissions.setEnabled(input.id,input.enabled);interactions.applyCommandRules();changed();});
  handle('permissions:command-remove',id=>{if(typeof id!=='string')throw new Error('无效命令模式');commandPermissions.remove(id);changed();});
  handle('workspace:pick',async scope=>{assertWorkspaceScope(store,scope);const selected=await dialog.showOpenDialog(window!,{title:'选择会话工作目录',defaultPath:conversationWorkspace(store,scope)||host.workspaceSettings().workspaceDir,properties:['openDirectory']});if(selected.canceled||!selected.filePaths[0])return null;const path=setConversationWorkspace(store,host,scope,selected.filePaths[0]);changed();return path;});
  handle('workspace:reset',scope=>{setConversationWorkspace(store,host,scope,null);changed();});
  handle('work:action',input=>{
    const work=new WorkItems(store),existing=work.get(input?.id);
    if(input?.action==='start'){
      if(harness.isRunning(existing.botId)||chatPins?.hasPending(existing.botId))throw Error('Bot 正在处理消息，请先暂停当前任务或稍后继续');
      if(!store.modelFor(existing.botId).model)throw Error('请先为 Bot 选择模型');
    }
    const item=work.action(input);
    if(input.action!=='start'){
      if(item.activeRunId&&harness.isRunning(item.botId)){const run=store.data.runs.find(r=>r.id===item.activeRunId);if(run){peerChats?.cancelRun(run);groupChats?.cancelRun(run);}harness.cancel(item.botId);}
      changed();return;
    }
    if(item.scope.kind==='group'){groupChats!.startWork(item);changed();return;}
    greetings?.cancel(item.botId);groupChats?.yieldToUser(item.botId);
    void harness.run(item.botId,'用户已点击'+(item.kind==='plan'?'执行计划':'继续目标')+'。沿用已保存步骤和执行记录：'+item.objective,{workItemId:item.id,workspaceDir:item.workspaceDir}).catch(error=>{item.status='blocked';item.reason=(error as Error).message;delete item.activeRunId;store.save();changed();});changed();
  });
  handle('host:workspace-save',path=>{if(harness.busy)throw new Error('请等待当前任务结束后修改默认工作目录');if(typeof path!=='string')throw new Error('无效工作目录');host.setWorkspaceDir(path);changed();});
  handle('host:workspace-pick',async()=>{const selected=await dialog.showOpenDialog(window!,{title:'选择本机默认工作目录',defaultPath:host.workspaceSettings().workspaceDir,properties:['openDirectory']});return selected.canceled?null:selected.filePaths[0]||null;});
  handle('integrations:refresh',async()=>{if(harness.busy)throw new Error('请等待当前任务结束后重新扫描');await integrations.refresh();});
  handle('skills:manage',input=>{if(harness.busy)throw Error('请等待当前任务结束');const result=integrations.skills.manage(String(input?.botId),String(input?.id),String(input?.action),input?.revision);changed();return result;});
  handle('skills:read',input=>integrations.skills.read(String(input?.botId),String(input?.id)));
  handle('integrations:open-path',async input=>{const target=integrations.path(input||{});const result=await shell.openPath(target);if(result)throw new Error(result);});
  handle('integrations:add-source',async kind=>{
    if(!['skills','mcp'].includes(kind))throw new Error('未知配置类型');if(harness.busy)throw new Error('请等待当前任务结束');
    const selected=await dialog.showOpenDialog(window!,{title:kind==='skills'?'添加共享技能目录':'添加已有 MCP 配置',properties:kind==='skills'?['openDirectory']:['openFile'],...(kind==='mcp'?{filters:[{name:'Agent 配置',extensions:['json','jsonc','toml','yaml','yml']}]}:{})});
    if(!selected.canceled&&selected.filePaths[0]){await integrations.add(kind,selected.filePaths[0]);changed();}
  });
  handle('mcp:enabled',async input=>{if(harness.busy)throw new Error('请等待当前任务结束后修改 MCP');if(typeof input?.enabled!=='boolean')throw new Error('无效状态');await integrations.setEnabled(String(input.id),input.enabled);});
  handle('mcp:test',async id=>{const result=await integrations.mcp.listTools(String(id));return {tools:result.tools.map(tool=>tool.name)};});
  handle('bot:create',(input)=>{if(!input||typeof input.name!=='string'||typeof input.role!=='string'||input.color!==undefined&&typeof input.color!=='string')throw new Error('无效 Bot 参数');const model=input.model?providers.selection(input.model):undefined,reasoningEffort=cleanReasoning(input.reasoningEffort===undefined?store.data.defaultModel?.reasoningEffort:input.reasoningEffort);const bot=store.createBot(input.name,input.role,input.color,input.avatarStyle,{model,reasoningEffort});changed();void greetings?.greet(bot.id);return bot;});
  handle('bot:delete',async(id)=>{
    if(typeof id!=='string')throw new Error('无效 Bot 参数');
    if(harness.isRunning(id))throw new Error('请先停止这个 Bot 的任务并等待结束，再删除');
    await harness.stopBotProcesses(id);greetings?.cancel(id);chatPins?.cancel(id);peerChats?.deletingBot(id);groupChats?.deletingBot(id);store.deleteBot(id);integrations.skills.forgetBot(id);scheduler?.removeTarget({kind:'bot',id});cognition.deleteBot(id);computer.forget(id);changed();
  });
  handle('bot:update',input=>{
    const modelChanged=updateBotProfile(store,providers,input,id=>beforeModelChange([id]));
    if(modelChanged)afterModelChange();else {greetings?.cancel(input.id);changed();void greetings?.greet(input.id);}
  });
  handle('attachments:pick',async scope=>{attachments.scope(scope);const result=await dialog.showOpenDialog(window!,{title:'添加附件',properties:['openFile','multiSelections']});return result.canceled?[]:attachments.importPaths(scope,result.filePaths);});
  const attachmentDrops=new AttachmentDrops(attachments,(scope,path)=>{const selected=setConversationWorkspace(store,host,scope,path);changed();return selected;});
  handle('attachments:drop-prepare',input=>attachmentDrops.prepare(input?.scope,input?.paths));
  handle('attachments:drop-apply',input=>attachmentDrops.apply(input?.scope,input?.ids,input?.action));
  handle('attachments:paste-prepare',async scope=>{attachments.scope(scope);const data=await readAttachmentClipboard();return {entries:data.paths.length?await attachmentDrops.prepare(scope,data.paths):[],attachments:data.files.length?attachments.importFiles(scope,data.files):[]};});
  handle('attachments:import',input=>attachments.importFiles(input?.scope,input?.files));
  handle('attachments:paste',async scope=>{attachments.scope(scope);const data=await readAttachmentClipboard();return data.paths.length?attachments.importPaths(scope,data.paths):data.files.length?attachments.importFiles(scope,data.files):[];});
  handle('attachments:preview',id=>attachments.previewRich(id));
  handle('attachments:save',async id=>{const file=attachments.metadata(id);const result=await dialog.showSaveDialog(window!,{defaultPath:file.name});if(result.canceled||!result.filePath)return null;writeFileSync(result.filePath,attachments.bytes(id));return result.filePath;});
  handle('chat:send',(input)=>{if(!input||typeof input.botId!=='string'||typeof input.message!=='string')throw new Error('无效消息');return chatPins!.send(input);});
  handle('chat:resume',input=>{if(typeof input?.botId!=='string'||typeof input.runId!=='string')throw Error('恢复任务参数无效');if(harness.isRunning(input.botId)||chatPins?.hasPending(input.botId))throw Error('Bot 正在处理消息，请稍后继续');const run=resumableRun(store,input.botId,input.runId);greetings?.cancel(input.botId);if(run.groupOrigin)groupChats!.retryRun(run);else if(run.peerOrigin)peerChats!.retryRun(run);else void harness.resume(input.botId,input.runId).catch(error=>{store.message(input.botId,'event',(error as Error).message);changed();});changed();});
  handle('chat:pin',input=>chatPins!.pin(input));
  handle('groups:pin',input=>groupChats!.pinUser(input));
  handle('chat:cancel',(id)=>{const botId=String(id);chatPins?.cancel(botId);const run=store.data.runs.find(run=>run.botId===botId&&run.status==='running');if(run){peerChats?.cancelRun(run);groupChats?.cancelRun(run);}harness.cancel(botId);});
  handle('peers:read',input=>peerChats!.read(input));
  handle('peers:cancel',id=>peerChats!.cancel(id));
  handle('groups:create',input=>groupChats!.create(input));
  handle('groups:update',input=>groupChats!.update(input));
  handle('groups:delete',id=>{groupChats!.delete(id);scheduler?.removeTarget({kind:'group',id});});
  handle('groups:read',input=>groupChats!.read(input));
  handle('groups:send',input=>{const room=store.data.groups.find(room=>room.id===input?.id);if(room&&!room.members.some(member=>!member.leftAt&&store.data.bots.some(bot=>bot.id===member.id)&&store.modelFor(member.id).model))throw new Error('请先为群内 Bot 选择模型');groupChats!.send(input);});
  handle('groups:read-mark',input=>groupChats!.markRead(input));
  handle('groups:stop',id=>groupChats!.stop(id));
  handle('groups:continue',id=>groupChats!.continue(id));
  handle('chat:tool-result',input=>store.readToolResult(String(input?.botId),String(input?.messageId)));
  handle('cognition:learning',enabled=>{if(typeof enabled!=='boolean')throw new Error('无效设置');cognition.learning.setEnabled(enabled);});
  handle('providers:save',async input=>{
    beforeModelChange(input?.id?providers.using(String(input.id)):[]);
    try{const provider=providers.save(input);return await providers.refresh(provider.id);}finally{afterModelChange();}
  });
  handle('providers:models',id=>providers.refresh(String(id)));
  handle('providers:remove',id=>{providers.remove(String(id));afterModelChange();});
  handle('models:default',selection=>{providers.selection(selection);beforeModelChange(store.data.bots.filter(bot=>!bot.model).map(bot=>bot.id));providers.setDefault(selection);afterModelChange();});
  handle('models:bot',input=>{const id=store.bot(String(input?.botId)).id;providers.selection(input?.selection);beforeModelChange([id]);providers.setBot(id,input.selection);afterModelChange();});
  handle('model:save',async(input)=>{
    const baseUrl=validateModelEndpoint(String(input?.baseUrl||''));const name=String(input?.model||'').trim();if(!name||name.length>150)throw new Error('请输入模型名称');
    const contextTokens=Number(input.contextTokens);if(!Number.isInteger(contextTokens)||contextTokens<8000||contextTokens>1000000)throw new Error('上下文容量应为 8000–1000000');
    const existing=providers.list().find(provider=>provider.id===store.data.defaultModel?.providerId);
    beforeModelChange([...new Set([...store.data.bots.filter(bot=>!bot.model).map(bot=>bot.id),...(existing?providers.using(existing.id):[])])]);
    try{const provider=providers.save({id:existing?.id,name:existing?.name||`默认 Provider ${providers.list().length+1}`,baseUrl,apiKey:input.apiKey});providers.setDefault({providerId:provider.id,model:name,contextTokens});await providers.refresh(provider.id);}finally{afterModelChange();}
  });
  handle('model:test',async()=>{const result=await model.complete([{role:'user',content:'Reply with READY only.'}],[],new AbortController().signal);return result.content.slice(0,200);});
  handle('vm:action',async(action)=>{
    if(!['prepare','start','stop','restart','repair-tools'].includes(action))throw new Error('不支持的维护操作');
    if(harness.busy&&action!=='prepare')throw new Error('Bot 正在工作，请先停止任务再维护电脑');
    if(action==='prepare')await vm.prepare();if(action==='start')await vm.start();if(action==='stop')await vm.stop();if(action==='restart')await vm.restart();if(action==='repair-tools')await vm.repairTools();changed();
  });
  handle('vm:terminal',(command)=>{if(typeof command!=='string')throw new Error('无效命令');return vm.execute(command,'manual');});
  handle('files:list',async(botId)=>{const id=String(botId);const files=await artifacts.list(id);if(artifacts.importKnown(id,files))changed();return files;});
  handle('files:preview',async(input)=>artifacts.preview(String(input?.botId),String(input?.path)));
  handle('files:open',async(input)=>{const bot=store.bot(String(input?.botId));if(computer.stateFor(bot.id).ownerBotId)throw new Error('Bot 正在操作桌面，请先接管电脑');await computer.ensure(bot.id);return artifacts.open(bot.id,String(input?.path));});
  handle('computer:screenshot',(id)=>{if(![...store.data.messages,...store.data.peerMessages,...store.data.groupRunMessages].some(message=>message.screenshotId===id))throw new Error('截图不存在');return computer.image(String(id));});
  handle('computer:ensure',id=>computer.ensure(store.bot(String(id)).id));
  handle('computer:control',async input=>{const bot=store.bot(String(input?.botId));if(typeof input?.enabled!=='boolean')throw new Error('无效控制状态');await computer.ensure(bot.id);return changeManualControl(interactions,computer,bot.id,input.enabled,id=>harness.cancel(id));});
  handle('computer:open-app',async(input)=>{const bot=store.bot(String(input?.botId));if(computer.stateFor(bot.id).ownerBotId)throw new Error('Bot 正在操作桌面，请先接管电脑');await computer.openApp(bot.id,input.app);});
  handle('files:export',async(input)=>{
    store.bot(String(input?.botId));const name=safeRelativePath(String(input?.path||''));
    const bytes=await artifacts.read(input.botId,name);
    const target=await dialog.showSaveDialog(window!,{defaultPath:name.split('/').pop(),title:'保存工作成果'});if(target.canceled||!target.filePath)return null;
    writeFileSync(target.filePath,bytes);return target.filePath;
  });
  handle('app:open-data',()=>shell.openPath(dataDir));
  const shutdown=new Shutdown({
    stop:()=>{vm.beginShutdown();if(timer)clearInterval(timer);for(const close of [()=>appUpdates?.dispose(),()=>scheduler?.dispose(),()=>greetings?.dispose(),()=>{for(const bot of store.data.bots)harness.cancel(bot.id);},()=>providers.dispose(),()=>model?.dispose(),()=>harness.disposeTools(),()=>chatPins?.dispose(),()=>peerChats?.dispose(),()=>groupChats?.dispose(),()=>interactions.dispose(),()=>host.dispose()])try{close();}catch(error){diagnostics?.record('app.shutdown-error',error);}},
    closeWork:()=>[harness.closeProcesses(),cognition.close(),integrations.close()],
    closeVm:()=>vm.shutdownForExit(),closeState:()=>{vm.dispose();store.close();},
    report:error=>diagnostics?.record('app.shutdown-error',error),exit:()=>{diagnostics?.dispose();app.exit(0);}
  });
  app.on('before-quit',event=>{event.preventDefault();if(exiting)return;exiting=true;void shutdown.run();});
  app.on('window-all-closed',()=>app.quit());
  vm.on('state',changed);
  const dev=process.env.AELION_DEV_URL;
  if(dev){if(new URL(dev).hostname!=='127.0.0.1')throw new Error('开发服务器必须在本机');await window.loadURL(dev);}else await window.loadFile(join(__dirname,'../dist/index.html'));
  window.show();
  appUpdates.startAutomaticChecks();
  void greetings.greetEmpty();
  await vm.refresh();
  if(exiting)return;
  if(launchContext?.resumeComputer&&resolve(launchContext.dataDir).toLowerCase()===dataDir.toLowerCase()){saveUpdateLaunchContext(profileDir,{...launchContext,resumeComputer:false});await vm.start().catch(()=>{});}
  if(exiting)return;
  scheduler.start();
  timer=setInterval(async()=>{if(polling)return;polling=true;try{await vm.refresh();}finally{polling=false;}},6000);

}
