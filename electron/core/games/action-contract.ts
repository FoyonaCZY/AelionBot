import type {GameRequest} from '../../../src/game-types';
type Field={type:'string'|'boolean';enum?:string[];minLength?:number;maxLength?:number};
export function actionContract(r:GameRequest){
 const properties:Record<string,Field>={note:{type:'string',maxLength:500},personalityNote:{type:'string',maxLength:200}};
 let variants:string[][];
 if(['speak','wolf_plan','campaign','pk_speak','last_words'].includes(r.kind)){properties.text={type:'string',minLength:1,maxLength:800};variants=[['text']];}
 else if(['sheriff_join','withdraw'].includes(r.kind)){properties.choice={type:'boolean'};variants=[['choice']];}
 else if(r.kind==='sheriff_order'){properties.direction={type:'string',enum:['clockwise','counterclockwise']};variants=[['direction']];}
 else if(r.kind==='witch'){properties.potion={type:'string',enum:['skip',...(r.witch?.canSave?['save']:[]),...(r.witch?.canPoison?['poison']:[])]};properties.target={type:'string',enum:r.targets};variants=[['potion'],['potion','target']];}
 else{properties.target={type:'string',enum:r.targets};variants=[['target']];if(['vote','sheriff_vote','guard','shoot','badge'].includes(r.kind)){properties.skip={type:'boolean'};variants.push(['skip']);}}
 return {type:'object',additionalProperties:false,properties,oneOf:variants.map(required=>({type:'object',required,properties:Object.fromEntries([...required,'note','personalityNote'].map(k=>[k,properties[k]])),additionalProperties:false})),description:r.kind==='witch'?'仅 poison 携带 target；save 和 skip 不带 target。':'只选一个动作分支；skip 必须为 true。'};
}
export function checkActionContract(a:Record<string,unknown>,r:GameRequest){
 const schema=actionContract(r);
 for(const [key,value] of Object.entries(a)){const f=schema.properties[key];if(!f)throw Error(`本轮 ${r.kind} 不允许字段 ${key}`);if(typeof value!==f.type)throw Error(`${key} 必须为 ${f.type}`);if(typeof value==='string'&&(f.enum&&!f.enum.includes(value)||f.minLength!==undefined&&value.trim().length<f.minLength||f.maxLength!==undefined&&value.length>f.maxLength))throw Error(`${key} 不符合本轮允许值或长度`);}
 const keys=Object.keys(a).filter(k=>!['note','personalityNote'].includes(k));
 if(!schema.oneOf.some(v=>keys.length===v.required.length&&v.required.every(k=>keys.includes(k))))throw Error('缺少本轮动作字段，或同时提交了多个动作');
 if('skip'in a&&a.skip!==true)throw Error('跳过动作必须为 skip:true');
 if(r.kind==='witch'&&((a.potion==='poison')!==('target'in a)))throw Error('仅使用毒药时必须携带 target');
}
