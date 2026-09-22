import {useEffect,useId,useMemo,useRef,useState,type KeyboardEvent} from 'react';
import {createPortal} from 'react-dom';
import type {DesignFont,DesignFontAcquire,DesignFontCatalogEntry,DesignFontCheck,DesignFontStyle} from './design-font-types';
import {Icon} from './ui';
import './design-fonts.css';

export interface DesignFontsApi {
 listDesignFonts(input:{id:string}):Promise<DesignFont[]>;
 searchDesignFonts(input:{query:string}):Promise<DesignFontCatalogEntry[]>;
 acquireDesignFont(input:{id:string}&DesignFontAcquire):Promise<unknown>;
 importDesignFonts(input:{id:string}):Promise<unknown>;
 checkDesignFonts(input:{id:string;text?:string;path?:string}):Promise<DesignFontCheck>;
 applyDesignFont(input:{id:string;fontId:string;role:'body'|'display'|'mono';path?:string}):Promise<unknown>;
 exportDesignProject?(input:{id:string;path?:string}):Promise<unknown>;
}
export interface DesignFontsPanelProps {
 sessionId:string;
 path?:string;
 en:boolean;
 busy?:boolean;
 api:DesignFontsApi;
 onClose:()=>void;
 onChanged?:()=>void;
}
const errorText=(error:unknown)=>String(error instanceof Error?error.message:error).replace(/^Error invoking remote method '[^']+': Error: /,'');
const languages:Record<string,[string,string]>={
 latin:['Latin','拉丁文'],'latin-ext':['Extended Latin','扩展拉丁文'],
 'chinese-simplified':['Simplified Chinese','简体中文'],'chinese-traditional':['Traditional Chinese','繁体中文'],
 'simplified-chinese':['Simplified Chinese','简体中文'],'traditional-chinese':['Traditional Chinese','繁体中文'],
 chinese:['Chinese','中文'],japanese:['Japanese','日文'],korean:['Korean','韩文'],
 cyrillic:['Cyrillic','西里尔文'],greek:['Greek','希腊文'],arabic:['Arabic','阿拉伯文'],
 hebrew:['Hebrew','希伯来文'],vietnamese:['Vietnamese','越南文'],thai:['Thai','泰文'],devanagari:['Devanagari','天城文'],
};
const languageNames=(subsets:string[],en:boolean)=>subsets.filter(value=>!value.endsWith('-ext')||!subsets.includes(value.slice(0,-4))).map(value=>languages[value]?.[en?0:1]||value).join(' · ');
const categoryName=(value:string,en:boolean)=>en?value:({'sans-serif':'无衬线',serif:'衬线',monospace:'等宽',display:'标题',handwriting:'手写'} as Record<string,string>)[value]||value;
const fontWeights=(font:DesignFont)=>{
 const ranges=font.files.flatMap(file=>file.weightRange?[file.weightRange.join('–')]:[]);
 return ranges.length?[...new Set(ranges)].join(', '):font.weights.join(', ');
};
const fileSize=(bytes:number)=>bytes>=1024*1024?`${(bytes/(1024*1024)).toFixed(1)} MB`:`${Math.max(1,Math.round(bytes/1024))} KB`;

type FontGroup=DesignFont&{memberIds:string[]};
const groupFonts=(fonts:DesignFont[]):FontGroup[]=>{
 const groups=new Map<string,FontGroup>();
 for(const font of fonts){
  const key=font.source+':'+font.family.toLowerCase()+':'+(font.version||''),old=groups.get(key);
  if(!old){groups.set(key,{...font,memberIds:[font.id]});continue;}
  groups.set(key,{...old,available:old.available!==false&&font.available!==false,issues:[...new Set([...(old.issues||[]),...(font.issues||[])])],memberIds:[...old.memberIds,font.id],weights:[...new Set([...old.weights,...font.weights])].sort((a,b)=>a-b),styles:[...new Set([...old.styles,...font.styles])],subsets:[...new Set([...old.subsets,...font.subsets])],files:[...new Map([...old.files,...font.files].map(file=>[file.path,file])).values()]});
 }
 return [...groups.values()];
};
const groupCheck=(font:FontGroup,check:DesignFontCheck|null)=>{
 const results=check?.fonts.filter(item=>font.memberIds.includes(item.id))||[];
 return results.length?{...results[0],valid:results.every(item=>item.valid),missingCharacters:[...new Set(results.flatMap(item=>item.missingCharacters))]}:undefined;
};

