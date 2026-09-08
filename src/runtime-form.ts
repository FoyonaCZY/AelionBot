import {DEFAULT_RUNTIME,type RuntimeSettings} from './runtime-types';

export type RuntimeNumberKey=keyof Omit<RuntimeSettings,'fileCheckpoints'>;
export interface RuntimeField {key:RuntimeNumberKey;label:string;hint:string;unit:string;min:number;max:number;factor?:number;stepper?:boolean;}
export const RUNTIME_FIELDS:readonly RuntimeField[]=[
  {key:'maxTurns',label:'执行轮数',hint:'0 表示不限',unit:'轮',min:0,max:10000},
  {key:'maxMinutes',label:'最长执行时间',hint:'0 表示不限',unit:'分钟',min:0,max:1440},
  {key:'maxTokens',label:'模型用量',hint:'0 表示不限',unit:'Token',min:0,max:10000000},
  {key:'requestTimeoutMs',label:'请求超时',hint:'单次请求的等待时间',unit:'秒',min:1,max:600,factor:1000},
  {key:'modelRetries',label:'失败重试',hint:'0 表示不重试',unit:'次',min:0,max:5,stepper:true},
  {key:'maxOutputTokens',label:'单次输出上限',hint:'每次模型响应的输出量',unit:'Token',min:256,max:65536},
  {key:'parallelReads',label:'并行读取',hint:'同时执行的只读操作',unit:'项',min:1,max:8,stepper:true},
  {key:'progressSeconds',label:'进度汇报间隔',hint:'两次进度消息的最短间隔',unit:'秒',min:15,max:600},
];
export interface RuntimeDraft {numbers:Record<RuntimeNumberKey,string>;fileCheckpoints:boolean;}
export function runtimeDraft(settings:RuntimeSettings):RuntimeDraft{
  return {numbers:Object.fromEntries(RUNTIME_FIELDS.map(field=>[field.key,String(settings[field.key]/(field.factor||1))])) as RuntimeDraft['numbers'],fileCheckpoints:settings.fileCheckpoints};
}
export function runtimeFieldValid(field:RuntimeField,raw:string){
  const value=Number(raw),stored=value*(field.factor||1);
  return raw.trim()!==''&&Number.isFinite(value)&&value>=field.min&&value<=field.max&&Math.abs(stored-Math.round(stored))<.000001;
}
export function runtimeDraftValues(draft:RuntimeDraft):RuntimeSettings|undefined{
  if(RUNTIME_FIELDS.some(field=>!runtimeFieldValid(field,draft.numbers[field.key])))return;
  const result={...DEFAULT_RUNTIME,fileCheckpoints:draft.fileCheckpoints};
  for(const field of RUNTIME_FIELDS)result[field.key]=Math.round(Number(draft.numbers[field.key])*(field.factor||1));
  return result;
}
