import {useEffect,useRef,useState} from 'react';
import type {Bot,McpServerView,Skill} from './shared';
import {Avatar,Icon} from './ui';
import {useI18n} from './i18n';
import Markdown from './MessageMarkdown';
import {SkillControls} from './integration-ui';
export function PluginSwitch({name,enabled,disabled,onChange}:{name:string;enabled:boolean;disabled:boolean;onChange:()=>void}){
 const {t}=useI18n();return <button type="button" className="plugin-switch" role="switch" aria-label={`${t('启用')} ${name}`} aria-checked={enabled} title={`${enabled?t('停用'):t('启用')} ${name}`} disabled={disabled} onClick={onChange}><span/></button>;
}
export function PluginOwner({bot,privateSkill=false}:{bot?:Bot;privateSkill?:boolean}){
 const {t,language}=useI18n();return bot?<span className="plugin-owner" title={bot.name}><Avatar bot={bot} size={22}/><span>{bot.name}</span></span>:<span className="plugin-shared">{privateSkill?t('Bot 私有'):language==='en'?'Shared':language==='zh-TW'?'共享':'共享'}</span>;
}
type Act=(operation:()=>Promise<unknown>)=>Promise<void>;
export function PluginDetails({skill,server,owner,busy,act,onBack}:{skill?:Skill;server?:McpServerView;owner?:Bot;busy:boolean;act:Act;onBack:()=>void}){
 const {t,language}=useI18n(),label=(cn:string,en:string,tw=cn)=>language==='en'?en:language==='zh-TW'?tw:cn;
 const [full,setFull]=useState<Skill>(),[error,setError]=useState(''),[loading,setLoading]=useState(false),[testResult,setTestResult]=useState('');const heading=useRef<HTMLHeadingElement>(null);
 const id=skill?.id||server?.id;
 useEffect(()=>{heading.current?.focus({preventScroll:true});setTestResult('');},[id]);
 useEffect(()=>{if(!skill)return;let active=true;setFull(undefined);setError('');setLoading(true);window.aelion.readSkill({id:skill.id,botId:skill.botId}).then(value=>{if(active)setFull(value);}).catch(e=>{if(active)setError((e as Error).message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[skill?.id]);
 const reload=async()=>{if(skill)setFull(await window.aelion.readSkill({id:skill.id,botId:skill.botId}));};
 const enabled=skill?(skill.enabled??!skill.archived):Boolean(server?.enabled),name=skill?.name||server?.name||'';
 const toggle=()=>void act(()=>skill?window.aelion.setSkillEnabled({id:skill.id,enabled:!enabled}):window.aelion.setMcpEnabled({id:server!.id,enabled:!enabled}));
 const cannotToggle=busy||Boolean(server&&(server.status==='connecting'||!enabled&&server.status==='needs-config'));
 if(!skill&&!server)return <div className="plugin-detail"><button className="plugin-back" onClick={onBack}><Icon name="back" size={15}/>{label('返回插件','Back to plugins','返回外掛')}</button><p>{label('这个插件已被移除。','This plugin was removed.','此外掛已被移除。')}</p></div>;
 return <article className="plugin-detail"><button className="plugin-back" onClick={onBack}><Icon name="back" size={15}/>{label('返回插件','Back to plugins','返回外掛')}</button>
  <header className="plugin-detail-heading"><span className="plugin-detail-icon"><Icon name={skill?'book':'globe'} size={24}/></span><div><p>{skill?'Skill':'MCP'}</p><h2 ref={heading} tabIndex={-1}>{name}</h2></div><PluginSwitch name={name} enabled={enabled} disabled={cannotToggle} onChange={toggle}/></header>
  {skill?<>
   <div className="plugin-detail-owner"><PluginOwner bot={owner} privateSkill={Boolean(skill.botId)}/><span>{enabled?t('启用'):t('停用')}</span></div>
   <p className="plugin-detail-description">{skill.description}</p>
   {loading?<p className="subtle" role="status">{t('正在读取 SKILL.md…')}</p>:error?<p role="alert" className="computer-notice">{error}</p>:<div className="plugin-detail-body markdown"><Markdown>{full?.body||skill.body}</Markdown></div>}
   {owner&&enabled&&<SkillControls hideArchive skill={full||skill} botId={owner.id} onChanged={reload}/>}
   {(full?.compatibility||skill.compatibility)&&<p className="subtle">{t('适用环境：{value}',{value:full?.compatibility||skill.compatibility||''})}</p>}
   <details className="plugin-detail-source"><summary>{label('来源与文件','Source & files','來源與檔案')}</summary>{skill.source&&<code>{skill.source.path}</code>}{full?.availableFiles?.map(path=><code key={path}>{path}</code>)}</details>
  </>:<>
   <div className="plugin-detail-owner"><span className={`plugin-connection ${server!.status}`}><i/>{server!.status==='connected'?t('已连接'):server!.status==='error'?t('连接失败'):server!.status==='needs-config'?t('需要配置'):server!.status==='connecting'?t('连接中'):enabled?t('等待使用'):t('已发现 · 未启用')}</span></div>
   <dl className="plugin-detail-meta"><div><dt>{label('连接方式','Transport','連接方式')}</dt><dd>{server!.transport.toUpperCase()}</dd></div><div><dt>{label('地址','Endpoint','位址')}</dt><dd>{server!.endpoint}</dd></div><div><dt>{label('来源','Source','來源')}</dt><dd>{server!.source.label}</dd></div>{server!.toolCount!==undefined&&<div><dt>{label('可用工具','Available tools','可用工具')}</dt><dd>{server!.toolCount}</dd></div>}</dl>
   {server!.issue&&<p className="computer-notice" role="alert">{server!.issue}</p>}
   <div className="plugin-detail-actions"><button className="secondary-button" disabled={busy||!enabled||server!.status==='needs-config'||server!.status==='connecting'} onClick={()=>void act(async()=>{setTestResult(t('正在握手并读取工具目录…'));try{const result=await window.aelion.testMcp(server!.id);setTestResult(t('握手成功：{count} 个工具{details}',{count:result.tools.length,details:result.tools.length?' · '+result.tools.slice(0,8).join('、'):''}));}catch(e){setTestResult(t('连接失败，请检查状态提示。'));throw e;}})}>{t('测试连接')}</button><button className="secondary-button" disabled={busy} onClick={()=>void act(()=>window.aelion.openIntegrationPath({kind:'source',id:server!.id}))}>{t('查看来源')}</button></div>
   {testResult&&<p className="plugin-test-result" role="status">{testResult}</p>}
   <details className="plugin-detail-source"><summary>{label('配置文件','Configuration file','設定檔')}</summary><code>{server!.source.path}</code></details>
  </>}
 </article>;
}