export function DesignFontsPanel({sessionId,path,en,busy=false,api,onClose,onChanged}:DesignFontsPanelProps){
 const titleId=useId(),tabsId=useId(),dialog=useRef<HTMLElement>(null),closeRef=useRef(onClose),alive=useRef(false),operation=useRef(false),currentSession=useRef(sessionId);
 closeRef.current=onClose;
 currentSession.current=sessionId;
 const [tab,setTab]=useState<'project'|'catalog'>('project'),[fonts,setFonts]=useState<DesignFont[]>([]),[loading,setLoading]=useState(true),[listError,setListError]=useState('');
 const [query,setQuery]=useState(''),[catalog,setCatalog]=useState<DesignFontCatalogEntry[]>([]),[searching,setSearching]=useState(false),[searchError,setSearchError]=useState('');
 const [expanded,setExpanded]=useState(''),[weights,setWeights]=useState<number[]>([]),[styles,setStyles]=useState<DesignFontStyle[]>(['normal']);
 const [pending,setPending]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[check,setCheck]=useState<DesignFontCheck|null>(null),[sample,setSample]=useState('');
 const fontGroups=useMemo(()=>groupFonts(fonts),[fonts]);
 const locked=busy||Boolean(pending),writeTitle=busy?(en?'Available after the task stops':'任务停止后可添加字体'):undefined;
 useEffect(()=>{
  alive.current=true;
  const before=document.activeElement instanceof HTMLElement?document.activeElement:null;
  dialog.current?.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
  const keydown=(event:globalThis.KeyboardEvent)=>{
   if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();closeRef.current();return;}
   if(event.key!=='Tab')return;
   const focusable=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],summary,[tabindex="0"]')||[]).filter(element=>element.tabIndex>=0&&element.getClientRects().length>0);
   const first=focusable[0],last=focusable.at(-1);
   if(!first){event.preventDefault();dialog.current?.focus();return;}
   if(event.shiftKey&&(document.activeElement===first||!dialog.current?.contains(document.activeElement))){event.preventDefault();last?.focus();}
   else if(!event.shiftKey&&(document.activeElement===last||!dialog.current?.contains(document.activeElement))){event.preventDefault();first.focus();}
  };
  window.addEventListener('keydown',keydown,true);
  return()=>{alive.current=false;window.removeEventListener('keydown',keydown,true);if(before?.isConnected)before.focus();};
 },[]);
 useEffect(()=>{
  let current=true;
  setLoading(true);setListError('');setCheck(null);
  void api.listDesignFonts({id:sessionId}).then(result=>{if(current)setFonts(result);}).catch(reason=>{if(current)setListError(errorText(reason));}).finally(()=>{if(current)setLoading(false);});
  return()=>{current=false;};
 },[sessionId,path,busy,api]);
 useEffect(()=>{
  if(tab!=='catalog')return;
  let current=true;setSearching(true);setSearchError('');
  const timer=window.setTimeout(()=>{
   void api.searchDesignFonts({query:query.trim()}).then(result=>{if(current)setCatalog(result);}).catch(reason=>{if(current){setCatalog([]);setSearchError(errorText(reason));}}).finally(()=>{if(current)setSearching(false);});
  },200);
  return()=>{current=false;window.clearTimeout(timer);};
 },[tab,query,api]);
 const mutate=async(name:string,action:()=>Promise<unknown>,message=en?'Font added':'字体已添加')=>{
  if(busy||operation.current)return;
  operation.current=true;setPending(name);setError('');setNotice('');
  try{
   const result=await action();
   if(name==='import'&&result==null)return;
   if(!alive.current||currentSession.current!==sessionId)return;
   onChanged?.();
   const updated=await api.listDesignFonts({id:sessionId});
   if(!alive.current||currentSession.current!==sessionId)return;
   setFonts(updated);setListError('');setCheck(null);setTab('project');setExpanded('');
   setNotice(message);
  }catch(reason){
   if(alive.current&&currentSession.current===sessionId){
    setError(errorText(reason));
    // A multi-file import may save valid files before a later file fails.
    try{const updated=await api.listDesignFonts({id:sessionId});if(alive.current&&currentSession.current===sessionId){setFonts(updated);setCheck(null);onChanged?.();}}catch{}
   }
  }
  finally{operation.current=false;if(alive.current)setPending('');}
 };
 const exportProject=async()=>{
  if(locked||operation.current||!api.exportDesignProject)return;
  operation.current=true;setPending('export');setError('');setNotice('');
  try{const result=await api.exportDesignProject({id:sessionId,path});if(result!=null&&alive.current&&currentSession.current===sessionId)setNotice(en?'Project exported':'项目已导出');}
  catch(reason){if(alive.current&&currentSession.current===sessionId)setError(errorText(reason));}
  finally{operation.current=false;if(alive.current)setPending('');}
 };
 const runCheck=async()=>{
  if(operation.current)return;
  operation.current=true;setPending('check');setError('');setNotice('');
  try{const result=await api.checkDesignFonts({id:sessionId,path,...(sample.trim()?{text:sample}: {})});if(alive.current&&currentSession.current===sessionId)setCheck(result);}
  catch(reason){if(alive.current&&currentSession.current===sessionId)setError(errorText(reason));}
  finally{operation.current=false;if(alive.current)setPending('');}
 };
 const selectFont=(font:DesignFontCatalogEntry)=>{
  setExpanded(previous=>previous===font.id?'':font.id);
  setWeights([font.weights.includes(400)?400:font.weights[0]||400]);
  setStyles([font.styles.includes('normal')?'normal':font.styles[0]||'normal']);
 };
 const changeTab=(next:'project'|'catalog')=>{setTab(next);setError('');setNotice('');};
 const tabKeys=(event:KeyboardEvent<HTMLButtonElement>)=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  event.preventDefault();const next=event.key==='Home'?'project':event.key==='End'?'catalog':tab==='project'?'catalog':'project';
  changeTab(next);document.getElementById(`${tabsId}-${next}`)?.focus();
 };
 const importButton=<button type="button" className="design-font-import" disabled={locked} title={writeTitle||(en?'Import WOFF2, WOFF, TTF or OTF':'导入 WOFF2、WOFF、TTF 或 OTF')} onClick={()=>void mutate('import',()=>api.importDesignFonts({id:sessionId}))}><Icon name="folder" size={15}/>{pending==='import'?(en?'Importing…':'正在导入…'):(en?'Import':'导入字体')}</button>;
 const issues=check?.fonts.filter(font=>!font.valid||font.missingCharacters.length)||[];
 return createPortal(<div className="modal-backdrop design-font-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}>
  <section className="design-font-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialog}>
   <header className="design-font-header"><h2 id={titleId}>{en?'Fonts':'字体'}</h2><div>{api.exportDesignProject&&<button type="button" className="design-font-export" disabled={locked} title={en?'Export project ZIP with fonts':'导出项目 ZIP（含字体）'} aria-label={en?'Export project ZIP with fonts':'导出项目 ZIP（含字体）'} onClick={()=>void exportProject()}><Icon name="download" size={15}/><span>{pending==='export'?(en?'Exporting…':'正在导出…'):(en?'Export project':'导出项目')}</span></button>}{importButton}<button type="button" className="icon-button" aria-label={en?'Close fonts':'关闭字体面板'} onClick={onClose}><Icon name="close" size={18}/></button></div></header>
   <div className="design-font-tabs" role="tablist" aria-label={en?'Font library':'字体库'}>
    <button type="button" data-initial-focus role="tab" id={`${tabsId}-project`} aria-selected={tab==='project'} aria-controls={`${tabsId}-panel-project`} tabIndex={tab==='project'?0:-1} onKeyDown={tabKeys} onClick={()=>changeTab('project')}>{en?'Project fonts':'项目字体'}<span>{fontGroups.length}</span></button>
    <button type="button" role="tab" id={`${tabsId}-catalog`} aria-selected={tab==='catalog'} aria-controls={`${tabsId}-panel-catalog`} tabIndex={tab==='catalog'?0:-1} onKeyDown={tabKeys} onClick={()=>changeTab('catalog')}>{en?'Open source fonts':'开源字体'}</button>
   </div>
   {tab==='project'?<div className="design-font-pane" id={`${tabsId}-panel-project`} role="tabpanel" aria-labelledby={`${tabsId}-project`}>
    <div className="design-font-list" aria-busy={loading}>
     {loading?<div className="design-font-empty" role="status"><span className="spinner"/>{en?'Loading fonts…':'正在读取字体…'}</div>:listError?<div className="design-font-empty design-font-error" role="alert">{listError}</div>:!fonts.length?<div className="design-font-empty"><span className="design-font-empty-mark" aria-hidden="true">Aa</span><strong>{en?'No project fonts yet':'还没有项目字体'}</strong><button type="button" className="primary-button" onClick={()=>changeTab('catalog')}><Icon name="plus" size={14}/>{en?'Add a font':'添加字体'}</button></div>:fontGroups.map(font=>{
      const result=groupCheck(font,check),unavailable=font.available===false,invalid=unavailable||Boolean(result&&(!result.valid||result.missingCharacters.length>0));
      const stateLabel=unavailable||result?.valid===false?(en?'File error':'文件异常'):result?.missingCharacters.length?(en?`${result.missingCharacters.length} missing glyphs`:`缺 ${result.missingCharacters.length} 个字`):result?(result.checkedCharacters?(en?'Text supported':'文字可用'):(en?'Files valid':'文件正常')):(en?'In project':'已加入');
      return <article className="design-font-row" key={font.id}>
       <div className="design-font-row-main"><div className="design-font-name"><strong>{font.family}</strong><span>{font.source==='import'?(en?'Imported':'本地导入'):'Fontsource'}</span></div><div className="design-font-meta"><span>{fontWeights(font)}</span>{font.styles.includes('italic')&&<span>{en?'Italic':'含斜体'}</span>}{font.subsets.length>0&&<span>{languageNames(font.subsets,en)}</span>}</div></div>
       <div className="design-font-row-side"><span className="design-font-status" data-warning={invalid||undefined}><Icon name={invalid?'alert':'check'} size={13}/>{stateLabel}</span><small>{fileSize(font.files.reduce((total,file)=>total+file.bytes,0))}</small></div>
       <div className="design-font-apply" role="group" aria-label={(en?'Apply ':'应用 ')+font.family}><span>{en?'Use for':'应用于'}</span>{(['body','display','mono'] as const).map(role=><button key={role} type="button" disabled={locked||unavailable} title={unavailable?(en?'Restore the font files before applying':'修复字体文件后可应用'):writeTitle} onClick={()=>void mutate('apply:'+font.id,()=>api.applyDesignFont({id:sessionId,fontId:font.id,role,path}),en?`${font.family} applied`:`已应用 ${font.family}`)}>{role==='body'?(en?'Body':'正文'):role==='display'?(en?'Headings':'标题'):(en?'Code':'代码')}</button>)}</div>
       <details className="design-font-details" open={unavailable||undefined}><summary>{en?'Details':'详情'}</summary><dl><dt>{en?'License':'许可'}</dt><dd>{font.license.name}</dd>{unavailable&&<><dt>{en?'File errors':'异常文件'}</dt><dd className="design-font-error">{font.issues?.join(', ')||(en?'Font files are missing or modified':'字体文件缺失或已修改')}</dd></>}<dt>{en?'Stylesheet':'样式文件'}</dt><dd>{font.cssPath}</dd><dt>{en?'Font files':'字体文件'}</dt><dd>{font.files.length}</dd>{font.version&&<><dt>{en?'Version':'版本'}</dt><dd>{font.version}</dd></>}</dl></details>
      </article>;
     })}
    </div>
    {fonts.length>0&&<div className="design-font-check"><div className="design-font-check-input"><input aria-label={en?'Text to check for missing glyphs':'要检查缺字的文字'} placeholder={en?'Text to check (optional)':'输入要检查的文字（可选）'} value={sample} disabled={pending==='check'} onChange={event=>{setSample(event.target.value);setCheck(null);}} maxLength={1000}/><button type="button" disabled={Boolean(pending)||loading} onClick={()=>void runCheck()}><Icon name="check" size={14}/>{pending==='check'?(en?'Checking…':'正在检测…'):(en?'Check':'检测字体')}</button></div>
     {check&&<div className="design-font-check-result" role="status" data-warning={!check.cssValid||issues.length>0||undefined}>{!check.cssValid&&<p>{en?'Font stylesheet is missing or invalid':'字体样式文件缺失或无效'}</p>}{issues.map(font=><p key={font.id}><strong>{font.family}</strong>{!font.valid?<span>{en?'Unable to read font files':'无法读取字体文件'}{font.missingFiles.length>0&&` · ${font.missingFiles.join(', ')}`}</span>:<span>{en?'Missing characters: ':'缺少字符：'}<b>{font.missingCharacters.join(' ')}</b></span>}</p>)}{check.cssValid&&!issues.length&&<p><Icon name="check" size={14}/>{sample.trim()?(en?'All project fonts support this text':'项目字体均支持这段文字'):(en?'Font files and stylesheet are valid':'字体文件和样式文件正常')}</p>}</div>}
    </div>}
   </div>:<div className="design-font-pane" id={`${tabsId}-panel-catalog`} role="tabpanel" aria-labelledby={`${tabsId}-catalog`}>
    <div className="design-font-search"><Icon name="search" size={17}/><input aria-label={en?'Search fonts':'搜索字体'} placeholder={en?'Search font names…':'搜索字体名称…'} value={query} onChange={event=>setQuery(event.target.value)}/>{query&&<button type="button" aria-label={en?'Clear search':'清空搜索'} onClick={()=>setQuery('')}><Icon name="close" size={14}/></button>}</div>
    <div className="design-font-list" aria-busy={searching}>{searching?<div className="design-font-empty" role="status"><span className="spinner"/>{en?'Searching…':'正在搜索…'}</div>:searchError?<div className="design-font-empty design-font-error" role="alert">{searchError}</div>:!catalog.length?<div className="design-font-empty">{en?'No matching fonts':'没有找到匹配的字体'}</div>:catalog.map(font=>{
     const added=fonts.find(current=>current.source==='fontsource'&&current.family.toLowerCase()===font.family.toLowerCase()),isOpen=expanded===font.id;
     return <article className={`design-font-catalog-row${isOpen?' is-expanded':''}`} key={font.id}>
      <button type="button" className="design-font-catalog-title" aria-expanded={isOpen} onClick={()=>selectFont(font)}><span className="design-font-row-main"><span className="design-font-name"><strong>{font.family}</strong>{added&&<span>{en?'In project':'已添加'}</span>}</span><span className="design-font-meta"><span>{categoryName(font.category,en)}</span><span>{languageNames(font.subsets,en)}</span></span></span><Icon name={isOpen?'down':'plus'} size={17}/></button>
      {isOpen&&<div className="design-font-options"><fieldset disabled={locked}><legend>{en?'Weights':'字重'}</legend><div>{font.weights.map(weight=><button type="button" key={weight} aria-pressed={weights.includes(weight)} onClick={()=>setWeights(previous=>previous.includes(weight)?previous.filter(value=>value!==weight):[...previous,weight].sort((a,b)=>a-b))}>{weight}</button>)}</div></fieldset>{font.styles.length>1&&<fieldset disabled={locked}><legend>{en?'Style':'样式'}</legend><div>{font.styles.map(style=><button type="button" key={style} aria-pressed={styles.includes(style)} onClick={()=>setStyles(previous=>previous.includes(style)?previous.filter(value=>value!==style):[...previous,style])}>{style==='italic'?(en?'Italic':'斜体'):(en?'Regular':'常规')}</button>)}</div></fieldset>}<button type="button" className="primary-button design-font-add" title={writeTitle} disabled={locked||!weights.length||!styles.length} onClick={()=>void mutate(font.id,()=>api.acquireDesignFont({id:sessionId,fontId:font.id,weights,styles}))}><Icon name={pending===font.id?'download':'plus'} size={14}/>{pending===font.id?(en?'Adding…':'正在添加…'):(en?'Add to project':'添加到项目')}</button></div>}
     </article>;
    })}</div>
   </div>}
   {(error||notice||busy||pending&&pending!=='check')&&<footer className="design-font-footer">{error?<p className="design-font-error" role="alert">{error}</p>:<p role="status">{notice|| (pending&&pending!=='check'?(pending==='import'?(en?'Importing fonts…':'正在导入字体…'):pending==='export'?(en?'Exporting project…':'正在导出项目…'):pending.startsWith('apply:')?(en?'Applying font…':'正在应用字体…'):(en?'Downloading fonts…':'正在下载字体…')):busy?(en?'Task is running · font editing paused':'任务进行中 · 暂不可修改字体'): '')}</p>}</footer>}
  </section>
 </div>,document.body);
}
