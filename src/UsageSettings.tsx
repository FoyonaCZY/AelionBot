import {useEffect,useState} from 'react';
import {Select} from './Select';
import type {Snapshot} from './shared';
import type {UsageBucket,UsageGroup,UsageQuery,UsageReport,UsageTotals} from './usage-types';
import './usage-settings.css';

const day=(value:Date)=>`${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`;
function range(days:number){const to=new Date(),from=new Date(to);from.setDate(from.getDate()-days+1);return {from:day(from),to:day(to)};}
const number=(value:number)=>value.toLocaleString('zh-CN');
const compact=(value:number)=>new Intl.NumberFormat('zh-CN',{notation:'compact',maximumFractionDigits:1}).format(value);
const percent=(value:UsageTotals)=>value.cacheReports&&value.cacheInputTokens?`${(value.cachedTokens/value.cacheInputTokens*100).toFixed(1)}%`:'—';
const purposes:Record<string,string>={foreground:'任务执行',permission_review:'权限审核',background_review:'后台整理',progress:'进度说明',greeting:'问候'};
type Metric='totalTokens'|'inputTokens'|'outputTokens'|'cachedTokens';
const metricNames:Record<Metric,string>={totalTokens:'总 tokens',inputTokens:'输入 tokens',outputTokens:'输出 tokens',cachedTokens:'缓存读取 tokens'};
function metricValue(row:UsageTotals,metric:Metric){const reports=metric==='totalTokens'?row.reportedRequests:metric==='inputTokens'?row.inputReports:metric==='outputTokens'?row.outputReports:row.cacheReports;return !row.requests||reports?row[metric]:undefined;}

function UsageTimeline({buckets,metric}:{buckets:UsageBucket[];metric:Metric}){
  const [selected,setSelected]=useState<number>();
  useEffect(()=>setSelected(undefined),[buckets,metric]);
  const width=700,height=206,left=47,right=14,top=18,bottom=31,plotWidth=width-left-right,plotHeight=height-top-bottom;
  const maximum=Math.max(1,...buckets.map(row=>metricValue(row,metric)||0)),step=10**Math.floor(Math.log10(maximum))/5,ceiling=Math.ceil(maximum/step)*step;
  const x=(index:number)=>left+(index+.5)*plotWidth/Math.max(1,buckets.length),y=(value:number)=>top+plotHeight*(1-value/ceiling);
  let drawing=false;const path=buckets.map((row,index)=>{const value=metricValue(row,metric);if(value===undefined){drawing=false;return '';}const point=`${drawing?'L':'M'}${x(index)},${y(value)}`;drawing=true;return point;}).join(' ');
  const selectedRow=selected===undefined?undefined:buckets[selected],selectedValue=selectedRow?metricValue(selectedRow,metric):undefined;
  const labelIndices=[...new Set([0,Math.floor((buckets.length-1)/2),buckets.length-1])].filter(index=>index>=0);
  return <div className="usage-timeline">
    <div className="usage-chart-detail" aria-live="polite">{selectedRow?<><span>{selectedRow.key}</span><strong>{selectedValue===undefined?'未返回用量':`${number(selectedValue)} tokens`}</strong><span>{selectedRow.requests} 次请求</span></>:<span>悬停或使用键盘查看各时段</span>}</div>
    <svg viewBox={`0 0 ${width} ${height}`} role="group" aria-label={`${metricNames[metric]}时间趋势`} onMouseLeave={()=>setSelected(undefined)}>
      {[0,.5,1].map(fraction=><g key={fraction}><line x1={left} x2={width-right} y1={y(ceiling*fraction)} y2={y(ceiling*fraction)} stroke="#e8e8ec" strokeDasharray={fraction?'3 5':undefined}/><text x={left-9} y={y(ceiling*fraction)+4} textAnchor="end" className="usage-axis">{compact(ceiling*fraction)}</text></g>)}
      <path d={path} fill="none" stroke="#8571c8" strokeWidth="2.5" strokeLinejoin="round"/>
      {buckets.length===1&&metricValue(buckets[0],metric)!==undefined&&<circle cx={x(0)} cy={y(metricValue(buckets[0],metric)!)} r={4} fill="#8571c8"/>}
      {selected!==undefined&&selectedValue!==undefined&&<g><line x1={x(selected)} x2={x(selected)} y1={top} y2={height-bottom} stroke="#b8acd8" strokeDasharray="3 4"/><circle cx={x(selected)} cy={y(selectedValue)} r={4} fill="#8571c8" stroke="#fcfcfc" strokeWidth={2}/></g>}
      {labelIndices.map(index=><text key={index} x={x(index)} y={height-8} textAnchor={index===0?'start':index===buckets.length-1?'end':'middle'} className="usage-axis">{buckets[index].key}</text>)}
      {buckets.map((row,index)=><rect key={row.key} x={left+index*plotWidth/buckets.length} y={top} width={plotWidth/buckets.length} height={plotHeight} fill="transparent" tabIndex={index===(selected??0)?0:-1} role="button" aria-label={`${row.key}，${metricNames[metric]} ${metricValue(row,metric)===undefined?'未返回':number(row[metric])}，${row.requests} 次请求`} onMouseEnter={()=>setSelected(index)} onFocus={()=>setSelected(index)} onBlur={()=>setSelected(undefined)} onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buckets.length-1:Math.max(0,Math.min(buckets.length-1,index+(event.key==='ArrowRight'?1:-1)));(event.currentTarget.parentElement?.querySelectorAll('rect')[next] as SVGElement)?.focus();}}/>)}
    </svg>
  </div>;
}

