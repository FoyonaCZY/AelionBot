import {useEffect,useRef,useState} from 'react';
import type {Snapshot} from './shared';
import {IntegrationSources,McpSnippetDialog} from './integration-ui';
import {PluginDetails,PluginOwner,PluginSwitch} from './PluginDetails';
import {Icon} from './ui';
import {useI18n} from './i18n';
import './plugins.css';
export type PluginFilter='all'|'skills'|'mcp';
export function PluginsPage({state,initialFilter='all',busy,act,onClose}:{state:Snapshot;initialFilter?:PluginFilter;busy:boolean;act:(operation:()=>Promise<unknown>)=>Promise<void>;onClose:()=>void}){
 const {t,language}=useI18n(),label=(cn:string,en:string,tw=cn)=>language==='en'?en:language==='zh-TW'?tw:cn;
 const [query,setQuery]=useState(''),[filter,setFilter]=useState<PluginFilter>(initialFilter),[selected,setSelected]=useState<{kind:'skill'|'mcp';id:string}>(),[addingMcp,setAddingMcp]=useState(false),heading=useRef<HTMLHeadingElement>(null);
 useEffect(()=>{if(!selected)heading.current?.focus({preventScroll:true});},[selected]);
 const search=query.trim().toLowerCase(),skills=state.skills,servers=state.integrations?.servers||[];
 const shownSkills=skills.filter(skill=>`${skill.name} ${skill.description} ${skill.source?.label||''} ${state.bots.find(bot=>bot.id===skill.botId)?.name||''}`.toLowerCase().includes(search));
 const shownServers=servers.filter(server=>`${server.name} ${server.source.label}`.toLowerCase().includes(search));
 const count=filter==='skills'?shownSkills.length:filter==='mcp'?shownServers.length:shownSkills.length+shownServers.length;
 const filters:Array<{id:PluginFilter;name:string;count:number}>=[{id:'all',name:t('全部'),count:skills.length+servers.length},{id:'skills',name:t('技能'),count:skills.length},{id:'mcp',name:'MCP',count:servers.length}];
 const selectedSkill=selected?.kind==='skill'?skills.find(skill=>skill.id===selected.id):undefined,selectedServer=selected?.kind==='mcp'?servers.find(server=>server.id===selected.id):undefined;
 return <main className="plugins-page" aria-labelledby="plugins-heading">
  <header className="plugins-header drag"><div className="plugins-header-inner"><div><h1 id="plugins-heading" ref={heading} tabIndex={-1}>{label('插件','Plugins','外掛')}</h1></div><button className="icon-button" aria-label={label('返回聊天','Back to chat','返回聊天')} onClick={onClose}><Icon name="close" size={20}/></button></div></header>
  <div className="plugins-content">
  {selected?<PluginDetails key={selected.kind+':'+selected.id} skill={selectedSkill} server={selectedServer} owner={state.bots.find(bot=>bot.id===selectedSkill?.botId)} busy={busy} act={act} onBack={()=>setSelected(undefined)}/>:<>
   <div className="plugins-toolbar"><label className="plugins-search"><Icon name="search" size={18}/><input type="search" aria-label={label('搜索插件','Search plugins','搜尋外掛')} placeholder={label('搜索插件','Search plugins','搜尋外掛')} value={query} onChange={event=>setQuery(event.target.value)}/></label><button className="icon-button" title={t('重新扫描')} aria-label={t('重新扫描')} disabled={busy} onClick={()=>void act(()=>window.aelion.refreshIntegrations())}><Icon name="restart" size={18}/></button><button className="secondary-button" disabled={busy} onClick={()=>void act(()=>window.aelion.addIntegrationSource('skills'))}><Icon name="plus" size={15}/>{label('添加技能','Add skills','新增技能')}</button><button className="primary-button" disabled={busy} onClick={()=>setAddingMcp(true)}><Icon name="plus" size={15}/>{label('添加 MCP','Add MCP','新增 MCP')}</button></div>
   <div className="plugins-filters"><div className="plugins-filter-group" role="group" aria-label={label('插件分类','Plugin categories','外掛分類')}>{filters.map(item=><button key={item.id} aria-pressed={filter===item.id} onClick={()=>setFilter(item.id)}>{item.name}<span>{item.count}</span></button>)}</div></div>
   <div className="plugins-list">
    {filter!=='mcp'&&shownSkills.length>0&&<section className="plugins-section" aria-labelledby="plugins-skills-title"><h2 id="plugins-skills-title">{t('技能')}<span>{shownSkills.length}</span></h2><div className="plugin-card-grid">{shownSkills.map(skill=>{
     const enabled=skill.enabled??!skill.archived,owner=state.bots.find(bot=>bot.id===skill.botId);
     return <article className="plugin-card" key={'skill:'+skill.id} data-plugin-id={skill.id}><span className="plugin-card-icon"><Icon name="book" size={18}/></span><div className="plugin-card-copy"><button className="plugin-name" onClick={()=>setSelected({kind:'skill',id:skill.id})}>{skill.name}</button><p title={skill.description}>{skill.description}</p></div><div className="plugin-card-right"><PluginOwner bot={owner} privateSkill={Boolean(skill.botId)}/><PluginSwitch name={skill.name} enabled={enabled} disabled={busy} onChange={()=>void act(()=>window.aelion.setSkillEnabled({id:skill.id,enabled:!enabled}))}/></div></article>;
    })}</div></section>}
    {filter!=='skills'&&shownServers.length>0&&<section className="plugins-section" aria-labelledby="plugins-mcp-title"><h2 id="plugins-mcp-title">MCP<span>{shownServers.length}</span></h2><div className="plugin-card-grid">{shownServers.map(server=><article className="plugin-card" key={'mcp:'+server.id} data-plugin-id={server.id}><span className="plugin-card-icon"><Icon name="globe" size={18}/></span><div className="plugin-card-copy"><button className="plugin-name" onClick={()=>setSelected({kind:'mcp',id:server.id})}>{server.name}</button><p className={`plugin-connection ${server.status}`}><i/>{server.status==='connected'?t('已连接'):server.status==='connecting'?t('连接中'):server.status==='needs-config'?t('需要配置'):server.status==='error'?t('连接失败'):server.enabled?t('等待使用'):t('已发现 · 未启用')}</p></div><div className="plugin-card-right"><PluginSwitch name={server.name} enabled={server.enabled} disabled={busy||server.status==='connecting'||!server.enabled&&server.status==='needs-config'} onChange={()=>void act(()=>window.aelion.setMcpEnabled({id:server.id,enabled:!server.enabled}))}/></div></article>)}</div></section>}
    {count===0&&<div className="plugins-empty"><span><Icon name={search?'search':'plugin'} size={24}/></span><h2>{search?label('没有找到相关插件','No matching plugins','找不到相關外掛'):label('暂无插件','No plugins','暫無外掛')}</h2><p>{search?t('试试其他关键词。'):label('添加技能目录，或粘贴 MCP 配置。','Add a skill directory or paste an MCP configuration.','新增技能目錄，或貼上 MCP 設定。')}</p>{search&&<button className="text-button" onClick={()=>setQuery('')}>{label('清除搜索','Clear search','清除搜尋')}</button>}</div>}
   </div>
   {state.integrations&&<details className="plugins-sources"><summary>{label('来源与配置','Sources & configuration','來源與設定')}<Icon name="down" size={15}/></summary><div><span>{label('共享技能','Shared skills','共享技能')}</span><code>{state.integrations.sharedSkillDir}</code><button className="text-button" disabled={busy} onClick={()=>void act(()=>window.aelion.openIntegrationPath({kind:'shared-skills'}))}>{t('打开目录')}</button></div><div><span>{label('MCP 配置','MCP configuration','MCP 設定')}</span><code>{state.integrations.mcpFile}</code><button className="text-button" disabled={busy} onClick={()=>void act(()=>window.aelion.openIntegrationPath({kind:'mcp-config'}))}>{t('打开配置')}</button></div><IntegrationSources sources={state.integrations.sources} busy={busy} act={act}/></details>}
   {addingMcp&&<McpSnippetDialog busy={busy} onClose={()=>setAddingMcp(false)} onImport={text=>window.aelion.importMcpSnippet(text)}/>}
  </>}
  </div>
 </main>;
}