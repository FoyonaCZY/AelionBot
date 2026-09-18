import type {ModelConfig} from '../../src/shared';

export function hiddenClientTools(config:Pick<ModelConfig,'protocol'|'hostedWebSearch'|'hostedImageGeneration'>){
  const hidden=new Set<string>();
  if((config.protocol||'chat')==='responses'&&config.hostedWebSearch)hidden.add('web_search');
  return hidden;
}

export function hostedResponseTools(config:Pick<ModelConfig,'protocol'|'hostedWebSearch'|'hostedImageGeneration'>){
  if((config.protocol||'chat')!=='responses')return [] as Array<{type:string}>;
  return [
    ...(config.hostedWebSearch?[{type:'web_search'}]:[]),
    ...(config.hostedImageGeneration?[{type:'image_generation'}]:[]),
  ];
}

export function hostedGeneratedImages(output:unknown){
  if(!Array.isArray(output))return [] as Buffer[];
  const images:Buffer[]=[];
  for(const item of output){
    if(!item||item.type!=='image_generation_call')continue;
    const raw=typeof item.result==='string'?item.result:typeof item.result?.b64_json==='string'?item.result.b64_json:undefined;
    if(!raw)continue;
    try{const bytes=Buffer.from(raw,'base64');if(bytes.length)images.push(bytes);}catch{}
  }
  return images;
}
