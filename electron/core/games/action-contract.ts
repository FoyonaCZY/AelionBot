import type {GameRequest} from '../../../src/game-types';
type Field={type:'string'|'boolean';enum?:string[];minLength?:number;maxLength?:number};
export function actionContract(r:GameRequest){
 const properties:Record<string,Field>={note:{type:'string',maxLength:500},personalityNote:{type:'string',maxLength:200}};
 const branch=(required:string[],fields:Record<string,Field>)=>({type:'object' as const,required,properties:{...fields,...Object.fromEntries(['note','personalityNote'].map(k=>[k,properties[k]]))},additionalProperties:false as const});
 let variants:string[][];
 let description='只提交本轮字段。禁止 type、action、kind。';
 if(['speak','wolf_plan','campaign','pk_speak','last_words'].includes(r.kind)){properties.text={type:'string',minLength:1,maxLength:800};variants=[['text']];description='只返回 text。禁止 type、action、kind。';}
 else if(['sheriff_join','withdraw'].includes(r.kind)){properties.choice={type:'boolean'};variants=[['choice']];description='只返回 choice:true 或 choice:false。禁止 type。';}
 else if(r.kind==='sheriff_order'){properties.direction={type:'string',enum:['clockwise','counterclockwise']};variants=[['direction']];description='只返回 direction 为 clockwise 或 counterclockwise。禁止 type 和 choice。';}
 else if(r.kind==='witch'){
  const idle=['skip',...(r.witch?.canSave?['save']:[])];
  const poison=Boolean(r.witch?.canPoison);
  properties.potion={type:'string',enum:[...idle,...(poison?['poison']:[])]};
  const target:Field={type:'string',enum:r.targets};
  if(poison)properties.target=target;
  const oneOf=[branch(['potion'],{potion:{type:'string',enum:idle}}),...(poison?[branch(['potion','target'],{potion:{type:'string',enum:['poison']},target})]:[])];
  return {type:'object' as const,additionalProperties:false as const,properties,oneOf,description:'用毒必须同时提交 potion="poison" 和 target，target 从 request.targets 原样复制 id，不能省略，也不能写成座位号或玩家名。save 和 skip 只提交 potion，禁止带 target。禁止 type、action、kind。'};
 }
 else{properties.target={type:'string',enum:r.targets};variants=[['target']];description='只提交 target，值必须是 request.targets 中的 id 原文。禁止 type、action、kind、role。';if(['vote','sheriff_vote','guard','shoot','badge'].includes(r.kind)){properties.skip={type:'boolean'};variants.push(['skip']);description='要么只提交 target（request.targets 中的 id），要么只提交 skip:true。不要同时提交。禁止 type、action、kind。';}}
 return {type:'object' as const,additionalProperties:false as const,properties,oneOf:variants.map(required=>branch(required,Object.fromEntries(required.map(k=>[k,properties[k]])))),description};
}
export function checkActionContract(a:Record<string,unknown>,r:GameRequest){
 const schema=actionContract(r);
 for(const [key,value] of Object.entries(a)){const f=schema.properties[key];if(!f)throw Error(`本轮 ${r.kind} 不允许字段 ${key}。不要输出 type、action 或 kind`);if(typeof value!==f.type)throw Error(`${key} 必须为 ${f.type}`);if(typeof value==='string'&&(f.enum&&!f.enum.includes(value)||f.minLength!==undefined&&value.trim().length<f.minLength||f.maxLength!==undefined&&value.length>f.maxLength))throw Error(`${key} 不符合本轮允许值或长度`);}
 const keys=Object.keys(a).filter(k=>!['note','personalityNote'].includes(k));
 if(!schema.oneOf.some(v=>keys.length===v.required.length&&v.required.every(k=>keys.includes(k))))throw Error('缺少本轮动作字段，或同时提交了多个动作');
 if('skip'in a&&a.skip!==true)throw Error('跳过动作必须为 skip:true');
 if(r.kind==='witch'&&a.potion==='poison'&&!('target'in a))throw Error('仅使用毒药时必须携带 target，写成 {"potion":"poison","target":"request.targets 中的 id"}');
 if(r.kind==='witch'&&a.potion!=='poison'&&('target'in a))throw Error('save 和 skip 不能携带 target，只有 poison 才带 target');
}
