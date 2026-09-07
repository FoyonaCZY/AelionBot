import {useEffect,useState} from 'react';
import Markdown from './MessageMarkdown';
import type {ChatMessage} from './shared';
import {toolResult,toolDisplay,toolOperation} from './activity';
import {Icon,bytes} from './ui';
import {arrayValue,cleanConsole,errorExplanation,fieldLabel,fileGroups,fileName,mcpResultParts,objectValue,parameterRows,parsedText,scalarText,textValue} from './tool-details-model';
import './tool-details.css';

function CopyText({value,label}:{value:string;label:string}){
  const [state,setState]=useState('');
  useEffect(()=>{if(!state)return;const timer=setTimeout(()=>setState(''),2200);return()=>clearTimeout(timer);},[state]);
  return <button className="detail-copy" onClick={async()=>{try{await navigator.clipboard.writeText(value);setState('已复制');}catch{setState('复制失败');}}} aria-label={label} title={label}><Icon name={state==='已复制'?'check':'copy'} size={13}/><span>{state||label}</span></button>;
}
function DetailHeader({icon,title,subtitle,meta,action}:{icon:string;title:string;subtitle?:string;meta?:string;action?:React.ReactNode}){
  return <header className="tool-detail-header"><span className="tool-detail-icon"><Icon name={icon} size={19}/></span><div className="tool-detail-heading"><strong>{title}</strong>{subtitle&&<span>{subtitle}</span>}</div>{meta&&<span className="tool-detail-meta">{meta}</span>}{action}</header>;
}
function Section({title,children}:{title?:string;children:React.ReactNode}){return <section className="tool-detail-section">{title&&<h4>{title}</h4>}{children}</section>;}
function FileList({files}:{files:unknown}){
  const [all,setAll]=useState(false);const groups=fileGroups(files),total=groups.reduce((sum,group)=>sum+group.files.length,0);let shown=0;
  if(!total)return null;
  return <div className="detail-files">{groups.map(group=>{const visible=all?group.files:group.files.slice(0,Math.max(0,10-shown));shown+=visible.length;return visible.length>0&&<div className="detail-file-group" key={group.label}><div className="detail-group-label">{group.label}<span>{group.files.length}</span></div>{visible.map(file=><div className="detail-file-row" key={file.path}><Icon name={/\.(py|js|ts|sh|mjs)$/.test(file.name)?'terminal':'file'} size={15}/><span title={file.path}>{file.name}</span><small>{file.path.includes('/')?file.path.slice(0,file.path.lastIndexOf('/')):''}</small></div>)}</div>;})}{total>10&&<button className="detail-show-more" onClick={()=>setAll(!all)}>{all?'收起文件清单':`查看全部 ${total} 个文件`}<Icon name="down" size={12}/></button>}</div>;
}
function TextPreview({text,name=''}:{text:string;name?:string}){
  if(!text)return <p className="detail-empty">文件内容为空</p>;
  const content=text.slice(0,30000);
  const value=parsedText(text);
  if(typeof value!=='string')return <DataView value={value}/>;
  if(/\.(md|markdown)$/i.test(name))return <div className="detail-document markdown"><Markdown>{content}</Markdown>{text.length>content.length&&<p className="detail-muted">预览已截取前 30,000 字符。</p>}</div>;
  return typeof value==='string'?<div className="detail-text-content">{content}</div>:<DataView value={value}/>;
}
function DataView({value,depth=0}:{value:unknown;depth?:number}){
  const [all,setAll]=useState(false);
  if(value===null||typeof value!=='object'){const content=scalarText(value),limit=all?30000:2400;return <span className="detail-value">{content.slice(0,limit)}{content.length>2400&&<button className="detail-show-more" onClick={()=>setAll(!all)}>{all?'收起内容':'展开内容'}</button>}{content.length>limit&&all&&<span className="detail-muted">预览显示前 30,000 字符。</span>}</span>;}
  if(depth>=5)return <p className="detail-muted">此处包含更深层的数据，完整内容保留在执行记录中。</p>;
  if(Array.isArray(value)){
    if(!value.length)return <p className="detail-empty">没有返回记录</p>;
    const rows=all?value.slice(0,200):value.slice(0,8),keys=[...new Set(value.slice(0,200).flatMap(item=>Object.keys(objectValue(item))))];
    const tabular=keys.length>0&&keys.length<=6&&value.slice(0,200).every(item=>item!==null&&typeof item==='object'&&!Array.isArray(item)&&Object.values(item).every(cell=>cell===null||typeof cell!=='object'));
    return <div>{tabular?<div className="detail-table-scroll"><table className="detail-table"><thead><tr>{keys.map(key=><th key={key}>{fieldLabel(key)}</th>)}</tr></thead><tbody>{rows.map((row,index)=><tr key={index}>{keys.map(key=><td key={key}>{scalarText(objectValue(row)[key])}</td>)}</tr>)}</tbody></table></div>:<ol className="detail-value-list">{rows.map((item,index)=><li key={index}><DataView value={item} depth={depth+1}/></li>)}</ol>}{value.length>8&&<button className="detail-show-more" onClick={()=>setAll(!all)}>{all?'收起记录':`查看全部 ${Math.min(value.length,200)} 条记录`}<Icon name="down" size={12}/></button>}{value.length>200&&<p className="detail-muted">显示前 200 条，共 {value.length} 条。</p>}</div>;
  }
  const entries=Object.entries(value).filter(([key,item])=>!(item==='[redacted]'&&/credential|token|secret|password|authorization/i.test(key)));
  if(!entries.length)return <p className="detail-empty">没有额外的返回内容</p>;
  return <dl className="detail-fields">{entries.slice(0,50).map(([key,item])=><div className={item&&typeof item==='object'?'detail-nested':''} key={key}><dt>{fieldLabel(key)}</dt><dd><DataView value={item} depth={depth+1}/></dd></div>)}</dl>;
}
export function ErrorDetails({error,exitCode,compact=false}:{error:string;exitCode?:number;compact?:boolean}){
  const detail=errorExplanation(error);
  if(compact)return <p className="detail-error-inline">{detail.message}{detail.code&&<small> · {detail.code}</small>}</p>;
  return <div className="detail-error"><div className="detail-error-title"><Icon name="alert" size={17}/><strong>{detail.title}</strong></div><p>{detail.message}</p><div className="detail-error-meta">{detail.code&&<span>{detail.code}</span>}{detail.location&&<span>{detail.location}</span>}{exitCode!==undefined&&<span>退出码 {exitCode}</span>}</div></div>;
}
function Collection({items,kind}:{items:unknown[];kind:'skills'|'servers'|'tools'|'resources'|'prompts'}){
  const [all,setAll]=useState(false);
  const states:Record<string,string>={disabled:'未启用',available:'可用',connected:'已连接',connecting:'连接中',error:'连接失败','needs-config':'需要配置'};
  if(!items.length)return <p className="detail-empty">没有找到{kind==='skills'?'匹配技能':kind==='tools'?'可用工具':kind==='servers'?'可用服务':kind==='prompts'?'提示模板':'资源'}</p>;
  return <div className="detail-collection">{(all?items:items.slice(0,6)).map((item,index)=>{const entry=objectValue(item),source=objectValue(entry.source),parameters=kind==='tools'?parameterRows(entry.inputSchema):[];const name=textValue(entry.title)||textValue(entry.name)||'未命名';return <article className="detail-collection-item" key={index}><div className="detail-collection-title"><Icon name={kind==='skills'?'book':kind==='servers'?'globe':kind==='tools'?'terminal':'file'} size={15}/><strong>{name}</strong>{kind==='servers'?<span className={`detail-badge ${entry.enabled?'enabled':''}`}>{states[textValue(entry.status)]||(entry.enabled?'已启用':'未启用')}</span>:textValue(source.label)&&<span className="detail-source">{textValue(source.label)}</span>}</div>{textValue(entry.description)&&<p>{textValue(entry.description)}</p>}{kind==='servers'&&<div className="detail-service-location"><span>{textValue(source.label)}</span><span>{entry.transport==='stdio'?'在本机运行':textValue(entry.endpoint)||'远程服务'}</span></div>}{parameters.length>0&&<details className="detail-parameters"><summary>{parameters.length} 个输入参数<Icon name="down" size={12}/></summary><div>{parameters.map(parameter=><div className="detail-parameter" key={parameter.name}><strong>{parameter.name}</strong><span>{parameter.type}</span>{parameter.required&&<small>必填</small>}{parameter.description&&<p>{parameter.description}</p>}{parameter.choices.length>0&&<p>可选：{parameter.choices.join('、')}</p>}</div>)}</div></details>}{kind==='resources'&&textValue(entry.uri)&&<span className="detail-resource-uri">{textValue(entry.uri)}</span>}</article>;})}{items.length>6&&<button className="detail-show-more" onClick={()=>setAll(!all)}>{all?'收起列表':`查看其余 ${items.length-6} 项`}<Icon name="down" size={12}/></button>}</div>;
}
function McpContent({result}:{result:Record<string,unknown>}){
  const parts=mcpResultParts(result);
  return <>{parts.structured!==undefined&&<DataView value={parts.structured}/>} {parts.content.map((block,index)=>{
    if(block.type==='text')return <div className="detail-mcp-text" key={index}><TextPreview text={textValue(block.text)} name="result.md"/></div>;
    if(block.type==='resource'){const resource=objectValue(block.resource);return <Section key={index} title={textValue(resource.uri)||'服务资源'}>{typeof resource.text==='string'?<TextPreview text={resource.text}/>:<p className="detail-muted">返回了文件资源{resource.mimeType?` · ${textValue(resource.mimeType)}`:''}</p>}</Section>;}
    if(block.type==='resource_link')return <div className="detail-linked-resource" key={index}><Icon name="file" size={17}/><div><strong>{textValue(block.name)||'文件资源'}</strong><span>{textValue(block.description)||textValue(block.uri)}</span></div></div>;
    return <p className="detail-muted" key={index}>{block.type==='image'?'返回了图像':block.type==='audio'?'返回了音频':'返回了附加资源'}</p>;
  })}{parts.structured===undefined&&!parts.content.length&&<p className="detail-empty">工具没有返回额外内容</p>}</>;
}
function ResultBody({message,value}:{message:ChatMessage;value:unknown}){
  const result=objectValue(value),tool=message.tool,display=toolDisplay(message),output=cleanConsole(textValue(result.stdout));
  if(message.status==='running')return <div className="detail-pending"><span className="activity-spinner"/>正在等待操作结果…</div>;
  if(message.status==='failed'||result.isError||result.error||typeof result.exitCode==='number'&&result.exitCode!==0){const error=textValue(result.stderr)||textValue(result.error)||textValue(objectValue(result.error).message)||arrayValue(result.content).map(block=>textValue(objectValue(block).text)).join('\n')||'操作没有完成';return <><ErrorDetails error={error} exitCode={typeof result.exitCode==='number'?result.exitCode:undefined}/>{output&&<Section title="已产生的输出"><TextPreview text={output}/></Section>}</>;}
  if(tool==='history_search'||tool==='history_read')return <><DetailHeader icon="search" title={tool==='history_search'?'找到的历史记录':'回查的历史内容'} meta={`${arrayValue(value).length} 条`}/><div className="detail-collection">{arrayValue(value).map((item,index)=>{const record=objectValue(item),raw=textValue(record.excerpt||record.content),parsed=objectValue(parsedText(raw)),payload=objectValue(parsed.result||parsed);const text=record.role==='tool'?textValue(payload.stdout||payload.error)||'已定位到这一步的执行记录。':raw;return <article className="detail-collection-item" key={index}><div className="detail-collection-title"><Icon name={record.role==='tool'?'terminal':'book'} size={15}/><strong>{record.role==='user'?'用户要求':record.role==='tool'?toolOperation(textValue(record.tool)).label:'历史答复'}</strong>{textValue(record.time)&&<span className="detail-source">{new Date(textValue(record.time)).toLocaleString('zh-CN')}</span>}</div><p>{text}</p></article>;})}</div></>;
  if(tool==='skill_file_read'||tool==='file_read'||tool==='host_file_read'){
    const path=textValue(result.path)||display.detail||'',name=fileName(path)||'文件内容',content=tool==='skill_file_read'||tool==='host_file_read'?textValue(result.content):textValue(result.stdout);
    return <><DetailHeader icon="file" title={name} subtitle={path.includes('/')?path:undefined} meta={`${content.split('\n').filter((line,index,list)=>index<list.length-1||line).length} 行`} action={content?<CopyText value={content} label="复制内容"/>:undefined}/><Section><TextPreview text={content} name={name}/></Section></>;
  }
  if(tool==='skill_materialize')return <><DetailHeader icon="folder" title={textValue(result.name)||'技能文件'} subtitle="已同步到工作电脑" meta={`${arrayValue(result.files).length} 个文件`}/><FileList files={result.files}/>{textValue(result.vmPath)&&<footer className="detail-location"><span><Icon name="computer" size={14}/>工作电脑中的技能副本</span><CopyText value={textValue(result.vmPath)} label="复制目录"/></footer>}</>;
  if(tool==='skill_read')return <><DetailHeader icon="book" title={textValue(result.name)||'技能说明'} subtitle={textValue(objectValue(result.source).label)}/>{textValue(result.description)&&<p className="detail-description">{textValue(result.description)}</p>}<Section><TextPreview text={textValue(result.body)} name="SKILL.md"/></Section><FileList files={result.availableFiles}/></>;
  if(tool==='skill_save')return <DetailHeader icon="book" title={textValue(result.name)||display.detail||'技能已保存'} subtitle="已保存到这个 Bot 的私有技能库" action={textValue(result.path)?<CopyText value={textValue(result.path)} label="复制位置"/>:undefined}/>;
  if(tool==='skills_list')return <><DetailHeader icon="book" title="匹配的技能" meta={`${arrayValue(value).length} 项`}/><Collection items={arrayValue(value)} kind="skills"/></>;
  if(tool==='mcp_list_servers')return <><DetailHeader icon="globe" title="可用服务" subtitle="按需连接已启用的服务" meta={`${arrayValue(value).length} 项`}/><Collection items={arrayValue(value)} kind="servers"/></>;
  if(tool==='mcp_list_tools')return <><DetailHeader icon="globe" title={textValue(result.name)||'外部服务'} subtitle={textValue(result.location).replace(/ · Windows 本机$/,' · 本机')} meta={`${arrayValue(result.tools).length} 个工具`}/><Collection items={arrayValue(result.tools)} kind="tools"/></>;
  if(tool==='mcp_call')return <><DetailHeader icon="globe" title={textValue(result.tool)||display.detail||'外部工具'} subtitle="工具返回结果"/><Section><McpContent result={result}/></Section></>;
  if(tool==='mcp_list_resources'||tool==='mcp_list_prompts'){const resources=tool==='mcp_list_resources';return <><DetailHeader icon="book" title={resources?'服务资源':'提示模板'} meta={`${arrayValue(result[resources?'resources':'prompts']).length} 项`}/><Collection items={arrayValue(result[resources?'resources':'prompts'])} kind={resources?'resources':'prompts'}/></>;}
  if(tool==='mcp_read_resource')return <>{arrayValue(result.contents).map((item,index)=>{const resource=objectValue(item);return <div key={index}><DetailHeader icon="file" title={fileName(textValue(resource.uri))||'服务资源'}/><Section>{typeof resource.text==='string'?<TextPreview text={resource.text}/>:<p className="detail-muted">返回了二进制资源 · {textValue(resource.mimeType)||'文件'}</p>}</Section></div>;})}</>;
  if(tool==='mcp_get_prompt')return <><DetailHeader icon="book" title="提示模板内容" subtitle={textValue(result.description)}/>{arrayValue(result.messages).map((item,index)=><Section key={index}><McpContent result={{content:[objectValue(item).content]}}/></Section>)}</>;
  if(tool==='memory')return result.duplicate?<DetailHeader icon="book" title="已有这条记忆" subtitle="保留原有内容，没有重复保存"/>:<><DetailHeader icon="book" title="长期记忆已更新" meta={`${arrayValue(result.memories).length} 项`}/><Section><DataView value={arrayValue(result.memories)}/></Section></>;
  if(tool==='host_file_write')return <DetailHeader icon="file" title={fileName(textValue(result.path))||'文件已保存'} subtitle={textValue(result.path)} meta="本机"/>;
  if(tool==='file_write'){const file=objectValue(parsedText(output));return <DetailHeader icon="file" title={fileName(textValue(file.path))||display.detail||'文件已保存'} subtitle="已保存到工作电脑" meta={typeof file.bytes==='number'?bytes(file.bytes):undefined}/>;}
  if(tool==='computer'||tool==='request_user_control')return <p className="detail-computer-caption">{message.screenshotId?'操作后的电脑画面，可点击放大查看。':'电脑操作已结束。'}</p>;
  if(tool==='python_execute'||tool==='computer_execute'||tool==='host_execute')return <><DetailHeader icon="terminal" title={tool==='host_execute'?'本机命令完成':'运行成功'} subtitle={tool==='host_execute'?textValue(result.cwd):undefined} meta={typeof result.durationMs==='number'?`${(result.durationMs/1000).toFixed(1)} 秒`:undefined}/><Section>{output?<TextPreview text={output}/>:<p className="detail-empty">本次运行没有文本输出</p>}{textValue(result.stderr)&&<details className="detail-additional-output"><summary>附加输出</summary><TextPreview text={cleanConsole(textValue(result.stderr))}/></details>}</Section></>;
  if(tool==='read_result')return <><DetailHeader icon="check" title="执行记录"/><Section><TextPreview text={textValue(result.text)}/></Section></>;
  return <><DetailHeader icon="file" title="操作结果"/><Section>{value===undefined?<p className="detail-muted">结果暂时无法预览，工作记录已保留。</p>:<DataView value={value}/>}</Section></>;
}
export function ToolDetails({message}:{message:ChatMessage}){
  const initial=toolResult(message),truncated=objectValue(initial).truncated===true;
  const [loaded,setLoaded]=useState<{id:string;value:unknown}>(),[error,setError]=useState('');
  useEffect(()=>{if(!truncated)return;let active=true;setError('');if(!window.aelion?.readToolResult){setError('结果较长，需要重新打开客户端后查看完整内容。');return;}window.aelion.readToolResult({botId:message.botId,messageId:message.id}).then(value=>{if(active)setLoaded({id:message.id,value});}).catch(()=>{if(active)setError('这项结果暂时无法预览，完整记录仍保留在本地。');});return()=>{active=false;};},[message.id,truncated]);
  return <div className="tool-detail">{truncated&&loaded?.id!==message.id?<p className="detail-pending">{error||'正在读取完整结果…'}</p>:<ResultBody message={message} value={truncated?loaded?.value:initial}/>}</div>;
}
