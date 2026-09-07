import test from 'node:test';
import assert from 'node:assert/strict';
import {usageReport} from '../electron/core/usage-report';
import {modelUsage} from '../electron/core/model-usage';
import {StreamAccumulator} from '../electron/core/model-protocol';
import type {UsageRecord} from '../src/runtime-types';

test('all protocols retain cache read/write, actual totals and unknown values',()=>{
  const response=modelUsage('responses',{input_tokens:1000,output_tokens:50,total_tokens:1050,input_tokens_details:{cached_tokens:800,cache_write_tokens:100},output_tokens_details:{reasoning_tokens:20}})!;
  assert.equal(response.cachedTokens,800);assert.equal(response.cacheWriteTokens,100);assert.equal(response.totalTokens,1050);assert.equal(response.reasoningTokens,20);
  const missing=modelUsage('chat',{prompt_tokens:20,completion_tokens:10})!;assert.equal(missing.totalTokens,30);assert.equal(missing.cachedTokens,undefined);assert.equal(modelUsage('chat',{prompt_tokens:NaN}),undefined);
  assert.equal(modelUsage('chat',{prompt_tokens:20,completion_tokens:10,prompt_tokens_details:{cached_tokens:0}})?.cachedTokens,0);
  const gemini=modelUsage('gemini',{promptTokenCount:200,candidatesTokenCount:30,thoughtsTokenCount:10,cachedContentTokenCount:80,totalTokenCount:240})!;assert.equal(gemini.outputTokens,40);assert.equal(gemini.totalTokens,240);
});

test('streaming usage accumulates fields without counting cumulative events twice',()=>{
  const claude=new StreamAccumulator('anthropic','test',()=>{});
  claude.consume({type:'message_start',message:{usage:{input_tokens:20,cache_read_input_tokens:80,cache_creation_input_tokens:10,output_tokens:1}}});
  claude.consume({type:'message_delta',delta:{},usage:{output_tokens:10}});claude.consume({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:30}});
  assert.equal(claude.usage?.inputTokens,110);assert.equal(claude.usage?.outputTokens,30);assert.equal(claude.usage?.totalTokens,140);assert.equal(claude.usage?.cacheWriteTokens,10);
  const chat=new StreamAccumulator('chat','test',()=>{});chat.consume({usage:{prompt_tokens:100,completion_tokens:5,prompt_tokens_details:{cached_tokens:50}},choices:[]});chat.consume({usage:{prompt_tokens:100,completion_tokens:20,prompt_tokens_details:{cached_tokens:50}},choices:[]});assert.equal(chat.usage?.totalTokens,120);assert.equal(chat.usage?.cachedTokens,50);
});

test('partial usage updates retain previous cache and reasoning components',()=>{
  const first=modelUsage('anthropic',{input_tokens:20,cache_read_input_tokens:80,cache_creation_input_tokens:10,output_tokens:1});
  const next=modelUsage('anthropic',{input_tokens:25,output_tokens:30},first)!;assert.equal(next.inputTokens,115);assert.equal(next.totalTokens,145);
  const more=modelUsage('anthropic',{cache_read_input_tokens:90},next)!;assert.equal(more.inputTokens,125);assert.equal(more.totalTokens,155);
  const gemini=modelUsage('gemini',{promptTokenCount:200,candidatesTokenCount:30,thoughtsTokenCount:10,totalTokenCount:245});
  const thinking=modelUsage('gemini',{thoughtsTokenCount:20},gemini)!;assert.equal(thinking.outputTokens,50);assert.equal(thinking.totalTokens,255);
  assert.equal(modelUsage('gemini',{cachedContentTokenCount:100},thinking)?.totalTokens,255);
  assert.equal(modelUsage('gemini',{thoughtsTokenCount:20})?.outputTokens,undefined);
});

const query={from:'2026-02-01',to:'2026-02-03',granularity:'day' as const};
const row=(id:string,time:string,patch:Partial<UsageRecord>={}):UsageRecord=>({id,time,purpose:'foreground',model:'shared-model',providerId:'a',usage:{version:2,inputTokens:100,outputTokens:20,cachedTokens:80},...patch});

test('full-history reporting uses local inclusive dates, fills gaps and avoids cache double counting',()=>{
  const records=Array.from({length:130},(_,index)=>row(String(index),'2026-02-01T12:00:00'));
  records.push(row('end','2026-02-03T23:59:59'),row('outside','2026-02-04T00:00:00'),row('bad-date','not a date'),records[0]);
  const report=usageReport(records,[{id:'a',name:'Alpha'}],query);
  assert.equal(report.totals.requests,131);assert.equal(report.totals.totalTokens,131*120);assert.equal(report.totals.cachedTokens,131*80);
  assert.equal(report.buckets.length,3);assert.equal(report.buckets[1].requests,0);assert.equal(report.buckets[2].requests,1);
  assert.equal(report.byProvider[0].name,'Alpha');assert.equal(report.totals.cacheInputTokens,131*100);
});

test('provider/model/purpose filters preserve identity and exclude unknown cache counters from hit rates',()=>{
  const records=[row('1','2026-02-01T12:00:00'),row('2','2026-02-01T12:00:00',{providerId:'b',providerName:'Removed provider',purpose:'permission_review',usage:{version:2,inputTokens:900,outputTokens:100,cachedTokens:0}}),row('3','2026-02-01T12:00:00',{usage:{inputTokens:500,outputTokens:20,cachedTokens:0}}),row('4','2026-02-01T12:00:00',{usage:undefined,error:'connection failed',estimatedTokens:100000})];
  const all=usageReport(records,[{id:'a',name:'Alpha'}],query);
  assert.equal(all.byModel.length,2);assert.equal(all.totals.cacheReports,2);assert.equal(all.totals.cacheInputTokens,1000);assert.equal(all.totals.missingUsage,1);assert.equal(all.totals.totalTokens,1640);assert.equal(all.totals.failedRequests,1);
  assert.equal(all.byProvider.find(row=>row.providerId==='b')?.name,'Removed provider');
  const filtered=usageReport(records,[],{...query,providerId:'b',model:'shared-model',purpose:'permission_review'});assert.equal(filtered.totals.requests,1);assert.equal(filtered.totals.cachedTokens,0);assert.equal(filtered.totals.totalTokens,1000);
  const empty=usageReport(records,[],{...query,model:'unknown-model'});assert.equal(empty.totals.requests,0);assert.equal(empty.buckets.length,3);
});

test('usage ranges validate real dates and aggregate hour/month boundaries',()=>{
  assert.throws(()=>usageReport([],[],{...query,from:'2026-02-30'}),/有效日期/);assert.throws(()=>usageReport([],[],{...query,to:'2026-01-01'}),/日期范围/);
  const records=[row('1','2026-02-01T00:00:00'),row('2','2026-02-01T23:59:59')],hours=usageReport(records,[],{...query,to:query.from,granularity:'hour'});assert.equal(hours.buckets.length,24);assert.equal(hours.buckets[23].requests,1);
  const months=usageReport(records,[],{...query,from:'2026-01-15',to:'2026-03-10',granularity:'month'});assert.deepEqual(months.buckets.map(bucket=>bucket.key),['2026-01','2026-02','2026-03']);
});
