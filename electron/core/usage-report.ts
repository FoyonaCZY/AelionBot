import {reportedTotal,type UsageRecord} from '../../src/runtime-types';
import type {UsageQuery,UsageReport,UsageTotals,UsageGroup} from '../../src/usage-types';

export const localDay=(date:Date)=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
function dateValue(value:unknown){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw Error('请选择有效日期');
  const date=new Date(value+'T00:00:00');if(!Number.isFinite(date.getTime())||localDay(date)!==value)throw Error('请选择有效日期');return date;
}
const empty=():UsageTotals=>({requests:0,failedRequests:0,reportedRequests:0,missingUsage:0,totalTokens:0,inputTokens:0,outputTokens:0,cachedTokens:0,cacheWriteTokens:0,reasoningTokens:0,inputReports:0,outputReports:0,cacheReports:0,cacheWriteReports:0,reasoningReports:0,cacheInputTokens:0});
const valid=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
function add(total:UsageTotals,record:UsageRecord){
  total.requests++;if(record.error)total.failedRequests++;
  const usage=record.usage,sum=reportedTotal(usage);
  if(valid(sum)){total.reportedRequests++;total.totalTokens+=sum;}else total.missingUsage++;
  if(valid(usage?.inputTokens)){total.inputTokens+=usage.inputTokens;total.inputReports++;}
  if(valid(usage?.outputTokens)){total.outputTokens+=usage.outputTokens;total.outputReports++;}
  // Old releases defaulted an absent cache field to zero. Its meaning cannot be reconstructed.
  if(valid(usage?.cachedTokens)&&(usage.version===2||usage.cachedTokens>0)&&valid(usage.inputTokens)&&usage.cachedTokens<=usage.inputTokens){total.cachedTokens+=usage.cachedTokens;total.cacheInputTokens+=usage.inputTokens;total.cacheReports++;}
  if(valid(usage?.cacheWriteTokens)){total.cacheWriteTokens+=usage.cacheWriteTokens;total.cacheWriteReports++;}
  if(valid(usage?.reasoningTokens)&&(usage.version===2||usage.reasoningTokens>0)){total.reasoningTokens+=usage.reasoningTokens;total.reasoningReports++;}
}

export function usageReport(records:UsageRecord[],providers:Array<{id:string;name:string}>,input:UsageQuery):UsageReport {
  if(!input||typeof input!=='object')throw Error('用量查询无效');
  const start=dateValue(input.from),last=dateValue(input.to),end=new Date(last);end.setDate(end.getDate()+1);
  if(start>last||end.getTime()-start.getTime()>3661*86400000)throw Error('日期范围需按先后顺序，最长十年');
  if(!['hour','day','month'].includes(input.granularity)||input.granularity==='hour'&&end.getTime()-start.getTime()>32*86400000)throw Error('按小时展示最多支持 31 天');
  for(const key of ['providerId','model','purpose'] as const)if(input[key]!==undefined&&(typeof input[key]!=='string'||input[key]!.length>256))throw Error('用量筛选条件无效');
  const query={...input},names=new Map(providers.map(provider=>[provider.id,provider.name]));
  const key=(date:Date)=>query.granularity==='month'?localDay(date).slice(0,7):localDay(date)+(query.granularity==='hour'?' '+String(date.getHours()).padStart(2,'0')+':00':'');
  const buckets=new Map<string,UsageTotals>(),providerOptions=new Map<string,string>(),modelOptions=new Set<string>(),purposes=new Set<string>(),byProvider=new Map<string,UsageGroup>(),byModel=new Map<string,UsageGroup>(),totals=empty();
  const cursor=new Date(start);if(query.granularity==='month')cursor.setDate(1);
  while(cursor<end){buckets.set(key(cursor),empty());if(query.granularity==='month')cursor.setMonth(cursor.getMonth()+1);else if(query.granularity==='hour')cursor.setHours(cursor.getHours()+1);else cursor.setDate(cursor.getDate()+1);}
  const seen=new Set<string>();
  for(const record of records){
    if(seen.has(record.id))continue;seen.add(record.id);
    const date=new Date(record.time);if(!Number.isFinite(date.getTime())||date<start||date>=end)continue;
    const providerId=record.providerId||'legacy',name=names.get(providerId)||record.providerName||(record.providerId?'已删除的 Provider · '+record.providerId.slice(0,8):'早期记录');
    providerOptions.set(providerId,name);if(!query.providerId||query.providerId===providerId)modelOptions.add(record.model);purposes.add(record.purpose);
    if(query.providerId&&providerId!==query.providerId||query.model&&record.model!==query.model||query.purpose&&record.purpose!==query.purpose)continue;
    const bucket=buckets.get(key(date));if(bucket)add(bucket,record);add(totals,record);
    if(!byProvider.has(providerId))byProvider.set(providerId,{...empty(),key:providerId,name,providerId});add(byProvider.get(providerId)!,record);
    const modelKey=JSON.stringify([providerId,record.model]);if(!byModel.has(modelKey))byModel.set(modelKey,{...empty(),key:modelKey,name,providerId,model:record.model});add(byModel.get(modelKey)!,record);
  }
  const sorted=(groups:Map<string,UsageGroup>)=>[...groups.values()].sort((a,b)=>b.totalTokens-a.totalTokens||b.requests-a.requests||a.key.localeCompare(b.key));
  return {query,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,totals,buckets:[...buckets].map(([key,value])=>({key,...value})),byProvider:sorted(byProvider),byModel:sorted(byModel),providers:[...providerOptions].map(([id,name])=>({id,name})).sort((a,b)=>a.name.localeCompare(b.name)),models:[...modelOptions].sort(),purposes:[...purposes].sort()};
}