function Breakdown({title,groups,onChoose,model=false}:{title:string;groups:UsageGroup[];onChoose:(row:UsageGroup)=>void;model?:boolean}){
  const [expanded,setExpanded]=useState(false),maximum=Math.max(1,...groups.map(row=>row.totalTokens));
  return <section className="usage-breakdown"><h3>{title}</h3>{groups.length?((expanded?groups:groups.slice(0,6)).map(row=><button type="button" className="usage-bar-row" key={row.key} onClick={()=>onChoose(row)} aria-label={`筛选${model?'模型':'Provider'} ${model?row.model+' · ':''}${row.name}`}><span className="usage-bar-label"><span title={model?row.model:row.name}>{model?row.model:row.name}</span>{model&&<small title={row.name}>{row.name}</small>}</span><span className="usage-bar-track"><i style={{width:`${row.totalTokens/maximum*100}%`}}/></span><span className="usage-bar-value">{row.reportedRequests?compact(row.totalTokens):'—'}</span></button>)):<p className="usage-empty-small">暂无记录</p>}{groups.length>6&&<button type="button" className="text-button" onClick={()=>setExpanded(value=>!value)}>{expanded?'收起':`展开全部 ${groups.length} 项`}</button>}</section>;
}

export function UsageSettings({state}:{state:Snapshot}){
  const [preset,setPreset]=useState('30'),[query,setQuery]=useState<UsageQuery>(()=>({...range(30),granularity:'day'})),[metric,setMetric]=useState<Metric>('totalTokens'),[report,setReport]=useState<UsageReport>(),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
  const revision=state.modelUsage?.at(-1)?.id,providerRevision=(state.providers||[]).map(provider=>provider.id+provider.name).join('|');
  useEffect(()=>{let active=true;setError('');const timer=setTimeout(()=>{void window.aelion.queryUsage(query).then(value=>{if(active)setReport(value);}).catch(error=>{if(active)setError(String(error.message).replace(/^Error invoking remote method '[^']+': Error: /,''));});},120);return()=>{active=false;clearTimeout(timer);};},[JSON.stringify(query),revision,providerRevision,refresh]);
  const update=(patch:Partial<UsageQuery>)=>setQuery(value=>{const next={...value,...patch};if(next.granularity==='hour'&&new Date(next.to).getTime()-new Date(next.from).getTime()>30*86400000)next.granularity='day';return next;});
  const reset=()=>{setPreset('30');setQuery({...range(30),granularity:'day'});};
  const totals=JSON.stringify(report?.query)===JSON.stringify(query)?report?.totals:undefined;
  return <div className="usage-settings">
    <div className="usage-filters">
      <label><span>时间</span><Select aria-label="用量时间范围" value={preset} onChange={event=>{const value=event.target.value;setPreset(value);if(value!=='custom')update({...range(Number(value)),granularity:value==='1'?'hour':'day'});}}><option value="1">今天</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="90">最近 90 天</option><option value="custom">自定义</option></Select></label>
      <label><span>Provider</span><Select aria-label="用量 Provider" value={query.providerId||''} onChange={event=>update({providerId:event.target.value||undefined,model:undefined})}><option value="">全部 Provider</option>{(report?.providers||state.providers||[]).map(provider=><option key={provider.id} value={provider.id}>{provider.name}</option>)}</Select></label>
      <label><span>模型</span><Select aria-label="用量模型" value={query.model||''} onChange={event=>update({model:event.target.value||undefined})}><option value="">全部模型</option>{[...new Set([...(report?.models||[]),...(query.model?[query.model]:[])])].map(model=><option key={model}>{model}</option>)}</Select></label>
      <label><span>用途</span><Select aria-label="用量用途" value={query.purpose||''} onChange={event=>update({purpose:event.target.value||undefined})}><option value="">全部用途</option>{[...new Set([...(report?.purposes||[]),...(query.purpose?[query.purpose]:[])])].map(purpose=><option key={purpose} value={purpose}>{purposes[purpose]||purpose}</option>)}</Select></label>
    </div>
    {preset==='custom'&&<div className="usage-dates"><label>开始日期<input type="date" aria-label="用量开始日期" value={query.from} onChange={event=>update({from:event.target.value})}/></label><span>—</span><label>结束日期<input type="date" aria-label="用量结束日期" value={query.to} onChange={event=>update({to:event.target.value})}/></label></div>}
    <div className="usage-toolbar"><span>{totals?`${number(totals.requests)} 次请求${totals.failedRequests?` · ${number(totals.failedRequests)} 次失败`:''}`:'正在读取记录…'}</span><div><button type="button" className="text-button" onClick={reset}>重置筛选</button><button type="button" className="text-button" onClick={()=>setRefresh(value=>value+1)}>刷新</button></div></div>
    {error?<div className="usage-query-error" role="alert">{error}</div>:!totals?<div className="usage-loading" role="status">正在统计用量…</div>:<>
      <div className="usage-metrics">
        <div><span>总 tokens</span><strong title={number(totals.totalTokens)}>{totals.reportedRequests||!totals.requests?compact(totals.totalTokens):'—'}</strong><small>{totals.missingUsage?`${totals.missingUsage} 次未返回完整用量`:'服务端报告的用量'}</small></div>
        <div><span>输入</span><strong title={number(totals.inputTokens)}>{totals.inputReports||!totals.requests?compact(totals.inputTokens):'—'}</strong><small>{totals.cacheWriteReports?`缓存写入 ${compact(totals.cacheWriteTokens)}`:'包含已缓存的输入'}</small></div>
        <div><span>输出</span><strong title={number(totals.outputTokens)}>{totals.outputReports||!totals.requests?compact(totals.outputTokens):'—'}</strong><small>{totals.reasoningReports?`其中推理 ${compact(totals.reasoningTokens)}`:'包含已报告的推理用量'}</small></div>
        <div><span>缓存命中率</span><strong>{percent(totals)}</strong><small>{totals.cacheReports?`读取 ${compact(totals.cachedTokens)} tokens`:'未返回缓存明细'}</small></div>
      </div>
      {!totals.requests?<div className="usage-empty"><svg width="42" height="42" viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M7 31h26M11 26V17m9 9V8m9 18V12" stroke="#aaa3bc" strokeWidth="2.5" strokeLinecap="round"/></svg><strong>这段时间还没有用量记录</strong><span>调整筛选，或与 Bot 聊天后再来查看。</span></div>:<>
        <section className="usage-chart-card"><div className="usage-chart-heading"><h3>用量趋势</h3><div><Select aria-label="用量图表指标" value={metric} onChange={event=>setMetric(event.target.value as Metric)}>{Object.entries(metricNames).map(([value,label])=><option key={value} value={value}>{label}</option>)}</Select><Select aria-label="用量时间粒度" value={query.granularity} onChange={event=>update({granularity:event.target.value as UsageQuery['granularity']})}><option value="hour" disabled={(new Date(query.to).getTime()-new Date(query.from).getTime())>30*86400000}>按小时</option><option value="day">按天</option><option value="month">按月</option></Select></div></div><UsageTimeline buckets={report!.buckets} metric={metric}/></section>
        <div className="usage-breakdowns"><Breakdown title="按 Provider" groups={report!.byProvider} onChoose={row=>update({providerId:row.providerId,model:undefined})}/><Breakdown title="按模型" model groups={report!.byModel} onChoose={row=>update({providerId:row.providerId,model:row.model})}/></div>
        <div className="usage-table-wrap"><table className="usage-table"><caption>模型明细</caption><thead><tr><th>模型 / Provider</th><th>请求</th><th>输入</th><th>输出</th><th>缓存读取</th><th>命中率</th></tr></thead><tbody>{report!.byModel.map(row=><tr key={row.key}><td><strong>{row.model}</strong><small>{row.name}</small></td><td>{number(row.requests)}</td><td>{row.inputReports?number(row.inputTokens):'—'}</td><td>{row.outputReports?number(row.outputTokens):'—'}</td><td>{row.cacheReports?number(row.cachedTokens):'—'}</td><td>{percent(row)}</td></tr>)}</tbody></table></div>
        <p className="usage-footnote">时间按 {report!.timeZone} 展示。{totals.cacheReports<totals.requests?`缓存命中率基于 ${totals.cacheReports} 次有缓存明细的请求。早期或未返回的明细不计入比例。`:'缓存命中率为缓存读取 tokens 占对应输入 tokens 的比例。'}{totals.missingUsage>0?' 未返回的完整用量不计入总量。':''}</p>
      </>}
    </>}
  </div>;
}
