import type {ModelConfig,WireMessage} from '../../src/shared';
export class ModelImageUnsupportedError extends Error {
 constructor(model:string,detail?:string){super(`当前模型或服务不支持图片输入（${model}）。请为这个 Bot 选择支持图片的模型；图片附件和原始对话已保留。${detail?'\n服务返回：'+detail:''}`);this.name='ModelImageUnsupportedError';}
}
export function imageInputRejected(status:number,text:string){return [400,404,422].includes(status)&&/no endpoints found that support image input|(?:does not|doesn't|cannot|not).*support.{0,30}(?:image|vision)|(?:image|vision).{0,40}(?:not supported|unsupported)|不支持.{0,10}(?:图片|图像)/i.test(text);}
export function imageCapability(value:any):boolean|undefined{
 const modalities=value?.architecture?.input_modalities??value?.input_modalities??value?.supported_input_modalities;
 if(Array.isArray(modalities)&&modalities.length&&modalities.every(item=>typeof item==='string'))return modalities.includes('image')||modalities.includes('image_url');
 for(const result of [value?.supports_images,value?.supportsImages,value?.capabilities?.vision])if(typeof result==='boolean')return result;
 const modality=value?.architecture?.modality;if(typeof modality==='string'&&modality.includes('->'))return modality.split('->')[0].includes('image');
 return undefined;
}
export function omitHistoricalImages(messages:WireMessage[],required:ReadonlySet<string>,config:ModelConfig,detail?:string){
 if(messages.some(message=>message.images?.some(image=>required.has(image.id))))throw new ModelImageUnsupportedError(config.model,detail);
 return messages.map(message=>message.images?.length?{...message,images:undefined,content:(message.content||'')+'\n[历史图片未发送：当前模型或服务不支持图片。可以继续处理文字，但不能声称已查看图片内容；需要图片细节时请切换支持图片的模型。]'}:message);
}
